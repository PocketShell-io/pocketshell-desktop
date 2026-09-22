/**
 * The aplexer client's brain, shared by BOTH clients: the total contracts,
 * the per-connection capability caches, and the never-throw method bodies.
 *
 * A client differs from its sibling only in HOW an exec happens — the desktop
 * addresses one SshService by connectionId, the browser runs one SshConnection
 * per host — so this core takes the exec as a one-method transport and both
 * wrappers stay thin. Every method is total: it resolves a result object or an
 * empty list, never throws for anything the host does.
 *
 * Identity discipline: the UUID is the stable selector for kill/rename
 * (renames change the tag, never the id, so an id can never be orphaned the
 * way a name can). `start` is the one call with no id yet and addresses
 * `workspace + tag`, which the host enforces as unique among live sessions.
 */

import type { SessionSummary } from './types';
import type { AplexerSessionRecord, AplexerSortKey, AplexerWarning } from './aplexer';
import { APLEXER_LIST_SORT } from './aplexer';
import {
  aplexerAckCommand,
  aplexerKillCommand,
  aplexerProbeCommand,
  aplexerRenameCommand,
  aplexerSnapshotCommand,
  aplexerStartCommand,
  aplexerWarningsCommand,
  isAplexerAckNotFound,
  isAplexerNotFound,
  isAplexerStartRefusal,
  isAplexerUnknownFlag,
  pathAwareCommand,
} from './aplexerCommands';
import {
  aplexerRecordToSummary,
  byOldestCreated,
  parseAplexerSnapshot,
  parseAplexerWarnings,
  parseSingleAplexerRecord,
} from './aplexerParsers';

/** The one thing a transport must answer: `exitCode` null = never reached one. */
export interface AplexerExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The one thing the core needs from a connection. */
export interface AplexerTransport {
  exec(command: string): Promise<AplexerExecOutcome>;
}

/** Outcome of {@link AplexerCore.startSession}. Never thrown. */
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

/** Outcome of {@link AplexerCore.killSession}. Never thrown. */
export interface AplexerKillOutcome {
  ok: boolean;
  /** True when the session was already gone — the ordinary stale-list race. */
  notFound: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerCore.renameSession}. Never thrown. */
export interface AplexerRenameOutcome {
  ok: boolean;
  notFound: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerCore.ackWarnings}. Never thrown. */
export interface AplexerAckOutcome {
  ok: boolean;
  /** True when the target matched nothing — another client acked first. */
  notFound: boolean;
  error: string | null;
}

export class AplexerCore {
  /**
   * `a` present on this host. Null means "not asked yet"; false means "asked
   * and it is absent". Remembering the negative matters as much as the
   * positive: a host without aplexer must pay one probe per CONNECTION, not
   * one per five-second poll tick.
   */
  private available: boolean | null = null;

  /**
   * `--sort` support, same discipline as the availability probe: true after
   * one sorted snapshot answered, false after the CLI refused the flag (an
   * old host — every tick then goes straight to the unsorted exec), unknown
   * until one of those happens.
   */
  private sortSupported: boolean | null = null;

  constructor(
    private readonly transport: AplexerTransport,
    /** Desktop main-process log line when a listing answered; the browser passes nothing. */
    private readonly onListed?: (rows: SessionSummary[]) => void,
  ) {}

  /** Forget cached per-host state. Call on disconnect. */
  evict(): void {
    this.available = null;
    this.sortSupported = null;
  }

