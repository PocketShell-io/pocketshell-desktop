import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseNetstatTlnp,
  parseProcCwds,
  parseProcessInfo,
  parseSsTln,
  parseSsTlnp,
  splitSections,
} from '@main/portfwd/PortScanner';

/**
 * Every assertion here runs against output CAPTURED from a real host, not
 * against text written from memory — the fixtures are captured output, not formats assumed. The cautionary example is how the Python's own `ss` parser silently produces nothing because it reads
 * column 7 of a six-column output, and how the project's Docker fixture (root,
 * both iproute2 AND net-tools installed) cannot catch that class of bug.
 *
 * Fixtures, all captured 2026-08-24 (see the report for the exact commands):
 *   portscan-alpine-root-*      pocketshell-test:helper (Alpine 3.24, root)
 *   portscan-alpine-nonroot-*   same container as uid 1000 `testuser`
 *   portscan-debian-*           debian:12 + iproute2 6.1.0, no net-tools
 *   portscan-busybox-*          busybox:1.36 (BusyBox netstat, no ss)
 *   portscan-nginx-root-*       nginx:alpine (truncated multi-word progname)
 */
function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `portscan-${name}.txt`), 'utf8');
}

describe('parseProcessInfo', () => {
  // The two vectors the Python's own unit tests pin (tests/test_cli.py:91-100).
  it('parses an ss users:(( )) blob', () => {
    expect(parseProcessInfo('users:(("python",pid=12345,fd=7))')).toEqual({
      name: 'python',
      pid: 12345,
    });
  });

  it('parses a netstat pid/name blob', () => {
    expect(parseProcessInfo('12345/node')).toEqual({ name: 'node', pid: 12345 });
  });

  it('takes the first entry of a multi-process ss blob', () => {
    // Real capture: two processes sharing one listening socket after fork().
    expect(
      parseProcessInfo('users:(("python3",pid=1527,fd=3),("python3",pid=1525,fd=3))'),
    ).toEqual({ name: 'python3', pid: 1527 });
  });

  it('handles net-tools truncating a program name that contains spaces', () => {
    // REGRESSION: the Python's `blob.split("/")[-1]` returns "s" here, and the
    // previous Node parser (last whitespace token, split on "/") returned
    // "usr". Both are wrong; the column is one field, truncated to 20 chars.
    expect(parseProcessInfo('1/sshd: /usr/sbin/s')).toEqual({ name: 'sshd', pid: 1 });
    expect(parseProcessInfo('1/nginx: master pro')).toEqual({ name: 'nginx', pid: 1 });
  });

  it('treats netstat\'s unattributed marker and empty blobs as unknown', () => {
    expect(parseProcessInfo('-')).toEqual({ name: null, pid: null });
    expect(parseProcessInfo('')).toEqual({ name: null, pid: null });
    expect(parseProcessInfo('   ')).toEqual({ name: null, pid: null });
  });

  it('falls back through the PID precedence chain', () => {
    expect(parseProcessInfo('users:(("x",pid=9,fd=1))').pid).toBe(9); // pid=
    expect(parseProcessInfo('42/thing').pid).toBe(42); // ^N/
    expect(parseProcessInfo('nope').pid).toBeNull();
  });
});

describe('parseSsTlnp (captured output)', () => {
  it('attributes what it can on an Alpine host as root', () => {
    const ports = parseSsTlnp(fixture('alpine-root-ss-tlnp'));
    const byPort = new Map(ports.map((p) => [p.port, p]));
    expect(byPort.get(22)).toEqual({ port: 22, process: 'sshd', pid: 1, cwd: null });
    expect(byPort.get(8000)).toEqual({ port: 8000, process: 'python3', pid: 705, cwd: null });
    expect(byPort.get(9999)).toEqual({ port: 9999, process: 'python3', pid: 1527, cwd: null });
    expect(byPort.get(19840)).toEqual({ port: 19840, process: 'nc', pid: 703, cwd: null });
    // Blank process column -> the row is still reported, without attribution.
    expect(byPort.get(3000)).toEqual({ port: 3000, process: null, pid: null, cwd: null });
  });

  it('BLANKS rather than hides unattributable rows as non-root', () => {
    //  assert that
    // `ss -tlnp` FILTERS OUT rows it cannot attribute when run as non-root.
    // On iproute2 6.x that is not what happens: every row is present and only
    // the process column is empty. The merge policy is correct either way,
    // but the port counts must match or the claim is being asserted blind.
    const nonroot = parseSsTlnp(fixture('alpine-nonroot-ss-tlnp'));
    const all = parseSsTln(fixture('alpine-nonroot-ss-tln'));
    expect(nonroot.map((p) => p.port)).toEqual(all.map((p) => p.port));
    // Only the caller's own processes are named.
    const named = nonroot.filter((p) => p.process !== null).map((p) => p.port);
    expect(named).toEqual([3000, 4000, 4001, 5555]);
  });

  it('handles Debian iproute2, where even `ss -tln` prints a Process header', () => {
    // The header reads "... Peer Address:PortProcess" with NO space, because
    // iproute2 pads the peer column and the header overflows it. Detecting
    // headers by column count would break here.
    const ports = parseSsTln(fixture('debian-root-ss-tln'));
    expect(ports.map((p) => p.port)).toEqual([8080, 19840]);
    expect(ports.every((p) => p.process === null)).toBe(true);
  });

  it('parses IPv6 [::]:PORT and wildcard *:PORT forms', () => {
    const ports = parseSsTln(fixture('alpine-root-ss-tln'));
    // *:5555 and *:19840 come from the wildcard rows; [::]:22 dedupes into 22.
    expect(ports.map((p) => p.port)).toEqual([
      22, 3000, 4000, 4001, 5555, 8000, 9999, 19840, 43741,
    ]);
  });

  it('drops *:* / 0.0.0.0:* rather than coercing them', () => {
    expect(parseSsTln('LISTEN 0 128 *:* *:*')).toEqual([]);
  });

  it('skips headers and blank input', () => {
    expect(parseSsTlnp('State Recv-Q\n\n')).toEqual([]);
    expect(parseSsTlnp('Netid State Recv-Q Send-Q Local:Port\n')).toEqual([]);
    expect(parseSsTln('')).toEqual([]);
  });
});

