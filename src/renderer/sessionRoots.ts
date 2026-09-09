/**
 * The roots a panel's top level is assembled from — the user-registered ones
 * (stored per host in `stores/settings.ts`), the paths they stand for, and
 * every path algebra their keys need: home inference, home-relative spelling,
 * root membership, and the stable directory key a manual order is stored
 * under. Extracted from sessionGrouping.ts, which keeps the row model this
 * feeds; the tree assembly that consumes both lives in sessionTree.ts.
 */
import { canonicalisePath, defaultLabelForPath, UNTRACKED_PATH } from './sessionGrouping';
import { sanitisePart } from '../shared/sessionNameParts';

/** Sentinel key for the catch-all root. Stable list key, never a real path. */
export const OTHER_ROOT = '::other::';
export const OTHER_LABEL = 'other';

/* ---------------------------------------------------------------------------
 * Registered roots — the top level, when the user has configured one
 *
 * The phone calls these WATCHED ROOTS and stores them per host in a Room table
 * (`project_roots`: `{hostId, label, path}`, ProjectRootEntity.kt:26-32). The
 * desktop stores them in `stores/settings.ts`, keyed by the SSH config alias.
 * A root is written home-relative (`~/git`), but that spelling does not mean
 * the directory exists on every host; the alias is the stable instance
 * identity that keeps one box's layout out of another's.
 *
 * Matching semantics are ported from FolderTreeProjection.kt verbatim, because
 * that is the behaviour the user already knows from the phone:
 *   - prefix match on a `/` boundary, so `~/git` never claims `~/gitlab`
 *     (`pathWithinRoot`, :310);
 *   - longest match wins when roots nest, first-registered breaking a tie
 *     (`bestRootForPath`, :475);
 *   - a session sitting exactly ON the root belongs to it;
 *   - anything matching no root goes to `other`, pinned last (:276);
 *   - a registered root with no sessions still renders (:179-241).
 *
 * Three deliberate divergences:
 *   - the phone's no-roots fallback dumps EVERYTHING into `Other folders`
 *     (:253-274). We keep deriving roots from `$HOME` instead, so a user who
 *     has configured nothing sees exactly what they saw before.
 *   - the phone dedupes roots by their STORED spelling, so `~/git` and
 *     `/home/me/git` survive as two identical-looking nodes. We dedupe on the
 *     resolved key, so they cannot.
 *   - the phone collapses a session's directory to the FIRST segment under its
 *     root (`projectPathUnderRoot`, :538). We keep the full directory the
 *     session actually runs in; the argument for keeping it is close.
 * ------------------------------------------------------------------------- */

/**
 * Upper bound on the registered-root list, applied when settings are parsed.
 *
 * Not a UI limit anybody should reach — it is a guard on a hand-editable JSON
 * blob, so a corrupt or pathological array cannot make the panel render
 * thousands of headers.
 */
export const SESSION_ROOTS_MAX = 32;

/**
 * Clean one registered root into the form that gets STORED, or null if it is
 * not usable as a root at all.
 *
 * Stored roots keep the spelling the user typed — `~/git` stays `~/git`,
 * `/home/alexey/git` stays absolute — because `$HOME` is per-host, so at write
 * time there is no home to rewrite against. The two spellings are folded
 * together later and per host by
 * {@link resolveRoots}, through `directoryKey`: the same rule that already
 * folds tmux's two spellings of one directory into one node. One rule applied
 * twice, rather than a second normalisation free to drift from it.
 */
export function normaliseRootPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // A control character cannot be in a path the user meant to type, and a
  // newline inside a stored root would corrupt every listing that prints it.
  if ([...value].some((ch) => ch < ' ')) return null;
  const canonical = canonicalisePath(value);
  if (canonical === UNTRACKED_PATH) return null;
  // `..` is refused rather than resolved: resolving it needs a real filesystem,
  // and a root that names a different directory depending on where it is
  // resolved from is not a root. The phone refuses it too
  // (WatchedFoldersViewModel.kt:368-388).
  if (canonical.split('/').includes('..')) return null;
  // Anchored, as on the phone: absolute, or under `~`. A bare `git` would be
  // relative to nothing this panel can name.
  if (canonical !== '~' && !canonical.startsWith('~/') && !canonical.startsWith('/')) return null;
  return canonical;
}