  /**
   * Is `a` installed on this host? Cached, never throws — a host that
   * cannot be asked is a host without aplexer.
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    let available = false;
    try {
      const res = await this.transport.exec(pathAwareCommand(aplexerProbeCommand()));
      available = res.exitCode === 0 && res.stdout.trim().length > 0;
    } catch {
      available = false;
    }
    this.available = available;
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
  async listSessions(sort: AplexerSortKey = APLEXER_LIST_SORT): Promise<SessionSummary[] | null> {
    if (!(await this.isAvailable())) return null;
    const records = await this.snapshotRecords(sort);
    const rows = records.map(aplexerRecordToSummary);
    if (rows.length > 0) this.onListed?.(rows);
    return rows;
  }

  /**
   * The raw snapshot records, or [] on any failure. Never throws.
   *
   * With [sort], the sorted command is tried first and its DOCUMENT ORDER is
   * kept — that is the feature. When the host cannot do it yet (the flag is
   * refused, remembered for the connection) or the sorted exec dies
   * mid-flight, the unsorted snapshot answers and is sorted client-side, so
   * the order a host without the flag sees is the one it always saw.
   */
  async snapshotRecords(sort?: AplexerSortKey): Promise<AplexerSessionRecord[]> {
    if (sort !== undefined && this.sortSupported !== false) {
      try {
        const res = await this.transport.exec(pathAwareCommand(aplexerSnapshotCommand(sort)));
        if (res.exitCode === 0) {
          this.sortSupported = true;
          return parseAplexerSnapshot(res.stdout);
        }
        // Remember the refusal only when it IS one: a usage error means every
        // future tick would fail the same way, while any other non-zero exit
        // may be a one-off not worth pinning the connection to the fallback.
        if (isAplexerUnknownFlag(res.stderr)) {
          this.sortSupported = false;
        }
      } catch {
        // Transport-level: fall through to the unsorted attempt this tick;
        // the capability stays unknown and the next tick asks again.
      }
    }
    try {
      const res = await this.transport.exec(pathAwareCommand(aplexerSnapshotCommand()));
      if (res.exitCode !== 0) return [];
      return byOldestCreated(parseAplexerSnapshot(res.stdout));
    } catch {
      return [];
    }
  }

  /** Find one live record by workspace+tag. Null when absent or unknown. */
  async findSession(
    workspace: string,
    tag: string,
  ): Promise<AplexerSessionRecord | null> {
    const records = await this.snapshotRecords();
    return records.find((r) => r.workspace === workspace && r.tag === tag) ?? null;
  }

  /** All live tags in [workspace] — the client-side free-name walk's input. */
  async liveTags(workspace: string): Promise<Set<string> | null> {
    if (!(await this.isAvailable())) return null;
    const records = await this.snapshotRecords();
    return new Set(records.filter((r) => r.workspace === workspace).map((r) => r.tag));
  }

  /**
   * Start a shell session for [workspace] under [tag].
   *
   * The caller checks liveness first (snapshot); a `liveRefusal` covers the
   * race where the pair went live between that check and this exec. Anything
   * else non-zero is a real failure with the host's own sentence.
   */
  async startSession(opts: { workspace: string; tag: string }): Promise<AplexerStartOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerStartCommand(opts.workspace, opts.tag)));
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
  async killSession(id: string): Promise<AplexerKillOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerKillCommand(id)));
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
  async renameSession(id: string, tag: string): Promise<AplexerRenameOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerRenameCommand(id, tag)));
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

  /**
   * Every unacknowledged crash/OOM warning on this host, newest first, or []
   * on any failure. Never throws, and [] on a host without `a` — the same
   * total contract as the snapshot, because a warning list the renderer can
   * be denied is a crash it can be denied, and the one thing this endpoint
   * exists to prevent. The availability gate rides the cache the listing
   * warms, so a tmux-only host pays no exec for this per poll tick.
   */
  async listWarnings(): Promise<AplexerWarning[]> {
    if (!(await this.isAvailable())) return [];
    try {
      const res = await this.transport.exec(pathAwareCommand(aplexerWarningsCommand()));
      if (res.exitCode !== 0) return [];
      return parseAplexerWarnings(res.stdout);
    } catch {
      return [];
    }
  }

  /**
   * Acknowledge warnings: the whole list when [target] is null, else the one
   * whose session UUID it is. `notFound` is the benign race — the warning
   * was acked from another client between the banner's render and this
   * click — not an error worth alarming over.
   */
  async ackWarnings(target?: string): Promise<AplexerAckOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerAckCommand(target)));
    } catch (e) {
      return { ok: false, notFound: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
    if (isAplexerAckNotFound(res.exitCode, res.stderr)) {
      return { ok: false, notFound: true, error: null };
    }
    return {
      ok: false,
      notFound: false,
      error: res.stderr.trim() || res.stdout.trim() || `a ack exited ${res.exitCode}`,
    };
  }
}
