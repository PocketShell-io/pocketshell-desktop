# PocketShell Desktop — Architecture

The process boundaries, the terminal model, state, security, and the
error/reconnect contract — the decisions the directory tree cannot show.
Mechanism detail lives where the mechanism lives: feature docs
(`PORTFWD.md`, `COMPOSER.md`, …) and the module doc comments each section
below names.

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
  It only calls typed methods on `window.api` and receives results and
  streams.
- All connections live in the main process, keyed by an opaque
  `connectionId` the renderer holds.
- Passphrases are **not stored at all**: one is supplied with a connect
  call, used by `ssh2`, and forgotten.

---

## 2. Module layout

`main/` groups by domain (`ssh/`, `sftp/`, `portfwd/`, `helper/`,
`preview/`, `projects/`, …). `renderer/` is the Electron shell (`App.vue`,
`main.ts`, `router.ts`) over the app tree — stores, views, components,
composables, terminal modules — which lives in `@ui/app` in the
`pocketshell-core` sibling and is consumed through the `@ui` Vite alias.
`shared/` re-exports the types and pure logic both processes import from
`@pocketshell/core`; `preload/` is the bridge. Two tsconfigs over a strict
shared base: `tsconfig.node.json` (main + preload), `tsconfig.web.json`
(renderer) — the split is the process boundary, enforced by the type
checker.

---

## 3. The terminal model — aplexer first, helper-driven attach beneath

The Android app speaks the full `tmux -CC` control-mode protocol itself
(per-pane VT rendering). The desktop port deliberately does **not** re-port
that. Instead:

1. **Listing.** The session tree is fetched from `a snapshot --json` over
   plain SSH exec channels. On a host with aplexer the snapshot is the
   WHOLE list: aplexer addresses `workspace + tag` under an immutable
   UUID, so its workspace is the folder-grouping key and its rows carry
   the agent kind directly — the snapshot's derived `agent` field (the
   live process tree, spec §18) preferred, the declared `engine` as the
   fallback; no inference. A host without `a` falls back
   to the legacy path (`pocketshell sessions list`, then
   `tmux list-sessions`). A session the app JUST created is filed from its
   start result as a pending row and replaced by the panel's next poll, so
   the create path spends no listing round trip between the click and the
   terminal.
2. **Join.** The first visit to a session opens a tracked SSH **shell**
   channel that runs the session join as its exec command — `a attach <id>`
   for an aplexer session, the helper-driven tmux join otherwise — directly
   under the PTY: no login shell, no profile startup ahead of it. The far
   end's real layout renders in xterm.js and owns the panes. The channel
   closes when the join ends for any reason, and the next visit to the tab
   joins fresh — a tab can never outlive its attach into a live prompt
   parked behind a dead session. While the join runs, the pane shows a
   muted "Joining …" veil that clears on the far end's first byte.
3. **Per-tab terminals.** Every visited session tab keeps its own terminal
   mounted; switching tabs is a renderer visibility change, not a remote
   switch or repaint. Input goes over the PTY (`shell.stdin.write`); resize
   calls `shell.setWindow(cols, rows)`.

`TmuxClientPool` keeps one client per visited tab, keyed beneath the SSH
connection (`workspace:tag` for aplexer — tags repeat across workspaces —
session name for tmux). A connection keeps at most **six** live tab clients
and evicts the least-recently-used beyond that; if `ssh2` reports a
channel-open refusal, one LRU client is released and the PTY request is
retried once. The cap leaves channel room on the same connection for exec,
SFTP, and forwarding.

**Why not control mode?** Its per-pane structured state is valuable on a
phone, less so on a big desktop where tiled tmux is perfectly readable.
Attach is ~70% less protocol code — no VT-escape un-decoding, no `%output`
demuxer — and it satisfies the requirement: *click a tree node → see the
terminal/session view*. Control mode can return later as an additive
"Per-pane" tab without rewrites.

Paths and web addresses printed by remote tools are linkified from the
terminal buffer and open in the Files tab or the browser, with at-rest
highlighting that survives a remote CLI wrapping a token across rows. The
detection rules, the wrapped shapes they reconstruct, and the evidence each
needs are documented where they live — `@ui/app/terminalLinks.ts`'s module
doc; the at-rest tint in `@ui/app/terminalPathHighlights.ts`.