/**
 * Clean a whole stored list: drop what {@link normaliseRootPath} rejects, drop
 * exact repeats, and cap the length.
 *
 * Dedupe here is exact-string only. `~/git` and `/home/alexey/git` are still
 * two entries at this point and are collapsed by {@link resolveRoots} once a
 * host's `$HOME` is known — which is the only place that question has an
 * answer.
 */
export function normaliseRootList(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= SESSION_ROOTS_MAX) break;
    const root = normaliseRootPath(value);
    if (root !== null && !out.includes(root)) out.push(root);
  }
  return out;
}

/** A registered root, resolved against one host's `$HOME`. */
export interface ResolvedRoot {
  /** Home-relative comparison key (`~/git`), or an absolute path outside home. */
  key: string;
  /** Header label: the root's own name, grown on collision. */
  label: string;
  /** The stored spelling, kept for the header tooltip. */
  source: string;
}

/**
 * Two registered roots can share a basename (`~/git/work`, `~/clients/work`).
 * Give every member of a colliding set its home-relative path instead, so no
 * two headers read identically. Deliberately simpler than the directory
 * level's `disambiguateLabels`: a root list is short, user-authored, and the
 * user can rename the collision away by registering a different root.
 */
function labelRootsApart(roots: ResolvedRoot[]): void {
  const counts = new Map<string, number>();
  for (const root of roots) counts.set(root.label, (counts.get(root.label) ?? 0) + 1);
  for (const root of roots) {
    if ((counts.get(root.label) ?? 0) < 2) continue;
    root.label = root.key.startsWith('~/') ? root.key.slice(2) : root.key;
  }
}

/**
 * Resolve the stored root list against a host's `$HOME`, in registered order.
 *
 * Deduping happens on the RESOLVED key, which is what stops `~/git` and
 * `/home/alexey/git` — the same directory, two spellings, both perfectly
 * reasonable things for a user to type — rendering as two identical branches.
 * The phone dedupes on the stored spelling and does render both.
 */
export function resolveRoots(roots: readonly string[], home: string | null): ResolvedRoot[] {
  const resolved: ResolvedRoot[] = [];
  const seen = new Set<string>();
  for (const source of roots) {
    const canonical = normaliseRootPath(source);
    if (canonical === null) continue;
    const key = directoryKey(canonical, home);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ key, label: defaultLabelForPath(key), source: canonical });
  }
  labelRootsApart(resolved);
  return resolved;
}

/**
 * Is `path` at or below `root`? Port of `pathWithinRoot`
 * (FolderTreeProjection.kt:310).
 *
 * The `/` boundary is the whole point: a plain `startsWith` would let `~/git`
 * swallow `~/gitlab`, and a user who registers one of those and not the other
 * means it.
 */
export function pathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * Which registered root claims this working directory, or null for none.
 *
 * **Longest match wins**, so registering both `~/git` and `~/git/work` puts a
 * session in `~/git/work/thing` under `work` rather than under `git` — the
 * more specific declaration is the more deliberate one. A tie is impossible
 * between distinct keys of equal length that both match, but the comparison is
 * strict `>` regardless, so the FIRST-registered root wins one if it ever
 * arises; that is `maxByOrNull`'s behaviour on the phone.
 */
export function bestRootForPath(
  folderPath: string,
  home: string | null,
  roots: readonly ResolvedRoot[],
): ResolvedRoot | null {
  if (folderPath === UNTRACKED_PATH) return null;
  const key = directoryKey(folderPath, home);
  let best: ResolvedRoot | null = null;
  for (const root of roots) {
    if (!pathWithinRoot(key, root.key)) continue;
    if (best === null || root.key.length > best.key.length) best = root;
  }
  return best;
}

