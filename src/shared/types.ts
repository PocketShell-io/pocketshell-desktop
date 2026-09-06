/**
 * Shared types crossing the main/renderer IPC boundary.
 *
 * These are the ONLY values that ever leave the main process. Private keys
 * and passphrases never appear here — the renderer holds opaque
 * {@link ConnectionId}s and parsed results only.
 */

/** Opaque handle for a live SSH connection in the main process. */
export type ConnectionId = string;

/** Opaque handle for a live PTY shell opened on a connection. */
export type ShellId = string;

/** A host parsed from ~/.ssh/config or entered manually. */
export interface HostEntry {
  /** Friendly name from the `Host` directive, or a generated one. */
  name: string;
  hostname: string;
  port: number;
  user: string;
  /** Absolute path to the private key, or null for agent/default. */
  identityFile: string | null;
  /** Jump host alias, if `ProxyJump` was set. */
  proxyJump: string | null;
  /** ForwardAgent yes/no. */
  forwardAgent: boolean;
  /** Raw `LocalForward`/`RemoteForward` lines, parsed lazily. */
  localForwards: ForwardSpec[];
  remoteForwards: ForwardSpec[];
  /** True if this entry came from ~/.ssh/config (vs manual entry). */
  fromConfig: boolean;
}

/** A single port-forward rule. */
export interface ForwardSpec {
  kind: 'local' | 'remote' | 'dynamic';
  /** Listening side. For local/dynamic: this machine; remote: the host. */
  listenHost: string;
  listenPort: number;
  /** Destination for -L/-R. Empty for dynamic (SOCKS). */
  destHost: string;
  destPort: number;
}

/** Result of an exec over SSH. Never thrown on non-zero exit. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Outcome of a connect attempt. Never throws. */
export interface ConnectResult {
  ok: boolean;
  connectionId?: ConnectionId;
  error?: string;
}

/** Bootstrap probe result for a connected host. */
export interface BootstrapResult {
  pocketshell: ToolState;
  /**
   * The binary the session-join command invokes (src/shared/attachCommand.ts).
   * Separate from `pocketshell` because a host can have one without the other,
   * and it is this one that decides whether clicking a session works.
   */
  tmuxctl: ToolState;
  tmux: ToolState;
  /**
   * The aplexer CLI (`a`) — the MAIN session manager when present.
   * Absent means the tmux path below serves every session; nothing warns,
   * because that fallback is complete, not degraded.
   */
  aplexer: ToolState;
  installer: 'uv' | 'pipx' | null;
  daemonRunning: boolean | null;
  daemonEnabled: boolean | null;
}

export interface ToolState {
  installed: boolean;
  /** Absolute path from `command -v`, when installed. */
  path: string | null;
  version: string | null;
}

/**
 * How a tmux session is classified — the desktop mirror of the phone's
 * `SessionAgentKind` (shared/ui-kit/.../model/SessionAgentKind.kt).
 *
 * Epic #821: the durable answer lives **host-side** as the per-session tmux
 * user option `@ps_agent_kind`, written by the `pocketshell agent` wrapper at
 * launch (`record_agent_kind` in the helper's `agents.py`). Reading that
 * option back is therefore the *authoritative* classification — no process
 * sniffing, no output parsing, and it survives reconnect / app restart
 * because tmux session options live for the life of the session.
 *
 * `probing` / `exited` are the phone's transient detector states. The desktop
 * runs no detector, so nothing in the main process emits them today; they are
 * listed so the renderer's badge switch is exhaustive against the same enum
 * the phone renders.
 */
export type SessionAgentKind =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'grok'
  | 'shell'
  | 'probing'
  | 'exited'
  | 'unknown';

/**
 * One row of `pocketshell env list --json` for a folder (FEATURES.md F16):
 * the key's NAME and which env file it was read from — never its value, which
 * the helper's write-only default keeps off the wire until `env get` names it
 * explicitly.
 */
export interface EnvVarRow {
  /** The env file the row came from (`.env` or `.envrc`). */
  file: string;
  /** Whether the key currently has a value set (it can exist empty). */
  hasValue: boolean;
  key: string;
}