The tab context menu's **Copy address** puts a session's aplexer address on
the clipboard — the immutable UUID, not the `workspace:tag` selector, because
the point is pasting it into another session so the two can reach each other
through `a`, and the id survives the renames the same menu's Rename performs.
The item is absent where no id exists: a tmux row addresses by its bare name,
and an aplexer row whose id has not landed must not offer a half address.

The shared agent picker includes Antigravity (`antigravity`, binary `agy`).
It is available when the remote helper advertises `pocketshell agent
antigravity`; an old helper or failed probe dims the choice and blocks
session creation with an explanation. The helper starts `agy --dangerously-skip-permissions`
by default, and the picker can request normal approvals with
`--no-skip-permissions`. Antigravity has no config-directory profile selector.
Its recorded `antigravity` or `agy` engine gets the vendor's own arch mark
(`brand-antigravity`, redrawn from antigravity.google's favicon — the same
mark the usage table's Antigravity row wears), groups
with agent sessions, and receives composer prompts through the terminal.
The composer offers the documented Antigravity CLI command catalog, including
`/plan`, `/permissions`, `/resume`, `/diff`, and `/usage`; its source is
`agentCommands.ts` in core and the Google CLI reference.

**PTY contract (matches the Android app):** term `xterm-256color`, initial
80×24, resized via `setWindow`; shell stdout → xterm.js `write`, xterm.js
`onData` → shell stdin.

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

Local `-L`, remote `-R`, and dynamic `-D` (SOCKS), all carried by the one
authenticated `ssh2` connection per host. `ForwardService` owns the
per-connection forward lifecycle; rules persist in `PortfwdStore`, so
manual toggles and persisted remappings survive reconnects (unlike the
Android in-memory-only manual toggles). The auto-forward loop scans remote
listeners and mirrors or allocates local ports — its algorithm and numbers
are the decision record in `docs/PORTFWD.md`. Reconnect is the renderer's
job (§9): main only reports the drop, and a fresh scan after the new
connection is up rediscovers the forward set.

---

## 6. Files (SFTP)

`SftpService` over `ssh2`'s own sftp channel: list, read/write, `mkdir`,
`rename`, `delete`, `fastPut`/`fastGet` with progress. The renderer's
editor is CodeMirror 6; save calls `window.api.sftp.writeFile`. Binary
detection is by extension + stat: images get a preview, other binaries
hex/download, and whatever is open carries a **Download…** that takes the
host's saved copy through a native save dialog — never the unsaved buffer.

HTML, markdown and SVG are documents, not binaries: each opens with a
Preview/Source toggle over the sandboxed `psview:` frame served by
`src/main/preview/` (markdown reuses the HTML pipeline rather than earning
a second one). Every guarantee that frame rests on is a property of how
bytes are SERVED, not of where they came from: an empty sandbox, a
per-response CSP naming no remote scheme, and request paths always folded
and re-resolved with `realpath` on the host. Clicking an *external* link
hands a web URL to the system browser (http(s)-only allow-list); the frame
never touches the network. The preview always renders the host's copy —
unsaved edits are not shown.

A markdown preview also lifts a leading YAML frontmatter block out of the
body: the scalar-and-list subset renders as a key/value table above the
prose (an http(s) value stays clickable through the same external-link
door), and anything the parser cannot attribute — nested maps, block
scalars — degrades the block to a code frame of the raw text rather than
mangle it. The rules live in `markdownDocument.ts`, which is also why no
YAML dependency crosses into the bundle.

The active Files pane is mounted only while its workspace tab is visible,
so the files store remembers each tab's directory and selected file across
a terminal visit. Clean files are re-read on return; dirty editable buffers
stay in memory so a tab switch cannot discard unsaved work. The helper's
`pocketshell env` is not reused for editing: it is scoped to
`.env`/`.envrc` and writes via stdin; general editing needs a real SFTP
channel (the env panel layers that secret-via-stdin safety on for the
`.env` case).

The env editor is docked, not floating: it takes over the Files pane's
editor area — the surface that otherwise shows the open file or the empty
placeholder — opened from the tree toolbar's type button or by clicking a
`.env`/`.envrc` row. It pins the folder it was opened for, so the tree
stays live underneath an open panel and browsing on never moves its
target; asking again in another folder re-pins it there.

---

## 7. State management

The renderer is layered; each layer talks only to the one below:

- **Components** (`views/`, `components/`) render. Templates do not
  compute; input policy, gestures and focus are theirs. Shared visual
  components, theme/font policy and CSS tokens live in `@ui` and use
  platform-free props and events — they do not import desktop stores or
  IPC.
- **Composables and controllers** (`usePaneWidth`, `useWorkspaceMemory`,
  `terminalPane.ts`) own reusable reactive logic and per-surface machinery.
- **Pinia stores** (`stores/`) hold cross-component state — never secrets —
  one per domain, and orchestrate it: the connection store drives the
  reconnect loop (§9), the files store runs the open/save pipelines over
  the SFTP bridge.
- **Plain TS modules** hold the extractable logic (`reconnectLoop.ts`,
  `remotePaths.ts`, `terminalLinks.ts`, the session grouping algebra shared
  through `@pocketshell/core`) — unit-testable without Pinia, out of both
  stores and views.

Everything crosses to main through the one typed bridge: components import
`window.api` only as `@ui/app/ipc.ts`, whose type is the preload's `Api`.
A view MAY call `api` directly for a self-contained concern no other
surface shares; anything two surfaces need goes through a store. Streams
(terminal bytes, tail lines, forward bytes) are pushed from main to
renderer over IPC events keyed by id; the stores subscribe and the
components render.

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
- `shell.openExternal` is reached only through purpose-built channels that
  construct and scheme-check the URL in main — release pages (`update:open`)
  and the VS Code deep link (§10). The renderer sends fields, never URLs.
- The committed `test_key` is a fixture used **only** by Docker tests.

---

## 9. Error + reconnect contract

- `SshService` operations return result objects, never throw for
  expected failures (auth refused, host unreachable, non-zero exit).
- A transport drop is reported to the renderer as a connection-state
  `'lost'` event. The connection store's FSM re-dials on the shared backoff
  (`shared/reconnectBackoff.ts`) and, on success, `connect()` re-runs
  bootstrap + session refresh + re-opens forwards. The banner shows the
  countdown; `retryNow()` skips the wait.
- Tails and shells are torn down on drop and re-established by their
  owners on the new connection (same contract as Android — tail does not
  self-heal).
- The composer store rekeys its per-session records to the new connection
  id before it is published, so drafts and history survive the swap; and
  terminal re-attachment restores focus only when the visible pane already
  owns it, so a reconnect cannot redirect the next keystroke from the
  composer into xterm.

### 9.1 Terminal parse stalls

A byte sequence that makes xterm's parser throw kills xterm's `setTimeout`
write loop, and the pane fed by that loop silently stops rendering.
`ParseStallMonitor` (`@ui/app/parseStall.ts`) detects the dead loop — no
parse completion within the stall timeout — and reports it through the diag
banner with the stalled bytes and buffer state, so a frozen pane says so.
The repair (`@ui/app/xtermWriteBuffer.ts`) restarts the loop in place —
dead chunk retired, backlog re-parsed — after which the pane does a bounded
fresh join. The failure class, the repair's contract, the tests and the
fuzzer are documented in those two modules' doc comments.

---

## 10. Open in VS Code

A folder workspace's tab bar carries a `code` button that hands the OS the
deep link making VS Code desktop open THIS folder through its Remote-SSH
extension, in a new window. The renderer sends FIELDS — host token,
absolute remote path — over `editors:openVsCode`; main builds the URL
itself and scheme-checks the result before `shell.openExternal`, the same
rule `update:open` runs under (§8). The format's forced decisions — the
host token resolved through the user's `~/.ssh/config`, the absolute path,
the new-window query — are documented with the spelling in
`@pocketshell/core`'s `src/shared/vscodeDeepLink.ts`.

---

## 11. The host monitor

An htop-style read of the connected host — CPU/memory meters, load, and a
live process table with a two-press kill — as the third host overlay
beside Ports and Usage. It rides the EXISTING `ssh.exec` seam with no new
IPC verb: the renderer polls one marked-section snapshot command every
two seconds while the panel is open, and a closed panel costs the host
nothing. The snapshot command, the parsers, the client-side tick-delta
CPU percentages and their deliberate gaps (unset first-sample bars, ps's
lifetime pcpu per process) are the decision record in `docs/MONITOR.md`;
the code is `@ui/app/hostMonitor.ts` and `useHostMonitor.ts`.
