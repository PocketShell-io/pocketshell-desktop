/**
 * The session panel's MANUAL folder order (docs/SESSIONLIST.md §14).
 *
 * > "let's not rearrange workspaces/sessions in here because it's confusing.
 * > let's use wheveer order we had when creating. but I can also pull them up
 * > and down to rearraange"
 *
 * Two halves, and they are deliberately in two files. The first half — stop
 * moving on your own, show one order — is a fact about the host and lives
 * in `sessionGrouping.ts` with the rest of the projection (the host's `--sort`
 * order today; creation order before the host could sort). The second half —
 * the arrangement the user reached by dragging rows until the panel looked
 * right — is a preference about the panel, and it lives here.
 *
 * ## This is `shared/workspaceTabs.ts`'s manual-order section, one level up
 *
 * The workspace's tab bar already solved exactly this problem
 *, and the shape is reused rather than reinvented:
 * `applyFolderOrder` is `applyTabOrder`, `canDropFolderAt` is `canDropTabAt`,
 * `reorderFolders` is `reorderTabs`. Everything §15 argues for holds here for
 * the same reasons, so the arguments are cited rather than restated — except
 * the two places where the panel genuinely differs, which are written out in
 * full below (the group rule, and what happens to a key that leaves the list).
 *
 * ## The stored value is a RANKING, not a list of folders
 *
 * §15.2 is the load-bearing part and it applies here with MORE force, not less.
 * A tab set changes when a session is created or killed; the panel's folder set
 * changes for those reasons AND because the panel re-reads the host every five
 * seconds (SessionTree's `POLL_MS`), on a list that spans every root on the
 * box. So the stored value has to be a preference ABOUT folders rather than a
 * list OF them — as a list it would need reconciling on every tick, and every
 * reconciliation is a chance to invent a row or lose one.
 *
 * As a ranking, the three awkward cases need no handling at all:
 *
 *   - **a NEW folder** — the user just started a session somewhere new — has no
 *     rank, sorts after everything that has one, and lands at the bottom of its
 *     root. A folder the user has never arranged behaves identically whether or
 *     not they have arranged anything else;
 *   - **a REMOVED folder** — its last session was killed — is simply absent from
 *     the roots and leaves no hole, because nothing is positioned by index;
 *   - **an UNKNOWN key** — a folder that is gone, or one belonging to a host
 *     this order was not written for — ranks nothing and is inert.
 *
 * The sort is STABLE and the comparator only ever compares ranks, so two
 * unranked folders keep their host-list order relative to each other.
 * `Array.prototype.sort` has been required to be stable since ES2019.
 */
import type { SessionDirectory, SessionRootFolder } from './sessionTree';

/**
 * Upper bound on how many hosts an order map may hold, and how many folder keys
 * one host's order may hold.
 *
 * Neither is a UI limit anybody can reach by using the app: the first is more
 * hosts than an `~/.ssh/config` usually names, and the second is more folders
 * than a box has ever had sessions in. They are guards on a hand-editable JSON
 * blob, in the same spirit as `SESSION_ROOTS_MAX` — so a corrupt or
 * pathological settings file cannot make the panel build a ranking map with a
 * million entries in it on every keystroke of the poll.
 */
export const FOLDER_ORDER_MAX_HOSTS = 64;
export const FOLDER_ORDER_MAX_ROWS = 512;

/**
 * One host's arrangement: the folder keys the user has placed, best first.
 *
 * The keys are {@link SessionDirectory.key}s — home-relative directory paths
 * (`~/git/dataops`), or the untracked sentinel plus a session name. The
 * home-relative spelling is what makes them survivable across restarts: it is
 * the key that has already had tmux's two spellings of one directory folded
 * into it (`directoryKey`), so an order written today still ranks the same rows
 * tomorrow even if the host starts reporting the absolute form.
 */
export type FolderOrder = Record<string, string[]>;

/**
 * Clean a stored order map, or return `undefined` for a blob that cannot be
 * trusted at all.
 *
 * The settings store's convention, followed exactly (`asRootMap`,
 * `asShortcutOverrides`): only the outermost shape is rejected outright,
 * because it is the one with no salvageable meaning. Inside it, damage costs
 * one ENTRY — a host whose value is not an array of strings loses its
 * arrangement and nobody else's, and a stray non-string inside one host's array
 * costs that key alone.
 *
 * Duplicates are dropped rather than tolerated. A repeated key would give one
 * folder two ranks, and `Map` would silently keep the last — so the file would
 * mean something subtly different from what it reads as. Keeping the FIRST
 * occurrence is the reading that matches the list's own semantics: it is
 * ordered best-first, so the first mention is the one the user placed.
 */
export function normaliseFolderOrder(raw: unknown): FolderOrder | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: FolderOrder = {};
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= FOLDER_ORDER_MAX_HOSTS) break;
    if (!Array.isArray(value) || host === '') continue;
    const keys: string[] = [];
    for (const key of value) {
      if (keys.length >= FOLDER_ORDER_MAX_ROWS) break;
      if (typeof key !== 'string' || key === '' || keys.includes(key)) continue;
      keys.push(key);
    }
    // An empty result is DROPPED rather than stored as `[]`, which is the same
    // rule {@link writeFolderOrder}'s callers follow on the way in: "the user
    // arranged nothing here" and "there is no entry for this host" are one
    // state, and one spelling of it means a host whose folders all went away
    // does not leave a key behind forever.
    if (keys.length > 0) out[host] = keys;
  }
  return out;
}

