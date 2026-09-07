/**
 * Client for the aplexer session manager (`a`) on the remote host.
 *
 * aplexer is the MAIN session manager wherever it is installed; the tmux
 * path (`PocketshellClient`, raw tmux through the helper) is the fallback for
 * hosts without it. Every method here is total — it resolves a result object
 * or an empty list, never throws for anything the host does — matching the
 * `SshService.exec` contract one layer down.
 *
 * Identity discipline: the UUID is the stable selector for kill/rename
 * (renames change the tag, never the id, so an id can never be orphaned the
 * way a name can). `start` is the one call with no id yet and addresses
 * `workspace + tag`, which the host enforces as unique among live sessions.
 */

import type { SshService } from '../ssh/SshService.js';
import type { SessionSummary } from '../../shared/types.js';
import type { AplexerSessionRecord, AplexerSortKey } from '../../shared/aplexer.js';
import { APLEXER_LIST_SORT } from '../../shared/aplexer.js';
import { pathAwareCommand } from './bootstrap.js';
import { shellQuote, shellQuoteRemotePath } from '../../shared/shellQuote.js';
import {
  aplexerRecordToSummary,
  byOldestCreated,
  parseAplexerSnapshot,
} from './aplexerParsers.js';
import { log } from '../log.js';

/**
 * `a snapshot --json`: the machine API — the same records `a list --json`
 * prints, so the host's `--sort` applies here too. Without [sort] the host
 * applies its own default; with one the panel's order is spelled out.
 */
export function aplexerSnapshotCommand(sort?: AplexerSortKey): string {
  return sort === undefined ? 'a snapshot --json' : `a snapshot --json --sort ${sort}`;
}

/**
 * True when [stderr] is the CLI refusing a flag it does not know — the
 * argument-parser's usage error a host whose `a` predates `--sort` answers
 * with. A host sentence that merely failed ("boom", a python traceback) does
 * not match, so a transient failure is never mistaken for a missing feature.
 */
export function isAplexerUnknownFlag(stderr: string): boolean {
  return /\bunexpected argument\b|\bunrecognized\b|\bunknown option\b/i.test(stderr);
}

/**
 * `a start --workspace W --tag T`: create a shell session for a folder.
 *
 * No `--engine`: a folder session is a plain shell, the same thing the tmux
 * fallback creates. Agent engines stay a terminal-typed launch on top (the
 * pending-launch flow), so engine/profile resolution is not on this path and
 * cannot fail it. `--json` prints the created record; a live holder is
 * refused with exit 1 and `already belongs to` on stderr (see below).
 */
export function aplexerStartCommand(workspace: string, tag: string): string {
  return `a start --workspace ${shellQuoteRemotePath(workspace)} --tag ${shellQuote(tag)} --json`;
}

/** True when [stderr] is `a start` refusing a workspace+tag that is live. */
export function isAplexerStartRefusal(exitCode: number, stderr: string): boolean {
  return exitCode !== 0 && /already belongs to/i.test(stderr);
}

/** `a kill <id>`: signal the workload and drop the record. */
export function aplexerKillCommand(id: string): string {
  return `a kill ${shellQuote(id)} --json`;
}

/** True when [stderr] is `a kill` reporting the id is already gone. */
export function isAplexerNotFound(exitCode: number, stderr: string): boolean {
  return exitCode !== 0 && /no matching session/i.test(stderr);
}

/**
 * `a rename <id> --tag <new>`: change the tag within its workspace.
 *
 * By id, never by `workspace:tag`: the selector names the session being
 * changed, and a workspace path containing `:` would misparse in the
 * positional form while the id is exact by construction.
 */
export function aplexerRenameCommand(id: string, tag: string): string {
  return `a rename ${shellQuote(id)} --tag ${shellQuote(tag)}`;
}

/** Outcome of {@link AplexerClient.startSession}. Never thrown. */
export interface AplexerStartOutcome {
  ok: boolean;
  /** The created session's UUID, for the join/kill/rename that follow. */
  id: string | null;
  /** The tag the host confirmed. Echoed back, like the helper's create. */
  tag: string | null;
  /**
   * True when the host refused because the pair is LIVE (a race with the
   * caller's snapshot check). The caller re-reads and treats it as a reuse,
   * rather than reporting a failure for a session that exists.
   */
  liveRefusal: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerClient.killSession}. Never thrown. */
export interface AplexerKillOutcome {
  ok: boolean;
  /** True when the session was already gone — the ordinary stale-list race. */
  notFound: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerClient.renameSession}. Never thrown. */
