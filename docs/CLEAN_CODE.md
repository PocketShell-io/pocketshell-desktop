# Clean Code Rules

The rules this codebase is held to. Adapted from Robert C. Martin's *Clean
Code* and tightened for what this repo actually is: TypeScript everywhere,
Vue 3 in the renderer, an Electron main process that owns an SSH transport.
Rules marked with a check are enforced mechanically by `eslint.config.js`
(type-checked linting); the rest are enforced by review. Full-repo audits
have been run; their findings became commits.

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
doc comment needs paragraphs per branch. Accepted exception: `onCustomKey`
(147 lines) is ~90% cited why-comment over a flat four-branch ladder —
extracting the branches would scatter each decision record away from the code
it argues for.

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

**10. Precise types.** No `any` (the repo has exactly one — see the recorded
deviation below). Non-null assertions only where the invariant is provable
from the immediate context, ideally in a comment. Make illegal states
unrepresentable instead of runtime-checking for them.

**11. Comments carry why, not what.** Decisions, invariants, measurements,
cited sources — the code already says what. A comment whose claim no longer
matches the code is worse than no comment: fix it in the same commit that
changed the code.

**12. Vue components are small and single-purpose.** Reusable reactive logic
goes into composables (`usePaneWidth`, `useStripDrag`); cross-component state
lives in stores; a component over ~1000 lines is flagged for extraction with
the specific sections named. Templates
do not compute; computeds do not mutate.

---

## Enforcement

- `eslint.config.js` — type-checked linting across the repo, per-environment
  globals, every deviation carries its reason inline.
- `npm run typecheck` — `tsc` for main/preload/shared, `vue-tsc` for the
  renderer.
- `tests/unit/designGates.test.ts` — executes DESIGN.md's greppable
  definition-of-done; the precedent for mechanical rule enforcement. Rules 7
  and 8 have graduated into it when a violation class reappears.
- Periodic full audits — findings become commits, one concern each, referenced
  back to the rule number.

---

## Known deviations, recorded on purpose

- **Large pure-TS modules were split along their section seams** (2026-09-03
  audit): `parsers.ts` into the session core plus `sessionPathRecovery.ts` /
  `usageParsers.ts` / `cliParsers.ts`; `sessionGrouping.ts` into the row model
  plus `sessionRoots.ts` and `sessionTree.ts`; `shortcuts.ts` into the engine
  plus `shortcutTable.ts`; `ipc.ts` into a composer plus `ipc/` per-domain
  registrars sharing an `IpcContext`.
- `env.d.ts` declares every `.vue` import as an `any`-typed
  `DefineComponent` (the repo's only `any`). Consequence: component props
  are unchecked at call sites, and seven call sites hand-write structural
  type contracts to route around it (each documented where it happens).
  Removing the shim wants per-SFC type generation or a stricter
  `vue-tsc`-only flow; until then the workarounds are stricter than the
  shim is wrong.