/** A tmux session row from `pocketshell sessions list`. */
export interface SessionSummary {
  name: string;
  /** Epoch seconds of creation. */
  created: number;
  /** Epoch seconds of last activity. */
  activity: number;
  attached: boolean;
  /** Working directory if reported, else null. */
  path: string | null;
  /**
   * Which runtime owns this row. `'tmux'` is the default and is also what an
   * absent field means — every fixture, cache, and test written before
   * aplexer landed is a tmux row without saying so.
   */
  backend?: 'tmux' | 'aplexer';
  /**
   * The aplexer workspace (canonical path) and tag. `name` carries the tag,
   * so display, tab identity, and rename labelling work unchanged; these two
   * are the ADDRESS the join/kill/rename commands aim at, because a tag alone
   * is unique only within its workspace. `path` carries the workspace too
   * (falling back to the workload cwd), which is what files the row under its
   * folder with no inference. Set only when `backend === 'aplexer'`.
   */
  workspace?: string | null;
  tag?: string | null;
  /**
   * The aplexer session's immutable UUID. Stable across renames — the join,
   * kill, and rename all prefer it over `workspace:tag` when it is known.
   * Set only when `backend === 'aplexer'`.
   */
  aplexerId?: string | null;
  /**
   * The aplexer profile the session was started with, when one was selected.
   * Display only; the launch dialog does not read it back.
   */
  profile?: string | null;
  /**
   * The persisted aplexer phase (`running`, `exited`, …). Display only; the
   * row is listed only while its worker is alive, so this is context rather
   * than a liveness signal the UI must interpret.
   */
  aplexerPhase?: string | null;
  /**
   * Recorded agent kind from the host-side `@ps_agent_kind` tmux user option,
   * or null when the option is absent/unrecognised — a session we did not
   * launch (the phone surfaces those as "Unknown" plus a kind picker).
   *
   * Optional so a host that yields no companion data at all (tmux missing,
   * probe failed) still produces valid rows.
   */
  agentKind?: SessionAgentKind | null;
  /**
   * True when `path` was not reported for this session and was adopted from a
   * SIBLING session whose name is a prefix of this one — `git-dtc-website-import`
   * taking `~/git/dtc-website` from `git-dtc-website`.
   *
   * It exists so the guess is legible rather than silent. The folder workspace
   * keys everything on the folder, so a session with no path has nowhere to
   * live at all; adopting a sibling's path is what
   * keeps it reachable, and this flag is what lets the UI say the placement is
   * inferred instead of implying certainty it does not have.
   */
  pathInferred?: boolean;
  /**
   * The repository this session's working directory belongs to, when that is
   * NOT the directory itself — i.e. when the session runs in a linked git
   * WORKTREE.
   *
   * Set only for worktrees; absent for an ordinary checkout at any depth. It is
   * what the session panel GROUPS by, so a worktree of `~/git/dtc-website`
   * files under `dtc-website` rather than under its own directory name.
   *
   * `path` is deliberately left alone. Grouping is about where work belongs
   * conceptually; `path` is where the process actually stands, and it is what
   * the Files tab opens at — a user who opens files from a worktree session
   * must get the worktree's contents, not the main checkout's.
   */
  repoRoot?: string | null;
}

/**
 * One item to stage as a prompt attachment.
 *
 * The two variants are the two ways a user attaches something: a
 * clipboard paste (bytes already in memory) and a picked or dropped
 * file (a local path we can stream from). Both land in the same remote
 * directory under the same naming scheme — see AttachmentStager.
 */
export type AttachmentSource =
  | {
      kind: 'bytes';
      /** Raw file bytes. Structured-cloned across the IPC boundary. */
      data: Uint8Array;
      /** Suggested filename, when the clipboard offered one. */
      name?: string | null;
      /** Mime type, e.g. 'image/png'. Used only to default a missing extension. */
      mimeType?: string | null;
    }
  | {
      kind: 'file';
      /** Absolute path on this machine; streamed to the remote, never read into memory. */
      path: string;
      /** Overrides the path's basename as the display name, when set. */
      name?: string | null;
      mimeType?: string | null;
    };

/**
 * Outcome of staging a batch of attachments. Never thrown.
 *
 * A partial failure resolves with `ok: false` AND a populated `paths` —
 * those files DID upload and must still be attached (Android issue
 * #570). Only an empty `paths` means nothing landed.
 */
export interface StageAttachmentsResult {
  /** True only when every source uploaded. */
  ok: boolean;
  /** Tilde-form remote paths, e.g. `~/.pocketshell/attachments/main/20260824-101500-01-shot.png`. */
  paths: string[];
  /** How many sources failed. */
  failedCount: number;
  /** Present whenever `ok` is false; safe to show to the user. */
  error?: string;
}

/** Connection state surfaced to the UI. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'lost';

/**
 * One answer to "is there a newer release?" — the desktop port of the
 * phone's ReleaseChecker result, with the same three-way contract: a failure
 * is an ANSWER (with a reason), never a silent null that a network blip and a
 * genuinely-current install both collapse into.
 *
 * Nothing here self-installs. `available` carries the browser download URL
 * of the asset that matches THIS platform/arch, and opening it is the user's
 * act.
 */
export interface ReleaseAssetInfo {
  /** Direct download URL (the browser asset, not the API URL). */
  downloadUrl: string;
  /** The GitHub release page — the "release notes" link. */
  notesUrl: string;
  /** The upstream tag, shown verbatim (e.g. `v0.1.3`). */
  tagName: string;
}

export type UpdateCheckResult =
  | ({ status: 'available'; currentVersion: string } & ReleaseAssetInfo)
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'failed'; reason: string; currentVersion: string };

/** A cols×rows pair, as two ends of the terminal geometry conversation see it. */
export interface GridSize {
  cols: number;
  rows: number;
}

/**
 * One answer to "what does tmux believe the geometry behind this shell is?"
 *
 * The three kinds are deliberately not collapsible into a nullable size,
 * because the renderer's reconcile loop has to treat them differently:
 *
 *   - `bare` — the shell is not a tmux client this pool holds (a bare-shell
 *     tab, an evicted one). There is nothing to check, ever; the renderer
 *     stops probing.
 *   - `dead` — the pool holds a client but tmux could not be asked about it
 *     (the handshake variable never published, the client detached, the
 *     server died, the exec failed). This is the state whose honest naming
 *     matters most: swallowed into a null it is indistinguishable from
 *     healthy agreement, and a pane whose repair path has quietly died sits
 *     garbled forever. The renderer counts these and re-joins.
 *   - `ok` — both quantities, measured. `client` is the size of OUR client's
 *     tty (what `resize` set — the thing our grid must equal);
 *     `window` is the size of the tmux window the client is showing, which
 *     `window-size latest` moves when another client drives the session.
 *     The window is at most one row shorter than the client: that row is
 *     tmux's status line, when the session runs with it on.
 */
export type GeometryProbe =
  | { kind: 'bare' }
  | { kind: 'dead' }
  | { kind: 'ok'; client: GridSize; window: GridSize };
