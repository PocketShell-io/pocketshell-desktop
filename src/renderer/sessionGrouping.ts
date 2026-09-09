/**
 * Folder grouping for the session list — a port of the Android app's
 * host-detail grouping so both clients section sessions identically.
 *
 * Android reference (C:/Users/alexey/git/pocketshell):
 *   - `FolderListViewModel.canonicalisePath`   (FolderListViewModel.kt:2068)
 *   - `FolderListViewModel.defaultLabelForPath`(FolderListViewModel.kt:2091)
 *   - `FolderListViewModel.groupSessionsIntoFolders` (…:2140-2167)
 *   - `folderRowSort` / `recencySessionSort`   (…:2609-2637)
 *
 * The phone app has a second, outer grouping level ("watched roots" plus a
 * trailing "Other folders" bucket) driven by a per-host project-roots table.
 * The desktop stores the table in renderer settings keyed by SSH host alias,
 * and falls back to the phone's *no-watched-roots* path when the active host
 * has no entries — `groupSessionsIntoFolders` — where folder groups are the
 * top level. The sort rules below are the same functions that path uses.
 *
 * ## Three projections over one set of rules
 *
 * The panel renders {@link groupSessionsIntoRoots}: a tree whose top level is
 * a ROOT plus an `other` catch-all, and whose second level is the DIRECTORY
 * each session runs in.
 *
 * The root level is the phone's *watched-roots* level, and it now works the
 * phone's way: the user REGISTERS roots (`settings.sessionRootsFor(host)`), and
 * whatever falls under none of them goes to `other`. When nothing is
 * registered — the default, and every existing install — roots are still
 * SYNTHESISED from `$HOME`'s children, so the panel looks exactly as it did
 * before anybody visited Settings. See the block above {@link normaliseRootPath}
 * for the ported matching semantics and the three deliberate divergences.
 *
 * The directory level is NOT `groupSessionsByFolder`, and the difference is
 * that it is scoped to a root and keyed home-relative.
 *
 * Every directory is a node with its sessions as children, whatever it holds.
 * The original measurement: a 1:1 folder:session distribution (11 folders, 11
 * sessions) and two revisions concluded from it that a directory holding one
 * session should collapse into that session's row. The measurement was real;
 * the conclusion was wrong in practice, because at that distribution the
 * collapse fires on nearly every node and what renders is a flat list under
 * one header — not the `git -> folder -> session` tree the user asked for
 * three times. The projection below is
 * therefore uniform, and the renderer no longer branches on `rows.length`.
 *
 * `groupSessionsByFolder` stays exported as the phone-parity anchor for the
 * leaf level, and `canonicalisePath` / `defaultLabelForPath` remain the shared
 * label rules the folder-first creation flow also speaks.
 *
 * ## The panel's order is the HOST's order
 *
 * The panel no longer sorts anything. The listing that reaches the sessions
 * store is already in the order the host was asked for — `a` sorts it
 * (`--sort accessed` today; see the order contract on
 * `PocketshellClient.listSessions`) — and this file PRESERVES that document
 * order: `buildRows` maps the store's array in place, and the tree derives
 * both of its levels from first appearance in that same order. A row moves
 * only when the host says so, which is the point of delegating: the helper
 * owns the timestamps, so it owns the order they produce.
 *
 * History, because both predecessors were deliberate. The recency sort
 * rearranged rows under the cursor — the five-second poll re-samples
 * `activity`, and `attached` flips as a side effect of navigating — and the
 * user's fix was creation order: "let's not rearrange workspaces/sessions in
 * here because it's confusing. let's use wheveer order we had when creating."
 * Creation order kept faith until the host could sort, and the same concern
 * (an order you can build muscle memory for) moved host-side once `a` grew
 * `--sort`. What the client may still do with the order is ANSWER it, never
 * change it — and the user's MANUAL arrangement is not here either. It is a
 * projection applied ON TOP of this one, in `renderer/folderOrder.ts`, for
 * the same reason the workspace's manual tab order is separate from
 * `buildWorkspaceTabs`: this module answers "what order did the host hand
 * us", which is a fact about the host, and that module answers "where did the
 * user put them", which is a preference about the panel.
 */
