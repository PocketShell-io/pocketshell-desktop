# Backlog

Every request made against this app, with where it landed — a list in someone's
head is not a list.

**Conventions.** `✅` done (shipped, or a manual check resolved). `⬜` accepted
but not started. `❓` open question for the user. `🔍` a finding or manual check
worth keeping. Add at the bottom of the relevant section rather than
reordering.

---

## Shipped

Everything below landed and is in the app; git log has the commits. One line
per area:

- **Session panel and folder workspaces** — the real tree (`git → folder → session`), worktrees grouped under their repo, extra roots in Settings, tabs per session (rename, drag, cycle, MRU close, confirmed stop), multiple Files tabs, the panel→agent chain (`takeAgentLaunch` in `views/FolderWorkspaceView.vue`), the durable session-to-folder registry (`tree get`/`tree upsert`, fails closed) — `docs/SESSIONLIST.md`.
- **Composer** — a floating, movable card overlaying the terminal, per-workspace drafts, doodle annotations (`components/DoodleCanvas.vue`) — `docs/COMPOSER.md`.
- **Files** — the SFTP browser (path bar, breadcrumbs, load-more), HTML and markdown previews (`main/preview/markdownDocument.ts`), binary-never-as-text, syntax highlighting, and **Serve this folder** (`portfwd/serveCommand.ts`) — `docs/SERVE.md`.
- **Terminal and connection** — join through the helper, instant tab switching, garble repair, clickable paths, logs, auto-reconnect with a 5s→60s backoff (`shared/reconnectBackoff.ts`).
- **Chrome and settings** — a Settings screen and default host (`views/SettingsView.vue`, `autoConnect.ts`), themes and palettes, and the shortcut registry every chord handler reads (`shared/shortcuts.ts`) — `docs/SHORTCUTS.md`.
- **Env editor** — the F16 panel on the Files tab (`views/EnvPanelView.vue`).
- **FEATURES.md remainder** — window state (`windowState.ts`), the PR gate (build matrix + Docker smoke in `.github/workflows/publish.yml`), the keyboard-navigable FILES tree.
- **Housekeeping** — old code and backwards compatibility removed; unimported `keytar`/`ssh2-sftp-client` and the duplicated CodeMirror dropped from the installer.
- Superseded, not shipped: the folder's path in the workspace header (the element it would have lived in was deleted).

---

## Accepted, not started

| | Item | Why it is worth doing |
|---|---|---|
| ⬜ | A `serve` subcommand in the pocketshell CLI | Filed as `alexeygrigorev/pocketshell#2333`. The desktop side ships on `python3 -m http.server`; retiring that costs one function. |

---

## Open questions

| | Question |
|---|---|
| ❓ | Is deleting the `switch-client` machinery right? `9a93590` removed roughly three commits of it as unreachable once tabs held live clients. Reversible. |
| ❓ | Should the directory level collapse to the first segment under a root, as the phone does? Flagged as the divergence most likely to be wrong. |
| ❓ | `isHelperMissing` still treats "no such command" as a too-old helper — now the last such shim. `67fdcf5` cut the rest. |
| ❓ | Solarized Light drifts furthest from canon; Nord's error red reads pink as text. Both are the AA-compliant versions. |

---

## Needs a manual check

| | Item |
|---|---|
| 🔍 | **No stray `python3 -m http.server` after quitting.** The serve feature relies on a channel close hanging up the process — traced through code, never observed, and it runs on a production box (`docs/SERVE.md` §4). |
| ✅ | electron-builder asar — run and executed: the packaged `win-unpacked` build boots from `app.asar`, and `import('./assets/toml-*.js')` inside it resolves the grammar. |
| 🔍 | Only Python was eyeballed for syntax highlighting; the other 40 grammars are covered headlessly. |
| 🔍 | Terminal palettes were verified as colour values, not against real `ls --color` or a tmux status line in every theme. |
| ✅ | panel→agent chain — landed complete in `169cf60`: `takeAgentLaunch(...)` runs in `views/FolderWorkspaceView.vue`, covered by `tests/unit/pendingAgentLaunch.test.ts`. |

---

## Findings worth keeping

Things nobody asked about that turned out to matter.

