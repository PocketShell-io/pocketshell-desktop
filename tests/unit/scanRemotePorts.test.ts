import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SshService } from '@main/ssh/SshService';
import {
  LISTENER_SCAN_COMMAND,
  mergeScanSections,
  procCwdCommand,
  scanRemoteListeners,
} from '@main/portfwd/scanRemotePorts';

/**
 * The merge policy and the exec orchestration, driven by the same captured
 * fixtures the parsers use. The point of these tests is the *combination*:
 * which command wins when several are available, and what happens when the
 * scan fails outright (which is what used to tear every tunnel down).
 */
function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `portscan-${name}.txt`), 'utf8');
}

/** Assemble a fake sentinel-delimited stdout from named fixtures. */
function scanStdout(parts: {
  ssTln?: string;
  ssTlnp?: string;
  netstatTlnp?: string;
  netstatTln?: string;
}): string {
  return [
    '<<<PS_SS_TLN>>>',
    parts.ssTln ?? '',
    '<<<PS_SS_TLNP>>>',
    parts.ssTlnp ?? '',
    '<<<PS_NETSTAT_TLNP>>>',
    parts.netstatTlnp ?? '',
    '<<<PS_NETSTAT_TLN>>>',
    parts.netstatTln ?? '',
  ].join('\n');
}

/** Minimal SshService double: one canned reply per command substring. */
function fakeSsh(
  replies: { match: RegExp; stdout: string; stderr?: string; exitCode?: number }[],
  log: string[] = [],
  platform: 'posix' | 'windows' = 'posix',
): SshService {
  return {
    exec: (_id: string, command: string) => {
      log.push(command);
      const hit = replies.find((r) => r.match.test(command));
      if (!hit) return Promise.resolve({ stdout: '', stderr: 'no match', exitCode: 127 });
      return Promise.resolve({
        stdout: hit.stdout,
        stderr: hit.stderr ?? '',
        exitCode: hit.exitCode ?? 0,
      });
    },
    hostPlatform: (_id: string) => Promise.resolve(platform),
  } as unknown as SshService;
}

describe('LISTENER_SCAN_COMMAND', () => {
  it('probes every listener tool in one exec, ending in `true`', () => {
    expect(LISTENER_SCAN_COMMAND).toContain('ss -tln 2>/dev/null');
    expect(LISTENER_SCAN_COMMAND).toContain('ss -tlnp 2>/dev/null');
    expect(LISTENER_SCAN_COMMAND).toContain('netstat -tlnp 2>/dev/null');
    // The trailing `true` keeps a missing `netstat` from looking like a
    // transport failure to the exitCode check.
    expect(LISTENER_SCAN_COMMAND.trimEnd().endsWith('true')).toBe(true);
  });
});

describe('procCwdCommand', () => {
  it('builds a readlink loop over the given PIDs', () => {
    const cmd = procCwdCommand([705, 703]);
    expect(cmd).toContain('for pid in 705 703;');
    expect(cmd).toContain('readlink "/proc/$pid/cwd"');
    expect(cmd.endsWith('true')).toBe(true);
  });

  it('returns nothing when there are no PIDs to probe', () => {
    expect(procCwdCommand([])).toBe('');
  });

  it('refuses non-integer PIDs (they come from remote output)', () => {
    // SECURITY: these values are parsed out of a remote command's stdout and
    // interpolated into a shell command.
    const cmd = procCwdCommand([1, Number.NaN, -5, 1.5, 2] as number[]);
    expect(cmd).toContain('for pid in 1 2;');
    expect(cmd).not.toContain('NaN');
    expect(cmd).not.toContain('-5');
  });
});

