import type { RemotePort } from '@pocketshell/core';
export type { RemotePort } from '@pocketshell/core';
/**
 * Pure parsers for remote port-scan output (`ss` / `netstat`) and for the
 * `/proc/<pid>/cwd` probe. Used by {@link scanRemotePorts} to discover
 * listening services worth mirroring to localhost.
 *
 * Every parser here is pinned to **captured** output, not to an assumed
 * format — see `tests/unit/fixtures/portscan-*.txt` (Alpine root + non-root,
 * Debian iproute2, BusyBox netstat, net-tools netstat, nginx). The fixtures
 * exist because two of the rules below are counter-intuitive:
 *
 *  - `ss`'s header line can read `... Peer Address:PortProcess` with **no
 *    space** between the last two column names (iproute2 6.x pads the peer
 *    column to a fixed width and the header overflows it). Header detection
 *    must key on the leading `State`/`Netid` token, never on column count.
 *  - `netstat -tlnp`'s `PID/Program name` column is truncated to 20 chars and
 *    the program name **may contain spaces** (`1/sshd: /usr/sbin/s`,
 *    `1/nginx: master pro`). Taking the last whitespace token and splitting on
 *    `/` yields `usr` for sshd. The whole tail after `LISTEN` is one field.
 *
 * The address is `IP:PORT`, `[IPv6]:PORT`, `:::PORT`, or `*:PORT`.
 */

import { MAX_PORT } from '@pocketshell/core';


/**
 * Parse one `ss` / `netstat` process blob into a name and a PID.
 *
 * Port of `ssh_auto_forward/forwarder.py:59-78` (`_parse_process_info`), with
 * one deliberate correction: the Python takes `blob.split("/")[-1]`, which
 * returns `s` for the real net-tools string `1/sshd: /usr/sbin/s`. We anchor
 * on `^<pid>/` and then cut the program name at the first space or colon, so
 * `1/sshd: /usr/sbin/s` -> `sshd` and `1/nginx: master pro` -> `nginx`, while
 * the Python's own test vectors (`12345/node` -> `node`) still hold.
 *
 * Accepted shapes:
 *   `users:(("python",pid=12345,fd=7))`         -> { python, 12345 }
 *   `users:(("py",pid=1,fd=3),("py",pid=2,fd=3))` -> { py, 1 }  (first entry)
 *   `12345/node`                                -> { node, 12345 }
 *   `1/sshd: /usr/sbin/s`                       -> { sshd, 1 }
 *   `-` / `` / garbage                          -> { null, null }
 */
export function parseProcessInfo(blob: string): {
  name: string | null;
  pid: number | null;
} {
  const text = blob.trim();
  if (!text || text === '-') return { name: null, pid: null };

  let name: string | null = null;
  const quoted = /"([^"]+)"/.exec(text);
  if (quoted?.[1]) {
    name = quoted[1];
  } else {
    const slashed = /^(\d+)\/(.+)$/.exec(text);
    if (slashed?.[2]) {
      // Cut at the first space or colon: net-tools appends the truncated
      // argv (`sshd: /usr/sbin/s`) to the program name in the same column.
      const cut = slashed[2].split(/[\s:,]/)[0];
      name = cut ? cut : null;
    }
  }

  // PID, in the Python's precedence order.
  let pid: number | null = null;
  const byKeyword = /pid=(\d+)/.exec(text);
  const byPrefix = /^(\d+)\//.exec(text);
  const byInfix = /\/(\d+)(?:\/|$)/.exec(text);
  const raw = byKeyword?.[1] ?? byPrefix?.[1] ?? byInfix?.[1];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) pid = n;
  }

  return { name, pid };
}

/** True for an `ss` header line (`State ...` or `Netid State ...`). */
function isSsHeader(line: string): boolean {
  return line.startsWith('State') || line.startsWith('Netid');
}

/**
 * Parse `ss -tlnp` output (with process attribution).
 *
 * As non-root, iproute2 **blanks** the process column for sockets it cannot
 * attribute rather than dropping the row (verified against
 * `portscan-alpine-nonroot-ss-tlnp.txt` and `portscan-debian-nonroot-ss-tlnp.txt`).
 * Older builds were reported to filter rows instead, so callers must still
 * treat this as an enrichment source and take the authoritative port list
 * from `ss -tln` — see {@link scanRemotePorts}.
 */