- **aplexer 0.1.4's `a attach` drops the head of a bracketed-paste write.** The composer's multi-line delivery (`ESC[200~…ESC[201~` framed in one write, `shared/composerSend.ts`) loses the start marker plus the first ~8 characters when the session PTY runs `a attach` — the surviving fragment executes as a command (`/bin/sh: ne_one: not found` is what the composer E2E showed). Plain multi-line input without markers is unaffected, the same framing split across three writes is unaffected, and the identical bytes through `tmux attach` are unaffected — so the loss is in aplexer's paste-marker handling, not the app's framing. Surfaced the day the helper fixture gained aplexer; needs an upstream fix in aplexer or a chunked-send workaround in the composer's deliver path.
- **Every breadcrumb that has to fit a narrow box should collapse WHOLE segments into a menu first, then cut characters only out of what survives, and only out of one label** — Carbon, WinUI, Fluent, GitLab and Grafana agree; VS Code never cuts characters at all. Stacking middle-collapse on a character-truncate shipped twice (the session rows, then the Files breadcrumb) because the rule was written as cell counts, which a drag-resizable pane has none of. `docs/DESIGN.md` §5.7.1.
- **A running Electron instance serves the bundle it loaded at launch; a rebuilt `out/` changes nothing for an open window.** This produced a convincing false bug report — the app was sending a command that no longer existed in source.
- **Four separate bugs came from geometry not reaching the far end** — the sliced status line, the font refit, the zoom refit, stale rows below the status bar. One owner now tracks *what the remote was last told*, not what xterm last was.
- **Garble was fixed in the wrong quantity, and only measuring on the fixture said so:** `#{window_height}` disagrees every tick on tmux 3.4 (a status-lined session is one row short of its PTY *by design*), so the meaningful probe is `#{client_width} #{client_height}` — exactly what `setWindow` set. Constant-geometry garble is invisible to any size comparison and is cured only by a `refresh-client`, so the loop repaints on the clock while healthy and re-joins the session when the probe answers `dead` twice.
- **The composer's chords are live wherever it is mounted** — once, behind a `v-show`, with its handler on `window` and `capture: true` — so `Ctrl+\`` on the Files tab toggled a panel nobody could see. This is why `src/shared/shortcuts.ts` exists.
- **Electron's default menu binds fifteen accelerators this app never declared;** two already cost a bug (`Ctrl+=` doing nothing, `Ctrl+W` closing the window). The useful distinction: *editing* roles yield to a cancelled keydown, *window* roles do not. `docs/SHORTCUTS.md` §1.6.
- **The terminal was never the victim of `Ctrl+W`** — xterm cancels the keydown, and a cancelled keydown never reaches an accelerator — while the composer draft, the Files path box, the tree filter and the code editor were losing the whole app to one keystroke. A fix scoped "only while the terminal has focus" would have changed nothing at all.
- **`registerAccelerator: false` on the cut/copy/paste roles is why removing the application menu costs a text field nothing** — measured with the menu nulled: `Ctrl+V` still pastes, `Ctrl+A` still selects all, `Ctrl+Shift+V` still fires a real `paste` on xterm's textarea.
- **`files: out/**/*` ships whatever is lying in `out/`** — a gitignored scratch directory that had collected `tsbuildinfo/` (incremental TypeScript state carrying absolute paths from the build machine) and a 3 MB second renderer bundle. The `files` list now names the three directories electron-vite actually emits.
- **The packaged app opens `node_modules` for exactly one package (`ssh2`)** — everything the renderer imports is compiled into `out/renderer`. So `dependencies` is the list of what gets copied into the installer, not a description of what the app uses, and the two had drifted by ~22 MB plus the native, unimported `keytar` (`app.asar` 42.19 MB → 4.67 MB).
- **Two stacked modals share one Escape listener on `document` and no stacking order**, so one Escape dismisses both. Render the second *instead of* the first — one modal at a time, Escape means "back one step".
- **A dialog that can NAME what it is about to create can defer creating it:** `NewSessionDialog` asks its second question on the `targetFolder` prediction and commits once, afterwards (the prediction is never trusted — the host's resolved folder is what gets used). `docs/SESSIONLIST.md` §13a.
- **Three bugs came from `return false` in xterm's key handler** without `preventDefault()`: `_keyDown` bails before calling its own `cancel()`, so the DOM event stays live.
- **`tmux -u` and plain `tmux` spell names differently, per display column** — that desynchronised the two halves of the session/cwd join for months of non-ASCII session names.
- **The session list and the cwd probe can read different tmux servers;** the sweep now covers every socket rather than assuming one.
- **`http.server` binds all interfaces when `--bind` is omitted** — the default would have published a right-clicked folder to the internet (`docs/SERVE.md` §1).
- **An ESM-only dependency in main is a runtime bomb that every test passes:** `marked` ships ESM only, electron-vite emits CJS for main, and Node 20 predates `require(esm)` — `ERR_REQUIRE_ESM` the first time anyone opens a `.md`, while Vitest loads the same import natively and stays green. Check a package's `exports` before trusting externalisation (`electron-store` taught the lesson first; the config now names both).
- **Revoking a capability was quietly revoking a FACT:** `releasePreview()` cleared `openHasScripts` along with the token, so on every Reload and theme re-mint the "scripts are not run" line vanished, leaving a document that renders as an empty shell with nothing on screen saying why. Reading the code did not catch it; a screenshot after a theme switch did.
- **The sanitiser that reads `obj[key]` reads the prototype too:** a payload of `{ __proto__: { '--bg': 'red' } }` has no own `--bg`, yet an index lookup returns `red` — caught by a test written to assert unknown keys were dropped. Structured clone strips prototypes over IPC, so it was unreachable; it would have become reachable the first time main built one of these objects itself.