export interface AplexerRenameOutcome {
  ok: boolean;
  notFound: boolean;
  error: string | null;
}

export class AplexerClient {
  /**
   * `a` present per connection. Null means "asked and it is absent";
   * absent means "not asked yet". Remembering the negative matters as much
   * as the positive: a tmux-only host must pay one probe per CONNECTION, not
   * one per five-second poll tick.
   */
  private readonly availableByConnection = new Map<string, boolean>();

  /**
   * `--sort` support per connection, same discipline as the availability
   * probe: true after one sorted snapshot answered, false after the CLI
   * refused the flag (an old host — every tick then goes straight to the
   * unsorted exec), unknown until one of those happens.
   */
  private readonly sortSupportedByConnection = new Map<string, boolean>();

  constructor(private readonly ssh: SshService) {}

  /** Forget cached per-connection state. Call on disconnect. */
  evict(connectionId: string): void {
    this.availableByConnection.delete(connectionId);
    this.sortSupportedByConnection.delete(connectionId);
  }

  /**
   * Is `a` installed on this connection's host? Cached per connection, never
   * throws — a host that cannot be asked is a host without aplexer.
   */
  async isAvailable(connectionId: string): Promise<boolean> {
    const cached = this.availableByConnection.get(connectionId);
    if (cached !== undefined) return cached;
    let available = false;
    try {
      const res = await this.ssh.exec(connectionId, pathAwareCommand('command -v a'));
      available = res.exitCode === 0 && res.stdout.trim().length > 0;
    } catch {
      available = false;
    }
    this.availableByConnection.set(connectionId, available);
    return available;
  }

  /**
   * Live aplexer sessions as rows in the host's own order, or null when `a`
   * is absent.
   *
   * Null vs [] is the whole contract: null means "no aplexer here, run the
   * tmux path", [] means "aplexer answered and nothing is running". A failed
   * exec on a host that HAS `a` also answers [] — the snapshot is the whole
   * list on such a host, so the tree shows empty for that poll tick and
   * recovers on the next; the legacy tmux path is only for hosts without `a`.
   *
   * [sort] is what the host sorts the list by, and the list's order is the
   * panel's order — the renderer does not re-sort. Hosts whose `a` predates
   * `--sort` get {@link byOldestCreated} instead, which is what such a host
   * showed before the flag existed.
   */
  async listSessions(
    connectionId: string,
    sort: AplexerSortKey = APLEXER_LIST_SORT,
  ): Promise<SessionSummary[] | null> {
    if (!(await this.isAvailable(connectionId))) return null;
    return this.snapshotSummaries(connectionId, sort);
  }

  /**
   * The raw snapshot records, or [] on any failure. Never throws.
   *
   * With [sort], the sorted command is tried first and its DOCUMENT ORDER is
   * kept — that is the feature. When the host cannot do it yet (the flag is
   * refused, remembered per connection) or the sorted exec dies mid-flight,
   * the unsorted snapshot answers and is sorted client-side, so the order a
   * host without the flag sees is the one it always saw.
   */
  async snapshotRecords(
    connectionId: string,
    sort?: AplexerSortKey,
  ): Promise<AplexerSessionRecord[]> {
    if (sort !== undefined && this.sortSupportedByConnection.get(connectionId) !== false) {
      try {
        const res = await this.ssh.exec(connectionId, pathAwareCommand(aplexerSnapshotCommand(sort)));
        if (res.exitCode === 0) {
          this.sortSupportedByConnection.set(connectionId, true);
          return parseAplexerSnapshot(res.stdout);
        }
        // Remember the refusal only when it IS one: a usage error means every
        // future tick would fail the same way, while any other non-zero exit
        // may be a one-off not worth pinning the connection to the fallback.
        if (isAplexerUnknownFlag(res.stderr)) {
          this.sortSupportedByConnection.set(connectionId, false);
        }
      } catch {
        // Transport-level: fall through to the unsorted attempt this tick;
        // the capability stays unknown and the next tick asks again.
      }
    }
    try {
      const res = await this.ssh.exec(connectionId, pathAwareCommand(aplexerSnapshotCommand()));
      if (res.exitCode !== 0) return [];
      return byOldestCreated(parseAplexerSnapshot(res.stdout));
    } catch {
      return [];
    }
  }

  /** Find one live record by workspace+tag. Null when absent or unknown. */
  async findSession(
    connectionId: string,
    workspace: string,
    tag: string,
  ): Promise<AplexerSessionRecord | null> {
    const records = await this.snapshotRecords(connectionId);
    return records.find((r) => r.workspace === workspace && r.tag === tag) ?? null;
  }

