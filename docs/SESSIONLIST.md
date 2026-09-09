# SESSIONLIST.md — Session panel: the folder view

Status: **current.** The panel is `root -> folder`, TWO levels, rendered in
the host's order and draggable. The requirement that produced this shape, in
the user's words:

> "git -> folder -> session"

The row model is `src/renderer/sessionGrouping.ts` (+ `sessionRoots.ts`,
`sessionTree.ts`, `folderTree.ts`); the component is `SessionTree.vue`. This
file holds the invariants, the rejected alternatives, and the decisions the
code cannot show.

---

## 0. The shape, and why the session level is gone

Earlier designs had three levels — `root -> directory -> session` — and
before that a conditional tree whose shape depended on its contents. All
gone: the panel is `root -> folder`, one row per folder, unconditionally —
so a reader can predict the panel's shape without knowing what is running.
Clicking a folder row opens a folder WORKSPACE whose tab bar carries every
session in that folder; the SESSION level only ever earned its rows by being
*the only way to reach a session*, and under the folder workspace selecting
a session became a tab operation. §1's measurement puts a number on it: 22
rows became 11, and the count no longer grows when a folder gains a second
session. The surviving principle, from the design that retired the level:
**a level must earn its rows.**

Three later corrections, each owning its section: the panel stops sorting —
the order is the host's (§6.0); the panel stops truncating creatively —
ordinary end-ellipsis plus the row tooltip (§5); and rows are draggable (§14),
the root header names its directory (§15). One fix the three-level design
could not make: a session whose cwd probe went quiet used to render as an
orphan; under the folder view an unplaced session is a session with no
workspace at all, because everything keys on the folder.
`inferPathsFromSiblings` (`src/main/helper/parsers.ts`) gives such a session
the directory of the session whose name it extends, and
`diagnoseSessionPaths` logs why the probe failed to place it.

## 0a. Creation moves onto the rows

A `+` on every root row, plus a general `+` in the header strip with nothing
pre-filled — the second is on screen whatever the panel holds, including a
host with no sessions at all. The root-row `+` opens the same folder-first
picker, rooted at THAT root and one level in: the user has said which root,
the folder under it is still an open question, and it is never guessed —
guessing is how a session ends up somewhere the user did not choose. The
root key is home-relative by construction (§8) and the picker browses over
SFTP, which runs no shell, so `~/git` has to be expanded before it is handed
over (`rootHostPath` in `sessionGrouping.ts`). Two cases handled
deliberately differently: the `other` bucket gets **no `+` at all** (it is
where paths that matched no root went, not a directory), and a root whose
host path cannot resolve gets a **disabled** `+` whose tooltip says why — a
control that vanishes on a failed fetch reads as a feature that is not
there. The mark is revealed on hover/focus by `opacity`, never `display`,
so the label never reflows under the cursor; it is deliberately not keyed on
whether the root is empty, because `directories.length` moves under the
refresh timer. The old foot button is deleted — it spent a bordered 44px
row, permanently, on one action.

---

## 1. The problem, from real data

Against the user's real dev box the distribution was **11 folders, every one
holding exactly one session**. The failures compounded: a header whose
entire content is one session cost a row and a disclosure affordance to
convey zero information; the two lines were near-duplicates BY CONSTRUCTION,
because the session name is derived from the folder path — `~/git/dataops`
→ `git-dataops` (`sessionBaseName`) — so folder `dataops` + session
`git-dataops` is the same fact twice; and folder and session name can
diverge outright (git worktree: folder `merry-sniffing-tortoise`, session
`git-dtc-website`).

The phone does not have this problem because its top level is **watched
project roots**, not individual folders — roots have real fan-out (`~/git`
holds all 11). The desktop had implemented only the phone's
no-watched-roots fallback; §12's registered roots closed that gap.

## 2. Position — the rejections that still bind

Grouping by ROOT, then directory, then session as header-plus-rows, is what
the panel grew out of; the level count changed, these rejections did not:

- **Group by agent kind or recency bucket** — agent kind is a badge, and
  recency is no sort at all any more (§6.0).
- **Recovering the DIRECTORY from a session name** — see §4.6. The
  derivation is not invertible past the first component, and a guessed
  directory row is worse than none.
- **A FOURTH level (nesting `~/git/a/b` under `~/git/a`)** — nothing in the
  real data has it, and it would spend a row on a node holding no session
  of its own. Two levels is where nesting stops.
- **Auto-collapsing a directory once the list is long** — a rule that
  removes a level at exactly the distribution that motivated it.

