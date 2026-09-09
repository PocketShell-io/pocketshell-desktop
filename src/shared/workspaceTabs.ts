/**
 * The folder workspace's tab model, as pure functions.
 *
 * Everything the tab bar decides — what a tab is called, what order the tabs
 * sit in, how two tabs that want the same name are told apart — is decided
 * here, with no Vue, no store and no DOM. It is separated for the usual reason
 * this repo separates things (a rule with a unit test beats a rule inside a
 * template).
 *
 * ## A tab's label IS the session's name
 *
 * There is no display relabel on top of the name. What `a ls` or `tmux ls`
 * prints is what the tab reads: `main`, `main-2`, `staging`, whatever the
 * session is actually called on the host. An earlier design stripped the
 * folder's derived base name off each session and relabelled the remainders
 * (`main`, `main 2`), which put words on the bar that existed nowhere on the
 * host; that projection is gone, and with it the whole strip/remainder
 * machinery the rename field used to work through. The rename field now edits
 * the NAME, and what it commits is what the host stores.
 *
 * The only label still invented here is collision numbering: a second tab
 * wanting an already-shown label reads `… 2` (see {@link numberCollisions}),
 * which is display-only disambiguation and never touches the name.
 */

/** A session tab, before labelling. */
export interface SessionTabInput {
  /** The session name (tmux name, or aplexer tag) — the join key and identity. */
  name: string;
  /** Epoch seconds of creation. Drives tab order; see {@link buildWorkspaceTabs}. */
  created: number;
}

/** A Files tab, before labelling. */
export interface FilesTabInput {
  /** Stable identity, unique within the workspace. */
  id: string;
  /** The directory this tab is looking at, when it has one yet. */
  path?: string | null;
}

export type WorkspaceTab =
  | {
      kind: 'session';
      /** Stable identity. For a session tab this IS the session name. */
      id: string;
      session: string;
      label: string;
      created: number;
    }
  | { kind: 'files'; id: string; label: string; path: string | null };

/** Files tabs all read `Files`; a second one becomes `Files 2`. */
export const FILES_LABEL = 'Files';

/**
 * Append ` 2`, ` 3`… to every label after the first that wants it.
 *
 * In place, in the array's own order, which is TAB ORDER. Numbering by tab
 * order rather than alphabetically is what makes the numbers stable: a session
 * created now lands at the end of the bar and cannot renumber the tabs already
 * on it. Alphabetical numbering would let a new `git-foo-aardvark` take the
 * plain label away from a tab that has had it all day.
 *
 * Note the session labels themselves cannot collide with each other within a
 * folder — a tmux name is host-global and an aplexer tag is per-workspace, and
 * both namespaces are unique, so two tabs in ONE bar are two different names.
 * Collisions are real against the Files label, which is invented here rather
 * than stored on the host, which is why the rule is applied uniformly instead
 * of special-cased per label kind.
 *
 * The counter reads the labels it was handed, not the ones it writes: a session
 * named `Files 2` beside two Files tabs comes out `Files 2 2`. That is a
 * pre-existing shape of this one-pass counter and it needs a hand-made session
 * named after a label this module invents before it can happen. Left alone
 * deliberately: this pass is display-only, and the ids underneath stay
 * distinct, so the cost is a repeated word on the bar and not an ambiguous
 * target.
 */
export function numberCollisions<T extends { label: string }>(tabs: T[]): T[] {
  const seen = new Map<string, number>();
  for (const tab of tabs) {
    const n = (seen.get(tab.label) ?? 0) + 1;
    seen.set(tab.label, n);
    if (n > 1) tab.label = `${tab.label} ${n}`;
  }
  return tabs;
}

