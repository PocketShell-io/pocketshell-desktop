/**
 * The root projection the session panel renders: a flat session/group list
 * folded into roots -> directories -> rows, in the order the host sorted.
 *
 * Split out of sessionGrouping.ts (which keeps the row model and the flat
 * folder grouping) together with the registered-roots algebra in
 * sessionRoots.ts; this module is where the two meet.
 */
import type { SessionSummary } from '../shared/types';
import {
  buildRows,
  defaultLabelForPath,
  disambiguateLabels,
  sessionActivity,
  UNTRACKED_PATH,
  type SessionRow,
} from './sessionGrouping';
import {
  bestRootForPath,
  directoryKey,
  inferHome,
  normaliseHome,
  OTHER_LABEL,
  OTHER_ROOT,
  resolveRoots,
  rootForPath,
  rootFromSessionName,
} from './sessionRoots';

/* ---------------------------------------------------------------------------
 * Root projection — the folder tree the panel renders
 * ------------------------------------------------------------------------- */


/**
 * One directory under a root — the panel's middle level.
 *
 * Always a collapsible node, never folded into its own child, however few
 * sessions it holds: `rows.length` is a count, not a rendering mode. Its
 * children are the session NAMES, at every size, because the header has
 * already said the directory and repeating it is what made the old rows read
 * as doubled.
 *
 * A session with no known working directory is modelled as a degenerate
 * directory of its own — label = its session name, `untracked`, exactly one
 * row — so the renderer sorts one list instead of threading a second loose-row
 * array through the same comparator. It is the one node the panel draws as a
 * single row, because there is no directory there to draw a level for; see
 * SessionTree.vue.
 */
export interface SessionDirectory {
  /** Stable list and expansion key. Unique within a root. */
  key: string;
  /**
   * Display path: home-relative (`~/git/dataops`) when under `$HOME`, the
   * canonical path otherwise, {@link UNTRACKED_PATH} when there is none.
   * Home-relative for the same reason root keys are (§8): it is what folds
   * tmux's two spellings of one directory into a single node.
   */
  path: string;
  /** The directory's own name (leaf component), grown only on collision. */
  label: string;
  /** The directory's sessions, in the host's order. Never empty. */
  rows: SessionRow[];
  /**
   * Newest activity across the directory — its displayed age.
   *
   * DISPLAY ONLY. The sort keys this level once carried (activity, then
   * created) are both gone: the panel shows the host's order and nothing
   * here rearranges it, so the timestamp is the only recency report left.
   * See SessionTree's container query.
   */
  mostRecentActivity: number;
  /** True when any session here is attached (drives the dot). */
  active: boolean;
  /** True when there is no reported working directory at all. */
  untracked: boolean;
  /** True when the root was recovered from the session name, not from a path. */
  inferredRoot: boolean;
}

/** One top-level folder in the panel: a `$HOME` child, or the `other` bucket. */
export interface SessionRootFolder {
  /** `~/git`, or {@link OTHER_ROOT}. Stable list key and expansion key. */
  key: string;
  /** Header label: the root's own name, or {@link OTHER_LABEL}. */
  label: string;
  /** The root's directories, ordered. */
  directories: SessionDirectory[];
  /** Sessions under this root, across every directory — the header count. */
  sessionCount: number;
  /** Newest activity across the root's sessions — the header's age, display only. */
  mostRecentActivity: number;
  /** True when any session under this root is attached (drives the dot). */
  active: boolean;
  /** True for the catch-all, which is pinned last and reads as a bucket. */
  other: boolean;
  /**
   * True when this root came from the user's registered list rather than from
   * the shape of the paths. Only a registered root can have `sessionCount: 0`
   * — a derived root exists BECAUSE a session is in it — so this is what lets
   * the panel say "registered, nothing running here" instead of drawing a
   * header with nothing under it and no explanation.
   */
  configured: boolean;
}
/**
 * A root header's text, split so the `~/` can be toned down.
 *
 * > "for git and tmp let's show ~/git ~/tmp (~/ part can be somewhat muted)"
 *
 * The header used to read `git`, which is `root.label` — the root's own leaf
 * component. The key it stands for has always been the home-relative `~/git`
 * (it is what `rootTooltip` prints and what the `+` resolves against), so this
 * is a presentation change over a value the root already carries and not a
 * second derivation of it.
 *
 * Two spans rather than one, because the mute has to apply to the `~/` and to
 * nothing else. Fading the whole label with `opacity` would tone down the word
 * that identifies the root, which is the opposite of what a prefix-mute is for:
 * `~/` is the part every root repeats, so it is the part that should recede.
 *
 * Three cases that are NOT `~/`-prefixed, and none of them may sprout one:
 *
 *   - **`other`** is a bucket, not a directory — the sessions that matched no
 *     root. It keeps its word, and `~/other` would name a folder that does not
 *     exist anywhere;
 *   - **`$HOME` itself**, registrable as `~`, keeps `defaultLabelForPath`'s
 *     named form (`~ (home)`). Splitting it would leave a muted `~` and an
 *     empty remainder, i.e. a header whose only legible content is the part
 *     that was meant to recede;
 *   - **a registered root outside `$HOME`** (`/srv/apps`) has no `~` in it at
 *     all and renders its absolute key verbatim. That is the same promise the
 *     `~/` form makes — the header names the real directory — kept for a root
 *     whose real directory happens not to be under home.
 *
 * The non-bucket cases render the KEY rather than the LABEL, which also makes
 * `labelRootsApart`'s collision growing invisible in the header: two roots
 * cannot share a key (`resolveRoots` dedupes on it), so two headers cannot read
 * alike. `label` is still what the `+`'s tooltip and the empty-root sentence
 * say, where a short word is what is wanted.
 */
