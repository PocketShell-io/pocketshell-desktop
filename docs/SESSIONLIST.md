# SESSIONLIST.md — Session panel: the folder view

Status: **current.** The panel is `root -> folder`, TWO levels, rendered in
the host's order and draggable. The requirement that produced this shape, in the
user's words:

> "git -> folder -> session"

Revision-history essays arguing for things the panel no longer does have been
cut; §0 keeps the map of what replaced what. Phone-side line numbers
(`FolderTreeProjection.kt` and friends) are from the v0.4.8 checkout and may
drift.

---

## 0. Revision 4 — the session level is gone

The panel this document was first written against had three levels —
`root -> directory -> session` — and twice before that a conditional tree
whose shape depended on its contents. All of that is gone. What survived:
the display-label rules (§4), truncation (§5), the panel width (§7),
registered roots (§12), and the `+` creation affordances (§0a).

Three later revisions, in brief:

- **Revision 6 — the panel stops rearranging itself.** The recency sort is
  overturned: rows render in CREATION order (§6.0), draggable to override
  (§14); the root header names its directory — `~/git`, not `git` — with its
  count beside it rather than pinned right (§15).
- **Revision 7 — the ordinary ellipsis.** Middle truncation is overturned at
  the user's ask ("this shortening looks strange — these names don't really
  need to be shortened"): a label renders as ONE span with the standard
  `text-overflow: ellipsis`; the full name is read on hover from the row
  tooltip (§5).
- **Revision 8 — the panel stops sorting.** Creation order — revision 6's own
  answer — is delegated to the host: `a` sorts the session list (`--sort`,
  `accessed` by default) and every level of the panel preserves that order
  (§6.0).

**What changed:** the panel is now `root -> folder`, two levels, one row per
folder. There is no session level. Clicking a folder row opens a folder
WORKSPACE in the right pane whose tab bar carries every session in that
folder; §2's "three levels, unconditionally" is historical. **Why, in one
sentence:** the SESSION level only ever earned its rows by being *the only
way to reach a session*, and under the folder workspace it is not — selecting
a session became a tab operation, and the leaf spent a row on a navigation
step the tab bar already performs. §1's measurement — 11 folders, 11 sessions
— puts a number on that: 22 rows became 11, and the count no longer grows
when a folder gains a second session.

Two properties of the earlier designs are worth keeping because they bound
what came after: revisions 1 and 2 removed a level CONDITIONALLY, so the
panel's shape moved under the refresh timer, while revision 4 removes the
session level for EVERY folder, so a reader can predict the panel's shape
without knowing what is running; and revision 3's "a level must earn its
rows" principle is what retired the session level rather than justified
keeping it.

**Consequences inside this document:**

| Section | Status under revision 4 and after |
|---|---|
| §2 "three levels, unconditionally" | historical — two levels, unconditionally |
| §3 indent budget | two-level geometry (§3.0); §3c's session row is gone |
| §3d orphan row | drawn as the folder row itself now, still selectable |
| §5 truncation | end-ellipsis + tooltip (revision 7) |
| §6 "finding the session I was just in" | answered by the attached dot on the folder row plus the workspace's tab bar; the panel no longer names sessions, so the folder tooltip lists them |
| §10 | rewritten as the current invariants ("spend a row only where there is fan-out" survives as the principle that retired the level) |

**And one thing revision 4 fixed that revision 3 could not.** Sessions whose
cwd probe went quiet used to render as orphans; under the folder view an
unplaced session is a session with no workspace at all, because everything
keys on the folder. `inferPathsFromSiblings` (src/main/helper/parsers.ts:545)
gives such a session the directory of the session whose name it extends, and
`diagnoseSessionPaths` (parsers.ts:605) logs why the probe failed to place it.

---

## 0a. Revision 5 — creation moves onto the rows (implemented)

> "I also want to have a `+` near git, near `tmp` (another project root in
> hetzner) and just a plus to create a random session in any place. then we
> don't need 'new session' button anymore"

**A `+` on every root row** (§3a field 4), plus a general `+` in the header
strip with nothing pre-filled — the second is what makes the foot button's
removal safe, since it is on screen whatever the panel holds, including a host
with no sessions at all. The root-row `+` opens the same folder-first picker,
rooted at THAT root: the user has said which root, and the folder under it is
still an open question, so the picker still opens — one level in. It does not
guess a directory from a root, because guessing is how a session ends up
somewhere the user did not choose. The root key is home-relative by
construction (§8) and the picker browses over SFTP, which runs no shell, so
`~/git` has to be expanded before it is handed over — `rootHostPath` in
`sessionGrouping.ts`, the inverse of `directoryKey`. Two cases have no honest
answer and are handled differently on purpose: the `other` bucket gets **no
`+` at all** (it is where paths that matched no root went, not a directory),
and a `~`-keyed root on a host whose `$HOME` neither resolved nor could be
inferred gets a **disabled** `+` whose tooltip says why — a control that
vanishes on a failed fetch reads as a feature that is not there.

The mark is revealed on hover or focus, never persistent — `opacity`, not
`display`, so the square is always laid out and the label never reflows under
the cursor; `:focus-visible` reveals it; `@media (hover: none)` shows it
unconditionally. It is deliberately **not** keyed on whether the root is
empty: `directories.length` moves under the refresh timer.

**The foot button is deleted** — it spent a bordered 44px row, permanently, on
one action, and it answered "where?" with a browse starting at `$HOME` even
when the user had just pointed at `git`.

**What did NOT change: the panel's `+` does not choose an agent.** It did not
then (§13); it chains now (§13a).

---

## 1. The problem, from real data

*Written against the three-level panel at commit `b55ec9f`; the measurement is
why the top level is ROOTS rather than folders, and why a per-session level
never earned its rows.*