## 3. Row anatomy

Two row types — the root header (§3a) and the folder row (§3b) — plus the
degenerate untracked variant (§3d), all height `--row-h`. Two levels,
floored at a 232px panel; the indent step is **8px** (VS Code's), the root
header's dot at 12px, the folder row's at 20, and both labels follow their
dot at a constant 16px, so the two levels share one rhythm. At the 232px
floor that leaves 186px for a folder row's label, badges, count and time.

**§3a Root header** — a plain `div`, **not a button, no disclosure mark**: a
root row is a grouping HEADER over its folders, and a chevron would
advertise an interaction that does not exist. Fields: the 8px status dot
(`--success` when any session under the root is attached — on a registered
root with nothing running it is the difference between "quiet" and "not
loaded"); the root's KEY as label (§15); a bare-integer count immediately
after the label; the `+` (§0a) at the right edge. Tooltip: the key + `N
sessions`; an empty registered root says `registered in Settings — nothing
running here` (§12.4); `other` says `sessions outside every root, or with
no known folder`.

**§3b Folder row** — a `<button>`, the panel's SELECTABLE row. Clicking it
opens that folder's workspace; there is no toggle and no `aria-expanded`,
because there is nothing to expand. It is also the drag source (§14) and the
context-menu anchor. Fields: 2px selection rail (accent when current);
**aggregate** status dot for the folder; the directory's own name — its
trailing path component, never the full path, never a session name; a count
**only from 2 up** (a `1` beside a row that stands for at least one session
is a dead field); up to two agent badges; the NEWEST activity as a compact
relative time at the right edge. Row tooltip: the full path + session NAMES
(up to six, then `… and N more`) — the names live here because they are no
longer on screen; the workspace's tab bar carries them, behind a click.

**§3d Untracked row** — a no-cwd session is modelled as a degenerate
directory (§8) and DRAWS as the folder row, label in mono — the session
name, the only label it has — fully selectable. The test is not "this folder
holds one session"; it is "there is no directory".

## 4. Display-label rules

1. **A folder row never shows a session name** (its tooltip lists them,
   §3b), and the tab bar labels sessions — so the old "is this name just its
   folder restated?" question has a structural answer; no derivation test
   gates any rendering.
2. **Divergence** (worktree, custom name): the folder row says the folder's
   name and its tooltip lists the session; the tab bar labels the session.
   Neither label fights the other for width.
3. **Label collision** (two directories, same basename): a post-pass
   prepends parent segments until unique — over DIRECTORIES, scoped per
   root (per root because two headers already tell `~/git/foo` from
   `~/work/foo` apart). Nodes are keyed by path; labels are display-only.
4. **Untracked**: each untracked session is its own folder row (§3d) — not
   merged into one branch, not given a header of its own (which would carry
   the identical string). The phone merges them; we diverge knowingly.
5. **§4.6 No reported cwd → recover the ROOT from the NAME.** `path` comes
   back null when tmux reports neither an active-pane cwd nor a
   `session_path`. But this app *derives* session names from paths —
   `~/git/red-stamp-sound` becomes `git-red-stamp-sound` — so the leading
   component of the name is the root, and `rootFromSessionName` reads it
   back. Three constraints keep it honest:
   - **Root only, never the directory.** The derivation is not invertible
     past the first component (`-` is both separator and a legal character
     inside one), so a name-recovered session sits as a direct child of the
     root, with no directory node invented for it.
   - **Only roots that exist from real paths or the registered list.** The
     heuristic may place a session, never create structure.
   - **It says so.** The tooltip reads `no reported folder — root read back
     from the name`. A guess presented as a reported cwd is the kind of
     thing that costs an hour.

   Everything still unplaceable stays in `other`, which is what keeps
   `other` honest rather than a dumping ground. The phone does none of this;
   adopted because the phone's behaviour IS the behaviour the user
   complained about. §11 holds the durable-registry alternative.

## 5. Truncation

Directory and folder labels end-truncate with the ordinary CSS ellipsis and
lean on the row tooltip for the full name. Middle truncation was specced
first — siblings in one folder share a derived prefix, so end-ellipsis
renders `pocketshell` and `pocketshell-desktop` identically — and the user
overturned it: a squeezed `course-manage…nt-agent` reads as a mangled
single name, and the tooltip redeems whatever the ellipsis hides. The
`splitLabel` helpers are still exported but no longer consumed by the
renderer.

## 6. Timestamp, order, and finding "the session I was just in"

Timestamps render compact-relative (`12m`, `3h`, `2d`, then a date), max ~6
characters; the absolute form lives in the tooltip, and the strings refresh
from a `now` ref ticked every 60s. Times run in no particular direction
down a root — a real loss, paid deliberately, because there is no
client-side sort at all.

### 6.0 What ships: the host's order

> "let's not rearrange workspaces/sessions in here because it's confusing.
> let's use wheveer order we had when creating."

That sentence produced creation order, and its successor ships now: **the
panel orders nothing at all.** Main asks the host to sort the listing (`a
list --sort`, default `accessed`) and every level of the panel preserves the
document order of the list the store receives — the projection
(`buildRows` / `buildDirectories` / `groupSessionsIntoRoots`) is a fold, not
a sort; there is not one comparator left in the path. `a` owns the
timestamps, so it owns the order they produce. Compatibility: a host whose
`a` predates `--sort` has its unsorted snapshot straightened oldest-first in
`PocketshellClient`; the legacy no-`a` path is pinned to that same creation
order. The order contract lives in main: `listSessions` returns the list
already in the order the panel shows.

**The tab bar kept creation order, deliberately.** Its stability argument is
the general lesson: rows that are HIT TARGETS may not reorder themselves
under the cursor — the recency sort died the day arrow-key navigation made
the panel's rows targets too. The panel's rows are the host's list; the
bar's rows are hit targets. `Ctrl+↑` / `Ctrl+↓` walk the panel's list,
which is exactly why nothing client-side may rearrange it. The marks that
answer "the session I was just in" without moving anything: the green dot,
the semibold label, the accent rail on the open folder.

## 7. Panel width

Default 280, persisted in `localStorage` under `pocketshell.sessionPanelWidth`,
clamped 232–560 on read as well as write. Below the container-query floor
(270px) the timestamp drops first — the least operational field now that
position no longer implies recency. **The rule stays unscoped**, so a root
header's aggregate age drops at the same width its children drop theirs; a
header still showing a time above rows that lost theirs would read as a
separate fact.

## 8. Implementation notes

- **Three projections, one row builder.** `groupSessionsIntoRoots` (the
  panel), `groupSessionsByFolder` (the phone-parity leaf grouping the
  creation flow speaks), and the workspace tabs all go through one private
  `buildRows`, so they cannot disagree about a label; each projection
  applies `disambiguateLabels` over its own scope (§4.3), because the
  correct scope differs.
- **Keys at both levels are home-relative.** `~/git/dataops`, not the
  absolute path: tmux reports one directory two ways (the active-pane cwd
  and the literal `~/...` a `session_path` can carry), and without the fold
  it renders as two identically labelled rows. `canonicalisePath`
  deliberately never expands `~` — this is the one place it is resolved,
  and the grouping key and the displayed path stay separate.
- **`other` is honest, not a dumping ground:** paths outside `$HOME`,
  sessions in `$HOME` itself, and sessions with neither a path nor a name
  that names a real root. `$HOME` itself renders as `~ (home)` — a row
  reading `alexey` looks like a user, not a project.
- **`$HOME` is fetched, then inferred.** A failure is not surfaced;
  `inferHome` reads the shape of the paths at hand. With no home every
  absolute path falls into `other`.

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
   the list, not a sort of it. A row moves only when the host says so or the
   user does, and both are on purpose.

## 11. Still open, and the alternative we did not build

- All width arithmetic uses nominal font metrics; the 270px breakpoint needs
  a live check at the user's DPI.
- **Whether an 8px step reads as nesting at all** — VS Code's step, but VS
  Code draws indent guide lines and this panel does not. If it reads flat: a
  guide line or wider steps, not more levels.
- **Per-host roots against several differently-shaped hosts** (§12.2): a
  root registered for `hetzner` does not render on `aws`.
- **Whether keeping the FULL directory as the folder level is the wrong
  call** — the phone collapses to the first segment under the root (§12.2).
- **How many of the `other` sessions §4.6 actually rescues**, and whether
  the root it picks is right. The user named three; all three should land
  under `git`. This is the one change whose failure mode is *confidently
  wrong* rather than merely unhelpful.

### The alternative to §4.6: the phone's tree registry

The phone carries a durable **session → folder registry** the desktop never
calls: `pocketshell tree get` / `tree upsert` / `tree reconcile`, persisting
`{session, order, folder_path, collapsed}` per node to an atomic 0600 JSON
file. That would give a *recorded* folder for a session whose cwd probe has
gone quiet — the real fix, not a heuristic. Not a drop-in: on the phone it
is a cold-start seed whose next reconcile overwrites `folder_path` from the
live probe, so adopting it as a no-cwd fallback is new behaviour; it means
writing on session create as well as reading; and the helper command surface
is a lead to verify, not a contract. Cost: one helper command, a parser, an
IPC route, a store field, an upsert on the create path — meaningfully more
than `rootFromSessionName`, and it fails closed rather than fails wrong.
**Left for the user to decide.** §4.6 is deliberately shaped so it can be
deleted the day the registry lands.

## 12. Registered roots — the top level, configured

> "I also want to add other roots (like ~/tmp) … the roots are registered in
> the settings"

**The root level stops being derived and becomes declared.** The user
registers roots in Settings — those are the panel's top level, in registered
order; everything under no registered root goes to `other`, pinned last.
This is the phone's watched-roots concept (§1).

**Ported verbatim from the phone**, because it is the behaviour the user
already knows: prefix match on a `/` boundary (`~/git` never claims
`~/gitlab`); longest match wins when roots nest, first-registered breaks a
tie; a session sitting exactly ON a root belongs to it; a registered root
with no sessions still renders.

**Where we diverge, and why:**

1. **No-roots fallback derives from `$HOME`'s children** instead of one
   `Other folders` node — empty means "derive", so the panel a user who
   never opens Settings sees is unchanged.
2. **Deduplication on the RESOLVED key, not the stored spelling** —
   registering both `~/git` and `/home/me/git` folds to one node (`resolveRoots`);
   two identical branches is a bug however arrived at.
3. **The folder level keeps the FULL directory** where the phone collapses
   to the first segment under the root. Genuinely attractive — it would make
   the level mean *project* — but the full directory is what the row label,
   the collision pass and the tooltip are built on. **This is the divergence
   most likely to be wrong** (BACKLOG open question), and cheap to revisit:
   one projection of the directory key.
4. **Roots are per host**, keyed by the `~/.ssh/config` alias — `~/git` can
   exist on one instance and not another, and the alias is the identity that
   keeps one instance's layout off another.
5. **No ordering hack** (the phone encodes position as a `[NN] ` label
   prefix; a JSON array has an order already). **Suggestions** come from the
   current host's sessions, not a remote scan — the Settings panel can open
   with no connection.

**Storage:** `settings.sessionRoots: Record<hostAlias, string[]>`, damage
degrading per host and per entry. **Two forms, and the split is the point:**
the stored form is what the user typed, cleaned (trimmed, `..` refused, not
resolved against a home that may not exist); the resolved form is
`directoryKey(stored, home)` — *the same function* that folds tmux's two
spellings of one directory (§8). Reusing it is what stops the two rules
drifting: if `~` resolution ever changes, it changes in one place.

**Decisions the two features force on each other:** an empty registered root
still renders, with a muted "registered in Settings — nothing running here"
(a registered root is a statement of intent, which stays true when nothing
runs); registered roots render in registered order and derived roots in
host-list order (a declared list is itself an ordering; §6.0); the §4.6
name-heuristic files into registered roots preferentially (a registered root
is stronger evidence than an inferred one) but still cannot create one;
nesting is longest-match — the more specific declaration is the more
deliberate one. The Settings control shows each root's **stored spelling**
in mono, since that string is what the panel matches against; rejections are
sentences, and "already registered" and "list is full" are told apart.

---

## 13. Creation: two dialogs, one chain

Two dialogs exist and deliberately stay apart: **`NewSessionDialog`** answers
*which folder* (browse, create or clone one) and **`LaunchSessionDialog`**
answers *which agent*, in a folder already chosen. They chain — §13a.

## 13a. It chains

The user asked for the chain in as many words: starting a session in a
folder should offer the agent choice. What shipped: **`NewSessionDialog`
defers its commit behind the agent step, and only the confirm creates.**
The chain is safe because every route can NAME its folder before that folder
exists — `targetFolder` already predicted the mkdir's path and the clone's
leaf for the session-name preview — so the agent question is asked on the
prediction, and the mkdir, the clone and `startSession` all wait behind the
confirm; cancelling at the agent step leaves no folder, no clone and no
session. The commit then re-points the choice at the folder the **host**
resolved before using it — a clone can land elsewhere, and `--dir` at a
missing directory is precisely the failure `shared/agentLaunch.ts` exists to
make unrepeatable (the finding: a dialog that can NAME what it is about to
create can defer creating it; the prediction is never trusted).

**The banner still ends the flow** and does not auto-dismiss: `via:
'tmux-fallback'` means the session was created with **no memory cap**, and
`code: 'folder-missing'` guards the helper trap where `-c` at a missing
directory exits 0 in `$HOME`.

**The launch mechanism is not the panel's to run.** What crosses the route
change is the *choice*, parked in a one-slot handoff
(`src/renderer/pendingAgentLaunch.ts`) and collected by the workspace on
arrival — "create" and "launch" separated in time, one implementation of the
trickiest part. Three properties of that slot, because a launch is a line
typed into somebody's shell: it is keyed on connection AND session name
(derived names collide across hosts); a miss does not consume it (the
collector runs on every tab change the user passes through); and it expires
after two minutes — an abandoned flow must not fire a `claude` into a
session minutes later. The commit bar carries `Start shell` (no choice) and
`Start session…` (chains). The chain reuses `LaunchSessionDialog` whole,
mounted *instead of* the picker rather than on top of it — two `OverlayPanel`s
share a z-index and both listen for Escape on `document`, so one keypress
would have closed two dialogs (BACKLOG finding).

---

## 14. Rearranging folder rows

The host's order is what a row gets until the user moves it; a manual
position wins once there is one. `src/renderer/folderOrder.ts` is the whole
rule, with `tests/unit/folderOrder.test.ts` beside it.

**The stored value is a RANKING, not a list of rows** — the folder set
changes on every create, kill and five-second poll, across every root. As a
ranking, a new folder is unranked and lands at the bottom of its root, a
dead folder is simply absent, and a key naming nothing is inert. The
mechanics reuse the tab bar's drag (`applyFolderOrder` is `applyTabOrder`):
the dragged row fades in place, the landing place is a 2px accent rule that
flips at the midpoint, a refused drop draws nothing, and native DnD
suppresses the click that would otherwise follow.

### 14.2 A row may NOT leave its root

The one place the panel reaches a different answer from the tab bar. The tab
bar's session/files boundary is presentational — cheap to relax if that
reading is wrong. A root is not presentational: it is a real directory on
the host, or one the user registered, and a folder row sits under it because
its working directory is genuinely inside it. A row dragged from `git` into
`tmp` would claim something about where the folder LIVES, and the row's own
tooltip would contradict its position the moment the user hovered it. The
constraint is the filesystem's; there is nothing to relax. The ROOT sequence
is never touched by a drag either: roots render in registered order (§12),
`other` pinned last. `canDropFolderAt` refuses a cross-root drop **visibly**,
while the drag is still in the air — a drop that is accepted and then snaps
back reads as a bug rather than as a rule.

### 14.3 Where the order lives

The **settings store** (`AppSettings.folderOrder`), keyed by host alias —
per host, like `sessionRoots`, and on the alias rather than the connection
id, because a connection id is an opaque handle minted per connect: a
preference keyed on it would never survive a restart. An empty arrangement
REMOVES the host's entry rather than storing `[]` — "not arranged" and "no
entry" are one state. A key that is not on screen is dropped: a drag writes
the whole panel's rows in draw order, and retaining stale keys would buy the
same position at the price of a list that only grows.

### 14.4 One derivation, or the chord and the panel disagree

The ranking is applied in `src/renderer/folderTree.ts` — on top of
`groupSessionsIntoRoots` and below both readers (the panel and the
`Ctrl+↑`/`Ctrl+↓` chord walk the same tree; a second derivation would open a
workspace with no tabs and highlight no row). It is applied as a **pure
projection** re-run on every recompute, never as a mutation of the row list
— that is what makes a drag survive the poll rather than race it.

---

## 15. The root header names its directory

> "for git and tmp let's show ~/git ~/tmp (~/ part can be somewhat muted)"

**The header prints the root's KEY, not its label** — `~/git` rather than
`git` (`rootHeaderParts`). The `~/` goes in its own muted span: it is the
fragment every root repeats, so it is the fragment that should recede. Three
keys carry no `~/` and must not be given one: `other` is a bucket, not a
directory (`~/other` names a folder that exists nowhere); `$HOME` itself
keeps the named form `~ (home)` (splitting it would leave a muted `~` and an
empty remainder); a registered root outside `$HOME` renders its absolute key
verbatim. The count sits beside the label, not the right edge — the right
edge belongs to the `+` and the timestamp, each a column the eye reads down;
folder rows match, so one list carries one convention.
