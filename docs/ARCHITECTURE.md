# PocketShell Desktop — Architecture

How the Electron app is structured: process boundaries, module layout,
the terminal model, state, and security.

---

## 1. Process model

Standard hardened Electron: three processes.

```
┌─────────────────────────────┐   contextBridge   ┌──────────────────────────┐
│  Renderer (Vue 3, sandboxed)│ ◀──────────────▶ │  Preload (trusted)        │
│  - views, components, Pinia  │   window.api      │  - typed IPC surface      │
│  - xterm.js, CodeMirror      │                   └────────────┬─────────────┘
└─────────────────────────────┘                                │ ipcRenderer
                                                               │
┌──────────────────────────────────────────────────────────────▼──────────────┐
│  Main (Node, privileged — the only process that touches ssh2/keys/fs)        │
│  - SshService, SftpService, ForwardService, TmuxClientPool, AplexerClient     │
│  - SshConfigParser, KnownHosts, PocketshellClient                            │
│  - ConnectionRegistry (connection id → live ssh2 Client)                      │
│  - PortfwdStore (electron-store); NO keychain — see the rule below           │
│  - ipcMain handlers                                                          │
└─────────────────────────────────────────────────────────────┬───────────────┘
                                                              │ ssh2 (TCP/SSH)
                                                              ▼
                                              ┌────────────────────────────┐
                                              │  Remote dev box            │
                                              │  aplexer, or tmux +        │
                                              │  pocketshell helper        │
                                              └────────────────────────────┘
```

**Rules:**
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- The renderer **never** imports `ssh2`, `fs`, `net`, or sees private keys.
  It only calls typed methods on `window.api` and receives results /
  streams.
- All connections live in the main process, keyed by an opaque `connectionId`
  the renderer holds.
- Passphrases are **not stored at all**: one is supplied with a connect
  call, used by `ssh2`, and forgotten; the OS-keychain option (`keytar`)
  was removed as dead weight — a year-long dependency nothing imported.

---

## 2. Module layout

```
src/
├─ main/
│  ├─ index.ts                 # app/window lifecycle, registers ipc handlers
│  ├─ ipc.ts                   # ipcMain.handle registrations (the API surface)
│  ├─ log.ts                   # main-process file log
│  ├─ windowState.ts           # window size/position/maximized across launches
│  ├─ attachments/             # composer attachments: staging, name sanitising, mime, retention
│  ├─ helper/                  # PocketshellClient (`pocketshell <cmd>` over an exec
│  │                           # channel), bootstrap (PATH probe + install), parsers
│  ├─ portfwd/
│  │  ├─ Forwarder.ts          # one -L/-R/-D forward (ssh2 forwardOut/forwardIn)
│  │  ├─ ForwardService.ts     # per-connection forward lifecycle: manual + auto rules
│  │  ├─ AutoForwarder.ts      # scan loop + mirror/allocate (extends Android local-only)
│  │  ├─ PortScanner.ts        # ss -tlnp -> netstat -> ss output parsing
│  │  ├─ scanRemotePorts.ts    # remote listener-scan command assembly + merge
│  │  ├─ serveCommand.ts       # "serve this folder": command/port/URL construction (pure)
│  │  ├─ ServeService.ts       # "serve this folder": execution + output classification
│  │  └─ PortfwdStore.ts       # electron-store: forward rules
│  ├─ preview/                 # document preview of remote HTML/markdown/SVG (URL<->path safety)
│  ├─ projects/                # project-folder-first sessions: folder pick, clone, name derivation
│  ├─ sftp/SftpService.ts      # list/read/write/mkdir/rename/delete/upload/download
│  ├─ ssh/
│  │  ├─ SshService.ts         # connect/exec/tail/shell/close (ssh2 wrapper)
│  │  ├─ ConnectionRegistry.ts # connectionId -> Client + metadata
│  │  ├─ ShellTracker.ts       # live PTY shells by shellId (renderer never holds the channel)
│  │  └─ TmuxClientPool.ts     # per-session tmux clients; LRU cap, channel budget
│  ├─ ssh-config/              # SshConfigParser (~/.ssh/config -> HostEntry[]),
│  │                           # KnownHosts (verify against known_hosts, TOFU)
│  └─ update/ReleaseChecker.ts # GitHub Releases poll -> newer / current / failed
├─ preload/index.ts            # contextBridge.exposeInMainWorld('api', ...)
├─ shared/                     # types + pure logic both processes import: types,
│                              # channels, reconnectBackoff, shellQuote, composer*, ...
└─ renderer/
   ├─ main.ts, App.vue         # Vue app bootstrap
   ├─ router.ts                # host-picker / host-workspace / folder-workspace
   ├─ ipc.ts                   # typed wrapper over window.api
   ├─ parseStall.ts, xtermWriteBuffer.ts  # xterm stall watchdog + write-loop
   │                                      # repair (§9.1)
   ├─ terminalPaths.ts, terminalLinks.ts  # path detection + click -> Files tab
   ├─ stores/                  # Pinia: connection, sessions, shells, files, projects,
   │                           # agents (usage rows), composer, forwards, settings, update
   ├─ views/                   # HostPicker, HostWorkspace, FolderWorkspace, Files, Usage,
   │                           # PortPanel, EnvPanel, Settings, session placeholder/redirect
   └─ components/              # TerminalView (xterm.js), SessionTree, FileTree,
                               # CodeEditor (CodeMirror), PromptComposer, OverlayPanel, ...
```