Against the user's real dev box the distribution was **11 folders, every one
holding exactly one session** — 22 rows for 11 sessions under the then-design,
versus 11 folder rows now. The failures compounded: a header whose entire
content is one session cost a row and a disclosure affordance to convey zero
information; the two lines were near-duplicates BY CONSTRUCTION, because the
session name is derived from the folder path — `~/git/dataops` → `git-dataops`
(`sessionBaseName`, src/shared/sessionNameParts.ts:87) — so folder `dataops` +
session `git-dataops` is the same fact twice; both levels truncated into
uselessness at the 280px default, where end-ellipsis eats exactly the tail
that disambiguates; and folder and session name can diverge outright (git
worktree: folder `merry-sniffing-tortoise`, session `git-dtc-website`).

The phone does not have this problem because its top level is **watched
project roots**, not individual folders — roots have real fan-out (`~/git`
holds all 11). The desktop implemented only the phone's no-watched-roots
fallback, where the degenerate level *is* the top level; §12's registered
roots closed that gap.

## 2. Position: three levels, unconditionally — HISTORICAL

*Superseded by §0; the rejections below still bind.* The position was: group
sessions by ROOT — the roots the user registered in Settings (§12), or
`$HOME`'s children when they have registered none — with an `other` catch-all;
inside a root, group by the working DIRECTORY; every directory a header row
with its sessions beneath it; no size at which a level disappears.

**Still rejected**, as binding now as then:

- **Group by agent kind or recency bucket** — agent kind is already a badge,
  and recency is no sort at all any more (§6.0).
- **Recovering the DIRECTORY from a session name** — see §4.6. The derivation
  is not invertible past the first component, and a guessed directory row is
  worse than none.
- **A FOURTH level (nesting `~/git/a/b` under `~/git/a`)** — nothing in the
  real data has it, and it would spend a row on a node holding **no session
  of its own**. The panel ships two levels, and this is still where the
  nesting stops.
- **Auto-collapsing a directory once the list is long** — a rule that removes
  the level at exactly the distribution that motivated it. Moot at two
  levels, but it is why collapse did not come back with them (§3a).

## 3. Row anatomy and the indent budget

Two row types — the root header (§3a) and the folder row (§3b) — both height
`--row-h` (28px, defined in `src/renderer/App.vue:357`), plus the degenerate
untracked variant of the folder row (§3d). Budget at the 280px default
(`DEFAULT_PANEL_WIDTH`, HostWorkspaceView.vue:184); the folder row carries the
2px selection rail slot + accent rail for `current`.

### 3.0 The indent budget

Two levels, floored at a **232px** panel (`MIN_PANEL_WIDTH = 232`,
HostWorkspaceView.vue:182; `.tree`'s `min-width` matches,
SessionTree.vue:1317). The step is **8px**, VS Code's own tree step: the root
header's dot sits at 12 (`--sp-3` padding), the folder row's at 20 (2px rail +
18px padding), and both labels follow their dot at a constant 16px (8px dot
plus an `--sp-2` gap), so the two levels share one rhythm. The empty-root
sentence starts at 36, where a folder LABEL starts — at the 232px floor that
leaves `232 − 36 − 10 = 186px` for a folder row's label, badges, count and
time, and the container query (§7) has already dropped the time by then.

### 3a. Root header row

A plain `div.folder-header` — **not** a button, and no disclosure mark. A root
row is a grouping HEADER over its folders, not a node with something hidden
under it; a chevron would advertise an interaction that does not exist, so the
row is not interactive at all — the tooltip is the only thing it offers.

| # | Field | Spec |
|---|-------|------|
| 1 | Status dot | The same 8px dot every row uses, `--success` when **any** session under the root is attached. It is how a root reports "something live is in here" in one mark — and on a registered root with nothing running it is the difference between "quiet" and "not loaded" |
| 2 | Root label | The root's KEY (`~/git`), with the `~/` in a `.path-prefix` span at `--fg-muted` (§15). `--font-ui` `--fs-300` `--fw-semibold`, `flex: 0 1 auto; min-width: 0`, end-ellipsis. The `other` bucket renders `--fw-regular` `--fg-secondary` instead: it is a bucket, not a directory the user could navigate to |
| 3 | Count | Bare integer, `--fs-100` `--fg-muted` `tabular-nums`, immediately after the label — not `· 3 sessions`, and not pinned to the right edge (§15). The phrase form retreats to the tooltip |
| 4 | New session | **Revision 5.** `AppIcon name="plus"` at 12px in an `.icon-btn.sm`, holding the right edge with `margin-left: auto`. `@click.stop`, `opacity: 0` until the row is hovered or the button is `:focus-visible`. Absent on `other`; disabled, with a tooltip saying why, when `rootHostPath` cannot resolve the root. See §0a |

**Header tooltip:** `~/git` + `3 sessions`, written home-relative because the
grouping key is (§8). An empty registered root says `registered in Settings —
nothing running here` (§12.4). The `other` header says `sessions outside every
root, or with no known folder` instead, since it has no one path to name.

### 3b. Folder row — every directory, whatever it holds

