# Clean Code Rules

The rules this codebase is held to, and the record of where it stands. The
list is adapted from Robert C. Martin's *Clean Code* and tightened for what
this repo actually is: TypeScript everywhere, Vue 3 in the renderer, an
Electron main process that owns an SSH transport. Rules marked with a check
are enforced mechanically by `eslint.config.js` (type-checked linting); the
rest are enforced by review and by the audits recorded at the bottom.

The rules are additive to `AGENTS.md` (one concern per commit, rebuild before
handoff) and `docs/TESTING.md` (a red file, never a green tick nobody
earned). A refactor commit changes no behavior — if behavior changes, it is
its own commit.

---

## The rules

**1. Names reveal intent.** A name answers why the thing exists and how it is
used. No single-letter names outside trivial loop indices and one-line
comparators. One vocabulary per concept: a connection is a *connection*, a
tmux session a *session*, an attached PTY a *shell*, a port forward a
*forward* — never a synonym drift (`link`, `socket`, `tab` for the same
thing) across a boundary.

**2. Functions do one thing.** One level of abstraction per function. A
function that needs its own section headers to be readable wants to be two
functions. Flag anything over ~80 lines for splitting; flag anything whose
doc comment needs paragraphs per branch.

**3. Guard clauses; shallow nesting.** Edges return early; the happy path
reads top to bottom at no more than two levels of indentation. `if` ladders
that map a value to a result become a table or a switch.

**4. No unnamed boolean flags at call sites.** `send(payload, true)` makes the
reader go find the signature. The repo's pattern is an options object whose
field names carry the semantics (`refresh(id, { quiet: true })`,
`pushGeometry({ redraw: true })`). The only bare booleans allowed are DOM
signatures (`addEventListener(..., /* capture */ true)`).

**5. Command–query separation.** A function either does something and reports,
or answers a question — not both. No side effects in `computed()`, getters,
or `snapshot()`s. A command that also needs to answer names itself as a
command (`openDedicatedRevealTab(...): boolean`), not as a predicate.

**6. One rule, one place.** Shared logic lives in shared modules, and the
precedents are deliberate: `shared/shellQuote.ts` (the one POSIX escape),
`shared/reconnectBackoff.ts`, `shared/shortcuts.ts`. A second implementation
of a rule is a bug that hasn't happened yet. When two copies exist "so they
must not drift", that comment is the extraction speaking.

**7. No magic numbers or strings.** A literal that a reader would ask "why
this number?" gets a named constant at the decision site, with the why.
CSS goes through the App.vue token set; raw hexes, pixel sizes and timings
outside `App.vue`/`themes.ts` are violations. Values with a written
derivation comment at the site are acceptable.

