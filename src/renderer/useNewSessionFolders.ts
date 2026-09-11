import { computed, nextTick, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { displayPath, joinPosix } from './stores/projects';
import { FILE_ROW_CAP, viewFileRows, type FileListView } from './fileListView';
import type { LaunchChoice } from '../shared/agentLaunch';
import type { Box } from '../shared/popupPlacement';
import type { DirEntry } from '../main/sftp/SftpService';
import type { useConnectionStore } from './stores/connection';
import type { useProjectsStore } from './stores/projects';
import type { SessionRoute } from './useNewSessionCommit';

export interface NewSessionFoldersDeps {
  projects: ReturnType<typeof useProjectsStore>;
  connection: ReturnType<typeof useConnectionStore>;
  route: Ref<SessionRoute>;
  /** True while a commit or a route's slow step is running (the commit pipeline). */
  busy: ComputedRef<boolean>;
  /** The one commit path; Enter on the `existing` route ends in it. */
  commit: (choice: LaunchChoice | null) => Promise<void>;
}

/**
 * The new-session dialog's folder browser: the always-visible filter, the
 * type-arrow-Enter keyboard flow, the rendered row cap, the crumb bar's
 * segments, and the roots dropdown.
 *
 * Extracted from NewSessionDialog.vue; every decision record below travelled
 * with its code. The state this feeds — target folder, derived name, the
 * commit path — lives in `useNewSessionCommit`.
 */
export function useNewSessionFolders(deps: NewSessionFoldersDeps): {
  folderQuery: Ref<string>;
  searchEl: Ref<HTMLInputElement | null>;
  folderListEl: Ref<HTMLElement | null>;
  activeRowIndex: Ref<number | null>;
  crumbs: ComputedRef<{ label: string; path: string }[]>;
  folderView: ComputedRef<FileListView<DirEntry>>;
  focusSearch: () => void;
  revealActiveRow: () => void;
  onFilterKeydown: (e: KeyboardEvent) => Promise<void>;
  showMoreFolders: () => void;
  onSearchEscape: (e: KeyboardEvent) => void;
  onEnter: (name: string) => Promise<void>;
  onUp: () => Promise<void>;
  onCrumb: (path: string) => Promise<void>;
  onHome: () => Promise<void>;
  rootsAnchor: Ref<Box | null>;
  rootsBtnEl: Ref<HTMLElement | null>;
  toggleRootsMenu: () => void;
  onRoot: (path: string) => Promise<void>;
} {
  const { projects, connection } = deps;
  const connId = computed(() => connection.connectionId);

  // -------------------------------------------------------------------------
  // Searching the folder listing
  // -------------------------------------------------------------------------
  //
  // `~/git` on the user's host is dozens of directories in a 260px box, which is
  // a scroll-and-squint every time a session is created. The logic is NOT
  // written here: `src/renderer/fileListView.ts` already solved this problem for
  // the Files tab and its header carries the reasoning. Two of its properties
  // are the whole reason to reuse it rather than to write `.includes()` again:
  //
  //   - **filter the FULL listing, then cap.** `projects.dirs` holds the entire
  //     directory (one `sftp.readdir`, no paging), so a match past row 100 is
  //     findable. Filtering what is rendered would search only what the user had
  //     already scrolled to, which is the most confusing behaviour available.
  //   - **the cap is a RENDER cap**, so "Show more" costs no round trip.
  //
  // ALWAYS VISIBLE here, where the Files tab summons its box with a button.
  // That is not an inconsistency, it is the same rule reaching a different
  // answer: the Files tree is a drag-narrow pane whose breadcrumb strip already
  // carries three controls, so a fourth permanent one would take back the line
  // the breadcrumb had just won. This is a fixed-width modal whose ONLY job is
  // picking a folder out of that list — there is no competing content to crowd,
  // and between `sessions.new` (Ctrl+Shift+N) and the caret this filter starts
  // with, a search you cannot see would still be a search nobody uses.
  // The chord's reasoning lives with the reserved-chord table in shared/shortcuts.ts.
  /** Filter over the browsed directory. Blank means "no filter". */
  const folderQuery = ref('');
  /** The filter input — where this dialog points the keyboard on open. */
  const searchEl = ref<HTMLInputElement | null>(null);

  /**
   * The caret starts IN the filter, because typing is the flow the `+` begins:
   * click `+`, type a few letters, click the row. Focusing the dialog's shell or
   * the first tab button instead would spend the first typed characters moving
   * focus that was never where the user's words were going.
   *
   * The input is disabled while a browse is in flight and a disabled element
   * cannot take focus, so the open browse (the `startIn` landings) swallows the
   * mount-time attempt; when the listing arrives and the input re-enables, focus
   * goes there after all. Landing it after every browse — entering a folder, up,
   * a crumb — keeps that same flow intact one level deeper: filter, descend,
   * filter again, with the caret never dropped on the floor.
   */
  function focusSearch(): void {
    if (projects.browsing) return;
    searchEl.value?.focus();
  }

  watch(
    () => projects.browsing,
    (browsing, was) => {
      if (was && !browsing) focusSearch();
    },
  );
  onMounted(focusSearch);

  // -------------------------------------------------------------------------
  // The keyboard flow: type, arrow, Enter
  // -------------------------------------------------------------------------
  //
  // The `+`/`Ctrl+Shift+N` ask was "my hands don't leave the keyboard": open the
  // picker, type a few letters, press Enter, and a session exists in that
  // folder. The filter alone only ever narrowed a list whose rows were
  // click-only — the keyboard could search but not ANSWER.

  /**
   * The highlighted row of {@link folderView}, or null when none is.
   *
   * Null is also the "let Enter mean the first match" state: after typing, the
   * palette contract is that Enter acts on the top hit without a preliminary
   * ArrowDown. With a BLANK query there is no such default — Enter would
   * otherwise start a session in whichever folder sorts first, which is nobody's
   * intent — so blank-query Enter does nothing until an arrow key has spoken.
   */
  const activeRowIndex = ref<number | null>(null);

  // Any of these replaces the rows the index was pointing into.
  watch(
    [folderQuery, () => projects.dirs, () => projects.cwd, deps.route],
    () => {
      activeRowIndex.value = null;
    },
  );

  const folderListEl = ref<HTMLElement | null>(null);

  function revealActiveRow(): void {
    void nextTick(() => {
      folderListEl.value
        ?.querySelector('.folder-row.active')
        ?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  /**
   * Enter on the filter: descend into the highlighted (or first matching)
   * folder and — on the `existing` route — start a shell in it, which is the
   * one-action commit `Start shell` performs. Descent runs first and is
   * verified, so the session targets the folder the row named, not whatever
   * `cwd` was last; a failed descent (folder gone) leaves nothing created and
   * `browseError` saying why.
   *
   * Ctrl+Enter descends WITHOUT starting — the keyboard's way to browse into a
   * nested folder on the way to a deeper match. On the `new` route Enter only
   * ever descends: that route's commit is the name field's own Enter.
   */
  async function onFilterKeydown(e: KeyboardEvent): Promise<void> {
    if (deps.route.value === 'clone') return;
    const rows = folderView.value.rows;
    const id = connId.value;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      const from = activeRowIndex.value ?? (down ? -1 : 0);
      activeRowIndex.value = Math.min(rows.length - 1, Math.max(0, from + (down ? 1 : -1)));
      revealActiveRow();
      return;
    }

    if (e.key !== 'Enter' || deps.busy.value || !id) return;
    const index = activeRowIndex.value ?? (folderQuery.value.trim() === '' ? null : 0);
    const row = index === null ? null : rows[index];
    if (!row) return;

    const parent = projects.cwd;
    await projects.enter(id, row.name);
    // A descent that did not land (the row's folder vanished under the list)
    // must not commit in the parent by accident.
    if (projects.cwd !== joinPosix(parent, row.name)) return;
    if (deps.route.value === 'existing' && !e.ctrlKey && !e.metaKey) await deps.commit(null);
  }

  /** Rows the browser will render. Grows by FILE_ROW_CAP per "Show more". */
  const folderCap = ref(FILE_ROW_CAP);

  /**
   * The browsed directory, filtered then capped.
   *
   * `projects.dirs` entries already carry a `name`, which is the whole of
   * `NamedEntry`, so no adapter is needed — the generalisation `viewFileRows`
   * needed to serve a second caller was done when it was written.
   */
  const folderView = computed(() =>
    viewFileRows(projects.dirs, { query: folderQuery.value, cap: folderCap.value }),
  );

  /**
   * A `cd` clears the filter and the cap.
   *
   * The filter because a query that survives navigation renders the next folder
   * as empty and reads as a broken listing — the single most baffling state this
   * feature can produce. The cap because otherwise it stops meaning anything
   * after a few folders: it is "the first hundred rows of what I am looking at",
   * not a running total.
   */
  watch(
    () => projects.cwd,
    () => {
      folderQuery.value = '';
      folderCap.value = FILE_ROW_CAP;
    },
  );

  // Typing resets the cap too, so the box shows the first hundred MATCHES rather
  // than the matches among the first hundred rows.
  watch(folderQuery, () => {
    folderCap.value = FILE_ROW_CAP;
  });

  function showMoreFolders(): void {
    folderCap.value += FILE_ROW_CAP;
  }

  /**
   * Escape in the search box clears the filter — but ONLY when there is one.
   *
   * `OverlayPanel` closes on Escape from a `document` listener, so a box that
   * swallowed the key unconditionally would make Escape mean nothing at all once
   * the filter was empty: the user presses it, the dialog stays, they press it
   * again, the dialog stays. Conditional swallowing gives the two meanings a
   * natural order — undo the filter, then leave — which is the same ladder the
   * composer's Escape uses.
   *
   * This is field-local and therefore NOT a registry chord: `shared/shortcuts.ts`
   * arbitrates keys that several surfaces could claim, and Escape inside a text
   * input that is on screen for as long as this modal is has no one to collide
   * with. The Files tree's search box makes the same call.
   */
  function onSearchEscape(e: KeyboardEvent): void {
    if (folderQuery.value === '') return;
    e.stopPropagation();
    e.preventDefault();
    folderQuery.value = '';
  }

  /** Breadcrumb segments for the browsed path, `~` collapsed. */
  const crumbs = computed(() => {
    const shown = displayPath(projects.cwd, projects.home);
    const parts = shown.split('/').filter((p) => p.length > 0);
    const out: { label: string; path: string }[] = [];
    let acc = shown.startsWith('~') ? (projects.home ?? '') : '';
    for (const part of parts) {
      if (part === '~') continue;
      acc = joinPosix(acc || '/', part);
      out.push({ label: part, path: acc });
    }
    return out;
  });

  async function onEnter(name: string): Promise<void> {
    if (connId.value) await projects.enter(connId.value, name);
  }

  async function onUp(): Promise<void> {
    if (connId.value) await projects.up(connId.value);
  }

  async function onCrumb(path: string): Promise<void> {
    if (connId.value) await projects.browse(connId.value, path);
  }

  async function onHome(): Promise<void> {
    if (connId.value && projects.home) await projects.browse(connId.value, projects.home);
  }

  // -------------------------------------------------------------------------
  // The roots dropdown
  // -------------------------------------------------------------------------
  //
  // The crumb bar's home / up / crumb trail answers "where am I relative to this
  // directory"; the roots menu answers "which of my roots am I in" — a jump one
  // level above the crumbs, from `~/git/proj` to `~/work` in one click instead
  // of walking up past `$HOME` and back down. The `+` already lands the browser
  // in the panel's first root; this menu is the "but select a different one"
  // half of that ask.

  /** Viewport box of the dropdown trigger, when the menu is open. */
  const rootsAnchor = ref<Box | null>(null);
  const rootsBtnEl = ref<HTMLElement | null>(null);

  function toggleRootsMenu(): void {
    if (rootsAnchor.value) {
      rootsAnchor.value = null;
      return;
    }
    const box = rootsBtnEl.value?.getBoundingClientRect();
    if (box) rootsAnchor.value = { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  /** Jump the browser to a root, and close the menu that offered it. */
  async function onRoot(path: string): Promise<void> {
    rootsAnchor.value = null;
    if (connId.value) await projects.browse(connId.value, path);
  }

  return {
    folderQuery,
    searchEl,
    folderListEl,
    activeRowIndex,
    crumbs,
    folderView,
    focusSearch,
    revealActiveRow,
    onFilterKeydown,
    showMoreFolders,
    onSearchEscape,
    onEnter,
    onUp,
    onCrumb,
    onHome,
    rootsAnchor,
    rootsBtnEl,
    toggleRootsMenu,
    onRoot,
  };
}