Two `tsconfig.json`s: `tsconfig.node.json` (main + preload, `@types/node`)
and `tsconfig.web.json` (renderer, DOM libs). A shared `tsconfig.base.json`
holds strict options.

---

## 3. The terminal model — aplexer first, helper-driven attach beneath

The Android app speaks the full `tmux -CC` control-mode protocol itself
(per-pane VT rendering). The desktop port deliberately does **not** re-port
that. Instead it attaches to persistent sessions over a tracked SSH shell
channel, and the sessions themselves come from **aplexer** wherever the host
has it (`a`), with the tmux helper path as the fallback:

1. The session tree is fetched from `a snapshot --json` over normal SSH exec
   channels (fast, cheap, pollable). On a host with aplexer the snapshot is
   the WHOLE list — no tmux rows are merged beside it (merging used to list
   every session twice: once under its workspace, once as a name-only row
   from the tmux side that could not be placed, which is where the tree's
   `other` bucket came from). aplexer addresses `workspace + tag` under an
   immutable UUID, so its workspace is the folder-grouping key with no
   inference, and its declared engine/profile replaces the `@ps_agent_kind`
   probe. On a host without `a`, the legacy path runs instead:
   `pocketshell sessions list` preferred, `tmux list-sessions` beneath it.
2. The first visit to a session mounts an `xterm.js` and opens a tracked SSH
    **shell** channel. The channel runs the session join — `a attach <id>`
   for an aplexer session, the helper-driven tmux join otherwise;
   the far end's real layout renders in the terminal and owns the panes.
3. Each visited session tab keeps its own terminal mounted. Switching tabs is
   therefore a renderer visibility change, not a remote switch or repaint.
4. Input goes over the PTY (`shell.stdin.write`); resize calls
   `shell.setWindow(cols, rows)`.
5. For resumable AI conversations, the tree offers `pocketshell sessions
   resume <id>` which creates a capped tmux session and attaches it the
   same way.

`TmuxClientPool` keeps one client per visited session tab, keyed beneath the
SSH connection — by session name for tmux, by `workspace:tag` for aplexer,
whose tags repeat across workspaces. Attach requests on one connection are serialized so PTYs that
are still opening count toward the channel budget. The session-list enrichment
result is retained as an attach hint: when present, the tmux join tries that socket
directly, with the socket sweep and `tmuxctl` kept as a stale-hint fallback.
When no cached hint is available, the optional tmux-server locator runs after
the PTY channel opens and updates the client in the background, so opening a
tab does not wait for another SSH round trip. An aplexer join needs neither:
one `a attach` spelling reaches every session the snapshot lists, by UUID,
and reattach repaints the live screen on its own — so redraw is a no-op and
the geometry probe answers `bare`. A connection keeps at most six
live tab clients and evicts the least-recently-used tab beyond that. If `ssh2`
reports a channel-open refusal, one LRU client is released and the PTY request
is retried once; unrelated PTY errors still reach the terminal as errors.

**Why not control mode?** Its per-pane structured state is valuable on a
phone, less so on a big desktop where tiled tmux is perfectly readable.
Attach is ~70% less protocol code — no VT-escape un-decoding, no `%output`
demuxer — and it satisfies the requirement: *click a tree node → see the
terminal/session view*. Control mode can return later as an additive
"Per-pane" tab without rewrites.

**PTY contract (matches the Android app):** term `xterm-256color`, initial
80×24, resized via `setWindow`. The shell channel's stdout → xterm.js
`write`; xterm.js `onData` → shell stdin. The six-client ceiling leaves room
on the same SSH connection for exec, SFTP, and forwarding channels.