**8. Dead code is deleted.** Commented-out code, unreachable branches, unused
exports, params accepted and ignored — gone; git remembers. Two sanctioned
exceptions, both requiring the label in so many words: test-only surfaces
(`/** Test-only: … */`, as `themes.ts`'s light-mode hook does) and
deliberate cross-platform parity shims (state which platform in the doc).

**9. Errors: one channel per layer.** Expected failures are result objects
(`{ ok, error }`); programming errors throw. Every catch either handles the
failure or says why silence is correct — an empty catch with no WHY comment
is a bug. Renderer surfaces route error sentences to the channel the user is
looking at (`fileError` vs `error` in the files store is the model).

**10. Precise types.** No `any` (the repo has exactly one, in `env.d.ts`'s
`.vue` shim — recorded below as a known deviation). Non-null assertions only
where the invariant is provable from the immediate context, ideally in a
comment. Make illegal states unrepresentable instead of runtime-checking for
them.

**11. Comments carry why, not what.** Decisions, invariants, measurements,
cited sources — the code already says what. A comment whose claim no longer
matches the code is worse than no comment: fix it in the same commit that
changed the code.

**12. Vue components are small and single-purpose.** Reusable reactive logic
goes into composables (`usePaneWidth`, `useStripDrag`); cross-component state
lives in stores; a component over ~1000 lines is flagged for extraction with
the specific sections named. Templates do not compute; computeds do not
mutate.

---

## Enforcement

- `eslint.config.js` — type-checked linting across the repo, per-environment
  globals, every deviation carries its reason inline.
- `npm run typecheck` — `tsc` for main/preload/shared, `vue-tsc` for the
  renderer.
- `tests/unit/designGates.test.ts` — executes DESIGN.md's greppable
  definition-of-done; the precedent for mechanical rule enforcement. Rules
  7 and 8 have graduated into it when a violation class reappears.
- Periodic full audits (the audit is recorded below) — findings become
  commits, one concern each, referenced back to the rule number.

---

## Audit record

**2026-09-03, full repo.** Scope: all of `src/` (~41k lines) plus `tests/`
grep-verified for dead-code claims. Findings became the commit series this
doc landed in; the classes and what was done:

- **Rule 8 (dead code)** — deleted: `SshService.shell()`/`tail()` (Phase-1
  leftovers), the unused `registry` dep in `registerIpcHandlers`,
  `KnownHosts.reload()`/`isKnownHostsPresent()`,
  `ConnectionRegistry.list()`/`ShellTracker.list()`, `PortfwdStore`'s
  `EMPTY_STATE`, `workspaceTabs.tabIdAtIndex` (its Ctrl-1..9 callers are
  gone), `sessionGrouping.flattenSessions`, `BootstrapResult.resolvedPath`,
  `ConnectResult.unknownHostKey`/`HostKeyFingerprint` (never populated), and
  the dead second clause of KnownHosts' digest comparison. Deliberately kept
  and labelled: test-only surfaces (`execBackground`, `SftpService.exists`,
  `PortfwdStore.hostKeys`, `TmuxClientPool.liveSessions`, `shortcutIds`) and
  the parity shim `FilenameSanitiser.composeRemoteName`.
- **Rule 11 (stale comments)** — fixed the batch of WHYs that no longer
  matched the code (the removed `switch-client` design, the `windowSize`
  null contract, the 32 MiB readBinary ceiling in three files,
  `MAX_JOIN_ROWS`' derivation, two orphaned doc blocks attached to the wrong
  function).
- **Rule 6 (duplication)** — one `shellQuote` everywhere (attachCommand's
  private copy, bootstrap's inline escape); one tmux `-S` aiming prefix
  (four copies); `firstNonEmptyLine`/`lastNonEmptyLine` (four copies); one
  `oversizeMessage`/`formatBytes` (five copies); a `usePaneWidth` and a
  `useStripDrag` composable (tab drag vs folder drag, sash drag vs tree
  drag); preload's subscription boilerplate ×10 → one `subscribe`;
  `(e as Error).message` ×~30 → the shared `errorMessage` helper;
  Forwarder's twin `startLocal`/`startDynamic` bodies; the five re-spelled
  failure results in `startSession`.
- **Rule 7 (magic numbers)** — `MAX_PORT`, `MIRROR_SWEEP_DISTANCE`,
  `LOOPBACK_HOST`, `PERSIST_DEBOUNCE_MS`, `COUNTDOWN_TICK_MS`; the Env panel's
  five references to CSS tokens that never existed were repointed at the real
  ones (a correctness fix — the styles silently never applied).
- **Rule 2 (oversized functions)** — `startSession`'s five re-spelled failure
  results became one builder, and Forwarder's twin `-L`/`-D` listen bodies
  merged into `listenAndReport`. The rest of the audit's >80-line list was
  inspected case by case and left, deliberately: `onCustomKey` (147 lines)
  is ~90% cited why-comment over a flat four-branch ladder — extracting the
  branches into helpers would scatter each decision record away from the
  code it argues for. It is recorded here as an accepted exception, to be
  re-read if the comment mass ever gets separated from the code by
  extraction anyway. Done since the audit: `createWindow`'s behavior wiring
  moved out of `index.ts` into `windowLinks.ts` (both navigation capture
  points behind one allow-list) and `windowChords.ts` (the intercept
  dispatcher, close action injected), and `openFile` shed its presentation
  half into `presentDoc` — the stat/classify/cap ladder stays inline because
  the staleness tickets are what make early `return`s safe there.

**Known deviations, recorded on purpose:**

- **Large files, first round split (2026-09-03), rest filed.** The pure-TS
  giants split along their section seams: `parsers.ts` (1098) into the
  session core plus `sessionPathRecovery.ts` / `usageParsers.ts` /
  `cliParsers.ts`; `sessionGrouping.ts` (1180) into the row model plus
  `sessionRoots.ts` (registered-roots path algebra) and `sessionTree.ts`
  (the panel's tree assembly); `shortcuts.ts` (1225) into the engine plus
  `shortcutTable.ts` (the registry as data); `ipc.ts` (913) into a composer
  plus `ipc/` per-domain registrars sharing an `IpcContext`. Still over the
  line, filed for their own passes: the nine components listed below; the
  `files` store (1301 — its pure helpers want a `fileModel.ts`); the preload
  (758 — wants per-domain api builders behind one bridge object); and
  `PocketshellClient.ts` (1046, whose helper verbs could group by feature).
  Components split along extraction seams, not line counts: the composer's
  doodle orchestration (~370 lines) → `useDoodleSheet`, TerminalView's
  geometry reconcile loop → a module, SettingsView's chord capture →
  `useChordCapture`, FileTree's roving tabindex → `useRovingList`.
- `env.d.ts` declares every `.vue` import as an `any`-typed
  `DefineComponent` (the repo's only `any`). Consequence: component props
  are unchecked at call sites, and seven call sites hand-write structural
  type contracts to route around it (each documented where it happens).
  Removing the shim wants per-SFC type generation or a stricter
  `vue-tsc`-only flow; until then the workarounds are stricter than the
  shim is wrong.
- Components over the line-12 bar, largest first:
  `FolderWorkspaceView.vue` (~2390), `PromptComposer.vue` (~2170),
  `SessionTree.vue` (~1800), `NewSessionDialog.vue` (~1580),
  `TerminalView.vue` (~1520), `DoodleCanvas.vue` (~1420),
  `SettingsView.vue` (~1420), `FileTree.vue` (~1100),
  `PortPanelView.vue` (~1030). The extractions that pay first are named in
  the audit: the composer's doodle orchestration (~370 lines), the geometry
  reconcile loop in TerminalView, the chord-capture block in SettingsView,
  the roving-tabindex list in FileTree. Filed here rather than executed
  because each is a UI-risk refactor that wants its own session.
