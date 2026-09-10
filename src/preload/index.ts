import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron';
import { ipc } from '../shared/channels.js';
import type { GeometryProbe, UpdateCheckResult } from '../shared/types';
import type { SyncApplyResult, SyncPullResult, SyncPushResult, SyncStatus } from '../shared/sync.js';
import type { ZoomCommand } from '../shared/zoomKeys.js';
import type {
  AttachmentSource,
  BootstrapResult,
  ConnectionState,
  ConnectResult,
  EnvVarRow,
  ExecResult,
  HostEntry,
  SessionSummary,
  ShellId,
  StageAttachmentsResult,
} from '../shared/types.js';
import type { UsageRow } from '../main/helper/usageParsers.js';
import type { DirEntry, FileStat, TransferProgress } from '../main/sftp/SftpService.js';
import type { RemotePort } from '../main/portfwd/PortScanner.js';
import type { ForwardState } from '../main/portfwd/Forwarder.js';
import type { AutoForwarderStatus, DiscoveredPort } from '../main/portfwd/AutoForwarder.js';
import type { PortIntent } from '../main/portfwd/PortfwdStore.js';
import type { ForwardSpec } from '../shared/types.js';
import type {
  AplexerSessionRef,
  CloneProgress,
  CloneResult,
  CreateFolderRequest,
  CreateFolderResult,
  HomeResult,
  ReposCloneOptions,
  ReposListRequest,
  ReposListResult,
  KillSessionResult,
  RenameSessionResult,
  StartSessionRequest,
  StartSessionResult,
} from '../main/projects/ProjectsService.js';

/**
 * The typed API surface exposed to the renderer as `window.api`.
 *
 * The renderer is sandboxed (contextIsolation: true, nodeIntegration: false),
 * so this is the ONLY way it can reach the main process. No Node primitives,
 * no ssh2, no filesystem, no keys ever cross this bridge — only the typed
 * values in src/shared/types.ts.
 */

/** Listener deregistrator returned by event subscriptions. */
export type Unsubscribe = () => void;

/**
 * The one subscription shape every `on*` wrapper below shares: register a
 * listener that drops the IpcRendererEvent and hands the payload to
 * [handler], return the unsubscribe closure. Spelled once so copy number ten
 * cannot get the cleanup subtly wrong.
 */