import type { SessionAgentKind, SessionSummary } from '../shared/types';

/** Sentinel path for sessions whose working directory is unknown. */
export const UNTRACKED_PATH = '::untracked::';
export const UNTRACKED_LABEL = 'Untracked';
const ROOT_LABEL = '/ (root)';
const HOME_LABEL = '~ (home)';

/** One folder section: a working directory plus the sessions living in it. */
export interface SessionFolder {
  /** Canonical folder path, or {@link UNTRACKED_PATH}. Stable list key. */
  path: string;
  /** User-visible header label (trailing path segment). */
  label: string;
  sessions: SessionSummary[];
  /** Newest activity across the folder's sessions — drives folder order. */
  mostRecentActivity: number;
  /** True when any session in the folder is attached (drives the status dot). */
  active: boolean;
}

/**
 * Canonicalise a session's working directory into a grouping key.
 * Trailing slashes are dropped so `/srv/app/` and `/srv/app` are one folder;
 * blank/unknown collapses to {@link UNTRACKED_PATH}. `~` is deliberately NOT
 * expanded — tmux reports absolute paths, so a literal `~` means the helper
 * could not resolve one.
 */
export function canonicalisePath(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return UNTRACKED_PATH;
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || '/';
}

/**
 * Derive a non-blank header label from a canonical path: the trailing segment
 * (`/home/alexey/git/pocketshell` -> `pocketshell`), with named fallbacks for
 * the degenerate cases so a folder never reads as nameless.
 */
export function defaultLabelForPath(path: string): string {
  if (path === UNTRACKED_PATH) return UNTRACKED_LABEL;
  const clean = path.trim();
  if (!clean) return UNTRACKED_LABEL;
  const stripped = clean.replace(/\/+$/, '');
  if (!stripped) return ROOT_LABEL;
  if (stripped === '~' || stripped === '$HOME') return HOME_LABEL;
  const tail = stripped.slice(stripped.lastIndexOf('/') + 1);
  return tail.trim() ? tail : stripped;
}

/** Last-activity epoch for a session, falling back to its creation time. */
export function sessionActivity(session: SessionSummary): number {
  return session.activity || session.created || 0;
}

/**
 * Does this kind sort with the agents? Port of `SessionAgentKind.isAgentSession`
 * (FolderTreeProjection.kt:588-600).
 *
 * `probing` / `exited` group WITH the agents — they are sessions we launched,
 * just not currently classified. `unknown` (foreign, never classified) groups
 * with shells, per #821. Null/absent is the phone's "Unknown".
 */
export function isAgentSession(kind: SessionAgentKind | null | undefined): boolean {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'grok':
    case 'probing':
    case 'exited':
      return true;
    case 'shell':
    case 'unknown':
    case null:
    case undefined:
      return false;
    default:
      return false;
  }
}

/**
 * Within-folder session order, mirroring the phone's `recencySessionSort`
 * (FolderTreeProjection.kt:564-568): **agents first**, then most-recent
 * activity descending, then session name ascending.
 *
 * The agent key is the primary one on purpose — a folder full of shells should
 * never bury the agent session you are actually talking to.
 */
function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const byAgent = Number(isAgentSession(b.agentKind)) - Number(isAgentSession(a.agentKind));
  if (byAgent !== 0) return byAgent;
  const byActivity = sessionActivity(b) - sessionActivity(a);
  if (byActivity !== 0) return byActivity;
  return a.name.localeCompare(b.name);
}

/** Folder order: newest activity first, ties broken by case-insensitive label. */
function compareFolders(a: SessionFolder, b: SessionFolder): number {
  const byActivity = b.mostRecentActivity - a.mostRecentActivity;
  if (byActivity !== 0) return byActivity;
  return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
}