  /** All live tags in [workspace] — the client-side free-name walk's input. */
  async liveTags(connectionId: string, workspace: string): Promise<Set<string> | null> {
    if (!(await this.isAvailable(connectionId))) return null;
    const records = await this.snapshotRecords(connectionId);
    return new Set(records.filter((r) => r.workspace === workspace).map((r) => r.tag));
  }

  /**
   * Start a shell session for [workspace] under [tag].
   *
   * The caller checks liveness first (snapshot); a `liveRefusal` covers the
   * race where the pair went live between that check and this exec. Anything
   * else non-zero is a real failure with the host's own sentence.
   */
  async startSession(
    connectionId: string,
    opts: { workspace: string; tag: string },
  ): Promise<AplexerStartOutcome> {
    let res;
    try {
      res = await this.ssh.exec(
        connectionId,
        pathAwareCommand(aplexerStartCommand(opts.workspace, opts.tag)),
      );
    } catch (e) {
      return { ok: false, id: null, tag: null, liveRefusal: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) {
      const record = parseSingleAplexerRecord(res.stdout);
      // The record echoes the tag back; trust it over the request the way the
      // helper create does. An unparseable body with exit 0 still created the
      // session (the host said so) — report it under the requested tag.
      return {
        ok: true,
        id: record?.id ?? null,
        tag: record?.tag ?? opts.tag,
        liveRefusal: false,
        error: null,
      };
    }
    if (isAplexerStartRefusal(res.exitCode, res.stderr)) {
      return { ok: false, id: null, tag: null, liveRefusal: true, error: res.stderr.trim() };
    }
    return {
      ok: false,
      id: null,
      tag: null,
      liveRefusal: false,
      error: res.stderr.trim() || res.stdout.trim() || `a start exited ${res.exitCode}`,
    };
  }

  /**
   * Kill the session [id]. `notFound` is the ordinary stale-list race, not
   * an error worth alarming over — the caller reports "already gone".
   */
  async killSession(connectionId: string, id: string): Promise<AplexerKillOutcome> {
    let res;
    try {
      res = await this.ssh.exec(connectionId, pathAwareCommand(aplexerKillCommand(id)));
    } catch (e) {
      return { ok: false, notFound: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
    if (isAplexerNotFound(res.exitCode, res.stderr)) {
      return { ok: false, notFound: true, error: `"${id}" is not running on this host any more.` };
    }
    return {
      ok: false,
      notFound: false,
      error: res.stderr.trim() || res.stdout.trim() || `a kill exited ${res.exitCode}`,
    };
  }

  /** Rename the session [id] to [tag] within its workspace. */
  async renameSession(
    connectionId: string,
    id: string,
    tag: string,
  ): Promise<AplexerRenameOutcome> {
    let res;
    try {
      res = await this.ssh.exec(
        connectionId,
        pathAwareCommand(aplexerRenameCommand(id, tag)),
      );
    } catch (e) {
      return { ok: false, notFound: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
    if (isAplexerNotFound(res.exitCode, res.stderr)) {
      return { ok: false, notFound: true, error: 'That session is not running any more.' };
    }
    return {
      ok: false,
      notFound: false,
      error: res.stderr.trim() || res.stdout.trim() || `a rename exited ${res.exitCode}`,
    };
  }

  /** Snapshot as session rows, in the host's order. [] on any failure — see {@link listSessions}. */
  private async snapshotSummaries(
    connectionId: string,
    sort?: AplexerSortKey,
  ): Promise<SessionSummary[]> {
    const records = await this.snapshotRecords(connectionId, sort);
    const rows = records.map(aplexerRecordToSummary);
    if (rows.length > 0) {
      log('sessions', `listed via aplexer: [${rows.map((s) => s.name).join(', ')}]`);
    }
    return rows;
  }
}

/**
 * Parse `a start --json`'s single-record body.
 *
 * `start` prints one object, not the snapshot's array; rather than a second
 * record parser, reuse the array one by wrapping — with a direct-parse
 * fallback for a body that is already an object but wrapped in shell noise
 * the brackets would corrupt. The first non-empty JSON-looking line wins.
 */
function parseSingleAplexerRecord(stdout: string): AplexerSessionRecord | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    const records = parseAplexerSnapshot(JSON.stringify([parsed]));
    return records.at(0) ?? null;
  } catch {
    return null;
  }
}
