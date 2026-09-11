<script setup lang="ts">
// SessionTreeRows: the session panel's rows — the root sections with their
// folder rows, the drag-to-reorder handlers, and the panel's empty state.
// Extracted from SessionTree.vue with its reasoning; the parent keeps the
// chrome: the header strip, the row menu, the stop flow and the creation
// dialog. The tree's design doc (why the panel is root -> folder and nothing
// deeper) lives in the parent's header, which is where the revision was
// written down.
//
// Scoped styles do not cross a component boundary, so every rule this markup
// uses is carried here from SessionTree.vue's stylesheet; the parent keeps
// only the rules for the chrome it still renders.
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';
import { useFolderTree } from '../folderTree';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import { rootHostPath } from '../sessionRoots';
import { rootHeaderParts, type SessionDirectory, type SessionRootFolder } from '../sessionTree';
import { agentBadges, dirTooltip, fmtRelative, rootTooltip } from '../sessionTreeText';
import { useFolderDrag } from '../useFolderDrag';

const props = defineProps<{
  /**
   * Key of the folder whose workspace is open, so its row can be marked.
   * A `SessionDirectory.key` — selection is a FOLDER fact.
   */
  activeFolder?: string | null;
  /** The panel's minute clock (`useSessionTreePoll`), for the relative ages. */
  now: number;
  /**
   * Where the empty state's "New session…" starts the picker: the panel's
   * first root, or null for the dialog's own `$HOME` behaviour.
   */
  defaultStartIn: string | null;
}>();

/**
 * The rows announce; the parent disposes. A click opens a folder's workspace,
 * a right-click opens the row menu whose state the parent owns, and the two
 * `+`s hand the folder they resolved to the ONE creation flow, which lives in
 * the parent with the dialog.
 */
const emit = defineEmits<{
  select: [folder: SessionDirectory];
  menu: [dir: SessionDirectory, e: MouseEvent];
  create: [startIn: string | null];
}>();

// The same derivation the parent renders from — one code path, two component
// instances reading it. See ../folderTree.ts for why this is not private to
// either of them.
const { home, host, roots } = useFolderTree();

/**
 * The roots, each paired with its header text already split for the muted `~/`.
 *
 * Paired here rather than called three times inside the `v-for` — once for the
 * `v-if`, once for the prefix, once for the rest. The cost is nothing (a handful
 * of roots, a four-line pure function), but the template is where this panel's
 * decisions are written down and a line that says `rootHeaderParts(root).prefix`
 * twice in a row reads as an accident rather than as a rule.
 */
const rootRows = computed(() =>
  roots.value.map((root) => ({ root, header: rootHeaderParts(root) })),
);

/**
 * The absolute host directory a root's `+` would start the picker in, or null
 * when the root names no directory we can resolve.
 *
 * Null has two causes and they are not the same. `other` is a BUCKET — the
 * sessions that matched no root — so there is no place to create anything in;
 * the template does not render a `+` on it at all. The second is a `~`-keyed
 * root on a host whose `$HOME` never resolved and could not be inferred from
 * the paths either, and there the `+` renders DISABLED rather than vanishing:
 * the control is real, the host is temporarily unable to answer, and a button
 * that disappears on a failed fetch reads as a feature that is not there.
 */
function rootAddPath(root: SessionRootFolder): string | null {
  return rootHostPath(root.key, home.value);
}

const sessions = useSessionsStore();
const settings = useSettingsStore();

// The drag's state, handlers and reasoning moved whole into ../useFolderDrag.ts;
// this binds them to the rows.
const { dragging, dropTarget, onRowDragStart, onRowDragOver, onRowDrop, onRowDragEnd } =
  useFolderDrag({ roots, host, settings });
</script>