/**
 * Group sessions into folder sections.
 *
 * Ordering, as on the phone: folders sorted by most-recent activity (desc)
 * with a case-insensitive label tiebreak, and the `Untracked` bucket pinned
 * last regardless of its activity.
 */
export function groupSessionsByFolder(sessions: SessionSummary[]): SessionFolder[] {
  const byPath = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const path = canonicalisePath(session.path);
    const bucket = byPath.get(path);
    if (bucket) bucket.push(session);
    else byPath.set(path, [session]);
  }

  const folders: SessionFolder[] = [];
  for (const [path, bucket] of byPath) {
    const ordered = [...bucket].sort(compareSessions);
    folders.push({
      path,
      label: defaultLabelForPath(path),
      sessions: ordered,
      mostRecentActivity: ordered.reduce((max, s) => Math.max(max, sessionActivity(s)), 0),
      active: ordered.some((s) => s.attached),
    });
  }

  const tracked = folders.filter((f) => f.path !== UNTRACKED_PATH).sort(compareFolders);
  const untracked = folders.filter((f) => f.path === UNTRACKED_PATH);
  return [...tracked, ...untracked];
}

/* ---------------------------------------------------------------------------
 * Row projection — the leaf of the tree, and the whole of the flat list
 * ------------------------------------------------------------------------- */

/** Characters of a label kept on the right of a middle truncation. */
const TAIL_CHARS = 8;
/** Labels at or under this length are never split — they cannot overflow. */
const SPLIT_THRESHOLD = 12;

/** One rendered session row. */
export interface SessionRow {
  session: SessionSummary;
  /**
   * Primary label: the folder basename, or the session name itself when the
   * session has no known working directory.
   */
  label: string;
  /**
   * `label` split for middle truncation. `labelHead` is the shrinkable span
   * and `labelTail` the protected one; `labelTail` is empty for short labels,
   * which render as a single span.
   */
  labelHead: string;
  labelTail: string;
  /**
   * The SESSION NAME, split for middle truncation the same way `label` is.
   *
   * This is what every LEAF row renders, and the split matters most where a
   * directory holds siblings: they share a prefix by construction —
   * `git-pocketshell` and `git-pocketshell-quse` — so an end-ellipsis would
   * render them identically.
   */
  nameHead: string;
  nameTail: string;
  /** Canonical folder path, or {@link UNTRACKED_PATH}. */
  folderPath: string;
  /** How many sessions share this row's folder. */
  siblings: number;
  /** True when the working directory is unknown. */
  untracked: boolean;
}

/** Split a label so the distinguishing tail survives an overflow. */
export function splitLabel(label: string): { labelHead: string; labelTail: string } {
  if (label.length <= SPLIT_THRESHOLD) return { labelHead: label, labelTail: '' };
  return {
    labelHead: label.slice(0, label.length - TAIL_CHARS),
    labelTail: label.slice(label.length - TAIL_CHARS),
  };
}

/** The last `count` segments of a path, e.g. `('/a/b/c', 2)` -> `b/c`. */
function tailSegments(path: string, count: number): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts.slice(-count).join('/');
}

/** The shape {@link disambiguateLabels} needs: a path-derived label. */
interface PathLabelled {
  label: string;
  untracked: boolean;
}

/**
 * Two different folders can share a basename (`~/git/foo` and `~/work/foo`).
 * Grow every colliding label by parent segments — the same depth for the whole
 * colliding set, so they stay comparable — until they are distinct.
 *
 * Generic over the item because both levels that carry a path-derived label
 * need it: the flat list's rows, and the tree's directory nodes. `pathOf`
 * exists because those two spell the path field differently and because the
 * directory node's path is the home-relative KEY, which is the spelling
 * that has already had tmux's two forms of one directory folded into it.
 */
