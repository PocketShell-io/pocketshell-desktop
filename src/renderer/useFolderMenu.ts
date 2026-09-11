import { ref, type ComputedRef, type Ref } from 'vue';
import { pointAnchor, type Box } from '../shared/popupPlacement';
import type { SessionDirectory } from './sessionTree';
import { rootHostPath } from './sessionRoots';

/**
 * One open row menu's state, snapshotted at right-click time — one object so
 * the label, the resolved folder and the session set cannot disagree about
 * which row was under the cursor.
 */
export interface FolderMenuState {
  label: string;
  startIn: string | null;
  /**
   * The sessions in the folder, snapshotted at open time.
   *
   * Same rule as `startIn` below, and it matters more here: this is the list a
   * confirmed Stop kills. Re-read at click time it could have grown on the
   * poll, and the folder would lose a session the user was never shown and
   * never agreed to lose. Each entry carries the row's aplexer address with
   * it, because a tag alone does not address an aplexer session.
   */
  sessions: { name: string; workspace: string | null; aplexerId: string | null; backend: 'tmux' | 'aplexer' }[];
  anchor: Box;
}

export interface FolderMenuDeps {
  /** The panel's resolved `$HOME`, for turning a folder key into a real directory. */
  home: ComputedRef<string | null>;
  /** The folder-first creation dialog, which `New session…` arms. */
  creating: Ref<{ startIn: string | null } | null>;
}

/**
 * The session tree's folder-row context menu: the state, the right-click that
 * snapshots it, and the `New session…` item that spends it. Extracted from
 * SessionTree.vue with its reasoning; the Stop item this menu arms lives in
 * `useFolderStop`.
 */
export function useFolderMenu(deps: FolderMenuDeps): {
  folderMenu: Ref<FolderMenuState | null>;
  openFolderMenu: (dir: SessionDirectory, e: MouseEvent) => void;
  createInFolder: () => void;
} {
  /* ── The folder row's context menu ─────────────────────────────────────────
   * A root row has a `+` and the header has a `+`, and between them they cover
   * "a session under `git`" and "a session anywhere". What neither covers is the
   * case the user actually hit: standing in front of the row that says
   * `dataqna`, wanting another session IN `dataqna`, and having to open the
   * picker at `~/git` and browse back down to the folder already under the
   * cursor. The row knows its own directory; the only thing missing was a way to
   * ask it.
   *
   * A right-click rather than another revealed `+`. The row is already tight —
   * dot, label, up to two badges, a count and a timestamp, in a panel that drags
   * down to 232px, where the container query has already had to drop the
   * timestamp — and the `+` on the root above it is the mark whose whole
   * justification (see `.root-add`) was that one per ROOT is a tolerable number
   * of identical marks to run down a scannable panel. One per FOLDER is not.
   *
   * `PopupMenu` rather than an absolute dropdown, for the reason that component
   * exists: `.folder-list` is `overflow-y: auto`, so a menu laid out inside a row
   * is clipped at the list's edge and a row near the bottom would open a menu
   * nobody can see. It teleports to `body` and positions from a measured
   * viewport rect, which is what a menu on a scrolling list needs.
   */
  const folderMenu = ref<FolderMenuState | null>(null);

  /**
   * Right-click a folder row.
   *
   * The absolute directory is resolved HERE, at open time, and parked in the
   * menu's own state rather than re-derived when the item is clicked. Same
   * reasoning as `creating` holding one object instead of a boolean and a path:
   * the poll re-reads the session list every few seconds, so `home` and the row
   * set can both move between the right-click and the click on the item. Resolved
   * once, the enabled/disabled state the user SAW and the folder the dialog gets
   * cannot disagree; re-derived, they could, and the way that failure presents is
   * a session created somewhere the user did not point at.
   *
   * `rootHostPath` is named for the root row's `+` but it is not root-specific —
   * it is the inverse of `directoryKey`, and `dir.path` is exactly what
   * `directoryKey` produced (`~/git/dataqna`). Reusing it is what keeps one rule
   * for turning a grouping key back into a real host directory, rather than a
   * second expansion free to drift from the first. It answers null for an
   * untracked folder, which is the case the item is disabled for.
   *
   * Nothing here selects the row, and that is deliberate — the workspace's tab
   * menu takes the same position. A right-click the user then dismisses would
   * otherwise have already navigated them somewhere else.
   */
  function openFolderMenu(dir: SessionDirectory, e: MouseEvent): void {
    folderMenu.value = {
      label: dir.label,
      startIn: rootHostPath(dir.path, deps.home.value),
      sessions: dir.rows.map((row) => ({
        name: row.session.name,
        workspace: row.session.workspace ?? null,
        aplexerId: row.session.aplexerId ?? null,
        backend: row.session.backend ?? 'tmux',
      })),
      anchor: pointAnchor(e.clientX, e.clientY),
    };
  }

  /**
   * "New session…" from the row's menu: the same folder-first dialog both `+`s
   * open, handed the folder the user right-clicked.
   *
   * The dialog still opens its picker rather than skipping to a confirmation,
   * because `startIn` is where the browse LANDS and not a folder already chosen.
   * That is the honest shape for it: a folder row is a strong hint about where
   * the session goes, not a commitment, and the one step the user is spared —
   * browsing back down to a directory they had already pointed at — is the whole
   * of the complaint.
   *
   * The null guard is a second line rather than the only one: the item renders
   * disabled in that case, so this is unreachable through the UI. It stays
   * because "disabled in the template" and "cannot start" are two statements of
   * one fact, and the one that must not be skippable is this one — a `startIn`
   * of null does not fail, it silently means "$HOME", which is the wrong folder
   * rather than no folder.
   */
  function createInFolder(): void {
    const target = folderMenu.value;
    folderMenu.value = null;
    if (!target || target.startIn === null) return;
    deps.creating.value = { startIn: target.startIn };
  }

  return { folderMenu, openFolderMenu, createInFolder };
}