/**
 * The whole tab bar for one folder workspace.
 *
 * Order: session tabs, then Files tabs — "the tabs are always ordered: first
 * agent sessions, then files."
 *
 * Session tabs sort by CREATION time, oldest first. A tab bar is a set of
 * targets: the user aims at a tab and then clicks it, and a bar that reorders
 * under the session store's refresh timer moves the target between those two
 * moments.
 *
 * This used to say it was "the one place in the app that does not sort by
 * activity", and the sentence after it was "the panel can sort by recency
 * because its rows are read; the tab bar cannot, because its rows are hit."
 * Both are now out of date, and the panel is what changed rather than this:
 * once its rows became one per FOLDER and `Ctrl+↑`/`Ctrl+↓` began walking them,
 * they were targets too, and the user reported the reordering as confusing.
 * The session panel therefore sorts by creation as well. The reasoning here did not move — it turned out to apply more widely
 * than it claimed.
 *
 * Creation order is also what makes "session one is
 * one tab, session two is another tab" literally true, since the create walks
 * `main`, `main-2`, `main-3` in exactly that order (aplexer) and
 * `<folder>`, `<folder>-2`, `<folder>-3` (tmux). Ties break on
 * the name so the order is total even on a host whose table reports one
 * timestamp for everything (`parseSessionsList` sets `activity === created`,
 * because the helper's table carries three columns and no more).
 *
 * Files tabs keep the order they were opened in, which is the order the caller
 * hands them over in.
 */
export function buildWorkspaceTabs(
  sessions: readonly SessionTabInput[],
  files: readonly FilesTabInput[] = [],
): WorkspaceTab[] {
  const sessionTabs: WorkspaceTab[] = [...sessions]
    .sort((a, b) => a.created - b.created || a.name.localeCompare(b.name))
    .map((s) => ({
      kind: 'session' as const,
      id: s.name,
      session: s.name,
      label: s.name,
      created: s.created,
    }));

  const filesTabs: WorkspaceTab[] = files.map((f) => ({
    kind: 'files' as const,
    id: f.id,
    label: FILES_LABEL,
    path: f.path ?? null,
  }));

  // Numbered across the WHOLE bar, not per kind: a session legitimately called
  // `Files` and a Files tab are two tabs reading identically, and which of them
  // keeps the plain label is decided by position like every other collision.
  return numberCollisions([...sessionTabs, ...filesTabs]);
}

/**
 * The session name a tab rename commits, given what the user typed into the
 * field.
 *
 * The field edits the NAME and commits the NAME: the label is the session's
 * real name, so what the user sees selected is what gets renamed, and what
 * they type is what the host stores. No prefix is re-applied and no remainder
 * is rebuilt — a rename may move a tmux session off its folder-derived name,
 * and that is accepted: grouping is carried by the reported working directory
 * (and the tree registry), not by the spelling of the name.
 *
 * Returns null when the input cannot become a legal session name at all, which
 * the caller must treat as "refuse", not as "use the fallback". The predicate
 * is `resolveSessionName`'s: at least one letter or digit survives sanitising.
 * A name this app accepts is therefore a name this app can also derive — and,
 * more importantly, one `tmuxctl <name>` can still join.
 */
export function renamedSessionName(
  typed: string,
  sanitise: (part: string) => string,
): string | null {
  const clean = sanitise(typed.trim());
  return /[A-Za-z0-9]/.test(clean) ? clean : null;
}

// `nextWorkspaceTabId` — the wrap-around traversal for the `Ctrl+Tab` /
// `Ctrl+Shift+Tab` cycle — is GONE with the chords that called it, removed at
// the user's request ("remove these hotkeys let's keep only ctrl left and ctrl
// right"). Its shared-module neighbour `adjacentIndex` (listNavigation.ts) is
// what the surviving tab arrows use, and it CLAMPS rather than wraps: an arrow
// is a direction, not a cycle.