<template>
  <!-- `dragend` sits on the LIST, not on the row: it fires on the source
       element and bubbles, so one listener here covers every row and — more
       to the point — covers the cancelled drag, where the pointer was
       released over something that is not a row at all. Without it a drag
       abandoned over the header would leave the dragged row faded forever.
       Same placement, same reason, as the tab strip's `<nav @dragend>`. -->
  <div class="folder-list" @dragend="onRowDragEnd">
    <section v-for="{ root, header } in rootRows" :key="root.key" class="folder">
      <!-- A plain element, not a <button>, and no disclosure mark: now that
           sessions live in workspace tabs the panel is root -> folder, and a
           root row is a grouping HEADER over its folders rather than a node
           with something hidden under it. A chevron here would advertise an
           interaction that does not exist, so the row is not interactive at
           all — the tooltip is the only thing it still offers, and it carries
           real information (the root's path and its size).

           ROOT ROWS ARE DELIBERATELY ALWAYS OPEN. If collapsing ever comes
           back, it must NOT be driven off the root list: `roots` recomputes
           every time the sessions store refreshes on its timer, so anything
           that reopens roots on recompute would reopen one the instant the
           user closed it. The state removed here dodged that by watching the
           ACTIVE FOLDER instead, so a deliberate collapse survived until the
           user navigated somewhere else. That is the trap, written down. -->
      <div class="folder-header" :title="rootTooltip(root)">
        <!-- The dot is how a root reports attachment in ONE mark: a reader
             scanning the headers sees which roots have something live in them
             without reading the folder rows underneath, and on a registered
             root with nothing running it is the difference between "quiet"
             and "not loaded". -->
        <span class="dot" :class="{ active: root.active }" />
        <!-- The header names the real directory — `~/git`, not `git` — with
             the `~/` in its own span so it can recede. It is the part every
             root repeats, so it is the part worth toning down; see
             `rootHeaderParts` for the three keys that carry no `~/` at all
             and must not be given one. -->
        <span class="folder-label" :class="{ bucket: root.other }">
          <!-- No whitespace between the two: a newline here is a text node,
               and the header would read `~/ git`. -->
          <span v-if="header.prefix" class="path-prefix">{{ header.prefix }}</span>{{ header.text }}
        </span>
        <!-- Beside the label, not pinned to the right edge. A count thrown to
             the far end of the row reads as its own column — "10" floating
             level with `git` but nowhere near it — and the user asked for it
             back: "move 10 closer to git". The `+` takes over the
             `margin-left: auto` and keeps the right end of the row. -->
        <span class="folder-count muted">{{ root.sessionCount }}</span>
        <!-- Per-root `+`: create a session UNDER THIS ROOT. It opens the same
             folder picker the header's `+` does, one level in — the root is
             known, the folder is not, and guessing a directory from a root is
             how you get a session in the wrong place.

             NOT on `other`. That row is a bucket for paths that matched no
             root, not a directory, so there is nowhere for the picker to
             start; the header's `+` already covers "somewhere else".

             `@click.stop` even though the row takes no click today. The row
             is deliberately inert (see the comment above), but "deliberately"
             is a decision that can be revisited, and a `+` that also selects
             the row it sits on is a bug that would arrive silently the moment
             it were. One modifier now, or a mystery later.

             `:title` carries the destination, because the mark alone cannot
             say WHICH root it belongs to once the eye is on the right of the
             row rather than the left. -->
        <button
          v-if="!root.other"
          class="icon-btn sm root-add"
          :disabled="rootAddPath(root) === null"
          :title="
            rootAddPath(root) === null
              ? `cannot resolve $HOME on this host, so ${root.label} has no directory to start in`
              : `New session in ${root.key}`
          "
          @click.stop="emit('create', rootAddPath(root))"
        >
          <AppIcon name="plus" :size="12" />
        </button>
      </div>

      <ul class="dir-list">
        <!-- Only a REGISTERED root can be empty; a derived one exists because
             a session is in it. Saying so beats a header with nothing under
             it, which reads as a failed load — and there is no collapsed
             state left to blame it on. -->
        <li v-if="!root.directories.length" class="empty-root muted">no sessions here yet</li>

        <!-- ONE ROW PER FOLDER. Not a header over a list any more: the row
             IS the destination, and what used to be its children are the
             tabs in the workspace it opens. Rendered as a <button> because
             it is a control that navigates, and marked `current` by the
             folder key so a workspace holding four session tabs still
             highlights exactly one row. -->
        <!-- The drop indicator lives on the `<li>`, not on the button: the
             button already spends its left border on the selection rail, and
             a landing rule drawn on the same element would have to fight it
             for the one border the row has. -->
        <li
          v-for="(dir, i) in root.directories"
          :key="dir.key"
          :class="{
            'drop-above': dropTarget?.root === root.key && dropTarget.gap === i,
            'drop-below':
              dropTarget?.root === root.key &&
              dropTarget.gap === root.directories.length &&
              i === root.directories.length - 1,
          }"
        >
          <!-- `draggable` for the "pull them up and down" drag. It changes
               nothing about the click, the context menu or the keyboard —
               see the drag section in the script for why each of those is
               safe rather than merely untested. -->
          <button
            class="dir-header"
            :class="{
              current: dir.key === props.activeFolder,
              orphan: dir.untracked,
              attached: dir.active,
              dragging: dragging === dir.key,
            }"
            :title="dirTooltip(dir)"
            draggable="true"
            @click="emit('select', dir)"
            @contextmenu.prevent="emit('menu', dir, $event)"
            @dragstart="onRowDragStart(dir, $event)"
            @dragover="onRowDragOver(root, i, $event)"
            @drop.prevent="onRowDrop"
          >
            <!-- The dot says "something live is in here". It used to be an
                 aggregate standing in for a collapsed branch; now it is the
                 only place the panel reports attachment at all, because the
                 sessions it belonged to are no longer rows. -->
            <span class="dot" :class="{ active: dir.active }" />
            <!-- One span, one CSS ellipsis: when the row runs out of width
                 the label degrades to `course-managemen…` and the tooltip
                 carries the full name (the full path) on hover. An untracked
                 folder is labelled by its session name, which is the only
                 label it has. -->
            <span class="label" :class="{ mono: dir.untracked }">{{ dir.label }}</span>
            <!-- Counted only from 2 up. The `1` is the dead field the original measurement ruled out — see
                 SESSIONLIST measured: every folder row stands for at least
                 one session, so saying so on most of them is noise.
                 IMMEDIATELY AFTER THE LABEL, ahead of the badges, for the
                 same reason the root's count moved: a reader scans ONE column
                 of rows, and a count that hugs its label on the header row
                 and floats to the right edge on the rows underneath would be
                 two conventions in one list. The badges follow, and the time
                 keeps the right edge. -->
            <span v-if="dir.rows.length > 1" class="folder-count muted">
              {{ dir.rows.length }}
            </span>
            <span
              v-for="badge in agentBadges(dir)"
              :key="badge"
              class="agent-badge"
              :class="{ dim: badge === 'probing…' || badge === 'exited' }"
            >
              {{ badge }}
            </span>
            <!-- The folder's age is its NEWEST session's, and it is now
                 INDEPENDENT of where the row sits: the list is in the host's
                 order plus the user's own arrangement, so times run in
                 no particular direction down a root. That is a cost of the
                 change and it is paid deliberately — an order you can predict
                 is worth more than one that happened to double as a sort key
                 — and it makes this field carry MORE than it used to rather
                 than less, since position no longer says any of it. -->
            <span class="row-time">{{ fmtRelative(dir.mostRecentActivity, now) }}</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- Nothing running anywhere on this host. The sentence used to stand
         alone, which made this the one empty state with no way forward: the
         header's `+` covers it in principle, but it is an unlabelled 14px
         mark in a strip of five, and an empty panel is exactly when a user
         has no habits to find it by. The folder workspace's own empty state
         set the pattern ("nothing is running in this folder" + a worded
         "Start a session here" button, FolderWorkspaceView.vue): say what is
         empty AND offer the one useful action. The button opens the same
         dialog the header `+` does, nothing pre-filled — a second door into
         the ONE creation flow, not a second flow. -->
    <div v-if="!roots.length && !sessions.loading" class="empty">
      <p class="muted">no sessions</p>
      <button class="btn-ghost" @click="emit('create', defaultStartIn)">
        New session…
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Everything in this block styles THIS component's markup and was carried
   verbatim from SessionTree.vue's stylesheet — scoped styles do not cross the
   component boundary, so the rules must live beside the rows they draw. The
   container queried at the bottom of the block is `.tree`, in the parent;
   container resolution follows the DOM, not the scope. */