export function parseSsTlnp(stdout: string): RemotePort[] {
  const out: RemotePort[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isSsHeader(line)) continue;
    // State Recv-Q Send-Q LocalAddress:Port PeerAddress:Port [Process]
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const port = extractPort(tokens[3] ?? '');
    if (port === null) continue;
    const blob = tokens.slice(5).join(' ');
    const { name, pid } = parseProcessInfo(blob);
    out.push({ port, process: name, pid, cwd: null });
  }
  return dedupe(out);
}

/** Parse `ss -tln` output (no `-p`, so never any process attribution). */
export function parseSsTln(stdout: string): RemotePort[] {
  const out: RemotePort[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isSsHeader(line)) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) continue;
    const port = extractPort(tokens[3] ?? '');
    if (port !== null) out.push({ port, process: null, pid: null, cwd: null });
  }
  return dedupe(out);
}

/**
 * Parse `netstat -tln` / `netstat -tlnp` output (net-tools or BusyBox).
 *
 * Only `LISTEN` rows are considered, which also skips both banner lines and
 * the non-root warning ("you would have to be root to see it all."). The
 * process field is everything **after** the `LISTEN` token, because net-tools
 * pads `PID/Program name` to 20 chars and lets the program name contain
 * spaces.
 */
export function parseNetstatTlnp(stdout: string): RemotePort[] {
  const out: RemotePort[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const listenAt = tokens.findIndex((t) => t.toUpperCase() === 'LISTEN');
    if (listenAt < 3) continue;
    const port = extractPort(tokens[3] ?? '');
    if (port === null) continue;
    const blob = tokens.slice(listenAt + 1).join(' ');
    const { name, pid } = parseProcessInfo(blob);
    out.push({ port, process: name, pid, cwd: null });
  }
  return dedupe(out);
}

/**
 * Parse the `pid<TAB>cwd` stream produced by the `/proc/<pid>/cwd` probe.
 * Requires a numeric PID and a non-empty path (`forwarder.py:772-777`);
 * everything else is dropped rather than throwing.
 */
export function parseProcCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const pidText = line.slice(0, tab).trim();
    // The cwd may legitimately contain spaces ("/tmp/dir with spaces"), so
    // only the trailing newline is stripped — never inner whitespace.
    const cwd = line.slice(tab + 1);
    if (!/^\d+$/.test(pidText) || !cwd) continue;
    out.set(Number.parseInt(pidText, 10), cwd);
  }
  return out;
}

/**
 * Split a sentinel-delimited multi-command stdout into named sections.
 *
 * `scanRemotePorts` runs every candidate listener command in ONE exec, each
 * preceded by `echo "<<<NAME>>>"`, so a scan costs one SSH round trip instead
 * of three. Text before the first sentinel is discarded; an absent section
 * yields `undefined` (distinct from a present-but-empty one, which yields '').
 */
export function splitSections(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null) sections[current] = buffer.join('\n');
    buffer = [];
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const marker = /^<<<([A-Z0-9_]+)>>>$/.exec(rawLine.trim());
    if (marker?.[1]) {
      flush();
      current = marker[1];
      continue;
    }
    if (current !== null) buffer.push(rawLine);
  }
  flush();
  return sections;
}

/**
 * Extract the port from a listen address.
 * `[::1]:8080` | `127.0.0.1:8080` | `*:8080` | `:::22` | `0.0.0.0:22`
 *
 * The tail after the last `:` must be **all digits** (`forwarder.py:806-810`),
 * so `0.0.0.0:*` and `*:*` are rejected rather than becoming NaN-adjacent
 * garbage — `Number.parseInt('8080x')` would happily return 8080.
 */
function extractPort(addr: string): number | null {
  if (!addr) return null;
  const colon = addr.lastIndexOf(':');
  if (colon < 0) return null;
  const tail = addr.slice(colon + 1);
  if (!/^\d+$/.test(tail)) return null;
  const n = Number.parseInt(tail, 10);
  return n >= 0 && n <= MAX_PORT ? n : null;
}

/**
 * Collapse rows that describe the same port (IPv4 + IPv6 bindings of one
 * service, or several `ss` rows for one socket), preferring whichever row
 * carries attribution. Sorted by port so callers and tests are deterministic.
 */
function dedupe(ports: RemotePort[]): RemotePort[] {
  const seen = new Map<number, RemotePort>();
  for (const p of ports) {
    const existing = seen.get(p.port);
    if (!existing) {
      seen.set(p.port, { ...p });
      continue;
    }
    if (!existing.process && p.process) existing.process = p.process;
    if (existing.pid === null && p.pid !== null) existing.pid = p.pid;
    if (!existing.cwd && p.cwd) existing.cwd = p.cwd;
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}