Paths printed by remote tools are linkified from the terminal buffer and
open in the Files tab (`terminalPaths.ts` holds the detection rules,
`terminalLinks.ts` the buffer flattening and click handling); the span
stays on the path itself — writer labels like `Write(...)` and trailing
punctuation are excluded. A `file:///` URL is the same link wearing a
scheme: the detector strips the scheme and opens the path (the file is on
the SSH host, so it must not travel to a browser) while underlining the
whole URL; `file://host/…` and any http(s) URL are left alone — web links
belong to WebLinksAddon and are never extended across a row break. A path
a TUI split across rows (this pane is always a tmux client, so nothing is
ever flagged `isWrapped`) is reconstructed from geometry — hard wrap,
box-gutter continuation, break at a hyphen or slash inside the token —
each shape anchored on
a tail token that is itself a path by the detector's standard (rooted,
`file:///`, or a relative one with two or more slashes — one slash is
`and/or` prose), so prose rows never glue together. The fit arithmetic ("the continuation would not have fitted") is
measured against the render width inferred from the fullest row of the
surrounding block — blank rows bound the block, and fill-rule decoration
drawn to the pane's width is refused — not against the pane's live width:
tmux keeps rows painted at the width they were rendered at, so a resized
window proves nothing about the margins those rows were written under.
The highlight is two layers: the hover underline from the link
provider, and an at-rest block tint (`terminalPathHighlights.ts`) that
re-derives decorations for every row the renderer touches, so a path
reads as one highlighted span at rest even when the remote CLI's own
underline stopped at its first row; the tint is each theme's selection
colour solidified over the terminal ground. The pane spends almost its
whole life on the alternate buffer — the tmux attach client is itself a
full-screen program that opens with `smcup` — and the tint renders there
all the same: xterm paints a decoration's background into the active
buffer's cell spans on either buffer (`registerDecoration` is
proposed-API, so the renderer constructs the terminal with
`allowProposedApi`).

---

## 4. SSH service contract

`SshService` mirrors the Android `RealSshSession` surface, adapted to
`ssh2`'s event model:

| Method | Behaviour |
|---|---|
| `connect(cfg): Promise<connectionId>` | publickey auth; 30s timeout; `keepaliveInterval=15`; verifies host key via `KnownHosts`. Never throws — returns a result object; non-ready is an error result. |
| `exec(connectionId, cmd): Promise<ExecResult>` | `{stdout, stderr, exitCode}`. **No throw on non-zero exit** (exit codes are semantic: `command -v`, `tmux has-session`). |
| `tail(connectionId, path, fromLine, onLine): TailHandle` | spawns `tail -F -n +N '<path>'`; swallows transport drops; the caller (reconnect FSM) re-launches on a new connection. |
| `shell(connectionId, {term, cols, rows}): Promise<ShellHandle>` | PTY shell; `ShellHandle { stdin, stdout, setWindow, close }`. |
| `close(connectionId)` | idempotent; cancels tails, closes forwards/shells, disconnects. |

Key formats: `ssh2` parses PEM / OpenSSH-v1 / PKCS8 directly (ed25519 +
RSA). PuTTY `.ppk` via a parser if needed later. A passphrase is optional
connect-call input: the renderer supplies it with `connect`, main hands it
to `ssh2` once, and nothing stores it (§1).

---

## 5. Port forwarding

Extends the Android local-only model with the two forward types desktop
users expect:

- **Local `-L`**: `net.createServer` → per-conn `ssh.forwardOut`. The
  auto-forward loop (`AutoForwarder` + `PortScanner`) scans remote
  listeners and mirrors/allocates a local port — same algorithm as Android
  (mirror if port ∈ [1024, 10000], else allocate from [3000, 65535];
  failed-port TTL 60s, 5s scan interval).
- **Remote `-R`**: `ssh.forwardIn(remoteHost, remotePort)` → the server
  accepts and channels back via `tcpip` events.
- **Dynamic `-D` (SOCKS)**: a local SOCKS5 server (`socksv` style) that
  opens `ssh.forwardOut` per SOCKS request.

`ForwardService` owns the per-connection forward lifecycle; rules persist
in `PortfwdStore`, so manual toggles and persisted remappings survive
reconnects (unlike the Android in-memory-only manual toggles). Reconnect
itself is the renderer's job (§9): main only reports the drop, and after
the new connection is up a fresh scan rediscovers the forward set.

---

## 6. Files (SFTP)

`SftpService` over `ssh2`'s own sftp channel (`client.sftp()` →
`SFTPWrapper`; the long-unused `ssh2-sftp-client` dependency is gone):
`list`, `readFile`/`stat`, `createWriteStream`/`writeFile`,
`mkdir`, `rename`, `delete`, `fastPut`/`fastGet` (upload/download, with
progress events). The renderer's `CodeEditor` is CodeMirror 6 (Monaco was
considered and dropped); save calls `window.api.sftp.writeFile`. Binary
detection by extension + stat; images get an `<img>` preview with a zoom
bar — Fit / 100% / slider over a scrollable pane, pure arithmetic in
`src/renderer/imageZoom.ts` — other binary offers hex/download. HTML,
markdown and SVG are documents, not binaries: each opens with a
Preview/Source toggle over the sandboxed `psview:` frame served by
`src/main/preview/` — DESIGN.md §5.7b holds the reasoning.