.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.folder {
  margin-bottom: var(--sp-1);
}
/* A <div>, so the button reset this used to carry — background, border, color,
   text-align, cursor, font-family/size/line-height — is all gone: everything in
   that list is either the element's own default or inherited from `body`. Only
   the weight is a real decision and it stays.

   The row still gets no BACKGROUND on hover: a lift under the cursor advertises
   a click, and this row does not take one. The `:hover` rule it does have
   reveals the `+` inside it and touches nothing else, which says the opposite
   of a lift — the row is inert, and the one thing in it that is not says so by
   appearing. */
.folder-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--row-pad-x) 0 var(--sp-3);
  font-weight: var(--fw-semibold);
  overflow: hidden;
}
.folder-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The `~/` every root header repeats, receding so the part that IDENTIFIES the
   root is what the eye lands on. A colour rather than an opacity, and on its
   own span rather than on the label: `opacity` on the label would fade `git`
   too, which is the one word in the row that has to stay crisp.

   `--fg-muted` rather than `--fg-secondary` — one step further down than the
   `other` bucket below, because that row's whole label is toned to say what
   KIND of row it is, whereas this tones a fragment inside an ordinary one. */
.path-prefix {
  color: var(--fg-muted);
}
/* `other` is a bucket, not a directory: lowered so it does not read as a
   folder the user could navigate to. */