A `<button class="dir-header">` — the panel's SELECTABLE row. Clicking it
emits `select`, which opens that folder's workspace; there is no disclosure,
no toggle and no `aria-expanded`, because there is nothing to expand. It is
also the drag source for §14 and the anchor for the context menu (right-click:
new session in this folder, or stop the folder's sessions).

| # | Field | Spec |
|---|-------|------|
| 1 | Left inset + rail | 2px selection rail + 18px padding; the dot lands at 20, one 8px step right of the root's (§3.0) |
| 2 | Status dot | **Aggregate**: `--success` when *any* session in the folder is attached — the only attachment report the row needs now that sessions are not rows |
| 3 | Folder label | The directory's own name — its trailing path component, never the full path and never a session name — in `--font-mono` when the folder is untracked (§3d). One span, standard end-ellipsis (§5); the row tooltip carries the full name. `flex: 0 1 auto; min-width: 0` — it shrinks last but no longer GROWS |
| 4 | Count | Bare integer, `--fs-100` `--fg-muted` — **only from 2 up** (a `1` beside a row that stands for at least one session is a dead field). It sits immediately after the label, ahead of the badges, matching the root header: a reader scans ONE column of rows (§15) |
| 5 | Agent badges | Up to two, the shared chip metric, `flex: none` — what is running in the folder |
| 6 | Relative time | The NEWEST activity in the folder, `--fs-100` `--fg-secondary` `tabular-nums`, holding the right edge with `margin-left: auto`. Independent of the sort since §6.0, which makes it carry more, not less: position no longer says any of it. Hidden below the 270px container query (§7) |

**Row tooltip** (`dirTooltip`): the folder's full path + `1 session` /
`3 sessions` + the session NAMES — up to six, then `… and N more`. The names
live here because they are no longer on screen: the workspace's tab bar
carries them, which is behind a click. An untracked folder says `no reported
folder` — or `no reported folder — root read back from the name` (§4.6) —
instead of a path it does not have.

### 3c. Session row — removed (revision 4)

The per-session leaf row is gone with the session level; §0 has the history.
Session names, ages and badges now live on the workspace tab bar and in the
folder tooltip (§3b).

### 3d. Untracked row — a session with no directory at all

A no-cwd session is modelled as a degenerate directory (§8) and DRAWS as the
folder row itself, with the `.orphan` variant: label in `--font-mono` — the
session name, the only label it has — no path in the tooltip, and fully
selectable: it opens a workspace holding that one session.

This is the one node whose label is a session name, and it is not a
conditional collapse coming back. The test is not "this folder holds one
session"; it is "there is no directory". See §4.4 and §4.6 for how these
sessions are labelled and where they are filed.

## 4. Display-label rules

Let `label = defaultLabelForPath(directoryKey(canonicalisePath(session.path), home))`
(sessionGrouping.ts) and `base = sanitisePart(label)` (the regex at
src/shared/sessionNameParts.ts:21-27; see §8 for why it lives there).

1. **Derived-name suppression is structural.** The old question — *is this
   session name just its folder
   restated?* — has a structural answer: a folder row never shows a session
   name (its tooltip lists them, §3b), and the panel's leaf rows show the
   session names themselves (§4's leaf), where a restated folder name is the
   point rather than a bug. No derivation test gates any rendering.
2. **Divergence** (worktree, custom name): folder `merry-sniffing-token`
   holding session `git-dtc-website` — the row the user circled, both labels
   truncated on one line, neither readable. Now the folder row says
   `merry-sniffing-token` and its tooltip lists `git-dtc-website`; the tab bar
   labels the session. Neither label fights the other for width.
3. **Multi-session folder:** simply the general case with N > 1 — one label, a
   count from 2 up, badges for what is running, names in the tooltip.
4. **Untracked** (`path === null` → `UNTRACKED_PATH`): the label is the
   session name itself, and each untracked session is its own folder row
   (§3d) — not merged into one `Untracked` branch (that branch's children
   would be the same names its parent could not show) and not given a header
   of their own (which would carry the identical string). The phone merges
   them (`Other folders` → `Untracked` → sessions,
   FolderTreeProjection.kt:152-166, 243-250); we diverge knowingly. See §4.6,
   which mostly empties that bucket anyway.
5. **Label collision** (two directories, same basename — `~/git/foo` and
   `~/git/nested/foo`): a post-pass prepends parent segments to the colliding
   labels until unique (`git/foo`, `nested/foo`). **The pass now runs over
   DIRECTORIES, scoped per root.** Per root because `~/git/foo` and
   `~/work/foo` are already told apart by their two headers; over directories
   because that is the level that carries a path-derived label. Nodes are
   keyed by path; labels are display-only.
6. **No reported cwd → recover the ROOT from the NAME.** The answer to *"these
   things are actually under git/ too"*.

   `path` comes back null when tmux reports neither an active-pane cwd nor a
   `session_path` (parsers.ts:243). But this app *derives* session names from
   paths: `sessionBaseName` joins the home-relative components with `-` after
   `sanitisePart`, so `~/git/red-stamp-sound` becomes `git-red-stamp-sound`
   and the **leading component of the name is the root**.
   `rootFromSessionName(name, knownLabels)` reads it back.

   Three constraints keep it honest:
   - **Root only, never the directory.** The derivation is not invertible past
     the first component: `-` is both the separator and a legal character
     inside a component, so `git-dtc-website-import` is genuinely ambiguous
     between `~/git/dtc-website-import` and `~/git/dtc-website/import`. A
     name-recovered session therefore sits as a **direct child of the root**,
     alongside the folder rows, with no directory node invented for it.
   - **Only roots that exist from real paths** — or from the registered list
     (§12.4). The candidate set is built in a first pass over sessions that
     *do* have a cwd; the heuristic may place a session, never create
     structure.
   - **It says so.** The row's tooltip reads `no reported folder — root read
     back from the name` where a normal row prints its path. A guess presented
     as a reported cwd is the kind of thing that costs an hour.

   Everything still unplaceable — no path *and* no name match, or a real path
   outside `$HOME` — stays in `other`, which is what keeps `other` honest
   rather than a dumping ground. The phone does none of this: a no-cwd session
   goes to `Other folders` → `Untracked`, both of its root resolvers
   hard-refuse the sentinel, and there is no name→path inverse anywhere in
   that codebase. So this is a desktop-only heuristic, adopted because the
   phone's behaviour *is* the behaviour the user complained about. See §11 for
   the durable-registry alternative the phone has and we do not call.

## 5. Truncation

> **Revision 7 — the shared-prefix case loses, knowingly.** Directory and
> folder labels end-truncate with the ordinary CSS ellipsis and lean on the
> row tooltip for the full name (§3b).

The original spec was middle truncation via a two-span head/tail pair,
because `pocketshell` and `pocketshell-desktop` differ only at the tail — an
end-ellipsis renders them identically, and siblings in one folder share a
derived prefix by construction. The user overturned it: a squeezed
`course-manage…nt-agent` reads as a mangled single name, not as a protected
tail, and the tooltip redeems whatever the ellipsis hides. `splitLabel` and
the `labelHead`/`labelTail`/`nameHead`/`nameTail` fields are still exported
and computed in `sessionGrouping.ts`, but the renderer no longer consumes
them.

## 6. Timestamp, order, and finding "the session I was just in"

**Timestamp → compact relative.** `Aug 24, 01:10 PM` costs ~90px per row to
say what a column of ages says better. Rows show `now` (<60s), `12m`, `3h`,
`2d` (<7 days), then `Aug 12` — max ~6 characters ≈ 36px at `--fs-100`. The
absolute form lives in the tooltip, and the strings refresh from a `now` ref
ticked every 60s (activity only changes on store refresh, so this is cosmetic
re-rendering). The time no longer doubles as a sort key — there is no
client-side sort at all (§6.0) — so times run in no particular direction down
a root — a real loss, paid deliberately.

### 6.0 What ships: the host's order

> "let's not rearrange workspaces/sessions in here because it's confusing.
> let's use wheveer order we had when creating."

That sentence produced creation order and kept faith until the host could
sort. What ships now is its successor, from the same concern: **the panel
orders nothing at all.** The main process asks the host to sort the listing —
`a`'s surface is `a list --sort name|created|accessed|activity`, and the app
requests its default, `accessed` — and every level of the panel preserves the
document order of the list the store receives: rows inside a folder, folders
inside a root (first appearance), derived roots (first appearance). Registered
roots render in registered order (§12) and `other` is pinned last; the drag
arrangement (§14) is a projection on top of all of it.

Delegating answers the original complaint the same way creation order did, by
removing the client's moving keys — and it goes one further: whether a row
moves at all is now the host's decision and nobody else's. `a` owns the
timestamps (activity, access, creation), so it owns the order they produce.
The order survives the poll because the projection (`buildRows` /
`buildDirectories` / `groupSessionsIntoRoots`) is a fold, not a sort — there
is not one comparator left in the path.

**Compatibility.** A host whose `a` predates `--sort` refuses the flag (the
refusal is remembered per connection) and its unsorted snapshot —
newest-created first — is straightened oldest-first in `PocketshellClient`:
the order such a host already showed. The legacy helper path (no `a` at all)
is pinned to that same creation order there. The order contract lives in main:
`listSessions` returns the list already in the order the panel shows it.

**The tab bar kept its own order.** `buildWorkspaceTabs` still sorts tabs by
creation, on its own stability argument — a bar that reorders under the
refresh timer moves the target between the click and the hit. The panel and
the bar therefore list a folder's sessions differently, deliberately: the
bar's rows are hit targets, the panel's rows are the host's list.

`Ctrl+↑` / `Ctrl+↓` walk this same list, which is exactly why nothing
client-side may rearrange it — the chord exists to move between the rows the
user can see. The marks that answer "the session I was just in" without
moving anything are unchanged: the green dot, the semibold label, the accent
rail on the open folder. Agents-first stays dropped too: agent-ness is the row
badge, a fact about a row, not a reason to move it.

### 6.1 SUPERSEDED — the recency sort

*What §6.0 replaced: within each root, any-session-attached desc →
most-recent activity desc → label; `other` pinned last. Its premise — that
the panel is READ rather than HIT — was the part that turned out wrong. Once
the panel gained arrow-key navigation and one row per folder rather than one
per session, its rows became targets, and a target list may not rearrange
itself under the cursor. (The tab bar had already reached the opposite
conclusion for the same reason: tab rows are hit, so they cannot sort by
recency either.)*

## 7. Panel width

- **Default 280** (`DEFAULT_PANEL_WIDTH = 280`, HostWorkspaceView.vue:184); the
  folder row is sized to render the real data untruncated there. **Persisted**
  under the `localStorage` key `pocketshell.sessionPanelWidth`, clamped to
  `MIN/MAX_PANEL_WIDTH` — **232 / 560** — on read as well as on write, written
  once per drag rather than per `mousemove`. `.tree`'s `min-width` (232px)
  matches the clamp.
- **Below the container-query floor**, `@container (width < 270px)`, the
  *timestamp* drops first (`.row-time { display: none }`) — the least
  operational field now that position no longer implies recency (§6.0). **The
  rule stays unscoped**, so a root header's aggregate age drops at the same
  width its children drop theirs — a header still showing a time above rows
  that had theirs removed would read as the header's own, separate fact. Dot,
  label, badges and count survive to the 232px floor.
- 270 leaves only 10px of headroom under the 280 default: one drag narrower
  and the times go. The alternative — holding the floor lower and letting the
  label truncate instead — trades the field that identifies the row for the
  field that dates it. Times lose.

## 8. Implementation notes

- **Three projections, one module, one row builder.**
  `src/renderer/sessionGrouping.ts` exports `groupSessionsIntoRoots` — what
  the panel renders (`SessionRootFolder = { key, label, directories,
  sessionCount, mostRecentActivity, active, other, configured }`;
  `SessionDirectory = { key, path, label, rows, mostRecentActivity,
  active, untracked, inferredRoot }`; `rows.length` is a count and nothing
  else — the only reader left is the header's `≥ 2` count field, §3b); and
  `groupSessionsByFolder`, the phone-parity LEAF grouping that nothing
  renders — the parity anchor, and the shape the folder-first creation flow
  speaks. All of them go through one private `buildRows`, so they cannot
  disagree about a label, and `buildRows` deliberately does not disambiguate:
  the correct scope differs (§4.5), so each projection applies
  `disambiguateLabels` over its own scope.
- **Keys at both levels are written home-relative.** `rootForPath(path, home)`
  returns `{ key: '~/git', label: 'git' }`; `directoryKey(path, home)` applies
  the same rewrite at full depth. Writing `~/git/dataops` rather than
  `/home/alexey/git/dataops` folds the two spellings tmux reports for one
  directory into a single node — the absolute path from the active pane, and
  the literal unexpanded `~/git/...` that `session_path` can carry
  (parsers.ts:243, `parseSessionEnrichment`). Without it, one directory
  reported both ways renders as two identically labelled rows side by side. A
  `~` prefix needs no `home` to resolve — and this is the one place `~` IS
  resolved; `canonicalisePath` deliberately never expands it, so the grouping
  key and the *displayed* path stay separate.
- **A no-cwd session is modelled as a degenerate directory.** Key
  `"::untracked:: <name>"`, path `UNTRACKED_PATH`, label = the session name,
  `untracked: true`, exactly one row — which is what lets §4.6's
  name-recovered rows sit alongside directory nodes in one sorted list.
  `inferredRoot` is set by the pairing `untracked && root !== other`; there is
  no other way an untracked row can be anywhere but `other`. The renderer
  reads `dir.untracked` (never `rows.length`) to draw it as the §3d orphan
  row: "there is no directory here" is the only question the template is
  allowed to ask about a node's shape.
- **`other` is honest, not a dumping ground.** It holds: paths outside `$HOME`
  (`/var/log` — they share no parent with the rest), sessions sitting in
  `$HOME` itself, and sessions with neither a path nor a name that names a
  real root. Directory grouping applies inside it too. **`$HOME` itself
  renders as `~ (home)`**, not the account name — its key collapses to `~`, so
  `defaultLabelForPath`'s named fallback takes over; a row reading `alexey`
  looks like a user, not a project.
- **`$HOME` is fetched, then inferred.** The panel calls
  `api.projects.home(connectionId)` directly rather than
  `projects.loadHome()`, which would also land the folder BROWSER on `$HOME`.
  A failure is not surfaced: `inferHome` reads the shape of the paths at hand
  (`/home/<user>`, `/Users/<user>`, `/var/home/<user>`, `/root`, most frequent
  wins). With no home every absolute path falls into `other` — one
  undifferentiated bucket — so the fallback exists and is scoped like one:
  only the standard home parents count.
- **`sanitisePart` reaches the renderer via shared.** The name rules —
  `sanitisePart`, `sessionBaseName`, `resolveSessionName` and the aplexer tag
  fallback `resolveAplexerTag` — live in `src/shared/sessionNameParts.ts`,
  re-exported by `src/main/projects/sessionName.ts`, so both processes run the
  same regexes instead of duplicates. The renderer's live use is the rename
  field's as-you-type pass; the tab bar labels sessions verbatim (what the
  host lists is what the tab reads, shared/workspaceTabs.ts). Covered by
  tests/unit/sessionNameParts.test.ts.
- **Design gates** (tests/unit/designGates.test.ts): no new hex; no
  character-as-icon — the `+` marks are `AppIcon name="plus"`, and every dot
  remains a styled span.

## 9. Documentation to revise

- **docs/DESIGN.md, session-panel anatomy — still wrong.** Its blockquote
  still reads "Superseded by docs/SESSIONLIST.md (implemented). The two-level
  tree below is gone… The panel is now flat", and its table still retires
  `.folder-header` / `.disclosure` / the 28px indent. All three are back; the
  indent is 8px per level; the container-query floor is 270px, not 230px; and
  `.row-name` should be retired in its place.
- **docs/screenshots** — captures live untracked under `docs/screenshots/`.
  When recapturing, cover: two or more `$HOME` roots, ≥10 one-session folders
  under one of them, one folder holding 2+ sessions, a worktree-divergent
  name, one out-of-`$HOME` session, and one no-cwd session whose name names a
  real root (§4.6).

## 10. The current invariants

1. **Two levels, always.** Root → folder, with no size at which a level folds
   away. A folder holding one session still gets its row; the only node that
   stands alone is a session that has no directory at all (§3d).
2. **A folder row selects; it never toggles.** There is no collapse state in
   the panel and no `aria-expanded`, because there is nothing to expand. The
   root header is inert prose plus its `+` (§3a).
3. **`select` opens a folder workspace and carries the folder, plus an
   optional session name** for the just-created case (`SessionTree.vue` emits
   `[folder: SessionDirectory, session?: string]`, handled by
   `HostWorkspaceView.onSelectFolder`). The payload is stable across panel
   redesigns — the workspace side learns nothing of what changed here.
4. **The client never rearranges the list.** The order is the host's (§6.0)
   with the user's arrangement (§14) on top, and the projection is a fold of
   the list, not a sort of it — the client adds no movement of its own. A row
   moves only when the host says so or the user does, and both are on purpose.

## 11. Still open, and the alternative we did not build

- All width arithmetic uses nominal font metrics (13px UI ≈ 6.5px/char); the
  270px container-query breakpoint needs a live check at the user's DPI.
- **Whether an 8px step reads as nesting at all** at 13px UI type — VS Code's
  step, but VS Code draws indent guide lines and this panel does not. If it
  reads flat: a guide line or wider steps, not more levels.
- **Per-host roots against several differently-shaped hosts** (§12.2.4): a
  root registered for `hetzner` does not render on `aws`.
- **Whether §12.2.3 is the wrong call** — we keep the FULL directory as the
  middle level where the phone collapses to the first segment under the root.
- **How many of the `other` sessions §4.6 actually rescues**, and whether the
  root it picks is right. The user named three (`git-dtc-website-import`,
  `git-red-stamp-sound`, `git-game-tester`); all three should land under
  `git`. This is the one change whose failure mode is *confidently wrong*
  rather than merely unhelpful, so it deserves a look at the real panel.

### The alternative to §4.6: the phone's tree registry

The phone carries a durable **session → folder registry** the desktop never
calls: `pocketshell tree get` / `tree upsert` / `tree reconcile`, a daemon RPC
persisting `{session, order, folder_path, collapsed}` per node to an atomic
0600 JSON file under XDG state (`tools/pocketshell/src/pocketshell/tree.py`:
`get_tree` at :373-392, `upsert_tree` at :395-433; Kotlin client
`TreeRemoteSource.kt:58-66, :172, :206`). That would give a *recorded* folder
for a session whose cwd probe has gone quiet — the real fix, not a heuristic.
It is not a drop-in: on the phone it is a cold-start seed whose next reconcile
overwrites `folder_path` from the live probe, so adopting it as a no-cwd
fallback is new behaviour, not a port; it means writing on session create as
well as reading, or the registry is empty for everything that already exists;
and the checkout is v0.4.8-era while hosts run 0.4.44, so the command surface
is a lead to verify, not a contract. Cost: one new helper command in
`src/main/helper/commands.ts` plus a parser, an IPC route, a store field, and
an `upsert` on the create path — meaningfully more than `rootFromSessionName`,
and it fails closed (empty registry → today's behaviour) rather than fails
wrong. **Left for the user to decide.** §4.6 is deliberately shaped so it can
be deleted the day the registry lands.

## 12. Registered roots — the top level, configured

> "I also want to add other roots (like ~/tmp) and have a part of the tree for
> other sessions that don't start with existing roots. like in pocketshell app.
> the roots are registered in the settings"

**The root level stops being derived and becomes declared.** The user registers
roots in Settings — `~/git`, `~/tmp`, anything — and those are the panel's top
level, in the order they registered them. Everything under no registered root
goes to `other`, which keeps its existing job and its pinned-last position.
This is the phone's **watched roots** concept (§1 named it as the reason the
phone does not have the desktop's problem); the desktop had implemented only
the phone's no-watched-roots fallback, and §12 closed that gap.

### 12.1 What is ported from the phone, exactly

Matching semantics come from `FolderTreeProjection.kt` and are ported
verbatim, because they are the behaviour the user already knows:

| Rule | Phone | Here |
|---|---|---|
| Prefix match on a `/` boundary — `~/git` never claims `~/gitlab` | `pathWithinRoot`, :310 | `pathWithinRoot` |
| Longest match wins when roots nest; first-registered breaks a tie | `bestRootForPath`, :475-479 | `bestRootForPath` |
| A session sitting exactly ON a root belongs to it | `pathWithinRoot`, :310 | same |
| Unmatched folders go to a synthetic `other` root, appended last | :165-167, :276 | unchanged; pinned last (§6.0) |
| A registered root with no sessions still renders | roots are built by iterating the root list, :179-241 | roots are seeded before rows are placed |
| Label = the root's trailing segment | `defaultLabelForPath`, :41-50 | same function, already shared |

### 12.2 Where we diverge, and why

1. **No-roots fallback.** The phone, with zero watched roots, puts *everything*
   into one `Other folders` node (`FolderTreeProjection.kt:253-274`). We keep
   deriving roots from `$HOME`'s children instead. Empty means "derive", and
   the panel a user who never opens Settings sees is byte-identical to the one
   they had.
2. **Deduplication is on the RESOLVED key, not the stored spelling.** The phone
   dedupes with `distinctBy { it.path }` over stored paths
   (`FolderTreeProjection.kt:449`), so registering both `~/git` and
   `/home/me/git` gives two nodes that look identical and split the sessions
   between them by longest-match. `resolveRoots` folds them, because two
   identical branches is a bug however it is arrived at.
3. **The directory level keeps the FULL directory.** The phone collapses a
   session's folder to the first segment under its root
   (`projectPathUnderRoot`, :538), so `~/git/pocketshell/tools` groups under
   `pocketshell`. That is genuinely attractive — it makes the middle level mean
   *project* and bounds the tree by construction — but we did not take it, for
   now, because the middle level's meaning ("the directory this session
   actually runs in") is what §3b's label, §4.5's collision pass and the
   folder tooltip are all built on. **This is the divergence most likely to be
   wrong**, and it is cheap to revisit: it is one projection of the directory
   key.
4. **Roots are per host.** The phone keys `project_roots` by `hostId`
   (`ProjectRootEntity.kt:26-32`), and the desktop keys its map by the stable
   `~/.ssh/config` alias. A registered root is written home-relative, but
   `~/git` can exist on one instance and not on another. The alias is the
   identity that prevents one instance's layout appearing on another.
5. **No ordering hack.** The phone encodes position as a `[NN] ` prefix inside
   the label (`WatchedFoldersViewModel.kt:428-451`). A JSON array has an order
   already.
6. **Suggestions come from the session list, not a remote scan.** The phone
   runs a remote `ls` over three guessed parents
   (`WatchedFoldersViewModel.kt:397`); the Settings panel can open with no
   connection. Suggestions appear only for the currently connected host,
   whose already-loaded sessions are where the user's roots are.

### 12.3 Storage and normalisation

`settings.sessionRoots: Record<string, string[]>`, default `{}`, in the
existing `pocketshell.settings.v1` blob. The outer map is keyed by SSH config
alias and each value is the ordered root list for that host. Its parser rejects
only a non-object outright; inside the map, damage is per host and per entry
(`normaliseRootList`), so one hand-edited value costs that host's list and not
the other hosts' — the same per-key degradation rule the store already applies
per setting, one level down.

**Two forms, and the split is the point.** The **stored** form is what the
user typed, cleaned: trimmed, trailing slashes dropped, `..` refused rather
than resolved, control characters refused, and anchored to `/` or `~`.
`~/git` and `/home/alexey/git` are still two different stored strings, because
`$HOME` is per-host and at write time there is no home to fold them against.
The **resolved** form is `directoryKey(stored, home)` — *the same function*
that already folds tmux's two spellings of one directory into one node (§8).
Reusing it rather than writing a second normalisation is what stops the two
rules drifting: if `~` resolution ever changes, it changes in one place.
Dedupe happens here, on the resolved key.

An older build stored one shared array under `sessionRoots`. On load, that
array is migrated only when the saved `defaultHost` supplies an explicit host
owner; otherwise it is discarded rather than copied to every host. Any new
write uses the per-host map.

### 12.4 Decisions the two features force on each other

- **An empty registered root still renders**, with a `0` count and a muted
  "no sessions here yet" line under it. A registered root is a statement of
  intent — "this is where my work lives" — which stays true on a host where
  nothing is running there; a setting that silently shows nothing reads as a
  broken setting. `SessionRootFolder` carries `configured` so the panel can
  say "registered in Settings — nothing running here" rather than leaving a
  bare `0` to be interpreted.
- **Registered roots render in registered order; derived roots follow the
  host's list** (§6.0). A declared list is itself an ordering, and re-sorting
  it by anything would let the sessions store's refresh timer reshuffle the
  panel's top level under the user's cursor. With nothing declared,
  first-appearance order in the host's list is the only ordering there is.
- **The §4.6 name heuristic files into registered roots.** A REGISTERED root
  is stronger evidence than an inferred one, so with roots configured the
  candidate set is the registered list — a no-cwd session called
  `tmp-scratch` reaches `~/tmp` even when nothing else is running there. The
  constraint is unchanged in spirit: the heuristic still cannot create a
  root, it can only file into one that already exists.
- **Nesting is longest-match.** Register `~/git` and `~/git/work` and a session
  in `~/git/work/thing` lands under `work`: the more specific declaration is
  the more deliberate one.

### 12.5 The Settings control

A `Session panel` group: the registered list — each entry showing its
**stored spelling** in `--font-mono`, since that string is what the panel
matches against and a paraphrase would be a lie — with a `trash-2` remove
button, then a text field plus an `Add` button. The field is backed by a
`<datalist>` of the roots the current host's sessions run under, minus what is
already registered; typing is still allowed, because registering a root no
session has used yet is legitimate. Rejections are sentences, not a silent
no-op, and "already registered" and "list is full" are told apart, because
they call for different next actions.

---

## 13. ~~Why the panel's `+` does not ask which agent~~ (superseded — it chains)

Two dialogs exist and were deliberately kept apart (commit `00eb3e7`); §13a
records the chain that shipped, which of §13's objections held, and the
handoff that carries the agent choice across the route change.

| Dialog | Question it answers |
|---|---|
| `NewSessionDialog` | **which folder** — browse, create or clone one |
| `LaunchSessionDialog` | **which agent**, in a folder already chosen |

---

## 13a. It chains

The user asked for the chain in as many words — *"when I start a session in a
folder I want to select the agent, it should show this modal as in here"*,
pointing at the folder workspace's `+`. What shipped: **`NewSessionDialog`
defers its commit behind the agent step, and only the confirm creates.** The
one refinement is that the picker raises `LaunchSessionDialog` itself rather
than emitting a folder up to the panel — a folder that has travelled up to the
panel and back is a folder two components can disagree about.

**The ordering objection, answered.** §13's real objection was that the two
dialogs have incompatible orderings: `NewSessionDialog` creates when Start is
pressed, while `LaunchSessionDialog` creates nothing — it emits a validated
choice, so cancelling costs nothing and a malformed launch is caught *before*
anything exists on the host. The chain keeps both properties because every
route can NAME its folder before that folder exists: `targetFolder` already
predicted the mkdir's path and the clone's leaf (the session-name preview
needed it), so the agent question is asked on the prediction, and the mkdir,
the clone and `startSession` all wait behind the confirm. Cancelling at the
agent step leaves no folder, no clone and no session. The commit then
re-points the choice at the folder the **host** resolved before using it —
the clone route can land elsewhere (a repo already on disk comes back at its
real path), and `--dir` at a directory that is not there is precisely the
failure `shared/agentLaunch.ts` exists to make unrepeatable.

**The banner still ends the flow** and still does not auto-dismiss, because
both of the things it says are unreadable anywhere else: `via:
'tmux-fallback'` means the session was created with **no memory cap**, and
`code: 'folder-missing'` guards the helper trap where `-c` at a missing
directory exits 0 in `$HOME`. The chained dialog is raised *before* the
create, so there is nothing for it to stack on top of.

**The launch mechanism is still not the panel's to run.** `pendingLaunch`,
`LAUNCH_TIMEOUT_MS` and the `api.shell.input` call stay in
`FolderWorkspaceView`, next to the terminal. What crosses the route change is
the *choice*, parked in a one-slot handoff
(`src/renderer/pendingAgentLaunch.ts`) and collected by the workspace on
arrival — so "create" and "launch" are separated in time, and there is still
exactly one implementation of the trickiest part. Three properties of that
slot, because a launch is a line typed into somebody's shell:

- **It is keyed on connection AND session name.** Session names are derived
  from folders, so the same name exists on two hosts routinely.
- **A miss does not consume it.** The collector runs on every tab-bar change
  of every workspace the user passes through; eating the slot on "not mine"
  would lose the launch on the way to the right place.
- **It expires** (`LAUNCH_HANDOFF_TTL_MS = 120_000` — two minutes,
  pendingAgentLaunch.ts:83). The banner is a deliberate stop, so the TTL
  cannot be a latency budget the user loses by reading — but an abandoned flow
  must not fire a `claude` into a session minutes after anyone asked for it.
  The launch's own PTY deadline is a different clock and starts only once the
  workspace has collected the slot.

**A plain shell is still one click.** The commit bar carries two buttons:
`Start shell`, which commits with no choice at all, and `Start session…` —
ellipsis, this app's usual promise that a dialog follows — which chains.

**The two dialogs still do not drift**: both end at `shared/agentLaunch.ts`,
the only place that knows how to spell a flag, pinned against the captured
`--help`. The chain reuses `LaunchSessionDialog` whole — mounted *instead of*
the picker rather than on top of it, because two `OverlayPanel`s share a
z-index and both listen for Escape on `document`, so one keypress would have
closed two dialogs and thrown away the browse.

---

## 14. Rearranging folder rows

> "but I can also pull them up and down to rearraange"

The second half of the sentence §6.0 answers the first half of. The host's
order is what a row gets until the user moves it; a manual position wins once
there is one. `src/renderer/folderOrder.ts` is the whole rule, with
`tests/unit/folderOrder.test.ts` beside it.

### 14.1 The tab bar's same rule, one level up

The workspace's tab bar already solved this problem, and the shape is reused
rather than reinvented: `applyFolderOrder` is `applyTabOrder`,
`canDropFolderAt` is `canDropTabAt`, `reorderFolders` is `reorderTabs` — the
same native HTML5 drag turned ninety degrees, with the tab bar's rules intact:
the dragged row fades but stays in place, the landing place is a 2px accent
rule that flips at the row's midpoint, a refused drop draws nothing, and the
drag does not fight the click because native DnD suppresses the one that would
otherwise follow it. The two are one gesture in the user's hands.

**The stored value is a RANKING, not a list of rows** — with more force here
than in the tab strip, since the folder set changes when sessions are created
and killed AND on a five-second poll, across every root on the box. As a
ranking, a new folder is unranked and lands at the bottom of its root, a dead
folder is simply absent, and a key
naming nothing is inert.

### 14.2 A row may NOT leave its root

The one place the panel reaches a different answer from the tab bar, and for
a different kind of reason. The tab bar's session/files boundary is a
presentational grouping — "cheap to relax if that reading is wrong". A root is
not presentational: it is a real directory on the host, or one the user
registered in Settings, and a folder row sits under it because its working
directory is genuinely inside it (`bestRootForPath` / `rootForPath`). A row
dragged from `git` into `tmp` would claim something about where the folder
LIVES, and the row's own tooltip — which prints `dir.path` — would contradict
its position on screen the moment the user hovered it. The constraint is the
filesystem's; there is nothing to relax.

So the ranking is applied WITHIN each root and never across, and the ROOT
sequence is never touched by a drag either: roots render in registered order, or
by §6.0's creation key, with `other` pinned last. `canDropFolderAt` refuses a
cross-root drop **visibly**, while the drag is still in the air, because a drop
that is accepted and then snaps back reads as a bug rather than as a rule.

### 14.3 Where the order lives

The **settings store** (`AppSettings.folderOrder`), keyed by host alias:
`{ hetzner: ['~/git/dataops', '~/git/dtc-website', …] }` — **per host**, like
`sessionRoots`, and on the `~/.ssh/config` alias rather than the connection
id, because a connection id is an opaque handle minted per connect: a
preference keyed on it would be a fresh key every launch and would never
survive a restart.

**The settings store rather than `localStorage`**, which is where the tab
order went: this is a per-host map the PANEL has to read before any workspace
is mounted, and the settings store already loads a validated per-user blob
synchronously at construction — splitting it across N `localStorage` keys
would mean the panel enumerating storage to find them. The store's
conventions are followed in full: one spec entry, a parser that degrades per
host and per key, and a reference default copied on the way out. An empty
arrangement REMOVES the host's entry rather than storing `[]`, because "this
host is not arranged" and "there is no entry for it" are one state.

**A key that is not on screen is dropped**, because a drag writes the whole
panel's rows in draw order. That costs nothing — an unranked folder sorts to
the bottom of its root anyway — while retaining stale keys would buy the same
position at the price of a list that only grows.

### 14.4 One derivation, or the chord and the panel disagree

The ranking is applied in `src/renderer/folderTree.ts`, **not** in the component
— on top of `groupSessionsIntoRoots` and below both readers. That file's header
already explains why the tree is derived once: `Ctrl+↑`/`Ctrl+↓` walk
`useFolderTree().folders`, and a chord navigating by a second derivation opens a
workspace with no tabs and highlights no row. A manual order is the same hazard
in a new coat. It is applied as a **pure projection** re-run on every recompute,
never as a mutation of the row list — that is what makes a drag survive the poll
rather than race it: the store holds a ranking, the poll brings a fresh list, and
the two are combined again from scratch five seconds later.

---

## 15. The root header names its directory

> "for git and tmp let's show ~/git ~/tmp (~/ part can be somewhat muted) and
> move 10 closer to git"

**The header prints the root's KEY, not its label** — `~/git` rather than
`git`, via `rootHeaderParts` in `sessionGrouping.ts` (a split, not a
computation: the key has always been home-relative (§8) and the tooltip has
always printed it). The `~/` goes in its own span at `--fg-muted`: it is the
fragment every root repeats, so it is the fragment that should recede.

Three keys carry no `~/` and must not be given one:

- **`other`** is a bucket, not a directory, and keeps its word and its
  `--fg-secondary` styling. `~/other` would name a folder that exists nowhere;
- **`$HOME` itself**, registrable as `~`, keeps `defaultLabelForPath`'s named
  form `~ (home)`. Splitting it would leave a muted `~` and an empty remainder
  — a header whose only legible content is the part meant to recede;
- **a registered root outside `$HOME`** (`/srv/apps`) renders its absolute key
  verbatim. Same promise, kept for a root whose real directory is not under
  home.

A side effect worth noting: two roots cannot share a key (`resolveRoots`
dedupes on it), so two headers can no longer read alike.

**The count sits beside the label**, not the right edge — the `auto` moved to
the two elements that genuinely want the right edge (the root row's `+` and
the folder row's timestamp), each a column the eye reads down. `.label` drops
to `flex: 0 1 auto` so it still shrinks first but no longer grows to push the
count away.

**The folder rows match**: their count moves ahead of the agent badges
(§3b field 4), because a count that hugged its label on the header and floated
right on the rows beneath would be two conventions in one list.