/** Trim a `$HOME` value to a comparable prefix; blank becomes "unknown". */
export function normaliseHome(home: string | null | undefined): string | null {
  const trimmed = (home ?? '').trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Directories that hold home directories on the platforms this app connects
 * to: Linux (`/home`), macOS (`/Users`), image-based Linux (`/var/home`), and
 * `root` — whose home is `/root` itself, not a child of anything.
 */
const HOME_PARENTS = ['/home', '/Users', '/var/home'];
const ROOT_HOME = '/root';

/**
 * Guess `$HOME` from the session paths themselves.
 *
 * The panel wants the host's real `$HOME`, but resolving it is a round trip
 * that can legitimately fail (`projects.homeError`), and with no home every
 * absolute path falls into `other` — one undifferentiated bucket, which is
 * precisely the view the user asked us to replace. So when the authoritative
 * value is missing we read the shape of the paths we already have.
 *
 * This is a fallback and is treated as one: only the standard home parents
 * count, and the most frequently seen candidate wins, so one stray `/root/x`
 * cannot outvote nine sessions under `/home/alexey`.
 */
export function inferHome(paths: (string | null | undefined)[]): string | null {
  const votes = new Map<string, number>();
  for (const raw of paths) {
    const path = canonicalisePath(raw);
    if (path === UNTRACKED_PATH) continue;
    let candidate: string | null = null;
    if (path === ROOT_HOME || path.startsWith(`${ROOT_HOME}/`)) candidate = ROOT_HOME;
    else {
      for (const parent of HOME_PARENTS) {
        if (!path.startsWith(`${parent}/`)) continue;
        const user = path.slice(parent.length + 1).split('/')[0];
        if (user) candidate = `${parent}/${user}`;
        break;
      }
    }
    if (candidate) votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestVotes = 0;
  for (const [candidate, count] of votes) {
    if (count > bestVotes) {
      best = candidate;
      bestVotes = count;
    }
  }
  return best;
}

/**
 * A canonical path rewritten relative to `$HOME`, or null when it is not under
 * one. `''` means the path IS `$HOME`.
 *
 * The home-relative spelling is what folds the two forms tmux reports for one
 * directory — the absolute `/home/alexey/git/x` from the active pane and the
 * literal unexpanded `~/git/x` that `session_path` can carry
 * (helper/parsers.ts:163) — into a single key. A `~` prefix needs no `home` to
 * resolve: `~` *is* home, whatever it expands to.
 */
function homeRelative(folderPath: string, home: string | null): string | null {
  if (folderPath === '~' || folderPath === '$HOME') return '';
  if (folderPath.startsWith('~/')) return folderPath.slice(2);
  const homePrefix = normaliseHome(home);
  if (homePrefix === null) return null;
  if (folderPath === homePrefix) return '';
  if (folderPath.startsWith(`${homePrefix}/`)) return folderPath.slice(homePrefix.length + 1);
  return null;
}

/**
 * Which top-level folder a session's working directory belongs to.
 *
 * Everything outside `$HOME` is `other`, and honestly so: a path outside
 * `$HOME` (`/var/log`, `/srv/app`) shares no parent with the home-rooted
 * sessions, and a session sitting in `$HOME` itself has no root folder to be
 * named after.
 */
export function rootForPath(
  folderPath: string,
  home: string | null,
): { key: string; label: string } {
  const other = { key: OTHER_ROOT, label: OTHER_LABEL };
  if (folderPath === UNTRACKED_PATH) return other;

  const relative = homeRelative(folderPath, home);
  if (relative === null) return other;

  const first = relative.split('/').find((part) => part.length > 0);
  if (!first) return other;
  return { key: `~/${first}`, label: first };
}

/**
 * The grouping key for a session's DIRECTORY — the same home-relative rewrite
 * the root key gets, applied at full depth (`~/git/dataops`).
 *
 * Written home-relative for exactly the reason {@link rootForPath} is: without
 * it, one directory reported both ways would render as two identically
 * labelled rows sitting next to each other.
 */
export function directoryKey(folderPath: string, home: string | null): string {
  if (folderPath === UNTRACKED_PATH) return UNTRACKED_PATH;
  const relative = homeRelative(folderPath, home);
  if (relative === null) return folderPath;
  return relative ? `~/${relative}` : '~';
}

/**
 * The ABSOLUTE host path a ROOT KEY names, or null when it names none.
 *
 * This is the inverse of the home-relative rewrite {@link directoryKey}
 * performs, and it exists for exactly one caller: the `+` on a root row, which
 * has to hand a real directory to the folder picker. A root key is a GROUPING
 * key — `~/git` — and `~` is a shell's expansion. The picker browses over SFTP,
 * which runs no shell, so `~/git` passed through as-is names a directory that
 * does not exist and the browse fails with a confusing "no such file".
 *
 * Null rather than a guess in the three cases where there is no honest answer:
 *
 *   - the `other` bucket is not a directory at all — it is where paths that
 *     matched no root went, and there is nothing to create a session *in*;
 *   - {@link UNTRACKED_PATH} is the same, one level down;
 *   - a `~`-rooted key on a host whose `$HOME` we never learned. Substituting
 *     the literal `~` would put the session somewhere the user did not pick.
 *
 * A configured root that resolved to an absolute path outside `$HOME`
 * (`/srv/apps`) passes straight through: that spelling needs no expansion.
 */
export function rootHostPath(key: string, home: string | null): string | null {
  if (key === OTHER_ROOT || key === UNTRACKED_PATH) return null;
  const homePrefix = normaliseHome(home);
  if (key === '~' || key === '$HOME') return homePrefix;
  if (key.startsWith('~/')) {
    if (homePrefix === null) return null;
    const rest = key.slice(2).replace(/\/+$/, '');
    return rest ? `${homePrefix}/${rest}` : homePrefix;
  }
  return key.startsWith('/') ? key : null;
}

/**
 * Recover a session's ROOT from its NAME when no working directory was
 * reported at all.
 *
 * This is a heuristic, and it is deliberately a shallow one. Session names on
 * this host are DERIVED from the path: `sessionBaseName` joins the
 * home-relative components with `-` after running each through `sanitisePart`
 * (src/main/projects/sessionName.ts). So `~/git/red-stamp-sound` becomes
 * `git-red-stamp-sound`, and the leading component of the name is the root the
 * session lives under — recoverable even when tmux reports no cwd, which
 * happens when the active pane has exited or was never recorded.
 *
 * It recovers the ROOT ONLY, never the directory, because the derivation is
 * not invertible past the first component: `-` is both the component separator
 * AND a legal character inside a component, so `git-dtc-website-import` is
 * genuinely ambiguous between `~/git/dtc-website-import` and
 * `~/git/dtc-website/import`. Inventing a directory row from that guess would
 * be worse than not having one, so a name-recovered session sits as a direct
 * child of its root instead.
 *
 * @param knownLabels the root labels that exist from REAL paths. Matching only
 *   against those is what stops the heuristic inventing structure: a session
 *   called `foo-bar` must not conjure a `foo` root nothing else lives in.
 * @returns the matching root label, or null to leave the session in `other`.
 */
export function rootFromSessionName(name: string, knownLabels: Iterable<string>): string | null {
  const first = name.split('-').find((part) => part.length > 0);
  if (!first) return null;
  for (const label of knownLabels) {
    // Compare sanitised: the name carries the sanitised form of the folder
    // component, so a root literally called `my.project` is `my_project` here.
    if (sanitisePart(label) === first) return label;
  }
  return null;
}