export function rootHeaderParts(root: SessionRootFolder): { prefix: string; text: string } {
  if (root.other) return { prefix: '', text: root.label };
  if (root.key === '~' || root.key === '$HOME') return { prefix: '', text: root.label };
  if (root.key.startsWith('~/')) return { prefix: '~/', text: root.key.slice(2) };
  return { prefix: '', text: root.key };
}

/**
 * Group sessions into the panel's folder tree.
 *
 * @param home the host's `$HOME`, or null — in which case it is inferred from
 *   the paths ({@link inferHome}) rather than surrendering every row to
 *   `other`.
 * @param roots the active host's REGISTERED roots
 *   (`settings.sessionRootsFor(host)`), in the order they were registered.
 *   Empty — the default — keeps the original
 *   behaviour of deriving roots from `$HOME`'s children, so nothing changes
 *   for a user who has configured nothing.
 *
 * **Root order.** Registered roots render in REGISTERED ORDER: a declared
 * list is itself an ordering. Derived roots render in FIRST-APPEARANCE order
 * — the position of each root's first row in the session list, which is the
 * host's sort (docs/SESSIONLIST.md §6). There are no comparators left in this
 * file: the panel's job is to fold the host's flat, already-sorted list into
 * roots and folders without disturbing it, the way `buildRows` does one level
 * down. Either way `other` is pinned last, however recent it is: it is a
 * bucket, not a place, and letting it float to the top would put the
 * least-organised rows where the eye lands first. Rows keep the session
 * list's order within each root.
 */