function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_evt: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  win: {
    /**
     * Set the OS window title. Fire-and-forget on purpose — see the channel
     * comment in src/shared/channels.ts. Build the string with the shared
     * `windowTitle()` so every caller formats identity the same way.
     */
    setTitle: (title: string): void => {
      ipcRenderer.send(ipc.win.setTitle, title);
    },

    /** Open or focus the dedicated Account & sync window. */
    openAccount: (): Promise<void> => ipcRenderer.invoke(ipc.win.openAccount),

    /**
     * Scale the whole renderer. `factor` is a multiplier, 1 being unzoomed.
     *
     * `webFrame`, not an IPC round-trip to `webContents.setZoomFactor`, and
     * the difference is not style. This is SYNCHRONOUS: the layout is dirty
     * before the call returns, so the terminal's re-fit — which runs on the
     * next animation frame — is guaranteed to measure the new viewport rather
     * than racing an IPC reply and fitting to the old one. `webFrame` is one
     * of the modules a sandboxed preload keeps (verified on this Electron, not
     * assumed: setting 1.5 moves devicePixelRatio 2 -> 3 and window.innerWidth
     * 987 -> 658, and reads back as 1.5).
     *
     * Fire-and-forget like `setTitle`, for the same reason: there is no result
     * worth awaiting, and the caller is a watcher on a settings value.
     */
    setZoom: (factor: number): void => {
      webFrame.setZoomFactor(factor);
    },

    /**
     * Subscribe to zoom chords the main process caught before the page could
     * see them (see src/shared/zoomKeys.ts). The payload is an INTENT, not a
     * value: the renderer owns the number. Returns an unsubscribe fn.
     */
    onZoomCommand: (handler: (command: ZoomCommand) => void): Unsubscribe =>
      subscribe(ipc.win.zoomCommand, handler),
  },

  app: {
    /**
     * The OS resumed from sleep (main's `powerMonitor` 'resume', wired in
     * main/index.ts). Payload-free — the fact itself is the message. Returns
     * an unsubscribe fn.
     */
    onResumed: (handler: () => void): Unsubscribe =>
      subscribe(ipc.app.resumed, handler),
  },

  ssh: {
    /** Read ~/.ssh/config into HostEntry rows. Empty if no config. */
    listConfigHosts: (): Promise<HostEntry[]> => ipcRenderer.invoke(ipc.ssh.listConfigHosts),

    /**
     * Connect; resolves a ConnectResult (never rejects).
     *
     * Pass `hostAlias: entry.name` whenever the host came from
     * `~/.ssh/config`. Port-forward preferences (friendly port names, local
     * remaps, on/off intents) are persisted under the alias when it is
     * present and under `user@host:port` when it is not — so omitting it for
     * a config host silently re-keys that host's saved state to its current
     * IP, and loses it the day the IP changes.
     */
    connect: (payload: {
      host: string;
      port?: number;
      user: string;
      /** The `~/.ssh/config` `Host` alias (`HostEntry.name`), when there is one. */
      hostAlias?: string;
      privateKeyPath?: string;
      privateKey?: string;
      passphrase?: string;
      tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
    }): Promise<ConnectResult> => ipcRenderer.invoke(ipc.ssh.connect, payload),

    /** Execute a command; no throw on non-zero exit. */
    exec: (connectionId: string, command: string): Promise<ExecResult> =>
      ipcRenderer.invoke(ipc.ssh.exec, connectionId, command),

    /** Close a connection. */
    close: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.ssh.close, connectionId),

    /**
     * Subscribe to connection-state changes. Fires `'lost'` when the
     * transport drops underneath us and `'idle'` on a clean disconnect, so
     * the UI can distinguish "your link died" from "you clicked disconnect".
     * Returns an unsubscribe function.
     */
    onState: (
      listener: (payload: { connectionId: string; state: ConnectionState }) => void,
    ): (() => void) => subscribe(ipc.ssh.state, listener),
  },

  shell: {
    /**
     * Open a tracked PTY shell (optionally running a command like
     * `tmux attach -t main`). Stdout bytes arrive via onShellData; the
     * returned ShellId addresses the shell for input/resize/close.
     */
    open: (payload: {
      connectionId: string;
      command?: string;
      cols?: number;
      rows?: number;
    }): Promise<ShellId> => ipcRenderer.invoke(ipc.shell.open, payload),

    /**
     * Show a session in this connection's terminal.
     *
     * The reply is deliberately NOT a bare ShellId. Main keeps one attached
     * client per visited session tab and may hand back the shell that tab
     * already owns. `switched: true` says that happened, and the caller must
     * leave its terminal alone: the existing client still owns the screen
     * and a reset would drop the modes it set.
     *
     * `backend` + `workspace`/`tag`/`aplexerId` address an aplexer session:
     * a tag alone is unique only within its workspace, so the join (and the
     * pool key behind it) needs the workspace. Absent backend means tmux.
     */
    attachSession: (payload: {
      connectionId: string;
      sessionName: string;
      cols?: number;
      rows?: number;
      backend?: 'tmux' | 'aplexer';
      workspace?: string;
      tag?: string;
      aplexerId?: string;
    }): Promise<{ shellId: ShellId; switched: boolean }> =>
      ipcRenderer.invoke(ipc.shell.attachSession, payload),

    /**
     * Write input bytes to a shell's stdin (xterm.js -> remote).
     *
     * `sessionName` is an optional fence for callers whose write is part of a
     * sequence — pass the session the write is FOR, and main refuses (returns
     * false) if the pooled shell is no longer associated with that session.
     * Without it the bytes go to whatever the shell is showing, which is what
     * a live keystroke from the focused pane wants. `workspace` narrows the
     * fence for aplexer sessions, whose tags repeat across workspaces.
     */
    input: (shellId: ShellId, data: string, sessionName?: string, workspace?: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.shell.input, shellId, data, sessionName, workspace),

    /** Resize a shell's PTY. */
    resize: (shellId: ShellId, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke(ipc.shell.resize, shellId, cols, rows),

    /**
     * Ask the tmux client on the far end to repaint every cell.
     *
     * A resize only makes tmux repaint when the size CHANGED, and it never
     * repaints rows it does not believe it owns — which is precisely the band
     * of stale text below the status line this exists to clear. Resolves false
     * when there is no tmux client to refresh (a bare shell, an evicted tab);
     * that is a normal answer, not a failure.
     */
    redraw: (shellId: ShellId): Promise<boolean> =>
      ipcRenderer.invoke(ipc.shell.redraw, shellId),

    /**
     * Ask tmux what geometry IT believes is behind this shell, as two
     * measured quantities — our client's tty size, and the tmux window that
     * tty is showing — plus an honest verdict on whether tmux could be asked
     * at all. Read-only: no resize, no repaint, no bytes into the pane.
     *
     * This is the noticing half of the stale-geometry repair — the far end can
     * move the window under us (`window-size latest`, a second client such as
     * the phone becoming latest) without anything on this side changing, and
     * `resize`'s own change-detection then correctly sends nothing forever.
     * `bare` means there is nothing to ask (a shell this pool never opened —
     * a bare-shell tab, an evicted one); `dead` means the pool holds a client
     * but tmux would not answer, which the renderer must hear about as a
     * failure rather than read as agreement.
     */
    windowSize: (shellId: ShellId): Promise<GeometryProbe> =>
      ipcRenderer.invoke(ipc.shell.windowSize, shellId),

    /** Close a shell. */
    close: (shellId: ShellId): Promise<boolean> => ipcRenderer.invoke(ipc.shell.close, shellId),

    /** Subscribe to terminal stdout bytes. Returns an unsubscribe fn. */
    onData: (handler: (payload: { shellId: ShellId; data: Uint8Array }) => void): Unsubscribe =>
      subscribe(ipc.shell.data, handler),

    /** Subscribe to shell-exit events. Returns an unsubscribe fn. */
    onExited: (
      handler: (payload: { shellId: ShellId; exitCode: number }) => void,
    ): Unsubscribe => subscribe(ipc.shell.exited, handler),
  },

  helper: {
    /** Run the bootstrap probe (pocketshell / tmux / installer / daemon). */
    bootstrap: (connectionId: string): Promise<BootstrapResult> =>
      ipcRenderer.invoke(ipc.helper.bootstrap, connectionId),

    /** List live tmux sessions. */
    sessionsList: (
      connectionId: string,
      sortBy?: 'activity' | 'created',
    ): Promise<SessionSummary[]> =>
      ipcRenderer.invoke(ipc.helper.sessionsList, connectionId, sortBy),

    /**
     * Create a detached tmux session under an EXPLICIT name.
     *
     * Prefer `projects.startSession` — it derives the name from the folder the
     * way the phone and `tmuxctl` do, so all three clients agree on which
     * session belongs to which folder. Use this only when the exact tmux name
     * is already known.
     */
    sessionsCreate: (connectionId: string, name: string, cwd: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.helper.sessionsCreate, connectionId, name, cwd),

    /** Provider usage/quota rows. */
    usage: (connectionId: string): Promise<UsageRow[]> =>
      ipcRenderer.invoke(ipc.helper.usage, connectionId),
  },

  /**
   * Project-folder-first session creation.
   *
   * Three routes, one destination: pick an EXISTING folder, create a NEW empty
   * one, or CLONE a GitHub repo — then `startSession` on the resulting path.
   * The session name is derived from the folder, never typed.
   *
   * Browsing for the existing folder uses the `sftp` surface above:
   * `projects.home()` for the starting point, then `sftp.list(path)` filtered
   * to `type === 'dir'`.
   */
  projects: {
    /** Resolve the remote `$HOME` — the browse root and the name-derivation input. */
    home: (connectionId: string): Promise<HomeResult> =>
      ipcRenderer.invoke(ipc.projects.home, connectionId),

    /**
     * Preview the session name a folder would get (`~/git/pocketshell` ->
     * `git-pocketshell`). Base name only — no `-2` suffix, which only the host
     * can decide at create time.
     */
    deriveName: (connectionId: string, folder: string, customName?: string): Promise<string> =>
      ipcRenderer.invoke(ipc.projects.deriveName, connectionId, folder, customName),

    /** Create a new empty project folder and get back its canonical path. */
    createFolder: (
      connectionId: string,
      request: CreateFolderRequest,
    ): Promise<CreateFolderResult> =>
      ipcRenderer.invoke(ipc.projects.createFolder, connectionId, request),

    /**
     * Local clones + the user's GitHub repos, merged by `fullName`.
     *
     * A host with no `gh`, or one that is not logged in, is a NORMAL state:
     * `remote.state` says which, `remote.repos` is empty, and the local list
     * is unaffected. Show a hint, not an error.
     */
    reposList: (connectionId: string, request?: ReposListRequest): Promise<ReposListResult> =>
      ipcRenderer.invoke(ipc.projects.reposList, connectionId, request),

    /**
     * Clone a GitHub repo. Slow — subscribe with `onCloneProgress` and pass a
     * `requestId` to correlate the started/finished events. An already-cloned
     * target resolves `{ ok: true, alreadyExists: true }` with its path, so the
     * caller can go straight on to `startSession`.
     */
    reposClone: (
      connectionId: string,
      request: ReposCloneOptions & { requestId?: string },
    ): Promise<CloneResult> => ipcRenderer.invoke(ipc.projects.reposClone, connectionId, request),

    /**
     * Start (or re-open) the session for a folder. Idempotent by default:
     * `reused: true` means a session for this folder was already open.
     * Pass `namePolicy: 'unique'` for a deliberate second session.
     */
    startSession: (
      connectionId: string,
      request: StartSessionRequest,
    ): Promise<StartSessionResult> =>
      ipcRenderer.invoke(ipc.projects.startSession, connectionId, request),

    /**
     * Rename a session. Never throws: a refused rename comes back
     * with `ok: false` and a `code` the UI can react to (`illegal-name`,
     * `name-taken`, `rename-failed`). Pass the row's aplexer ref (workspace
     * and/or id) when the row is aplexer-backed — a tag alone does not
     * address it.
     */
    renameSession: (
      connectionId: string,
      from: string,
      to: string,
      ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
    ): Promise<RenameSessionResult> =>
      ipcRenderer.invoke(ipc.projects.renameSession, connectionId, from, to, ref),

    /**
     * Kill a session. Never throws: `ok: false` with
     * `code: 'not-found'` means the session was already gone, which is the
     * ordinary outcome of a tab bar that refreshes on a timer, and
     * `code: 'kill-failed'` carries the host's own sentence.
     *
     * The only destructive call on this surface — confirm before reaching for
     * it. Pass the row's aplexer ref when the row is aplexer-backed.
     */
    killSession: (
      connectionId: string,
      name: string,
      ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
    ): Promise<KillSessionResult> =>
      ipcRenderer.invoke(ipc.projects.killSession, connectionId, name, ref),

    /** Subscribe to clone lifecycle events. Returns an unsubscribe fn. */
    onCloneProgress: (handler: (progress: CloneProgress) => void): Unsubscribe =>
      subscribe(ipc.projects.cloneProgress, handler),
  },

  sftp: {
    /** List directory entries. */
    list: (connectionId: string, path: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke(ipc.sftp.list, connectionId, path),

    /** Stat a path. Rejects if it does not exist. */
    stat: (connectionId: string, path: string): Promise<FileStat> =>
      ipcRenderer.invoke(ipc.sftp.stat, connectionId, path),

    /** Read a file as UTF-8 text. Use `readBinary` for anything that is not text. */
    readFile: (connectionId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(ipc.sftp.readFile, connectionId, path),

    /**
     * Read a remote file as raw bytes — what `readFile` cannot do, since
     * UTF-8 decoding turns every non-ASCII byte of a PNG into U+FFFD.
     * For images to annotate or preview, not for bulk transfer: main caps it
     * at 128 MiB (MAX_SFTP_READ_BYTES) however large a maxBytes the caller
     * passes — the 32 MiB default below is the DoodleCanvas-sized read — and
     * a file over the cap rejects rather than truncating.
     *
     * Rejects on a missing path, a non-regular file, or an oversized one.
     *
     * The bytes arrive as a plain `Uint8Array` (never a Node `Buffer` —
     * the prototype does not survive the structured clone, so the main
     * process copies into a Uint8Array before sending; `shell.onData`
     * already ships bytes this way).
     */
    readBinary: (connectionId: string, path: string, maxBytes?: number): Promise<Uint8Array> =>
      ipcRenderer.invoke(ipc.sftp.readBinary, connectionId, path, maxBytes),

    /** Write UTF-8 text to a file (overwrites). */
    writeFile: (connectionId: string, path: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.writeFile, connectionId, path, content),

    /**
     * Create a file, optionally with content. Refuses a name that is already
     * there — unlike `writeFile`, which overwrites by contract.
     */
    createFile: (connectionId: string, path: string, content?: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.createFile, connectionId, path, content ?? ''),

    /** Create a directory. */
    mkdir: (connectionId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.mkdir, connectionId, path),

    /** Rename/move a path. */
    rename: (connectionId: string, fromPath: string, toPath: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.rename, connectionId, fromPath, toPath),

    /** Delete a file. */
    deleteFile: (connectionId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.deleteFile, connectionId, path),

    /** Remove an empty directory. */
    rmdir: (connectionId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.sftp.rmdir, connectionId, path),

    /** Resolve a path to its absolute form (follows symlinks). */
    realPath: (connectionId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(ipc.sftp.realPath, connectionId, path),

    /** Upload a local file to a remote path, streaming progress. */
    upload: (payload: {
      connectionId: string;
      localPath: string;
      remotePath: string;
      transferId: string;
    }): Promise<boolean> => ipcRenderer.invoke(ipc.sftp.upload, payload),

    /** Download a remote file to a local path, streaming progress. */
    download: (payload: {
      connectionId: string;
      remotePath: string;
      localPath: string;
      transferId: string;
    }): Promise<boolean> => ipcRenderer.invoke(ipc.sftp.download, payload),

    /**
     * Download a remote file to a location the user picks in a native save
     * dialog. Resolves to the path written, or null if they cancelled.
     *
     * The Files tab's answer for everything it will not render. Unlike
     * `readBinary` this streams straight to disk, so it has no size ceiling.
     */
    saveAs: (payload: { connectionId: string; remotePath: string }): Promise<string | null> =>
      ipcRenderer.invoke(ipc.sftp.saveAs, payload),

    /** Subscribe to transfer-progress events. Returns an unsubscribe fn. */
    onProgress: (
      handler: (payload: { transferId: string } & TransferProgress) => void,
    ): Unsubscribe => subscribe(ipc.sftp.progress, handler),
  },

  /**
   * The Files tab's document preview — HTML files, SVG files, and markdown
   * rendered to HTML in main.
   *
   * Note what is NOT here: no way to read a preview's bytes, list its
   * directory, or change its root. The renderer receives a URL and puts it in
   * a sandboxed iframe; everything the frame is then allowed to reach is
   * decided in main by HtmlPreviewService, which is the only place that ever
   * sees the paths the previewed document names.
   */
  preview: {
    /**
     * Mint a preview of one remote HTML file. Rejects if the path is not a
     * regular file. The returned URL is on the `psview:` scheme and is only
     * usable while the token lives.
     */
    openHtml: (connectionId: string, path: string): Promise<{ token: string; url: string }> =>
      ipcRenderer.invoke(ipc.preview.openHtml, connectionId, path),

    /**
     * Mint a preview of one remote markdown file, rendered in main.
     *
     * [style] is the app's own design tokens, read out of computed style by the
     * caller — the palette cannot cross into the frame any other way, because a
     * custom property does not cascade through an iframe boundary and the
     * document is on a different origin. Main re-validates every value before
     * it reaches a stylesheet; see markdownDocument.ts.
     */
    openMarkdown: (
      connectionId: string,
      path: string,
      style: { palette: Record<string, string>; appearance: 'dark' | 'light' },
    ): Promise<{ token: string; url: string }> =>
      ipcRenderer.invoke(ipc.preview.openMarkdown, connectionId, path, style),

    /**
     * Mint a preview of one remote SVG file. Same shape and same guarantees
     * as {@link openHtml} — the bytes are served untouched at
     * `image/svg+xml`, and the frame's sandbox and CSP are what make a
     * document format that can carry script safe to show.
     */
    openSvg: (connectionId: string, path: string): Promise<{ token: string; url: string }> =>
      ipcRenderer.invoke(ipc.preview.openSvg, connectionId, path),

    /**
     * Revoke a preview. Fire-and-forget: it runs on the way out of a file,
     * where an awaited round trip would sit inside a close handler for no
     * observable gain, and a token that outlives its release by a few
     * milliseconds can still only read inside the folder it was scoped to.
     */
    release: (token: string): void => ipcRenderer.send(ipc.preview.release, token),

    /**
     * Subscribe to a preview's asset counters. Returns an unsubscribe fn.
     *
     * The counts are the whole reason the preview is honest rather than
     * merely pretty: a page missing its stylesheet and a page that genuinely
     * looks like that are indistinguishable on screen, and this is what tells
     * them apart.
     */
    onStats: (
      handler: (stats: {
        token: string;
        loaded: number;
        blocked: number;
        missing: number;
        capped: boolean;
      }) => void,
    ): (() => void) => subscribe(ipc.preview.stats, handler),
  },

  forwards: {
    /** One-shot remote port scan. */
    scan: (connectionId: string): Promise<RemotePort[]> =>
      ipcRenderer.invoke(ipc.forwards.scan, connectionId),

    /**
     * Start the auto-forwarder for a connection (idempotent).
     *
     * Pass the host's `~/.ssh/config` `LocalForward` lines as
     * `configForwards` (`HostEntry.localForwards`) to have them opened
     * alongside the scan loop, tagged `origin: 'ssh-config'`. Omit for a
     * manually-entered host, which has none.
     */
    startAuto: (connectionId: string, configForwards?: ForwardSpec[]): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.startAuto, connectionId, configForwards),

    /** Stop the auto-forwarder for a connection. */
    stopAuto: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.stopAuto, connectionId),

    /** Add a manual -L/-R/-D forward. */
    addManual: (connectionId: string, spec: ForwardSpec): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.addManual, connectionId, spec),

    /** Remove a forward by its key. */
    remove: (connectionId: string, key: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.remove, connectionId, key),

    /** Current snapshot for a connection. */
    list: (connectionId: string): Promise<ForwardState[]> =>
      ipcRenderer.invoke(ipc.forwards.list, connectionId),

    /**
     * Run one scan pass now, APPLYING the forward policy — the "Scan" button.
     * Unlike `scan`, which only lists ports, this opens and closes forwards.
     * A no-op when the auto-forwarder is not running.
     */
    refresh: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.refresh, connectionId),

    /**
     * Every port the last scan saw, annotated with whether it is forwarded,
     * its local port, intent, name, auto-eligibility and last error —
     * including ports we do NOT forward, so the panel can offer them.
     */
    discovered: (connectionId: string): Promise<DiscoveredPort[]> =>
      ipcRenderer.invoke(ipc.forwards.discovered, connectionId),

    /**
     * Scan health, so the panel can tell "idle" from "scan failing".
     * Null when no forwarder is running for this connection.
     */
    status: (connectionId: string): Promise<AutoForwarderStatus | null> =>
      ipcRenderer.invoke(ipc.forwards.status, connectionId),

    /** Set a port's friendly name; null or blank deletes it. Persisted per host. */
    setName: (connectionId: string, remotePort: number, name: string | null): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.setName, connectionId, remotePort, name),

    /** Pin a remote port to a specific local port. Persisted per host. */
    setRemap: (connectionId: string, remotePort: number, localPort: number): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.setRemap, connectionId, remotePort, localPort),

    /** Drop a pin, returning the port to mirror-then-allocate resolution. */
    clearRemap: (connectionId: string, remotePort: number): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.clearRemap, connectionId, remotePort),

    /** Force a port on, off, or (null) back to the automatic policy. Persisted. */
    setIntent: (
      connectionId: string,
      remotePort: number,
      intent: PortIntent | null,
    ): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.setIntent, connectionId, remotePort, intent),

    /** Flip a remote port between forwarded and silenced. Persisted. */
    togglePort: (connectionId: string, remotePort: number): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.togglePort, connectionId, remotePort),

    /**
     * Whether auto-forward was left enabled for this connection's host —
     * restore the panel's toggle from this on connect.
     */
    isAutoEnabled: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(ipc.forwards.isAutoEnabled, connectionId),

    /** Subscribe to forward-state snapshots. Returns an unsubscribe fn. */
    onStates: (
      handler: (payload: { connectionId: string; states: ForwardState[] }) => void,
    ): Unsubscribe => subscribe(ipc.forwards.states, handler),
  },

  attachments: {
    /**
     * Upload pasted bytes and/or picked files into
     * `~/.pocketshell/attachments/<scope>/` and get back the remote paths
     * to splice into the prompt text.
     *
     * Never rejects. On a partial batch `ok` is false but `paths` still
     * holds the files that DID upload — attach those and show `error`.
     */
    stage: (payload: {
      connectionId: string;
      scopeKey: string;
      sources: AttachmentSource[];
    }): Promise<StageAttachmentsResult> => ipcRenderer.invoke(ipc.attachments.stage, payload),

    /** Open the native file picker; resolves [] if the user cancelled. */
    pickFiles: (payload?: { title?: string; multiple?: boolean }): Promise<string[]> =>
      ipcRenderer.invoke(ipc.attachments.pickFiles, payload),

    /**
     * Read the bytes of a local file, so it can be drawn on before being
     * staged. Same 32 MiB cap as `sftp.readBinary`.
     *
     * `path` must be one `pickFiles` returned **in this session** —
     * anything else rejects, deliberately, without saying whether it
     * exists. That is the whole permission model: the main process will
     * read a file for you only if the user chose it in a native dialog.
     * A path from a previous run of the app is not readable either.
     *
     * Also rejects on a missing file, a non-regular file, or an
     * oversized one. Bytes arrive as a plain `Uint8Array`.
     */
    readLocal: (path: string): Promise<Uint8Array> =>
      ipcRenderer.invoke(ipc.attachments.readLocal, path),
  },

  agent: {
    /**
     * The engines this host's `pocketshell agent` lists, or **null** when the
     * host could not be asked. The two are not interchangeable: null means the
     * picker falls back to the engines the pinned helper guarantees, where an
     * empty array would mean a host that says it can launch nothing.
     */
    kinds: (connectionId: string): Promise<string[] | null> =>
      ipcRenderer.invoke(ipc.agent.kinds, connectionId),

    /** Agent config-dir profiles. */
    profiles: (connectionId: string): Promise<unknown[]> =>
      ipcRenderer.invoke(ipc.agent.profiles, connectionId),

    /** Env keys for a folder. */
    envList: (connectionId: string, dir: string): Promise<EnvVarRow[]> =>
      ipcRenderer.invoke(ipc.agent.envList, connectionId, dir),

    /**
     * Env values for a folder. Omit `keys` for the whole env; pass them to
     * reveal only some. (`pocketshell env get` has no "all keys" mode, so the
     * omitted case costs one extra `env list` round-trip on the host.)
     */
    envGet: (
      connectionId: string,
      dir: string,
      keys?: string[],
    ): Promise<Record<string, string>> =>
      ipcRenderer.invoke(ipc.agent.envGet, connectionId, dir, keys),

    /**
     * Set env values (a `{"KEY":"value"}` record). Rejects when the helper
     * refuses the write. The values are invoke ARGS here, which stops at
     * main; main hands them to `pocketshell env set` as a JSON object on the
     * command's STDIN, so they never appear in a process list on the host.
     */
    envSet: (connectionId: string, dir: string, values: Record<string, string>, file?: string): Promise<void> =>
      ipcRenderer.invoke(ipc.agent.envSet, connectionId, dir, values, file),
  },

  diag: {
    /**
     * Forward an unhandled renderer error to the desktop log. Fire-and-forget:
     * the reporter is already in a failed state, so this must not be able to
     * reject or block it further.
     */
    log: (entry: { kind: string; message: string; stack?: string; detail?: Record<string, unknown> }): void =>
      ipcRenderer.send(ipc.diag.log, entry),
  },
  update: {
    /** One poll of the repo releases; resolves to the three-way answer. */
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(ipc.update.check),
    /**
     * Open a validated release URL in the system browser. Main refuses
     * anything that is not this repo, see ipc.ts.
     */
    open: (url: string): Promise<void> => ipcRenderer.invoke(ipc.update.open, url),
  },
  sync: {
    /** Who is signed in (and keychain availability); no network, no tokens. */
    status: (): Promise<SyncStatus> => ipcRenderer.invoke(ipc.sync.status),
    /**
     * The PKCE browser round-trip; resolves to the signed-in email, rejects
     * with the reason (denied, timed out, no keychain). Tokens stay in main.
     */
    login: (): Promise<string | null> => ipcRenderer.invoke(ipc.sync.login),
    logout: (): Promise<void> => ipcRenderer.invoke(ipc.sync.logout),
    /**
     * Fetch a slot's blob, DECRYPTED with [passphrase] — the renderer's
     * session-memory passphrase, never persisted on either side.
     */
    pull: (slot: string, passphrase: string): Promise<SyncPullResult> =>
      ipcRenderer.invoke(ipc.sync.pull, slot, passphrase),
    /**
     * Encrypt [plaintext] with [passphrase] and store it. [baseVersion] is
     * the version the caller merged from (0 for a first write); a mismatch
     * comes back as a `conflict` result, not a rejection.
     */
    push: (slot: string, plaintext: string, passphrase: string, baseVersion: number): Promise<SyncPushResult> =>
      ipcRenderer.invoke(ipc.sync.push, slot, plaintext, passphrase, baseVersion),
    /** Append hosts missing from ~/.ssh/config; returns the aliases added. */
    applyHosts: (hosts: HostEntry[]): Promise<SyncApplyResult> =>
      ipcRenderer.invoke(ipc.sync.applyHosts, hosts),
  },
} as const;

export type Api = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error('Failed to expose api in the context bridge:', error);
  }
} else {
  // Fallback when context isolation is disabled (shouldn't happen in prod,
  // but keeps dev tooling from crashing if a flag is flipped).
  (window as unknown as { api: Api }).api = api;
}