.folder-label.bucket {
  font-weight: var(--fw-regular);
  color: var(--fg-secondary);
}
/* Bare count, no `· 3 sessions`: the number is the whole message, and the
   header is the one row per root this design is allowed to spend.

   NEXT TO THE LABEL, not pinned right. It carried `margin-left: auto`, which
   threw it to the far end of the row where `10` sat level with `git` and
   related to nothing — "move 10 closer to git". The `auto` moved to the two
   elements that genuinely want the right edge: the root row's `+` and the
   folder row's timestamp, each of which is a column in its own right. */
.folder-count {
  flex: none;
  font-weight: var(--fw-regular);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* ── The per-root `+`: revealed, not persistent ────────────────────────────
   HOVER- AND FOCUS-REVEALED, and this is the decision the control turned on.

   Persistent was the alternative and it is affordable on width — the root
   labels are short words (`git`, `tmp`) and a 24px square leaves plenty at the
   232px floor. What it is not affordable on is NOISE: one `+` per root is a
   column of identical marks running down a panel whose entire job is to be
   scanned, repeating an affordance that is identical on every row. VS Code's
   tree-row actions reach the same conclusion for the same reason.

   Two rules make the reveal honest rather than merely quiet:

     - it is `opacity`, never `display`. The square is always laid out, so the
       root label never reflows when the cursor arrives — a row that changes
       width under the pointer is worse than a mark that was always there.
     - `:focus-visible` reveals it too, so it is fully reachable by keyboard and
       VISIBLE once reached. A hover-only affordance is one a keyboard user can
       tab into and not see, which is the failure mode this pattern usually
       ships with.

   `@media (hover: none)` shows it unconditionally: a pointer that cannot hover
   would otherwise never reveal it at all.

   What it is deliberately NOT conditioned on is whether the root is empty. An
   empty registered root is the `+`'s most useful case, but `directories.length`
   changes under the sessions store's refresh timer, so keying visibility off it
   would make the control appear and disappear as sessions come and go — the
   same trap the root rows' own comment records about expansion state. Every
   root row carries the same mark, always, in the same place. */
/* `margin-left: auto` is what keeps the `+` on the right edge now that the
   count no longer holds it there. It is the one control in this row rather
   than a field, so it is the one that belongs in the right column — and
   because the square is always LAID OUT (only its opacity changes), the label
   and count never reflow when the cursor arrives. */
.root-add {
  flex: none;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.folder-header:hover .root-add,
.root-add:focus-visible {
  opacity: 1;
}
/* `.folder-header` clips (`overflow: hidden`), which would eat a +2px ring. */
.root-add:focus-visible {
  outline-offset: -2px;
}
@media (hover: none) {
  .root-add {
    opacity: 1;
  }
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* ---- dragging a folder row ---------------------
 *
 * The tab bar's three rules, turned ninety degrees (FolderWorkspaceView's
 * `.tab.dragging`): the carried row FADES BUT STAYS IN
 * PLACE, because removing it from the flow would shift every row below it the
 * instant the drag began and move the target the user is aiming at; the landing
 * place is a 2px accent rule in the gap, because without one a reorder is "let
 * go and find out"; and a REFUSED drop draws nothing at all, which is how the
 * one rule this drag enforces — a row cannot leave its root — is made visible
 * while the drag is still in the air.
 *
 * `inset` box-shadow rather than a real border, exactly as the tabs do it: a
 * border would change the row's height and shove the whole list down by 2px as
 * the indicator moved between gaps, which is the same "target moves under the
 * cursor" failure the fade is avoiding. The shadow is drawn on the `<li>`
 * because the button's own left border is already spent on the selection rail.
 */
.dir-header.dragging {
  opacity: var(--disabled-opacity);
}
.dir-list li.drop-above {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.dir-list li.drop-below {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}
/* ── The indent budget, in one place ───────────────────────────────────────
   TWO levels, and no chevron column on either of them now that a root row is a
   header rather than a node. The column both rows share is the DOT, because it
   is the one element every row type has; the labels follow it at a constant
   16px (8px dot + an --sp-2 gap).

     level        dot    label
     root          12      28
     folder        20      36

   The root's 12px is --sp-3 rather than the --sp-2 the chevron used to start
   at: with the mark gone, an 8px inset put the dot hard against the panel edge
   and the root read as unindented rather than as the outer level. The folder
   step stays 8px — 18px of padding plus its 2px selection rail — which is the
   whole of the nesting this panel expresses.

   Dropping the chevron gives every row 18px back. At the 232px panel floor the
   timestamp is already gone (see the container query at the bottom of this
   block) and a folder row has 232 - 36 - 10 = 186px for its label, badges and
   count. Truncation is the ordinary end ellipsis; the row tooltip carries the
   full name. */
/* Sits in the folder slot, but is prose rather than a row: no dot, so
   it starts where a directory LABEL starts (36) instead of where its dot
   does. */
.empty-root {
  height: var(--row-h);
  display: flex;
  align-items: center;
  padding: 0 var(--row-pad-x) 0 36px;
  font-size: var(--fs-200);
  font-style: italic;
}
/* One step in from the root header: 18px of padding plus the 2px rail puts the
   dot at 20, 8px right of the root's. */
.dir-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--row-pad-x) 0 18px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
}
.dir-header:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed; hover is a neutral lift. The two used
   to be the same cyan at two alphas, which read as one state. */
.dir-header.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* A folder that is only a session — no reported cwd — is labelled by that
   session's NAME, so it is set in the mono face the name deserves and toned
   down, because it is a row we could not place rather than a folder the user
   organised. */
.dir-header.orphan .label {
  color: var(--fg-secondary);
}
.dir-header:hover {
  background: var(--state-hover);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex-shrink: 0;
}
.dot.active {
  background: var(--success);
}
/* The label wins the width fight; everything else shrinks first.

   `flex: 0 1 auto`, not `1 1 auto`: it may still SHRINK before the badges and
   the count do, but it no longer GROWS to eat the free space — growing is what
   pushed the count away from the label it belongs to. The right edge is held
   by `.row-time`'s `auto` margin instead, so the timestamps still line up in a
   column down the panel. */
.label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.label.mono {
  font-family: var(--font-mono);
}
/* A folder holding an attached session is semibold, so weight and colour (the
   green dot) say the same thing. This is what replaced the `attached` tag —
   and it now carries the whole of that job, because attachment is no longer a
   SORT key: a row that jumped to the top of its root the moment you opened it
   was the list rearranging itself in response to being used. The mark stays; the movement went. */
.dir-header.attached .label {
  font-weight: var(--fw-semibold);
}
/* Badge metric, shared by every --r-sm chip in the app:
   inline-flex, 0 var(--sp-1) padding, --lh-100. */
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  font-weight: var(--fw-medium);
  color: var(--agent);
  background: var(--agent-soft);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  white-space: nowrap;
}
/* Transient detector states read as "not settled yet", not as a live agent. */
.agent-badge.dim {
  color: var(--fg-secondary);
  background: transparent;
  border-color: var(--border);
}
/* Holds the right edge, which the count used to. It is a column the eye reads
   down — ages only compare against each other — so it is the field that has to
   stay aligned. When the container query below hides it, the `auto` goes with
   it and the row simply hugs the left, which is the right shape for a row that
   has run out of width. */
