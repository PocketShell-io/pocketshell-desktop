/**
 * The aplexer session manager — shared identity, wire shape, and join command.
 *
 * aplexer (`a`) is the MAIN session manager on hosts that have it; raw tmux
 * (via the `pocketshell` helper and `tmuxctl`) is the fallback for hosts that
 * do not. The two models are deliberately different shapes — tmux names one
 * flat global namespace, aplexer addresses `workspace + tag` with an immutable
 * UUID underneath — so this module is the one place that translates between
 * them. See docs/ARCHITECTURE.md §3.
 *
 * This file is renderer-safe: pure types and string builders only, no Node,
 * no ssh2. The exec-level client lives in main (`helper/AplexerClient.ts`)
 * and the JSON parsing in `helper/aplexerParsers.ts`.
 */

import { USER_BIN_PATH } from './userBinPath';
import { shellQuote, shellQuoteRemotePath } from './shellQuote';

/** Which runtime owns a session row. Absent on a row means `'tmux'`. */
export type SessionBackend = 'tmux' | 'aplexer';

/**
 * One element of `a snapshot --json`: the machine-readable session record.
 *
 * Only the fields this app reads are modelled. The full schema is versioned
 * host-side (`schemas/session-v1.schema.json` in the aplexer repo);
 * `worker_alive` is NOT persisted — the snapshot enriches each record with it
 * (a worker killed without recording an exit leaves `phase: 'running'`
 * forever, so liveness is `phase` AND `worker_alive`, never `phase` alone).
 */
export interface AplexerSessionRecord {
  /** Immutable internal id (UUID). Stable across renames — the join key. */
  id: string;
  /** Canonical workspace path. The folder-grouping key, no inference needed. */
  workspace: string;
  /** Human discriminator within the workspace. Shown as the session name. */
  tag: string;
  /** Declared engine (`shell`, `claude`, `codex`, `opencode`, `grok`, …). */
  engine: string;
  /** Profile id, when the session was started with one. Often absent. */
  profile?: string | null;
  /** The directory the workload runs in. Falls back to `workspace`. */
  cwd?: string | null;
  /** Persisted fact: what the worker last wrote. */
  phase: string;
  /** Derived liveness for the persisted phase. Absent on older hosts. */
  worker_alive?: boolean;
  /** Epoch milliseconds of creation. */
  created_at_ms: number;
  /** Epoch milliseconds of last PTY activity. May be absent. */
  last_activity_ms?: number;
}

/** A session is attachable only while its worker is alive and its phase is not terminal. */
export function isAplexerSessionLive(record: Pick<AplexerSessionRecord, 'phase' | 'worker_alive'>): boolean {
  if (record.worker_alive === false) return false;
  switch (record.phase) {
    case 'starting':
    case 'running':
    case 'exiting':
      return true;
    default:
      return false;
  }
}

/**
 * The `workspace:tag` selector `a` itself prints (`SessionRecord.selector()`).
 * Human addressing only — machine calls in this app prefer the UUID, which
 * survives renames while a selector names the name being changed.
 */
export function aplexerSelector(workspace: string, tag: string): string {
  return `${workspace}:${tag}`;
}

/**
 * Build the join command for an aplexer session inside the session PTY.
 *
 * The shape mirrors {@link sessionAttachCommand} on purpose: the same
 * subshell-scoped PATH widening (the `a` binary lives in `~/.local/bin`, which
 * a PTY login shell does not always have), a labelled `||` diagnostic so a
 * failed join never reads as a no-op click, and a trailing `exit` so the tab's
 * shell dies with the join (see the "why the join ends with exit" note on
 * {@link sessionAttachCommand}).
 *
 * The join is by UUID when [id] is known — renames change the tag, never the
 * id, so an id join cannot be orphaned the way a name join can — and by
 * `--workspace/--tag` otherwise. `a attach` repaints the live screen
 * tmux-style on reattach, so there is no socket sweep and no second arm: one
 * spelling reaches every session the snapshot lists.
 */
export function aplexerAttachCommand(options: {
  /** Immutable session id. Preferred; survives renames. */
  id?: string | null;
  /** Canonical workspace. Required when [id] is absent. */
  workspace?: string | null;
  /** Tag within the workspace. Required when [id] is absent. */
  tag?: string | null;
}): string {
  const { id, workspace, tag } = options;
  // A blank workspace must stay blank (fail closed: `a` refuses it) rather
  // than degrading to `$HOME` the way `shellQuoteRemotePath` reads blanks —
  // attaching to the wrong workspace's same-named tag is the one failure this
  // join must never produce. In practice the id arm above always runs: the
  // renderer carries the snapshot UUID for every aplexer row it shows.
  const workspaceArg =
    workspace != null && workspace.trim() !== ''
      ? shellQuoteRemotePath(workspace)
      : shellQuote(workspace ?? '');
  const target = id != null && id !== '' ? shellQuote(id) : `--workspace ${workspaceArg} --tag ${shellQuote(tag ?? '')}`;
  const label = tag ?? workspace ?? id ?? 'session';
  const failure =
    '\\n[PocketShell] could not join session %s. ' +
    'The aplexer session is gone, or `a` is not installed on this host any more.\\n';
  return (
    `( PATH="${USER_BIN_PATH}:$PATH"; a attach ${target} ) || ` +
    `printf '${failure}' ${shellQuote(label)}; exit`
  );
}
