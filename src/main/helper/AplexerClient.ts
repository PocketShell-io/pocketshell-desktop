/**
 * Client for the aplexer session manager (`a`) on the remote host.
 *
 * The method bodies, outcome shapes, and capability caches live in the SHARED
 * core (`shared/aplexerClientCore.ts`) — the browser's `aplexer/client` runs
 * the exact same code against its own transport, so the two clients cannot
 * drift about what to ask the host or how to read its answers. What remains
 * here is the desktop shell: one core per connection, exec by connectionId,
 * and the main-process log line.
 *
 * aplexer is the MAIN session manager wherever it is installed; the tmux
 * path (`PocketshellClient`, raw tmux through the helper) is the fallback for
 * hosts without it.
 */

import type { SshService } from '../ssh/SshService.js';
import type { SessionSummary } from '../../shared/types.js';
import type {
  AplexerSessionRecord,
  AplexerSortKey,
  AplexerWarning,
} from '../../shared/aplexer.js';
import { APLEXER_LIST_SORT } from '../../shared/aplexer.js';
import {
  AplexerCore,
  type AplexerAckOutcome,
  type AplexerKillOutcome,
  type AplexerRenameOutcome,
  type AplexerStartOutcome,
} from '../../shared/aplexerClientCore.js';
import {
  aplexerAckCommand,
  aplexerProbeCommand,
  aplexerSnapshotCommand,
  aplexerStartCommand,
  aplexerKillCommand,
  aplexerRenameCommand,
  aplexerWarningsCommand,
  isAplexerAckNotFound,
  isAplexerNotFound,
  isAplexerStartRefusal,
  isAplexerUnknownFlag,
  pathAwareCommand,
} from '../../shared/aplexerCommands.js';
import { log } from '../log.js';

// The command builders and sentence classifiers are shared code now
// (`shared/aplexerCommands.ts`); re-exported here so the helper's existing
// importers — tests included — keep one import path.
export {
  aplexerAckCommand,
  aplexerProbeCommand,
  aplexerSnapshotCommand,
  aplexerStartCommand,
  aplexerKillCommand,
  aplexerRenameCommand,
  aplexerWarningsCommand,
  isAplexerAckNotFound,
  isAplexerNotFound,
  isAplexerStartRefusal,
  isAplexerUnknownFlag,
  pathAwareCommand,
};
export type {
  AplexerAckOutcome,
  AplexerKillOutcome,
  AplexerRenameOutcome,
  AplexerStartOutcome,
};

export class AplexerClient {
  /** One shared core per connection; it owns the capability caches. */
  private readonly cores = new Map<string, AplexerCore>();

  constructor(private readonly ssh: SshService) {}

  /** Forget cached per-connection state. Call on disconnect. */
  evict(connectionId: string): void {
    this.cores.get(connectionId)?.evict();
    this.cores.delete(connectionId);
  }

  /** Is `a` installed on this connection's host? Cached per connection. */
  async isAvailable(connectionId: string): Promise<boolean> {
    return this.core(connectionId).isAvailable();
  }

  /** Live sessions in the host's own order, or null when `a` is absent. */
  async listSessions(
    connectionId: string,
    sort: AplexerSortKey = APLEXER_LIST_SORT,
  ): Promise<SessionSummary[] | null> {
    return this.core(connectionId).listSessions(sort);
  }

  /** The raw snapshot records, or [] on any failure. Never throws. */
  async snapshotRecords(
    connectionId: string,
    sort?: AplexerSortKey,
  ): Promise<AplexerSessionRecord[]> {
    return this.core(connectionId).snapshotRecords(sort);
  }

  /** Find one live record by workspace+tag. Null when absent or unknown. */
  async findSession(
    connectionId: string,
    workspace: string,
    tag: string,
  ): Promise<AplexerSessionRecord | null> {
    return this.core(connectionId).findSession(workspace, tag);
  }

  /** All live tags in [workspace] — the client-side free-name walk's input. */
  async liveTags(connectionId: string, workspace: string): Promise<Set<string> | null> {
    return this.core(connectionId).liveTags(workspace);
  }

  /** Start a shell session for [workspace] under [tag]. Never throws. */
  async startSession(
    connectionId: string,
    opts: { workspace: string; tag: string },
  ): Promise<AplexerStartOutcome> {
    return this.core(connectionId).startSession(opts);
  }

  /** Kill the session [id]. `notFound` is the ordinary stale-list race. */
  async killSession(connectionId: string, id: string): Promise<AplexerKillOutcome> {
    return this.core(connectionId).killSession(id);
  }

  /** Rename the session [id] to [tag] within its workspace. */
  async renameSession(
    connectionId: string,
    id: string,
    tag: string,
  ): Promise<AplexerRenameOutcome> {
    return this.core(connectionId).renameSession(id, tag);
  }

  /** Every unacknowledged crash/OOM warning, newest first, or []. */
  async listWarnings(connectionId: string): Promise<AplexerWarning[]> {
    return this.core(connectionId).listWarnings();
  }

  /** Acknowledge warnings: the whole list when [target] is null, else one. */
  async ackWarnings(connectionId: string, target?: string): Promise<AplexerAckOutcome> {
    return this.core(connectionId).ackWarnings(target);
  }

  /** The connection's core, created on first use with the desktop transport. */
  private core(connectionId: string): AplexerCore {
    const existing = this.cores.get(connectionId);
    if (existing) return existing;
    const core = new AplexerCore(
      {
        exec: (command: string) => this.ssh.exec(connectionId, command),
      },
      (rows) => log('sessions', `listed via aplexer: [${rows.map((s) => s.name).join(', ')}]`),
    );
    this.cores.set(connectionId, core);
    return core;
  }
}