export function disambiguateLabels<T extends PathLabelled>(items: T[], pathOf: (item: T) => string): void {
  const pathsByLabel = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.untracked) continue;
    const seen = pathsByLabel.get(item.label);
    if (seen) seen.add(pathOf(item));
    else pathsByLabel.set(item.label, new Set([pathOf(item)]));
  }

  for (const [label, paths] of pathsByLabel) {
    if (paths.size < 2) continue;
    const deepest = Math.max(...[...paths].map((p) => p.split('/').filter(Boolean).length));
    let depth = 2;
    while (depth < deepest) {
      const expanded = new Set([...paths].map((p) => tailSegments(p, depth)));
      if (expanded.size === paths.size) break;
      depth += 1;
    }
    for (const item of items) {
      if (item.untracked || item.label !== label) continue;
      item.label = tailSegments(pathOf(item), depth) || item.label;
    }
  }
}

/**
 * The path a session GROUPS under, which is not always the path it runs in.
 *
 * A session in a linked git worktree groups under the repository the worktree
 * belongs to — the user's "this one should be in
 * dtc-website actually" about a session running in `~/git/merry-sniffing-token`.
 * `repoRoot` is set by the main process only for worktrees, so for every other
 * session this is just its own path.
 *
 * Note what does NOT change: `session.path` is untouched, and it is what the
 * Files tab opens at. Grouping answers "where does this work belong"; the path
 * answers "where is this process standing", and for a worktree those are
 * genuinely different places.
 */
function groupingPath(session: SessionSummary): string {
  return canonicalisePath(session.repoRoot ?? session.path);
}

/**
 * Build one row per session, in the order the sessions arrived, but NOT yet
 * disambiguated.
 *
 * "The order the sessions arrived" is doing real work in that sentence: it is
 * the host's order, and this function is a map, not a sort. The main process
 * asks the host to sort the listing (`--sort accessed`; the order contract is
 * on `PocketshellClient.listSessions`), the store keeps that document order,
 * and a row moves only when the host says so. `Ctrl+↑`/`Ctrl+↓` walk this
 * list, which is exactly why nothing here may rearrange it.
 *
 * It has been two other things. First recency — attached first, then activity
 * — and both of those keys move on their own: `activity` is re-sampled by the
 * panel's five-second poll, and `attached` flips the moment the user opens a
 * workspace, so the list rearranged itself both while the user was reading it
 * and as a side effect of the user reading it. Then creation order, the
 * user's fix for that ("let's not rearrange workspaces/sessions in here
 * because it's confusing"), which held until the host could sort.
 *
 * The workspace's TAB BAR is the one surface that still sorts by creation
 * (`buildWorkspaceTabs`), on its own stability argument — a bar that reorders
 * under the refresh timer moves the target between the click and the hit. The
 * panel and the bar therefore order a folder's sessions differently now,
 * deliberately: the bar's rows are HIT targets, the panel's rows are the
 * host's list.
 *
 * Disambiguation is left to the caller because its correct SCOPE differs
 * between the two projections: the flat list has to separate `~/git/foo` from
 * `~/work/foo` itself, while the tree already separates them with two root
 * headers and only needs to disambiguate within a root.
 *
 * Built on the same `canonicalisePath` / `defaultLabelForPath` /
 * `sessionActivity` rules as {@link groupSessionsByFolder}, so every
 * projection agrees about what a folder is called.
 */
export function buildRows(sessions: SessionSummary[]): SessionRow[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const path = groupingPath(session);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  return sessions.map((session) => {
    const folderPath = groupingPath(session);
    const untracked = folderPath === UNTRACKED_PATH;
    // An untracked session has no folder to name it after, so its own name is
    // the only label there is — and there is nothing left to show beside it.
    const label = untracked ? session.name : defaultLabelForPath(folderPath);
    const siblings = counts.get(folderPath) ?? 1;
    const nameSplit = splitLabel(session.name);
    return {
      session,
      label,
      ...splitLabel(label),
      nameHead: nameSplit.labelHead,
      nameTail: nameSplit.labelTail,
      folderPath,
      siblings,
      untracked,
    };
  });
}