describe('mergeScanSections', () => {
  it('takes the port list from ss -tln and attribution from ss -tlnp', () => {
    const ports = mergeScanSections(
      scanStdout({
        ssTln: fixture('alpine-root-ss-tln'),
        ssTlnp: fixture('alpine-root-ss-tlnp'),
        netstatTlnp: fixture('alpine-root-netstat-tlnp'),
      }),
    );
    const byPort = new Map(ports.map((p) => [p.port, p]));
    // 4000/4001 exist ONLY in `ss -tln` — neither -p variant attributed them,
    // which is exactly why the full list must not come from `ss -tlnp`.
    expect([...byPort.keys()]).toEqual([22, 3000, 4000, 4001, 5555, 8000, 9999, 19840, 43741]);
    expect(byPort.get(8000)?.process).toBe('python3');
    expect(byPort.get(8000)?.pid).toBe(705);
    expect(byPort.get(4000)?.process).toBeNull();
  });

  it('prefers ss attribution over netstat when both have a name', () => {
    // netstat as root names 9999 as pid 1525; ss names the other fork, 1527.
    const ports = mergeScanSections(
      scanStdout({
        ssTln: fixture('alpine-root-ss-tln'),
        ssTlnp: fixture('alpine-root-ss-tlnp'),
        netstatTlnp: fixture('alpine-root-netstat-tlnp'),
      }),
    );
    expect(ports.find((p) => p.port === 9999)?.pid).toBe(1527);
  });

  it('fills attribution from netstat when ss could not (non-root)', () => {
    // As a non-root user `ss -tlnp` blanks 8000 while `netstat -tlnp` names
    // nothing either — but 4000 is named by both, and 19840 by neither.
    const ports = mergeScanSections(
      scanStdout({
        ssTln: fixture('alpine-nonroot-ss-tln'),
        ssTlnp: fixture('alpine-nonroot-ss-tlnp'),
        netstatTlnp: fixture('alpine-nonroot-netstat-tlnp'),
      }),
    );
    const byPort = new Map(ports.map((p) => [p.port, p]));
    expect(byPort.get(4000)?.pid).toBe(1812);
    expect(byPort.get(8000)?.process).toBeNull();
    expect(byPort.get(19840)?.process).toBeNull();
  });

  it('falls back to netstat when the host has no ss at all (BusyBox)', () => {
    const ports = mergeScanSections(
      scanStdout({
        ssTln: '',
        ssTlnp: '',
        netstatTlnp: fixture('busybox-netstat-tlnp'),
        netstatTln: fixture('busybox-netstat-tln'),
      }),
    );
    expect(ports).toEqual([
      { port: 8081, process: 'nc', pid: 7, cwd: null },
      { port: 19840, process: 'nc', pid: 8, cwd: null },
    ]);
  });

  it('works on a host with ss but no netstat (minimal Debian)', () => {
    const ports = mergeScanSections(
      scanStdout({
        ssTln: fixture('debian-root-ss-tln'),
        ssTlnp: fixture('debian-nonroot-ss-tlnp'),
      }),
    );
    expect(ports.map((p) => p.port)).toEqual([8080, 19840]);
    expect(ports.find((p) => p.port === 19840)?.process).toBe('python3');
  });

  it('returns nothing when every section is empty', () => {
    expect(mergeScanSections(scanStdout({}))).toEqual([]);
  });

  // The three below run against the LITERAL bytes LISTENER_SCAN_COMMAND put
  // on the wire, captured by running the exact `pathAwareCommand(...)` string
  // inside each container — sentinels, headers, padding and all.
  it('parses the real wire output of a root Alpine host', () => {
    const ports = mergeScanSections(fixture('wire-alpine-root'));
    expect(ports).toEqual([
      { port: 22, process: 'sshd', pid: 1, cwd: null },
      { port: 8000, process: 'python3', pid: 4460, cwd: null },
      { port: 19840, process: null, pid: null, cwd: null },
      { port: 36101, process: null, pid: null, cwd: null },
    ]);
  });

  it('parses the real wire output of the same host as a non-root user', () => {
    const ports = mergeScanSections(fixture('wire-alpine-nonroot'));
    // Same ports as root — nothing is hidden — but only the caller's own
    // process is attributed.
    expect(ports.map((p) => p.port)).toEqual([22, 8000, 19840, 36101]);
    expect(ports.find((p) => p.port === 19840)).toEqual({
      port: 19840,
      process: 'python3',
      pid: 4462,
      cwd: null,
    });
    expect(ports.find((p) => p.port === 22)?.process).toBeNull();
  });

  it('parses the real wire output of a host with no `ss` at all', () => {
    // BusyBox: both ss sections come back completely empty and the command
    // still exits 0 thanks to the trailing `true`.
    expect(mergeScanSections(fixture('wire-busybox'))).toEqual([
      { port: 8081, process: 'nc', pid: 7, cwd: null },
    ]);
  });
});