// ---------------------------------------------------------------------------
// Manual tab order
//
// "I also want to be able to rearrange tabs like drag and drop them around."
//
// ## This overrides an earlier instruction, and only partly
//
// The workspace was specified with "the tabs are always ordered: first agent
// sessions, then files", and {@link buildWorkspaceTabs} enforces exactly that.
// A manual order overrides a derived one by definition, so the two requests
// cannot both be obeyed in full — and the resolution taken here is:
//
//   - **the derived order becomes the DEFAULT.** A tab the user has never
//     dragged sits where the rule below puts it: sessions by creation time, oldest first,
//     then Files tabs in the order they were opened. Nothing changes for a user
//     who never drags anything.
//   - **a manual position wins once set**, for the tabs that have one.
//   - **the two GROUPS stay separate.** A Files tab may not be dragged in among
//     the session tabs, and a session tab may not be dragged past the first
//     Files tab.
//
// The last of those is the judgement call, and the freest reading of "drag them
// around" says the opposite. It is kept because the grouping is doing work that
// the ordering within a group is not. It is what makes the bar's SHAPE
// predictable — everything before the first Files tab is a live process on
// another machine, everything after it is a file browser — and the tab styling
// leans on it: `.tab.files` is deliberately toned down so the eye can find the
// session half of the bar without reading the labels. Interleaving would take
// that away and give back only the ability to put a file browser in the middle
// of a row of terminals.
//
// It is also cheap to relax if that reading is wrong: delete the clamp in
// {@link reorderTabs} and the groups merge. What must NOT happen meanwhile is a
// drag that appears to cross the boundary and then snaps back, which reads as a
// bug rather than as a rule — hence {@link canDropTabAt}, so the UI can refuse
// visibly while the drag is still in the air.
// ---------------------------------------------------------------------------

/**
 * Re-sort [tabs] by a stored manual [order], keeping the derived order for
 * anything the user has not placed.
 *
 * ## Why the stored value is a RANKING and not a list of tabs
 *
 * The tab set is not static: sessions appear on the refresh timer, are created
 * from `+`, and vanish when they are killed here, from the phone, or from the
 * user's own terminal. So the stored order has to be a preference ABOUT tabs
 * rather than a list OF them — if it were the list, it would have to be
 * reconciled on every refresh and every reconciliation is a chance to invent a
 * tab or lose one.
 *
 * As a ranking, all three awkward cases fall out with no special handling:
 *
 *   - **a NEW tab** has no rank, sorts after everything that does, and so lands
 *     at the end of its own group — which is where a new session belongs and is
 *     exactly what the derived order already did with it;
 *   - **a REMOVED tab** is simply absent from [tabs] and leaves no hole, because
 *     nothing is positioned by index;
 *   - **an UNKNOWN id** in the order — a tab that is gone, or one from a
 *     different workspace — ranks nothing and is inert. It is pruned anyway (see
 *     {@link pruneTabIds}), so it cannot pin a tab that comes back later under
 *     the same name.
 *
 * The sort is STABLE and the comparator only ever compares ranks, so two
 * unranked tabs keep their derived relative order. `Array.prototype.sort` is
 * required to be stable since ES2019.
 *
 * Groups are re-established after the sort rather than trusted through it, so a
 * stored order written by an older build — or hand-edited in `localStorage` —
 * cannot interleave the kinds.
 */
export function applyTabOrder(
  tabs: readonly WorkspaceTab[],
  order: readonly string[],
): WorkspaceTab[] {
  if (order.length === 0) return [...tabs];
  const rank = new Map(order.map((id, i) => [id, i]));
  const byRank = (a: WorkspaceTab, b: WorkspaceTab): number =>
    (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY);
  return [
    ...tabs.filter((tab) => tab.kind === 'session').sort(byRank),
    ...tabs.filter((tab) => tab.kind === 'files').sort(byRank),
  ];
}

/**
 * May the tab [fromId] be dropped at position [toIndex]?
 *
 * Exists so the UI can say NO while the drag is still happening — no drop
 * indicator, and a `no-drop` cursor — rather than accepting the drop and
 * snapping the tab back, which reads as a bug rather than as a rule.
 *
 * [toIndex] is a GAP index in `0..tabs.length`: the position the tab would take
 * in the bar, so `0` is "before the first tab" and `tabs.length` is "after the
 * last". The valid gaps for a tab are the ones inside its own group, plus the
 * gap immediately after it, which is why the upper bound is `end + 1`.
 */
export function canDropTabAt(
  tabs: readonly WorkspaceTab[],
  fromId: string,
  toIndex: number,
): boolean {
  const moving = tabs.find((tab) => tab.id === fromId);
  if (!moving) return false;
  const first = tabs.findIndex((tab) => tab.kind === moving.kind);
  if (first < 0) return false;
  let last = first;
  while (last + 1 < tabs.length && tabs[last + 1]?.kind === moving.kind) last += 1;
  return toIndex >= first && toIndex <= last + 1;
}