.row-time {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
/* Sentence over action, left on the panel's own indent rather than centred:
   the workspace's empty state centres in a whole pane, and centring in a strip
   that drags down to 232px would just ragged-edge two short lines. */
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}
.empty p {
  margin: 0;
}
/* Below ~270px the row cannot hold every field. The timestamp goes first: it
   is still the least operational of them, though the ORIGINAL reason for
   picking it — "a recency-sorted list already carries most of what it says" —
   died with the recency sort. What survives the
   revision is the comparison rather than the absolute: at the 232px floor
   something has to go, and every other field on the row either identifies it
   (label), locates it (dot) or says what is running in it (badge), and an age
   answers none of those. It is a genuine loss at that width now rather than a
   redundancy, and it is recorded as one. Dot, label and badge survive to the
   232px floor. The
   rule is unscoped on purpose, so a directory header drops its aggregate age
   at the same width its children drop theirs — a header still showing a time
   above rows that had theirs removed would read as its own, separate fact.
   270 rather than revision 2's 250, by the same arithmetic that set 250: the
   leaf row is 16px deeper than the single-session row it replaces, and it now
   carries a full session name rather than a short directory basename, so it
   runs out of width that much sooner. */
@container (width < 270px) {
  .row-time {
    display: none;
  }
}
</style>
