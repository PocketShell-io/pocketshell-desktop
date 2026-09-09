# PocketShell Desktop — working rules for agents in this repo

## 0. What this project is

Electron desktop port of PocketShell — a tmux-native, agent-aware SSH
client. It connects to remote dev boxes running tmux plus the `pocketshell`
helper; sessions are joined through the helper-driven tmux attach model, not
`tmux -CC` control mode (rationale in `docs/ARCHITECTURE.md` §3).

Layout, three Electron processes plus shared code:

- `src/main/` — Node, privileged. The only place that touches `ssh2`,
  keys, fs, and the network: `SshService`, `SftpService`, port forwarding,
  `pocketshell` helper client, ipcMain handlers (`ipc.ts`).
- `src/preload/` — contextBridge; exposes the typed `window.api` surface.
- `src/renderer/` — Vue 3 + Pinia + vue-router, xterm.js terminals,
  CodeMirror editor. Sandboxed: never imports `ssh2`, `fs`, or `net`.
- `src/shared/` — types and pure logic used by both main and renderer.

Commands: `npm run dev` (watch), `npm run build` (→ `out/`), `npm run
typecheck` (two tsconfigs: node = main+preload, web = renderer), `npm run
lint`, `npm run test:unit`, `npm run test:integration` (needs Docker),
`npm run test:e2e` (Playwright + Electron, needs the Docker compose fleet),
`npm run smoke` (pre-release gate). Test tiers are described in
`docs/TESTING.md`.

Docs in `docs/`: `ARCHITECTURE.md` is the deep dive — read the relevant
section before working in an area; feature docs (`COMPOSER`, `PORTFWD`,
`SESSIONLIST`, `SHORTCUTS`, `DESIGN`) record how each subsystem works;
`CLEAN_CODE.md` the rules the code is held to.

Dependency rule: production `dependencies` is only what is `require()`d
from disk at runtime (currently just `ssh2`); everything the renderer
imports is bundled by Vite and belongs in `devDependencies`. See the
`//dependencies` note in `package.json` — a test fails if the list grows
without a written reason.

## 1. Commit regularly, one concern per commit

Do not hold a batch of work for one big commit at the end. Each logical
change — a feature, a fix, a doc section that belongs to it — is its own
commit as soon as it is done and verified (tests for the touched area,
`npm run typecheck`, `eslint` on the changed files).

"Focused" means: one concern per commit, code and its tests and the
`docs/*.md` section that records it travel together, and the tree at that
commit builds and passes on its own. When two changes touch the same file,
split the hunks rather than mixing concerns.

Push after the work is committed.

## 2. Rebuild before handing off

The app runs from the built bundle (`package.json` `main` → `out/main/`),
not from `src/` — launching `node_modules/electron/dist/electron.exe .`
against a stale `out/` shows an old interface no matter what landed in
git. After any change to app source, run `npm run build` so `out/` matches
what was just committed, and say so when handing off.

(`npm run dev` watches and rebuilds on its own; the rebuild rule is for the
build-and-launch workflow.)

## 3. Keep the docs lean

Docs in `docs/` describe current behavior and durable decisions, not
history. When a change supersedes a doc section, rewrite it in place — do
not append "superseded" or "revised" narration next to the old text. Give
every mechanism one home; other docs point at it. Sections that code
comments cite by number keep their numbers (gaps are fine); a section that
must shrink to a stub states the current truth and points at where the
detail lives now.
