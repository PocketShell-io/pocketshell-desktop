# PocketShell Desktop — Architecture

How the Electron app is structured: process boundaries, the terminal model,
state, and security. The module layout lives in the tree below and in the
directory names themselves; this file's job is the decisions the tree cannot
show.

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
│  - ConnectionRegistry (connection id → live ssh2 Client)                      │
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

The directories under `src/` are the map: `main/` groups by domain (`ssh/`,
`sftp/`, `portfwd/`, `helper/`, `attachments/`, `preview/`, `projects/`,
`ssh-config/`, `update/`), `renderer/` is `stores/` + `views/` +
`components/`, `shared/` holds the types and pure logic both processes
import, `preload/` is the bridge. Two `tsconfig.json`s:
`tsconfig.node.json` (main + preload, `@types/node`) and
`tsconfig.web.json` (renderer, DOM libs), over a shared strict base.

The non-obvious residents, by name: `renderer/parseStall.ts` +
`xtermWriteBuffer.ts` are the xterm stall watchdog and write-loop repair
(§9.1); `terminalPaths.ts` / `terminalUrls.ts` / `terminalLinks.ts` are
terminal path and URL detection and click-to-Files; `terminalPane.ts` is the terminal pane's PTY-lifecycle
controller (§3's join model as code — the component decides when a PTY
opens, the controller does how); `reconnectLoop.ts` is the reconnect FSM's
schedule machinery, driven by the connection store (§9); `remotePaths.ts`
resolves printed or typed paths for the SFTP channel; `useWorkspaceMemory.ts`
holds the folder workspace's remembered tab state; `TmuxClientPool.ts` keeps
the per-tab PTY clients; the `helper/` client speaks `pocketshell <cmd>` over
exec channels and probes and installs itself on a host missing it.

---

## 3. The terminal model — aplexer first, helper-driven attach beneath

The Android app speaks the full `tmux -CC` control-mode protocol itself
(per-pane VT rendering). The desktop port deliberately does **not** re-port
that. Instead it attaches to persistent sessions over a tracked SSH shell
channel, and the sessions themselves come from **aplexer** wherever the host
has it (`a`), with the tmux helper path as the fallback:

1. The session tree is fetched from `a snapshot --json --sort accessed` over
   normal SSH exec
   channels (fast, cheap, pollable) — the host sorts the list (its own
   default; `a list --sort name|created|accessed|activity` is the surface)
   and the app keeps that order for the panel, falling back to a
   client-sorted unsorted snapshot on a host whose `a` predates the flag. On
   a host with aplexer the snapshot is
   the WHOLE list — no tmux rows are merged beside it (merging used to list
   every session twice: once under its workspace, once as a name-only row
   from the tmux side that could not be placed, which is where the tree's
   `other` bucket came from). aplexer addresses `workspace + tag` under an
   immutable UUID, so its workspace is the folder-grouping key with no
   inference, and its declared engine/profile replaces the `@ps_agent_kind`
   probe. On a host without `a`, the legacy path runs instead:
   `pocketshell sessions list` preferred, `tmux list-sessions` beneath it,
   both straightened to creation order.
   A session this app JUST created does not wait for a listing: the start
   result carries the row whole (name, folder, backend, aplexer UUID), the
   sessions store files it as a pending row, and the next refresh — the
   panel's five-second poll — replaces it with the authoritative one. The
   create path therefore spends no listing round trip between the click and
   the terminal.
2. The first visit to a session mounts an `xterm.js` and opens a tracked SSH
    **shell** channel. The channel runs the session join — `a attach <id>`
   for an aplexer session, the helper-driven tmux join otherwise;
   the far end's real layout renders in the terminal and owns the panes.
   The join IS its tab's channel: it runs directly under the PTY as the exec
   request's command — no login shell, no profile startup ahead of it, which
   was the join's largest fixed cost — and the channel closes when the join
   ends for any reason (a detach, a worker-side disconnect, a dead session, a
   failed join after its diagnostic). The pool drops the client through the
   ordinary `onExit`, and the next visit to the tab re-joins fresh — a tab
   can never outlive its attach into a live prompt parked behind a dead
   session. While the join runs, the pane says so — a muted "Joining …" veil
   that clears on the far end's first byte — instead of sitting black.
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
whole URL; `file://host/…` is refused, and any other scheme is left to
nobody. Web addresses (`http(s)://`) belong to WebLinksAddon — except a
URL the remote CLI's wrapper broke across rows, which the addon, reading
one row at a time, sees only as its first-row fragment. The same
reconstruction that heals paths rejoins the address (a `?` after a query
separator joins the break opportunities, and a tail that already ends
extension-shaped refuses the join — a finished URL must not pick up the
next sentence), `terminalUrls.ts` finds the address in the flattened
line, and that link is registered BEFORE the addon, which xterm's
priority rule lets claim every row of the URL; a single-row URL answers
nothing and stays the addon's. A path
a TUI split across rows (this pane is always a tmux client, so nothing is
ever flagged `isWrapped`) is reconstructed from geometry — hard wrap,
box-gutter continuation, break at a hyphen or slash inside the token —
each shape anchored on
a tail token that is itself a path by the detector's standard (rooted,
`file:///`, or a relative one with two or more slashes — one slash is
`and/or` prose), read past a `KEY="…` assignment the way the matcher
itself reads one, so prose rows never glue together. The fit arithmetic ("the continuation would not have fitted") is
measured against the render width inferred from the fullest row of the
surrounding block — blank rows bound the block, and fill-rule decoration
drawn to the pane's width is refused — not against the pane's live width:
tmux keeps rows painted at the width they were rendered at, so a resized
window proves nothing about the margins those rows were written under,
and a CLI that wraps its block at its own narrower width leaves every
continuation looking like it "had room" against the pane.
The highlight is two layers: the hover underline from the link
provider, and an at-rest block tint (`terminalPathHighlights.ts`) that
re-derives decorations for every row the renderer touches, so a path —
or a URL wrapped across rows — reads as one highlighted span at rest
even when the remote CLI's own
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