describe('scanRemoteListeners', () => {
  it('reports ok with attributed ports and their working directories', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(
      [
        {
          match: /ss -tln/,
          stdout: scanStdout({
            ssTln: fixture('alpine-nonroot-ss-tln'),
            ssTlnp: fixture('alpine-nonroot-ss-tlnp'),
            netstatTlnp: fixture('alpine-nonroot-netstat-tlnp'),
          }),
        },
        { match: /readlink/, stdout: fixture('alpine-nonroot-proc-cwd') },
      ],
      log,
    );
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    const byPort = new Map(result.ports.map((p) => [p.port, p]));
    expect(byPort.get(4000)?.cwd).toBe('/home/testuser/projects/client/web-api');
    expect(byPort.get(4001)?.cwd).toBe('/tmp/dir with spaces');
    // Unattributed ports have no PID, so no cwd can be looked up.
    expect(byPort.get(8000)?.cwd).toBeNull();
    // Exactly two round trips: the listener probe and the cwd probe.
    expect(log).toHaveLength(2);
  });

  it('skips the cwd exec entirely when nothing was attributed', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(
      [{ match: /ss -tln/, stdout: scanStdout({ ssTln: fixture('debian-root-ss-tln') }) }],
      log,
    );
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result.ok).toBe(true);
    expect(result.ports).toHaveLength(2);
    expect(log).toHaveLength(1);
  });

  it('reports ok:false — NOT an empty list — when the exec fails', async () => {
    // This is the distinction the empty-scan guard depends on. Conflating a
    // failed scan with "nothing is listening" is what tore down live tunnels.
    const ssh = fakeSsh([
      { match: /ss -tln/, stdout: '', stderr: 'channel open failure', exitCode: -1 },
    ]);
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result.ok).toBe(false);
    expect(result.ports).toEqual([]);
    expect(result.error).toBe('channel open failure');
  });

  it('reports ok:false when no sentinel came back (the shell never ran)', async () => {
    const ssh = fakeSsh([{ match: /ss -tln/, stdout: 'bash: line 1: syntax error' }]);
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('port scan produced no output');
  });

  it('reports ok:true with an empty list on a host with zero listeners', async () => {
    const ssh = fakeSsh([{ match: /ss -tln/, stdout: scanStdout({}) }]);
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result.ok).toBe(true);
    expect(result.ports).toEqual([]);
  });

  it('survives a thrown exec rather than rejecting', async () => {
    const ssh = {
      exec: () => Promise.reject(new Error('connection closed')),
    } as unknown as SshService;
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result).toEqual({ ok: false, ports: [], error: 'connection closed' });
  });

  it('does not fail the scan when only the cwd probe breaks', async () => {
    const ssh = fakeSsh([
      { match: /ss -tln/, stdout: scanStdout({ ssTln: fixture('alpine-root-ss-tln'), ssTlnp: fixture('alpine-root-ss-tlnp') }) },
      { match: /readlink/, stdout: '', stderr: 'boom', exitCode: 1 },
    ]);
    const result = await scanRemoteListeners(ssh, 'c1');
    expect(result.ok).toBe(true);
    expect(result.ports.length).toBeGreaterThan(0);
    expect(result.ports.every((p) => p.cwd === null)).toBe(true);
  });

  it('runs the Windows arm on a windows host: netstat -ano, one exec, no cwd probe', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(
      [
        {
          match: /netstat -ano/,
          stdout: [
            '<<<PS_WIN_NETSTAT_ANO>>>',
            '',
            'Active Connections',
            '',
            '  Proto  Local Address          Foreign Address        State           PID',
            '  TCP    0.0.0.0:22               0.0.0.0:0              LISTENING       5000',
            '  TCP    127.0.0.1:8000          0.0.0.0:0              LISTENING       7000',
            '  TCP    [::]:22                 [::]:0                 LISTENING       5000',
            '  UDP    0.0.0.0:5353            *:*                                    6000',
          ].join('\r\n'),
        },
      ],
      log,
      'windows',
    );
    const result = await scanRemoteListeners(ssh, 'c1', { platform: 'windows' });
    expect(result.ok).toBe(true);
    expect(result.ports.map((p) => p.port).sort((a, b) => a - b)).toEqual([22, 8000]);
    expect(result.ports.find((p) => p.port === 8000)).toMatchObject({
      port: 8000,
      pid: 7000,
      process: null,
      cwd: null,
    });
    // One round trip: the POSIX arm's `ss -tln` and /proc readlink loop must
    // both stay off a host that has neither.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('netstat -ano');
  });

  it('keeps the POSIX arm on a posix host even when netstat -ano would answer', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(
      [{ match: /ss -tln/, stdout: scanStdout({ ssTln: fixture('debian-root-ss-tln') }) }],
      log,
      'posix',
    );
    const result = await scanRemoteListeners(ssh, 'c1', { platform: 'posix' });
    expect(result.ok).toBe(true);
    expect(log[0]).toContain('ss -tln');
  });
});
