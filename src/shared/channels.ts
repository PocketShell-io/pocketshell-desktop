/**
 * IPC channel names. Defined once here so main and preload agree and the
 * preload's typed surface stays in sync. The preload wraps these into a
 * typed `window.api` (see src/preload/index.ts).
 *
 * Convention: request/response channels use `<domain>:<verb>`; streaming
 * events (main -> renderer) use `<domain>:event:<name>` and carry a payload
 * keyed by the relevant id (connectionId / shellId).
 */

export const ipc = {
  /**
   * Window chrome. `setTitle` is the one renderer -> main channel that is
   * fire-and-forget (`ipcRenderer.send`, not `invoke`): a title update has no
   * result worth awaiting, and making the caller await it would put an IPC
   * round-trip inside a navigation watcher.
   */
  win: {
    setTitle: 'win:setTitle',
    /** Open or focus the dedicated Account & sync window. */
    openAccount: 'win:openAccount',
    /**
     * Main -> renderer: the user pressed a zoom chord. Carries the INTENT
     * ('in' | 'out' | 'reset'), never a zoom value, because main deliberately
     * does not know what the current zoom is — the renderer's settings store
     * is the only thing that does. See src/shared/zoomKeys.ts for why the
     * chords are recognised in main at all.
     */
    zoomCommand: 'win:event:zoomCommand',
  },
  app: {
    /**
     * Main -> renderer: the OS just resumed from sleep (Electron
     * `powerMonitor` 'resume'). Main cannot drive the reconnect itself — the
     * dialling lives in the renderer's connection store — so it only announces
     * the fact. The store answers with a liveness probe: a laptop that slept
     * is the classic silent-drop (the NAT/firewall table entry expired
     * overnight and the TCP link looks healthy until someone writes to it),
     * and ssh2's keepalive will not notice for up to ~45s of silence.
     */
    resumed: 'app:event:resumed',
  },
  ssh: {
    listConfigHosts: 'ssh:listConfigHosts',
    connect: 'ssh:connect',
    exec: 'ssh:exec',
    close: 'ssh:close',
    state: 'ssh:event:state', // event: ConnectionState per connectionId
  },
  shell: {
    open: 'shell:open', // open a PTY shell (optionally running a command)
    /**
     * Show a tmux session in this connection's terminal. Distinct from
     * `shell:open` because it is NOT necessarily a new PTY: main keeps one
     * attached tmux client per SESSION TAB (src/main/ssh/TmuxClientPool.ts),
     * so attaching to a tab whose client is still alive reuses it and the
     * reply carries the SAME shellId the renderer already holds.
     */
    attachSession: 'shell:attachSession',
    input: 'shell:input', // write bytes to a shell's stdin
    resize: 'shell:resize', // setWindow(cols, rows)
    /**
     * Ask the tmux client on the far end of a shell to repaint every cell.
     *
     * Separate from `resize` because the two answer different halves of one
     * question. A resize tells tmux how big we are; it only repaints when that
     * number CHANGED. Rows tmux has never owned — the band below its status
     * line after it had been drawing to a shorter screen — hold whatever the
     * renderer last put there, and no resize will ever clear them because from
     * tmux's point of view nothing moved. See TerminalView's `pushGeometry`.
     */
    redraw: 'shell:redraw',
    /**
     * Ask tmux what size IT believes the window behind this shell is, without
     * touching anything. The read-only half of `redraw`: the stale-geometry
     * failure starts when ANOTHER client of a shared session becomes
     * `window-size latest` and moves the window while nothing changes here,
     * and what cannot change locally cannot be noticed locally — so the
     * renderer asks. A shell with no tmux behind it answers `{ kind: 'bare' }`
     * and an evicted tab `{ kind: 'dead' }` — both normal, not errors (see
     * `GeometryProbe` in shared/types.ts).
     */
    windowSize: 'shell:windowSize',
    close: 'shell:close', // close a shell
    data: 'shell:event:data', // event: { shellId, data: Uint8Array }
    exited: 'shell:event:exited', // event: { shellId, exitCode }
  },
  helper: {
    bootstrap: 'helper:bootstrap',
    sessionsList: 'helper:sessionsList',
    /**
     * Create a session under an EXPLICIT name. The folder-first flow uses
     * `projects:startSession` instead, which derives the name from the folder;
     * this stays as the escape hatch for a caller that already knows the exact
     * tmux session name it wants.
     */
    sessionsCreate: 'helper:sessionsCreate',
    usage: 'helper:usage',
  },
  /**
   * Project-folder-first session creation: pick a folder (existing / new /
   * freshly cloned), and the session name is derived from it.
   */
  projects: {
    home: 'projects:home', // resolve the remote $HOME (browse root + name input)
    deriveName: 'projects:deriveName', // preview the name a folder would get
    createFolder: 'projects:createFolder', // mkdir -p a new empty project folder
    reposList: 'projects:reposList', // local clones + GitHub repos
    reposClone: 'projects:reposClone', // clone a GitHub repo, return its path
    startSession: 'projects:startSession', // folder-first session create
    /**
     * Rename a live tmux session. It sits under
     * `projects:` rather than `helper:` because the name it produces has to
     * obey the SAME derivation rules a folder-derived name obeys — the
     * sanitiser and the host-side uniqueness probe both live in that service.
     */
    renameSession: 'projects:renameSession',
    /**
     * Kill a live tmux session — the ONLY destructive
     * channel in this list. Beside `renameSession` for the same reason: both
     * address a session by the exact name the folder-first derivation produced,
     * and the `=`-anchored tmux target that makes that safe lives in
     * `main/projects/commands.ts` next to the rest of the session lifecycle.
     */
    killSession: 'projects:killSession',
    cloneProgress: 'projects:event:cloneProgress', // event: CloneProgress
  },
  sftp: {
    list: 'sftp:list',
    stat: 'sftp:stat',
    readFile: 'sftp:readFile', // UTF-8 text; mangles anything binary
    readBinary: 'sftp:readBinary', // raw bytes, size-capped (images, audio, pdf)
    writeFile: 'sftp:writeFile',
    createFile: 'sftp:createFile', // create-only; refuses a name already there
    mkdir: 'sftp:mkdir',
    rename: 'sftp:rename',
    deleteFile: 'sftp:deleteFile',
    rmdir: 'sftp:rmdir',
    realPath: 'sftp:realPath',
    upload: 'sftp:upload',
    download: 'sftp:download',
    saveAs: 'sftp:saveAs', // download to a location picked in a native dialog
    progress: 'sftp:event:progress', // event: { transferId, bytes, total? }
  },
  forwards: {
    scan: 'forwards:scan', // run a one-shot port scan, return RemotePort[]
    startAuto: 'forwards:startAuto', // start the auto-forwarder (+ ssh-config LocalForwards)
    stopAuto: 'forwards:stopAuto',
    addManual: 'forwards:addManual', // add a -L/-R/-D forward
    remove: 'forwards:remove', // remove a forward by key
    list: 'forwards:list', // current snapshot
    refresh: 'forwards:refresh', // one policy-applying scan pass now ("Scan" button)
    discovered: 'forwards:discovered', // DiscoveredPort[] — incl. ports we do NOT forward
    status: 'forwards:status', // AutoForwarderStatus | null — scan health
    setName: 'forwards:setName', // set/clear a port's friendly name (persisted)
    setRemap: 'forwards:setRemap', // pin a remote port to a local port (persisted)
    clearRemap: 'forwards:clearRemap', // drop a pin (persisted)
    setIntent: 'forwards:setIntent', // force-on / force-off / null (persisted)
    togglePort: 'forwards:togglePort', // flip a remote port forwarded <-> silenced
    isAutoEnabled: 'forwards:isAutoEnabled', // was auto left enabled for this host?
    states: 'forwards:event:states', // event: { connectionId, states[] }
  },
  /**
   * The Files tab's document preview. `openHtml` / `openMarkdown` /
   * `openSvg` mint a capability — a one-off token plus the `psview://` URL
   * to frame — and `release` revokes it, so a closed file's frame cannot go
   * on reading the host. See src/main/preview/HtmlPreviewService.ts.
   *
   * Three open verbs rather than one with a flag, because they do not take
   * the same arguments: markdown is converted in main and therefore needs the
   * app's palette, while an HTML or SVG file brings its own styling and must
   * not be given ours.
   */
  preview: {
    openHtml: 'preview:openHtml',
    openMarkdown: 'preview:openMarkdown',
    openSvg: 'preview:openSvg',
    release: 'preview:release',
    /**
     * Main -> renderer: how many assets that preview has loaded, refused as
     * outside its folder, or failed to find. The toolbar shows it, which is
     * what stops "this page has no stylesheet" being indistinguishable from
     * "this page looks like this".
     */
    stats: 'preview:event:stats',
  },
  attachments: {
    stage: 'attachments:stage', // upload pasted bytes / picked files, return ~/ display paths
    pickFiles: 'attachments:pickFiles', // native open dialog, returns local paths
    readLocal: 'attachments:readLocal', // bytes of a path pickFiles handed out THIS session
  },
  agent: {
    kinds: 'agent:kinds', // agent --help -> the engines this host can launch
    profiles: 'agent:profiles', // profiles list --json
    envList: 'agent:envList', // env list --dir --json
    envGet: 'agent:envGet',
    // The VALUE travels in the invoke args and crosses to the helper on the
    // command's stdin — never as a command-line argument (see SshService's
    // ExecOptions.stdin for why).
    envSet: 'agent:envSet',
  },
  /**
   * Renderer diagnostics. A packaged app has no console anyone can read, so an
   * unhandled renderer error used to vanish entirely: the component that died
   * mid-render just left a blank panel, with no reason anywhere on disk. The
   * renderer forwards such errors here; main writes them into the same desktop
   * log every SSH decision lands in, and the app shows its own strip
   * (renderer/diag.ts + DiagBanner) so the failure is visible, not swallowed.
   */
  diag: {
    log: 'diag:log', // send: { kind, message, stack?, detail? }
  },
  /**
   * Optional Google-login settings sync (docs/SYNC.md). The passphrase is a
   * per-call argument and is never persisted by either process; tokens live
   * in main behind safeStorage and are NOT part of this surface — the
   * renderer sees only the signed-in email.
   */
  sync: {
    status: 'sync:status', // SyncStatus — who is signed in, keychain state
    login: 'sync:login', // run the PKCE browser flow; resolves to the email
    logout: 'sync:logout', // forget tokens (and revoke the grant)
    pull: 'sync:pull', // (slot, passphrase) -> SyncPullResult (decrypted)
    push: 'sync:push', // (slot, plaintext, passphrase) -> SyncPushResult
    accountHosts: 'sync:accountHosts', // () -> HostEntry[] | null — the last copy decrypted this session
    applyHosts: 'sync:applyHosts', // HostEntry[] -> append missing to ~/.ssh/config
  },
  /**
   * Update check — the desktop port of the phone's ReleaseChecker: main polls
   * the repo's `releases/latest`, compares against the running version, and
   * hands the renderer a three-way answer (available / up-to-date / failed).
   * Nothing self-installs; `open` hands the asset URL to the system browser
   * and unpacking or installing is the user's act, exactly like the phone.
   */
  update: {
    check: 'update:check',
    /**
     * Open a release-asset or release-page URL in the system browser. Main
     * validates the URL against this repo's GitHub hosts before handing it
     * to the shell — the renderer is our code, but `shell.openExternal` is
     * the one bridge an XSS would drive straight off the machine.
     */
    open: 'update:open',
  },
} as const;