export function groupSessionsIntoRoots(
  sessions: SessionSummary[],
  home: string | null = null,
  roots: readonly string[] = [],
): SessionRootFolder[] {
  const resolvedHome = normaliseHome(home) ?? inferHome(sessions.map((s) => s.path));
  const configured = resolveRoots(roots, resolvedHome);
  const configuredKeys = new Set(configured.map((root) => root.key));
  const rows = buildRows(sessions);

  // Pass 1: the roots the NAME heuristic (§4.6) is allowed to file into.
  //
  // Configured: the registered list. A root the user declared is BETTER
  // evidence than one we inferred, so a no-cwd session called `tmp-scratch`
  // reaches a registered `~/tmp` even when nothing else is running there.
  // Derived: only roots that exist from REAL paths, which is what stops the
  // heuristic inventing a place rather than merely placing a session.
  const rootLabels = new Map<string, string>();
  if (configured.length > 0) {
    for (const root of configured) rootLabels.set(root.label, root.key);
  } else {
    for (const row of rows) {
      if (row.untracked) continue;
      const { key, label } = rootForPath(row.folderPath, resolvedHome);
      if (key !== OTHER_ROOT) rootLabels.set(label, key);
    }
  }

  /** Where a row's working directory belongs, before the name heuristic. */
  function placeRow(row: SessionRow): { key: string; label: string } {
    if (configured.length === 0) return rootForPath(row.folderPath, resolvedHome);
    const match = bestRootForPath(row.folderPath, resolvedHome, configured);
    if (match === null) return { key: OTHER_ROOT, label: OTHER_LABEL };
    return { key: match.key, label: match.label };
  }

  // Pass 2: place every row, then group its root's rows into directories.
  const byRoot = new Map<string, { key: string; label: string; rows: SessionRow[] }>();
  // Registered roots are seeded EMPTY, before any row is placed, so a root the
  // user declared still renders when nothing is running in it — including on a
  // host where the directory does not exist at all. A registered root is a
  // statement of intent, not a fact derived from the session list, and a
  // setting that silently shows nothing reads as a broken setting.
  for (const root of configured) {
    byRoot.set(root.key, { key: root.key, label: root.label, rows: [] });
  }
  for (const row of rows) {
    let placement = placeRow(row);
    if (row.untracked) {
      const recovered = rootFromSessionName(row.session.name, rootLabels.keys());
      const key = recovered !== null ? rootLabels.get(recovered) : undefined;
      if (recovered !== null && key !== undefined) placement = { key, label: recovered };
    }
    const bucket = byRoot.get(placement.key);
    if (bucket) bucket.rows.push(row);
    else byRoot.set(placement.key, { ...placement, rows: [row] });
  }

  const folders: SessionRootFolder[] = [];
  for (const bucket of byRoot.values()) {
    const directories = buildDirectories(bucket.rows, resolvedHome);
    // A session with no reported cwd can only have reached a REAL root through
    // the name heuristic, so that pairing is what marks the guess — there is
    // no other way for an untracked row to be anywhere but `other`.
    for (const dir of directories) dir.inferredRoot = dir.untracked && bucket.key !== OTHER_ROOT;
    // Scoped to the root: two `foo` directories under one root still need
    // growing apart, but `~/git/foo` vs `~/work/foo` are already told apart by
    // their two headers, so growing both would be the header's information a
    // second time. First-appearance order comes out of `buildDirectories`
    // untouched — a directory sits where its first session sat in the host's
    // list.
    disambiguateLabels(directories, (dir) => dir.path);
    folders.push({
      key: bucket.key,
      label: bucket.label,
      directories,
      sessionCount: bucket.rows.length,
      mostRecentActivity: directories.reduce((max, d) => Math.max(max, d.mostRecentActivity), 0),
      active: directories.some((d) => d.active),
      other: bucket.key === OTHER_ROOT,
      configured: configuredKeys.has(bucket.key),
    });
  }

  const rooted = folders.filter((f) => !f.other);
  const other = folders.filter((f) => f.other);
  if (configured.length > 0) {
    // Registered order. Every non-`other` key here came from `configured` —
    // `placeRow` and the name heuristic can only produce registered keys or
    // `other` — so the lookup always hits.
    const rank = new Map(configured.map((root, index) => [root.key, index]));
    rooted.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  }
  // Derived mode: nothing to do — `byRoot`'s insertion order already is
  // first-appearance order in the host's list.
  return [...rooted, ...other];
}

/**
 * Group one root's rows into directory nodes, preserving the incoming row
 * order inside each, and first-appearance order across the nodes themselves.
 *
 * Untracked rows get a key of their own rather than sharing the
 * {@link UNTRACKED_PATH} sentinel, so they stay one row each. Merging them
 * would produce a branch labelled `Untracked` whose children are the only
 * labels those sessions ever had — a level of nesting that hides the one fact
 * the row carries.
 */
function buildDirectories(rows: SessionRow[], home: string | null): SessionDirectory[] {
  const byKey = new Map<string, SessionDirectory>();
  for (const row of rows) {
    const path = row.untracked ? UNTRACKED_PATH : directoryKey(row.folderPath, home);
    const key = row.untracked ? `${UNTRACKED_PATH}\x00${row.session.name}` : path;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    // An untracked session has no directory to name it after, so its own name is
    // the only label there is — the same rule the flat row already used.
    const label = row.untracked ? row.session.name : defaultLabelForPath(path);
    byKey.set(key, {
      key,
      path,
      label,
      rows: [row],
      mostRecentActivity: 0,
      active: false,
      untracked: row.untracked,
      inferredRoot: false,
    });
  }

  const directories = [...byKey.values()];
  for (const dir of directories) {
    // MAX for the age: it is the one field that must move, because it is the
    // row's displayed "2h". The ORDER of `directories` is untouched here —
    // first appearance in the host's list is what the panel renders.
    dir.mostRecentActivity = dir.rows.reduce(
      (max, r) => Math.max(max, sessionActivity(r.session)),
      0,
    );
    dir.active = dir.rows.some((r) => r.session.attached);
  }
  return directories;
}
