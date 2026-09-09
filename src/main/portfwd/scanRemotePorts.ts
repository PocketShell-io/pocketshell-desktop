import type { SshService } from '../ssh/SshService.js';
import { pathAwareCommand } from '../helper/bootstrap.js';
import {
  parseSsTln,
  parseSsTlnp,
  parseNetstatTlnp,
  parseProcCwds,
  splitSections,
  type RemotePort,
} from './PortScanner.js';

export type { RemotePort };

/** Outcome of one remote scan. */
export interface ScanResult {
  /**
   * True when the scan actually ran and produced parseable output. False for
   * a transport hiccup, a shell that could not start, or a host with neither
   * `ss` nor `netstat`.
   *
   * The distinction matters: `AutoForwarder` must never read a *failed* scan
   * as "nothing is listening any more" and tear every tunnel down.
   */
  ok: boolean;
  ports: RemotePort[];
  error: string | null;
}

/** Section sentinels emitted by {@link LISTENER_SCAN_COMMAND}. */
const SECTION_SS_TLN = 'PS_SS_TLN';
const SECTION_SS_TLNP = 'PS_SS_TLNP';
const SECTION_NETSTAT_TLNP = 'PS_NETSTAT_TLNP';
const SECTION_NETSTAT_TLN = 'PS_NETSTAT_TLN';

/**
 * All listener probes in ONE exec, each preceded by a sentinel line.
 *
 * Cost matters here: this runs every `scanIntervalSec` for the lifetime of a
 * connection, and each `ssh.exec` is a full channel open/close round trip.
 * Sentinels let us keep the four-way probe while paying for one.
 *
 * Double quotes around the sentinels on purpose — `pathAwareCommand` wraps the
 * whole string in single quotes and escapes any single quote inside it, so
 * single-quoting here would work but is needlessly noisy to read in a log.
 * `2>/dev/null` swallows the "not found" noise of hosts that have only one of
 * the two tools; the trailing `true` keeps the exec's exit code at 0 so a
 * missing `netstat` is not mistaken for a transport failure.
 */
export const LISTENER_SCAN_COMMAND = [
  `echo "<<<${SECTION_SS_TLN}>>>"; ss -tln 2>/dev/null;`,
  `echo "<<<${SECTION_SS_TLNP}>>>"; ss -tlnp 2>/dev/null;`,
  `echo "<<<${SECTION_NETSTAT_TLNP}>>>"; netstat -tlnp 2>/dev/null;`,
  `echo "<<<${SECTION_NETSTAT_TLN}>>>"; netstat -tln 2>/dev/null;`,
  'true',
].join(' ');

/**
 * Build the `/proc/<pid>/cwd` probe for a set of PIDs.
 *
 * SECURITY: PIDs originate in remote command output and are interpolated into
 * a shell command. The caller filters to positive integers and this function
 * asserts the same thing again — never let a raw token through.
 *
 * `readlink` only succeeds for our own processes or as root, so on a shared
 * box most PIDs yield nothing; the trailing `true` keeps the exit code at 0
 * when the *last* pid in the loop is one of them.
 */
export function procCwdCommand(pids: readonly number[]): string {
  const safe = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (safe.length === 0) return '';
  return (
    `for pid in ${safe.join(' ')}; do ` +
    `cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) && ` +
    `printf '%s\\t%s\\n' "$pid" "$cwd"; done; true`
  );
}

/**
 * Merge the sections of a {@link LISTENER_SCAN_COMMAND} run into one port list.
 *
 * Policy (deliberately NOT the Python's):
 * the authoritative list comes from `ss -tln`, because `ss -tlnp` has been
 * observed to *filter out* sockets it cannot attribute on some builds instead
 * of blanking their process column. Attribution is merged in afterwards by
 * port number, from `ss -tlnp` first and `netstat -tlnp` second.
 */
export function mergeScanSections(stdout: string): RemotePort[] {
  const sections = splitSections(stdout);

  let ports = sections[SECTION_SS_TLN] ? parseSsTln(sections[SECTION_SS_TLN]) : [];
  if (ports.length === 0 && sections[SECTION_NETSTAT_TLN]) {
    ports = parseNetstatTlnp(sections[SECTION_NETSTAT_TLN]);
  }
  if (ports.length === 0 && sections[SECTION_NETSTAT_TLNP]) {
    ports = parseNetstatTlnp(sections[SECTION_NETSTAT_TLNP]);
  }
  if (ports.length === 0 && sections[SECTION_SS_TLNP]) {
    ports = parseSsTlnp(sections[SECTION_SS_TLNP]);
  }
  if (ports.length === 0) return [];

  const attribution = new Map<number, { process: string | null; pid: number | null }>();
  for (const source of [SECTION_NETSTAT_TLNP, SECTION_SS_TLNP]) {
    const text = sections[source];
    if (!text) continue;
    const rows = source === SECTION_SS_TLNP ? parseSsTlnp(text) : parseNetstatTlnp(text);
    for (const row of rows) {
      if (row.process === null && row.pid === null) continue;
      attribution.set(row.port, { process: row.process, pid: row.pid });
    }
  }

  return ports.map((p) => {
    const extra = attribution.get(p.port);
    if (!extra) return p;
    return {
      ...p,
      process: p.process ?? extra.process,
      pid: p.pid ?? extra.pid,
    };
  });
}

/**
 * Scan a remote host for listening TCP ports, with process attribution and
 * (where readable) each process's working directory.
 *
 * Two execs at most: one sentinel-delimited listener probe, and one
 * `/proc/<pid>/cwd` probe that is skipped entirely when nothing was attributed.
 */
export async function scanRemoteListeners(
  ssh: SshService,
  connectionId: string,
): Promise<ScanResult> {
  let listener;
  try {
    listener = await ssh.exec(connectionId, pathAwareCommand(LISTENER_SCAN_COMMAND));
  } catch (e) {
    return { ok: false, ports: [], error: (e as Error).message };
  }
  if (listener.exitCode !== 0) {
    return {
      ok: false,
      ports: [],
      error: listener.stderr.trim() || `port scan exited ${listener.exitCode}`,
    };
  }
  const sections = splitSections(listener.stdout);
  if (Object.keys(sections).length === 0) {
    // No sentinel came back at all: the shell never ran our command.
    return { ok: false, ports: [], error: 'port scan produced no output' };
  }

  const ports = mergeScanSections(listener.stdout);
  const pids = [...new Set(ports.map((p) => p.pid))].filter(
    (n): n is number => Number.isInteger(n) && (n as number) > 0,
  );
  const cwdCommand = procCwdCommand(pids);
  if (cwdCommand) {
    try {
      const cwds = await ssh.exec(connectionId, pathAwareCommand(cwdCommand));
      // Deliberately NOT gated on exitCode: the loop's final `readlink` may
      // fail for a process we do not own, and `true` only guards the common
      // case. Partial output is still useful.
      const table = parseProcCwds(cwds.stdout);
      for (const p of ports) {
        if (p.pid !== null) p.cwd = table.get(p.pid) ?? null;
      }
    } catch {
      // Attribution is best-effort; a failed cwd probe never fails the scan.
    }
  }

  return { ok: true, ports, error: null };
}

/**
 * Back-compatible wrapper: the port list only.
 *
 * Callers that must distinguish "scan failed" from "nothing is listening"
 * should use {@link scanRemoteListeners} instead — conflating the two is what
 * made a single transport hiccup tear down every live tunnel.
 */
export async function scanRemotePorts(
  ssh: SshService,
  connectionId: string,
): Promise<RemotePort[]> {
  return (await scanRemoteListeners(ssh, connectionId)).ports;
}
