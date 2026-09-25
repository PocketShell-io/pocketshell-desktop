/**
 * The session panel's folder SORT — the one the user picks from the panel's
 * sort menu, as opposed to the manual arrangement the user drags
 * (`folderOrder.ts`) and the host's listing order everything starts from.
 *
 * ## Why client-side, when the host's `a list --sort` exists
 *
 * The host sorts SESSIONS; the panel draws FOLDERS. A host-side `--sort name`
 * orders the session list, and the folder projection (`buildDirectories`) then
 * orders folders by first encounter in that list — which is the session name's
 * order, not the folder's, and falls apart wherever the two diverge (a worktree
 * folder, a renamed tag, a folder holding two sessions sorted apart). The row
 * the user sees is the folder row, so the sort has to run at the folder level,
 * and the folder level exists only here.
 *
 * Two more reasons, both about reach: the tmux-fallback path
 * (`PocketshellClient`) has no `--sort` to pass, and a client-side comparator
 * is the one sorting both backends answer the same way — which matters because
 * the panel never says which backend it is showing. And a pure projection over
 * the store's list survives the five-second poll the way the manual arrangement
 * does (`folderOrder.ts`'s argument): it is re-APPLIED on every recompute, so
 * nothing races the refresh.
 *
 * The host's listing keeps its own default (`accessed`) and keeps owning the
 * order the tab bar and the create flow read; this module only reorders the
 * panel's folder rows.
 *
 * ## Within roots, never across them
 *
 * The same rule the manual drag obeys (`canDropFolderAt`), and for the same
 * reason: a root is a real directory on the host or one the user registered,
 * and its header names it. Sorting is not allowed to move `~/git/dataops`
 * under `~/tmp`, because the row's own tooltip would contradict its position
 * the moment the user hovered it. The root SEQUENCE — registered order, or
 * first-appearance, with `other` pinned last — is the grouping's declared
 * output and is left exactly as `groupSessionsIntoRoots` produced it.
 */
import type { SessionDirectory, SessionRootFolder } from './sessionTree';

/**
 * The keys the panel's sort menu offers.
 *
 * `host` is the default and is the order the listing arrived in — what the
 * panel has always drawn. The other three are folder-level readings of the
 * host's own sort vocabulary (`a list --sort name|created|accessed|activity`):
 * `accessed` and `activity` fold into one key here because the folder row
 * carries a single aggregate (`mostRecentActivity`, which is the session
 * `activity || created` the host's own default sorts by), and a folder has no
 * separate "attached last at" to distinguish the two.
 */
export type FolderSortKey = 'host' | 'activity' | 'name' | 'created';

export const FOLDER_SORT_DEFAULT: FolderSortKey = 'host';

/** The keys, in the order the sort menu lists them. */
export const FOLDER_SORT_KEYS: readonly FolderSortKey[] = [
  'host',
  'activity',
  'name',
  'created',
];

/** The menu's word for each key. One source, so the menu and tests cannot drift. */
export const FOLDER_SORT_LABELS: Record<FolderSortKey, string> = {
  host: 'Host order',
  activity: 'Newest activity',
  name: 'Name',
  created: 'Created',
};

/**
 * A stored sort key, or `undefined` for a value this build cannot trust.
 *
 * The settings-store parser convention (`normaliseFolderOrder`): a value that
 * fails falls back to the default and costs nothing else.
 */
export function normaliseFolderSort(raw: unknown): FolderSortKey | undefined {
  return typeof raw === 'string' && (FOLDER_SORT_KEYS as readonly string[]).includes(raw)
    ? (raw as FolderSortKey)
    : undefined;
}

/**
 * The folder's own creation time: its OLDEST session's.
 *
 * A folder is "created" when its first session was — a second session arriving
 * later does not move it, which is what makes `created` the key that answers
 * "the order I had when creating" (the sentence the host-order default came
 * from, SESSIONLIST §6.0). The `activity` fallback mirrors
 * `sessionActivity`'s, for a listing that reported neither.
 */
export function folderCreatedAt(dir: SessionDirectory): number {
  let min = Number.POSITIVE_INFINITY;
  for (const row of dir.rows) {
    min = Math.min(min, row.session.created || row.session.activity || 0);
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}

/**
 * Re-sort each root's folder rows by [key], leaving the root sequence alone.
 *
 * `host` copies through untouched — the default must be indistinguishable from
 * no sort at all, down to the referential honesty of the output (a fresh outer
 * array, the same `SessionDirectory` objects inside, exactly what
 * `applyFolderOrder` returns for an empty arrangement).
 *
 * The sort is STABLE, so two folders the key cannot tell apart keep their
 * host-list order relative to each other — a sort the user picks must never
 * reshuffle what it cannot rank. `Array.prototype.sort` has been required to
 * be stable since ES2019.
 *
 * A NEW array is returned and the input is not mutated, because the input is a
 * Vue computed's value: sorting `root.directories` in place would be a write
 * during a read, which is how a reactive dependency loop starts.
 */
export function applyFolderSort(
  roots: readonly SessionRootFolder[],
  key: FolderSortKey,
): SessionRootFolder[] {
  if (key === 'host') return [...roots];
  const byKey = (a: SessionDirectory, b: SessionDirectory): number => {
    switch (key) {
      // Newest FIRST: a recency sort that put the oldest on top would read as
      // a bug, not a choice.
      case 'activity':
        return b.mostRecentActivity - a.mostRecentActivity;
      case 'name':
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      case 'created':
        return folderCreatedAt(a) - folderCreatedAt(b);
    }
  };
  return roots.map((root) => ({ ...root, directories: [...root.directories].sort(byKey) }));
}