/**
 * Re-sort each root's folder rows by a stored manual [order], keeping creation
 * order for anything the user has not placed.
 *
 * ## The ROOTS themselves are never reordered, and a row never leaves its root
 *
 * This is the panel's version of §15.1's group rule, and it is the one place
 * the two features reach a different answer for a different reason. The tab
 * bar's groups (sessions / files) are a presentational grouping, so keeping
 * them separate is a judgement call that §15.1 admits is "cheap to relax". A
 * root is not presentational: it is a real directory on the host, or a root the
 * user registered in Settings, and a folder row sits under it because its
 * working directory is genuinely inside it (`bestRootForPath` /`rootForPath`).
 * A row dragged from `git` into `tmp` would be a claim about where the folder
 * LIVES, and the row's own tooltip — which prints `dir.path` — would contradict
 * its position on screen the moment the user hovered it. There is nothing to
 * relax here; the constraint is the filesystem's, not this module's.
 *
 * So the ranking is applied WITHIN each root and never across them, and the
 * root sequence is left exactly as `groupSessionsIntoRoots` produced it
 * (registered order, or oldest-created first, with `other` pinned last). That
 * also means a stored order can hold keys from every root in one flat list
 * without any of them being able to move a row between roots: two keys in
 * different roots are simply never compared.
 *
 * A NEW array is returned and the input is not mutated, because the input is a
 * Vue computed's value: sorting `root.directories` in place would be a write
 * during a read, which is how a reactive dependency loop starts.
 */
export function applyFolderOrder(
  roots: readonly SessionRootFolder[],
  order: readonly string[],
): SessionRootFolder[] {
  if (order.length === 0) return [...roots];
  const rank = new Map(order.map((key, i) => [key, i]));
  const byRank = (a: SessionDirectory, b: SessionDirectory): number =>
    (rank.get(a.key) ?? Number.POSITIVE_INFINITY) - (rank.get(b.key) ?? Number.POSITIVE_INFINITY);
  return roots.map((root) => ({ ...root, directories: [...root.directories].sort(byRank) }));
}

/**
 * May the folder [fromKey] be dropped at gap [toIndex] of [root]?
 *
 * Exists so the panel can say NO while the drag is still in the air — no drop
 * indicator, no `preventDefault`, so the pointer keeps its `no-drop` cursor —
 * rather than accepting the drop and snapping the row back, which reads as a
 * bug rather than as a rule (§15.1's argument, unchanged).
 *
 * [toIndex] is a GAP index in `0..root.directories.length`: `0` is "above the
 * first row", `length` is "below the last".
 *
 * The whole of the rule is **[fromKey] must be a row of THIS root**. That is
 * what refuses a cross-root drag, and it refuses it without either side having
 * to know which root the drag started in: the panel calls this with the root
 * the pointer is currently over, and a key from a different root is simply not
 * in it. A key naming no live row at all — a stale drag, a hand-crafted event —
 * is refused by the same test.
 */
export function canDropFolderAt(
  root: SessionRootFolder,
  fromKey: string,
  toIndex: number,
): boolean {
  if (!root.directories.some((dir) => dir.key === fromKey)) return false;
  return toIndex >= 0 && toIndex <= root.directories.length;
}

/**
 * Move [fromKey] to gap [toIndex] within its own root, and return the WHOLE
 * PANEL's folder keys as the new stored order — or null when the move is
 * refused or is a no-op.
 *
 * ## Why the whole panel and not the one root
 *
 * §15's reason first: a total ranking is what makes `applyFolderOrder`'s
 * "unranked sorts last" mean "folders I have never touched go at the bottom".
 * If only the moved row were ranked, every other row would be unranked and the
 * one drag would have moved everything.
 *
 * And one the tab bar does not have: the panel is many roots at once, so a
 * write scoped to one root would have to be merged into whatever was stored for
 * the others. Emitting the flat list in DRAW ORDER — root by root, folders
 * inside each, which is exactly `folderTree.ts`'s `folders` — makes the merge
 * unnecessary, because the emitted list already contains every other root's
 * current arrangement. One write, no reconciliation.
 *
 * ## A key that is not on screen right now is dropped
 *
 * The flat list holds the rows the panel is drawing, so a folder whose sessions
 * were all killed loses its rank the next time anything is dragged. That is
 * deliberate and it costs nothing: an unranked folder sorts to the BOTTOM of
 * its root, and a folder that has been away since the last arrangement would
 * have been ranked after every currently-visible row anyway. Retaining stale
 * keys would buy the same position at the price of a list that only ever grows.
 * (The tab bar reaches the same place from the other side, by pruning against
 * the live bar — `pruneTabIds`, §15.2.)
 *
 * ## The index is clamped, not rejected
 *
 * §15's reason exactly: the interaction being performed is "put this as far up
 * as it goes", and refusing an overshoot outright would make the first and last
 * positions reachable only by a pixel-accurate drop. {@link canDropFolderAt} is
 * what stops an overshoot being invited; this is what makes it harmless.
 *
 * Returning null for a no-op is what lets the caller skip writing — and
 * persisting — an arrangement for a drag that ended where it started, which is
 * most cancelled drags.
 */
export function reorderFolders(
  roots: readonly SessionRootFolder[],
  fromKey: string,
  toIndex: number,
): string[] | null {
  const owner = roots.find((root) => root.directories.some((dir) => dir.key === fromKey));
  if (!owner) return null;

  const from = owner.directories.findIndex((dir) => dir.key === fromKey);
  const moving = owner.directories[from];
  if (moving === undefined) return null;

  // A gap index becomes an array index: removing the row first shifts every gap
  // after it down by one.
  const gap = Math.max(0, Math.min(owner.directories.length, toIndex));
  const to = gap > from ? gap - 1 : gap;
  if (to === from) return null;

  const arranged = [...owner.directories];
  arranged.splice(from, 1);
  arranged.splice(to, 0, moving);

  return roots.flatMap((root) =>
    (root === owner ? arranged : root.directories).map((dir) => dir.key),
  );
}