/**
 * Move [fromId] to [toIndex] and return the WHOLE bar's ids as the new stored
 * order, or null when the move is refused or is a no-op.
 *
 * The full bar rather than a delta, because a total ranking is what makes
 * {@link applyTabOrder}'s "unranked sorts last" rule mean "tabs I have never
 * touched go at the end": if only the moved tab were ranked, every other tab
 * would be unranked and the one drag would have moved everything.
 *
 * The index is CLAMPED into the moving tab's group rather than rejected, so a
 * drag that overshoots the boundary lands hard against it instead of doing
 * nothing — the interaction the user is performing is "put this as far left as
 * it goes", and refusing it outright would make the last position in a group
 * unreachable by anything but a pixel-accurate drop. {@link canDropTabAt} is
 * what stops the overshoot being invited in the first place; this is what makes
 * it harmless if it happens anyway.
 *
 * Returning null for a no-op is not tidiness — it is what lets the caller skip
 * writing (and persisting) an order for a drag that ended where it started,
 * which is most cancelled drags.
 */
export function reorderTabs(
  tabs: readonly WorkspaceTab[],
  fromId: string,
  toIndex: number,
): string[] | null {
  const from = tabs.findIndex((tab) => tab.id === fromId);
  const moving = tabs[from];
  if (from < 0 || !moving) return null;

  const first = tabs.findIndex((tab) => tab.kind === moving.kind);
  let last = first;
  while (last + 1 < tabs.length && tabs[last + 1]?.kind === moving.kind) last += 1;

  // A gap index becomes an array index: removing the tab first shifts every gap
  // after it down by one.
  const gap = Math.max(first, Math.min(last + 1, toIndex));
  const to = gap > from ? gap - 1 : gap;
  if (to === from) return null;

  const next = [...tabs];
  next.splice(from, 1);
  next.splice(to, 0, moving);
  return next.map((tab) => tab.id);
}

/**
 * Move [fromId] one place left (`-1`) or right (`+1`) — the keyboard
 * counterpart of a drag.
 *
 * Written on top of {@link reorderTabs} rather than beside it, so the group
 * clamp and the stored shape are decided in ONE place. A keyboard move that
 * would leave the group returns null and the caller does nothing, which is the
 * right feel for a key: the tab stops at the edge of its group instead of
 * silently jumping the boundary.
 */
export function nudgeTabOrder(
  tabs: readonly WorkspaceTab[],
  fromId: string,
  direction: 1 | -1,
): string[] | null {
  const from = tabs.findIndex((tab) => tab.id === fromId);
  if (from < 0) return null;
  // `+1` because a move right by one means landing in the gap TWO along: the
  // gap immediately to its right is the one it already occupies.
  return reorderTabs(tabs, fromId, direction === 1 ? from + 2 : from - 1);
}

// ---------------------------------------------------------------------------
// The MRU stack, and what closing a tab selects
// ---------------------------------------------------------------------------

/**
 * Record that [id] was just selected, most-recent LAST.
 *
 * A plain array used as a stack rather than a `Set` or a timestamped map,
 * because the only two operations this needs are "put this on top" and "walk
 * down from the top", and an array does both without a comparator.
 *
 * The prior occurrence is REMOVED before the push, so an id appears at most
 * once. Without that, cycling between two tabs a dozen times would build a
 * stack a dozen deep whose first eleven entries all name tabs that are still
 * open, and popping a dead tab off the top would land on the same tab again
 * rather than on the one before it.
 *
 * Pure: it returns a new array and never mutates the one it was given, so a
 * caller can hold this in a reactive ref without the reactivity system having
 * to observe an in-place splice.
 */
export function pushMru(mru: readonly string[], id: string): string[] {
  return [...mru.filter((entry) => entry !== id), id];
}