describe('parseNetstatTlnp (captured output)', () => {
  it('parses net-tools output as root, including a spaced program name', () => {
    const ports = parseNetstatTlnp(fixture('alpine-root-netstat-tlnp'));
    const byPort = new Map(ports.map((p) => [p.port, p]));
    expect(byPort.get(22)).toEqual({ port: 22, process: 'sshd', pid: 1, cwd: null });
    expect(byPort.get(8000)).toEqual({ port: 8000, process: 'python3', pid: 705, cwd: null });
    expect(byPort.get(19840)).toEqual({ port: 19840, process: 'nc', pid: 703, cwd: null });
    expect(byPort.get(4000)).toEqual({ port: 4000, process: null, pid: null, cwd: null });
  });

  it('ignores the non-root warning banner net-tools prints to stdout', () => {
    // "(Not all processes could be identified, non-owned process info / will
    // not be shown, you would have to be root to see it all.)" — two lines,
    // no LISTEN, so they must not become ports.
    const ports = parseNetstatTlnp(fixture('alpine-nonroot-netstat-tlnp'));
    expect(ports.map((p) => p.port)).toEqual([22, 3000, 4000, 4001, 5555, 8000, 9999, 19840, 43741]);
    expect(ports.find((p) => p.port === 4000)).toEqual({
      port: 4000,
      process: 'python3',
      pid: 1812,
      cwd: null,
    });
    expect(ports.find((p) => p.port === 22)?.process).toBeNull();
  });

  it('parses a header-only listing without process attribution', () => {
    const ports = parseNetstatTlnp(fixture('alpine-root-netstat-tln'));
    expect(ports.map((p) => p.port)).toEqual([
      22, 3000, 4000, 4001, 5555, 8000, 9999, 19840, 43741,
    ]);
    expect(ports.every((p) => p.process === null)).toBe(true);
  });

  it('parses BusyBox netstat (the only tool on a minimal image)', () => {
    expect(parseNetstatTlnp(fixture('busybox-netstat-tlnp'))).toEqual([
      { port: 8081, process: 'nc', pid: 7, cwd: null },
      { port: 19840, process: 'nc', pid: 8, cwd: null },
    ]);
    expect(parseNetstatTlnp(fixture('busybox-netstat-tln')).map((p) => p.port)).toEqual([
      8081, 19840,
    ]);
  });

  it('parses nginx, whose progname is truncated mid-word', () => {
    expect(parseNetstatTlnp(fixture('nginx-root-netstat-tlnp'))).toEqual([
      { port: 80, process: 'nginx', pid: 1, cwd: null },
    ]);
  });

  it('dedupes the IPv4 and IPv6 rows of one service, keeping attribution', () => {
    const ports = parseNetstatTlnp(fixture('alpine-root-netstat-tlnp'));
    expect(ports.filter((p) => p.port === 22)).toHaveLength(1);
  });
});

describe('parseProcCwds', () => {
  it('parses the pid<TAB>cwd stream, preserving spaces in paths', () => {
    const table = parseProcCwds(fixture('alpine-nonroot-proc-cwd'));
    expect(table.get(1812)).toBe('/home/testuser/projects/client/web-api');
    // A cwd may contain spaces; only the tab is a separator.
    expect(table.get(1814)).toBe('/tmp/dir with spaces');
    expect(table.get(707)).toBe('/home/testuser');
    // PIDs whose /proc/<pid>/cwd was unreadable produce no line at all.
    expect(table.has(1)).toBe(false);
  });

  it('parses the root capture where every cwd is /', () => {
    const table = parseProcCwds(fixture('alpine-root-proc-cwd'));
    expect([...table.entries()]).toEqual([
      [1527, '/'],
      [1525, '/'],
      [1, '/'],
    ]);
  });

  it('drops malformed rows instead of throwing', () => {
    expect(parseProcCwds('notapid\t/x\n\n123\n\t/y\n456\t\n789\t/ok').size).toBe(1);
    expect(parseProcCwds('789\t/ok').get(789)).toBe('/ok');
  });
});

describe('splitSections', () => {
  it('splits a sentinel-delimited multi-command stdout', () => {
    const stdout = ['noise', '<<<A>>>', 'a1', 'a2', '<<<B>>>', '', '<<<C>>>', 'c1'].join('\n');
    expect(splitSections(stdout)).toEqual({ A: 'a1\na2', B: '', C: 'c1' });
  });

  it('distinguishes an empty section from an absent one', () => {
    const sections = splitSections('<<<A>>>\n');
    expect(sections.A).toBe('');
    expect(sections.B).toBeUndefined();
  });

  it('ignores lines that merely look like markers', () => {
    expect(splitSections('<<<lower>>>\nx')).toEqual({});
  });
});