Why not reuse the helper's `pocketshell env` for editing? It is scoped to
`.env`/`.envrc` and writes via stdin; general editing needs a real SFTP
channel. The env panel layers that secret-via-stdin safety on for the
`.env` case.

---

## 7. State management

Pinia stores in the renderer hold **view state only** — never secrets:

| Store | Holds |
|---|---|
| `connection` | active connectionId per host, connection/error state, bootstrap result, reconnect schedule |
| `sessions` | per-host `SessionSummary[]`, refresh state |
| `shells` | which live PTY (shellId) belongs to which session |
| `projects` | active host `$HOME`, SFTP folder browser, and repository loading state; cleared when the connection id changes |
| `files` | current path, tree cache, open file buffers |
| `agents` | per-pane detection, conversation events, usage rows |
| `composer` | per-session composer state: draft text, attachments, send state |
| `forwards` | per-host forward table + statuses |
| `settings` | fonts, theme, zoom, folder order, per-host root folders |
| `update` | release-check status behind the update banner |

Streams (terminal bytes, tail lines, forward bytes) are pushed from main
to renderer over IPC events keyed by id; the stores subscribe and the
components render.

---

## 8. Security model

- Renderer is sandboxed; no Node, no filesystem, no network primitives.
- Private keys never cross into the renderer; a passphrase travels one
  way, with the connect call, and is never stored. Only connection ids
  and parsed results come back.
- `~/.ssh/known_hosts` is **enforced** (unlike the Android `AcceptAll`):
  unknown host → TOFU prompt (accept once / always); mismatch → hard
  block. No silent accept.
- Provider credentials are never on the client (D19): usage/quota comes
  from the server-side `pocketshell usage`; repo browsing from `gh` on the
  host (D23).
- Logs redact secrets (the helper's `logs ingest` already does this).
- The committed `test_key` is a fixture used **only** by Docker tests.

---

## 9. Error + reconnect contract

- `SshService` operations return result objects, never throw for
  expected failures (auth refused, host unreachable, non-zero exit).
- A transport drop is reported to the renderer as a connection-state
  `'lost'` event. The connection store's FSM re-dials on the shared
  backoff (`shared/reconnectBackoff.ts`, 5→10→20→40→60s, capped at
  `MAX_ATTEMPTS`) and, on success, `connect()` re-runs bootstrap +
  session refresh + re-opens forwards. The banner shows the countdown;
  `retryNow()` skips the wait.
- Tails and shells are torn down on drop and re-established by their
  owners on the new connection (same contract as Android — tail does not
  self-heal).
- During replacement, the composer store rekeys its per-session records
  to the new connection id before it is published, so drafts and history
  survive the swap without a blank intermediate composer. Terminal
  re-attachment restores focus only when the visible pane already owns
  focus (or the document has no focused control), so a reconnect cannot
  redirect the next keystroke from the composer into xterm.

### 9.1 Terminal parse stalls

xterm's write loop is a `setTimeout` queue, and one failure class kills
it: a byte sequence that makes the parser throw — an xterm-internal
buffer invariant, exposed by region/scroll-heavy TUI output arriving
mid-fit (the xterm 6.0.0 `Buffer.resize`/write ordering bug behind
`start argument out of range`). The pane fed by that loop then silently
stops rendering; the error reaches the desktop log (`renderer/diag.ts`)
but looks like a one-off glitch.

`ParseStallMonitor` (`renderer/parseStall.ts`) wraps every chunk a
`TerminalView` feeds xterm with the completion callback xterm already
supports: no callback within two seconds (`PARSE_STALL_TIMEOUT_MS`) means
a dead loop, reported as `terminal-stall` with the session and
connection, buffer state (line count, baseY, cursor), the stalled bytes
in printable and hex form, and the queue behind them. The diag banner
shows the same report, so a frozen pane says so instead of just stopping.

Repair lives in `renderer/xtermWriteBuffer.ts`: every fit and chunk
checks the active core buffer's `lines.length >= ybase + core.rows`, and
an incomplete viewport gets the blank lines xterm's own resize path
appends, before the next chunk parses. It reads `_core.buffers.active`,
not the proposed `term.buffer` API — no `allowProposedApi`, parser state
preserved, no reset or repaint. A stall preceded by a thrown unhandled
error is parser death: `resumeWriteBufferAfterError` restarts the loop
(dead chunk retired, backlog re-parses), then the pane does a bounded
fresh join under the same anti-hammer budget as a dead geometry probe.
Tests: `tests/unit/xtermWriteBuffer.test.ts` drives the real
`@xterm/headless` internals through the identical sync-throw path;
`scripts/xterm-fuzz.mjs` is the fuzzer that found the original invariant
break (seed 32) and the tool to rerun when upgrading xterm.
