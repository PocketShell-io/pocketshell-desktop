# PocketShell Desktop — working rules for agents in this repo

## 0. What this project is

Electron desktop port of PocketShell — a tmux-native, agent-aware SSH
client. It connects to remote dev boxes whose sessions are aplexer
sessions, reached through the `pocketshell` helper, with the helper-driven
tmux attach as the fallback on hosts without aplexer — not `tmux -CC`
control mode.

Layout, three Electron processes plus shared code:

- `src/main/` — Node, privileged. The only place that touches `ssh2`,
  keys, fs, and the network: `SshService`, `SftpService`, port forwarding,
  `pocketshell` helper client, ipcMain handlers (`ipc.ts`).
- `src/preload/` — contextBridge; exposes the typed `window.api` surface.
- `src/renderer/` — the renderer's Electron shell: `App.vue`, `main.ts`,
  `router.ts` (Vue 3 + Pinia + vue-router, xterm.js terminals, CodeMirror
  editor). The app tree itself — `stores/`, `views/`, `components/`,
  composables, terminal modules — lives in the core sibling's
  `packages/ui/src/app`, consumed through the `@ui` Vite alias.
  Sandboxed: never imports `ssh2`, `fs`, or `net`.
- `src/shared/` — import-path shims over `@pocketshell/core` (the sibling
  repo at `../pocketshell-core`, which holds the types and pure logic shared
  by the desktop and the other PocketShell clients). The shared visual
  package — tokens, themes, fonts, `AppIcon` — is that repo's
  `packages/ui`, consumed through the `@ui` Vite alias.

Commands: `npm run dev` (watch), `npm run build` (→ `out/`), `npm run
typecheck` (three tsconfigs: node = main+preload, web = renderer, ui = the
core sibling's `packages/ui`), `npm run lint`, `npm run test:unit`,
`npm run test:integration` (needs Docker),
`npm run test:e2e` (Playwright + Electron, needs the Docker compose fleet),
`npm run smoke` (pre-release gate).

Dependency rule: production `dependencies` is only what is `require()`d
from disk at runtime (currently just `ssh2`); everything the renderer
imports is bundled by Vite and belongs in `devDependencies`. See the
`//dependencies` note in `package.json` — a test fails if the list grows
without a written reason.

## 1. Commit regularly, one concern per commit

Do not hold a batch of work for one big commit at the end. Each logical
change — a feature, a fix — is its own commit as soon as it is done and
verified (tests for the touched area, `npm run typecheck`, `eslint` on the
changed files).

"Focused" means: one concern per commit, code and its tests travel
together, and the tree at that commit builds and passes on its own. When
two changes touch the same file, split the hunks rather than mixing
concerns.

Push after the work is committed.

## 2. Rebuild before handing off

The app runs from the built bundle (`package.json` `main` → `out/main/`),
not from `src/` — launching Electron (`npx electron .`) against a stale
`out/` shows an old interface no matter what landed in git. After any
change to app source, run `npm run build` so `out/` matches
what was just committed, and say so when handing off.

(`npm run dev` watches and rebuilds on its own; the rebuild rule is for the
build-and-launch workflow.)