`SshService` mirrors the Android `RealSshSession` surface adapted to
`ssh2`'s event model. The three rules a caller must know:

- Operations return **result objects, never throw** for expected failures;
  `exec` does not throw on non-zero exit either — exit codes are semantic
  (`command -v`, `tmux has-session`).
- `tail` swallows transport drops and does **not** self-heal: the caller
  (the reconnect FSM) re-launches on the new connection.
- `close` is idempotent and cancels tails, shells and forwards.

Key formats: PEM / OpenSSH-v1 / PKCS8 via `ssh2` (ed25519 + RSA); a
passphrase travels one way, with the connect call (§1).

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
the new connection is up a fresh scan rediscovers the forward set. The
full decision record is `docs/PORTFWD.md`.

---

## 6. Files (SFTP)

`SftpService` over `ssh2`'s own sftp channel:
`list`, read/write, `mkdir`, `rename`, `delete`, `fastPut`/`fastGet` (with
progress). The renderer's `CodeEditor` is CodeMirror 6 (Monaco was
considered and dropped); save calls `window.api.sftp.writeFile`. Binary
detection by extension + stat; images get an `<img>` preview with a zoom
bar — Fit / 100% / slider over a scrollable pane, pure arithmetic in
`src/renderer/imageZoom.ts` — drag-to-pan with a grab cursor whenever the
zoomed picture exceeds the pane, and a Dark/Light backdrop toggle on the
canvas, for checking a picture against the ground its author assumed.
Other binary offers hex/download. HTML,
markdown and SVG are documents, not binaries: each opens with a
Preview/Source toggle over the sandboxed `psview:` frame served by
`src/main/preview/` — DESIGN.md §5.7b holds the reasoning.

Why not reuse the helper's `pocketshell env` for editing? It is scoped to
`.env`/`.envrc` and writes via stdin; general editing needs a real SFTP
channel. The env panel layers that secret-via-stdin safety on for the
`.env` case.

---

## 7. State management

The renderer is layered; each layer talks only to the one below:

- **Components** (`views/`, `components/`) render. Templates do not compute;
  input policy, gestures and focus are theirs.
- **Composables and controllers** (`usePaneWidth`, `useStripDrag`,
  `useWorkspaceMemory`, `terminalPane.ts`) own reusable reactive logic and
  per-surface machinery.
- **Pinia stores** (`stores/`) hold cross-component state — never secrets —
  one per domain (`connection`, `sessions`, `shells`, `projects`, `files`,
  `agents`, `composer`, `forwards`, `settings`, `sync`, `update`). Stores
  orchestrate their domain: the connection store drives the reconnect loop
  (§9), the files store runs the open/save pipelines over the SFTP bridge.
- **Plain TS modules** hold the extractable logic — `reconnectLoop.ts`,
  `remotePaths.ts`, `terminalLinks.ts`, `sessionTree.ts` and the rest — which
  is what keeps it unit-testable without Pinia and out of both stores and
  views.

Everything crosses to main through the one typed bridge: components import
`window.api` only as `src/renderer/ipc.ts`, whose type is the preload's
`Api`. A view or pane MAY call `api` directly for a self-contained concern no
other surface shares (UpdateBanner's open-the-release actions, a tree's
one-shot probe); anything two surfaces need goes through a store. Streams
(terminal bytes, tail lines, forward bytes) are pushed from main to renderer
over IPC events keyed by id; the stores subscribe and the components render.

The layering has teeth: CLEAN_CODE.md rule 12 is executed by
`tests/unit/designGates.test.ts`, which fails any component over 1000 lines
whose exemption is not recorded there with its extraction queue.

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