/**
 * Drop every id that no longer names a live tab.
 *
 * **This is the rule that makes the MRU safe**, and the brief named the hazard
 * exactly: "an MRU that can resurrect a dead tab is worse than the index
 * behaviour it replaces." A stale entry does not merely point at nothing — a
 * session tab's id IS its tmux session name, so a session killed and then
 * re-created under the same name (which `sessions create` does routinely, since
 * it derives the name from the folder) would put a *different* session's tab
 * back at the top of the stack, and the next close would jump to it.
 *
 * So the stack is pruned against the live bar rather than only popped on close.
 * Popping alone is not enough: a session can leave the bar without anything in
 * this app closing it — killed from the user's own terminal, killed from the
 * phone, or the host rebooted — and none of those routes runs a close handler.
 * Pruning is driven by the tabs themselves, so every disappearance is covered
 * by one rule instead of by an enumeration of the ways a tab can vanish.
 *
 * **Shared by the MRU stack and the manual tab ORDER** ({@link applyTabOrder}),
 * because they have the same shape and the same hazard: both are lists of tab
 * ids kept beside a tab set that changes underneath them, and for both a stale
 * entry is worse than a missing one. Keeping ONE function is what stops the two
 * developing different ideas of when an id has died.
 */
export function pruneTabIds(ids: readonly string[], tabs: readonly WorkspaceTab[]): string[] {
  const live = new Set(tabs.map((tab) => tab.id));
  return ids.filter((id) => live.has(id));
}

/**
 * Which tab is selected once [closing] is gone.
 *
 * [tabs] is the bar as it is NOW — [closing] included — because that is what
 * both the adjacency fallback and the caller have in hand; this function does
 * the removal itself.
 *
 * ## Closing a tab that is not the active one changes nothing
 *
 * The first branch, and the one most easily got wrong. Middle-clicking a
 * background tab, or picking "Stop session" off another tab's context menu, is
 * not a request to go anywhere: the user is looking at what they were looking
 * at and expects to keep looking at it. Returning [active] unchanged is the
 * whole of that, and it holds even when [active] is not in [tabs] at all —
 * a selection that was already stale is not this operation's business to fix.
 *
 * ## The MRU is consulted, then adjacency
 *
 * The user's request: "closing a tab selects the previously active one, not the
 * first". So the stack is walked from the top down, skipping the tab being
 * closed and anything that is not on the bar — the same defensive filter
 * {@link pruneTabIds} applies from the other side, kept here as well because this
 * function is the one that must not be able to name a dead tab whatever it was
 * handed.
 *
 * ## Empty MRU falls back to the tab on the RIGHT
 *
 * Reached on a first-ever close, or after every previously visited tab has
 * itself been closed. The right neighbour, falling back to the left when the
 * closed tab was last on the bar.
 *
 * Right rather than left because it keeps the SELECTION INDEX where it was:
 * closing tab 3 of 5 leaves you on the tab that is now tab 3, so closing a run
 * of tabs from one position walks forward through the bar instead of retreating
 * to the start. That is what every browser and VS Code do. Falling back to the
 * left at the end is not a second rule — it is the same rule finding nothing on
 * the right.
 *
 * Returns null only for a bar that had nothing but the closed tab on it.
 */
export function tabAfterClose(
  tabs: readonly WorkspaceTab[],
  closing: string,
  active: string | null,
  mru: readonly string[],
): string | null {
  // Closing a background tab is not a navigation. Answered before anything
  // else, so no MRU or adjacency reasoning can leak into a case that has none.
  if (active !== null && active !== closing) return active;

  const index = tabs.findIndex((tab) => tab.id === closing);
  const remaining = tabs.filter((tab) => tab.id !== closing);
  if (remaining.length === 0) return null;

  const live = new Set(remaining.map((tab) => tab.id));
  for (let i = mru.length - 1; i >= 0; i -= 1) {
    const id = mru[i];
    if (id !== undefined && live.has(id)) return id;
  }

  // Adjacency. `index` is -1 when the closed tab was not on the bar, which
  // makes `index` itself the first remaining tab — the honest answer for a
  // caller closing something the bar never had.
  if (index < 0) return remaining[0]?.id ?? null;
  return remaining[index]?.id ?? remaining[remaining.length - 1]?.id ?? null;
}
