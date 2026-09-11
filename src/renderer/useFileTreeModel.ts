import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { ConnectionId } from '../shared/types';
import { FILE_ROW_CAP, viewFileRows, type FileListView } from './fileListView';
import { normaliseTypedPath } from './remotePaths';
import { listStep, type ListStepKey } from '../shared/listNavigation';
import { isShortcut } from '../shared/shortcuts';
import { pointAnchor, type Box } from '../shared/popupPlacement';
import type { DirEntry } from '../main/sftp/SftpService';
import type { useFilesStore } from './stores/files';
import type { useSettingsStore } from './stores/settings';

export interface FileTreeModelDeps {
  files: ReturnType<typeof useFilesStore>;
  settings: ReturnType<typeof useSettingsStore>;
  connId: ComputedRef<ConnectionId | null>;
  /** Activate a row's entry — the tree's click semantics, owned by the view. */
  onEntry: (entry: DirEntry) => void | Promise<void>;
}

/**
 * The file tree's model: the rendered rows (cap + search), the keyboard
 * navigation over them, the inline create flow, and the editable path bar.
 *
 * The tree's state and behavior, extracted from FileTree.vue so the component
 * keeps template and gestures; every decision record below travelled with its
 * code.
 */
export function useFileTreeModel(deps: FileTreeModelDeps): {
  // rows
  cap: Ref<number>;
  query: Ref<string>;
  searchOpen: Ref<boolean>;
  searchEl: Ref<HTMLInputElement | null>;
  view: ComputedRef<FileListView<DirEntry>>;
  loadMore: () => void;
  focusSearch: () => Promise<void>;
  closeSearch: () => void;
  // keyboard
  entryListEl: Ref<HTMLElement | null>;
  upRow: ComputedRef<number>;
  rowCount: ComputedRef<number>;
  rowTabIndex: (i: number) => 0 | -1;
  onRowFocus: (i: number) => void;
  focusRow: (i: number) => void;
  onListKeydown: (e: KeyboardEvent) => void;
  // create
  creating: Ref<'file' | 'folder' | null>;
  createName: Ref<string>;
  createEl: Ref<HTMLInputElement | null>;
  createMenu: Ref<{ anchor: Box } | null>;
  plusBtn: Ref<HTMLButtonElement | null>;
  startCreate: (kind: 'file' | 'folder') => void;
  cancelCreate: () => void;
  commitCreate: () => Promise<void>;
  toggleCreateMenu: () => void;
  onListContextMenu: (e: MouseEvent) => void;
  // path bar
  editing: Ref<boolean>;
  draft: Ref<string>;
  inputEl: Ref<HTMLInputElement | null>;
  startEditing: () => Promise<void>;
  cancelEditing: () => void;
  onSubmit: () => Promise<void>;
} {
  const { files } = deps;

  // -------------------------------------------------------------------------
  // Row cap + search
  // -------------------------------------------------------------------------
  //
  // The cap is a RENDER cap, not a fetch limit: `api.sftp.list` already returns
  // the whole directory in a single `readdir`, so nothing is saved by asking for
  // less, and everything is lost by it — the search below filters the FULL
  // listing the store is holding, which is what makes a match past row 100
  // findable at all. `src/renderer/fileListView.ts` carries that reasoning and
  // the logic; this half is the wiring.

  /** Rows currently allowed to render. Grows by `FILE_ROW_CAP` per "Load more". */
  const cap = ref(FILE_ROW_CAP);
  /** The filter text. Blank means "no filter", not "match nothing". */
  const query = ref('');
  const searchOpen = ref(false);
  const searchEl = ref<HTMLInputElement | null>(null);

  const view = computed(() => viewFileRows(files.entries, { query: query.value, cap: cap.value }));

  // Entering a directory starts at 100 again, or the cap silently stops meaning
  // anything after a few folders. The query is cleared too: a filter that
  // survives navigation looks like an empty directory in the next folder.
  watch(
    () => files.cwd,
    () => {
      cap.value = FILE_ROW_CAP;
      query.value = '';
      searchOpen.value = false;
    },
  );

  // Typing resets the cap as well, so the first 100 MATCHES are shown rather
  // than the first 100 matches among the first 100 rows.
  watch(query, () => {
    cap.value = FILE_ROW_CAP;
  });

  function loadMore(): void {
    cap.value += FILE_ROW_CAP;
  }

  async function focusSearch(): Promise<void> {
    searchOpen.value = true;
    await nextTick();
    searchEl.value?.focus();
    searchEl.value?.select();
  }

  function closeSearch(): void {
    searchOpen.value = false;
    query.value = '';
  }

  // -------------------------------------------------------------------------
  // Keyboard navigation over the entry list (FEATURES.md F18 — "the tree is
  // fully keyboard-navigable")
  // -------------------------------------------------------------------------
  //
  // The session panel's folder rows are <button>s — Tab reaches them, Enter
  // opens them, and Ctrl+↑/↓ walks workspaces — so the file list was the one
  // tree a keyboard could not reach. This is the standard roving-tabindex fix:
  // exactly one row is a Tab stop at a time, arrows move the focus, Enter or
  // Space activates (the platform's own behaviour for a focused control, not a
  // registered chord), Home and End jump to the ends. The arithmetic lives in
  // shared/listNavigation.ts beside its two siblings.
  //
  // `kbIndex` of -1 means "nothing focused yet"; row 0 is then the sole Tab
  // stop, so Tab always has a way in. A directory change resets it: the rows
  // the index named are gone, and a fresh listing should not start mid-way.

  const entryListEl = ref<HTMLElement | null>(null);
  const kbIndex = ref(-1);

  /** How many rows precede the entry list proper (the `..` row, when present). */
  const upRow = computed(() => (files.cwd !== '/' ? 1 : 0));
  const rowCount = computed(() => upRow.value + view.value.rows.length);

  function rowTabIndex(i: number): 0 | -1 {
    return kbIndex.value === i || (kbIndex.value === -1 && i === 0) ? 0 : -1;
  }

  function onRowFocus(i: number): void {
    kbIndex.value = i;
  }

  function focusRow(i: number): void {
    if (!rowCount.value) return;
    const target = Math.max(0, Math.min(rowCount.value - 1, i));
    kbIndex.value = target;
    void nextTick(() => {
      entryListEl.value?.querySelector<HTMLElement>(`[data-idx="${target}"]`)?.focus();
    });
  }

  function activateRow(i: number): void {
    if (!deps.connId.value) return;
    if (i < upRow.value) {
      void files.cd(deps.connId.value, '..');
      return;
    }
    const entry = view.value.rows[i - upRow.value];
    if (entry) void deps.onEntry(entry);
  }

  function onListKeydown(e: KeyboardEvent): void {
    // Only when a ROW holds focus — the search box and the path field keep
    // their own arrows, and nothing here may steal them.
    const row = (e.target as HTMLElement | null)?.closest?.('[data-idx]');
    if (!row) return;
    if (isShortcut(deps.settings.shortcutBindings, 'files.treeStep', e)) {
      const key: ListStepKey | null =
        e.key === 'ArrowDown'
          ? 'down'
          : e.key === 'ArrowUp'
            ? 'up'
            : e.key === 'Home'
              ? 'home'
              : e.key === 'End'
                ? 'end'
                : null;
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      const next = listStep(rowCount.value, kbIndex.value, key);
      if (next != null) focusRow(next);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateRow(Number((row as HTMLElement).dataset['idx']));
    }
  }

  watch(
    () => files.cwd,
    () => {
      kbIndex.value = -1;
    },
  );

  // -------------------------------------------------------------------------
  // New file / new folder
  // -------------------------------------------------------------------------
  //
  // Creation was the one thing this tab could not DO: it browsed, opened,
  // served and downloaded, but making a file meant going to a terminal. The
  // shape is the editors' (VS Code's explorer, Nautilus): an inline naming row
  // at the top of the list, not a dialog — creating is a small edit of the
  // listing, and a modal would stop the user checking the names already on
  // screen while they type.
  //
  // Two doors into the same menu, because neither is always reachable: a `+` on
  // the breadcrumb strip (discoverable, and there even when the listing is
  // full), and a right-click on the listing's empty ground (where a Files-app
  // user looks for it first). One menu, one action set.
  //
  // The store does the work — `createFile` refuses-to-overwrite is the
  // main-process verb, a created FILE opens ready to type into, a created
  // FOLDER just appears in the listing — and a refusal keeps the naming row
  // open over the footer's message, the same ruling as the path bar.

  const creating = ref<'file' | 'folder' | null>(null);
  const createName = ref('');
  const createEl = ref<HTMLInputElement | null>(null);

  function startCreate(kind: 'file' | 'folder'): void {
    createMenu.value = null;
    creating.value = kind;
    createName.value = '';
    void nextTick(() => createEl.value?.focus());
  }

  function cancelCreate(): void {
    creating.value = null;
  }

  async function commitCreate(): Promise<void> {
    const kind = creating.value;
    if (!deps.connId.value || kind == null) return;
    // Enter on an empty field dismisses — do nothing, not an error, the same
    // ruling the path bar makes for an empty submit.
    const name = createName.value.trim();
    if (name === '') {
      creating.value = null;
      return;
    }
    const ok =
      kind === 'folder'
        ? await files.createFolder(deps.connId.value, name)
        : await files.createFile(deps.connId.value, name);
    // A cancel during the create (Esc, a blur) is not re-opened by the answer.
    if (ok && creating.value === kind) creating.value = null;
  }

  /** The menu's anchor: null when closed. Both doors write the same state. */
  const createMenu = ref<{ anchor: Box } | null>(null);
  const plusBtn = ref<HTMLButtonElement | null>(null);

  function toggleCreateMenu(): void {
    if (createMenu.value || plusBtn.value == null) {
      createMenu.value = null;
      return;
    }
    const box = plusBtn.value.getBoundingClientRect();
    createMenu.value = {
      anchor: { left: box.left, top: box.bottom, width: box.width, height: box.height },
    };
  }

  /**
   * Right-click on the listing itself, as opposed to a row: the row's own
   * handler has already claimed anything with an `.entry` under the pointer,
   * and this bubbling second pass must not overwrite that menu with the
   * creation one. Everything else — the ground below a short listing, the
   * Load-more row — is the empty folder's "make something here".
   */
  function onListContextMenu(e: MouseEvent): void {
    if ((e.target as HTMLElement | null)?.closest?.('.entry')) return;
    createMenu.value = { anchor: pointAnchor(e.clientX, e.clientY) };
  }

  // -------------------------------------------------------------------------
  // The path bar
  // -------------------------------------------------------------------------
  //
  // Typing or pasting a path was the one way to navigate this tab that did not
  // exist: the tree walks one directory at a time and the breadcrumb only goes
  // UP, so a path sitting in the clipboard — out of terminal output, a log, a
  // colleague's message — could not be used at all.
  //
  // It is click-to-edit rather than a second permanent row, the way Explorer and
  // VS Code do it. The breadcrumb strip already IS the "where am I" line, and
  // spending another --tabbar-h on a control used a few times a session, in a
  // pane whose whole job is a list, is not a trade this layout can afford (see
  // the same reasoning behind the merged session bar). The pencil
  // button is the affordance, so the feature does not depend on knowing a chord;
  // Ctrl+L is there for people who expect it from every address bar they use.
  //
  // Editing REPLACES the crumbs rather than sitting beside them, which also keeps
  // c9d4039's `~` collapsing intact by not touching the crumb builder at all.
  // It is now also the escape hatch that makes the crumb COLLAPSING safe: however
  // much of the middle the `…` swallows, the full path is one click from here.

  /** True while the strip is an input rather than a row of crumbs. */
  const editing = ref(false);
  /** What the user has typed. Seeded from the current directory on open. */
  const draft = ref('');
  const inputEl = ref<HTMLInputElement | null>(null);

  async function startEditing(): Promise<void> {
    // Seeded with the current directory and fully selected: typing replaces it
    // outright, while a small edit to where you already are stays cheap.
    draft.value = files.cwd;
    editing.value = true;
    await nextTick();
    inputEl.value?.focus();
    inputEl.value?.select();
  }

  function cancelEditing(): void {
    editing.value = false;
  }

  /**
   * Go where the field says.
   *
   * The destination goes through `files.revealPath` — the SAME action a path
   * clicked in the terminal uses. That is deliberate and is the point of routing
   * both here: a directory navigates, a file opens in whichever viewer its kind
   * calls for, and a path that is not there says so. Two entry points with two
   * copies of that logic would drift the first time one of them was touched.
   *
   * The field stays open when the path did not resolve, because the next thing
   * the user wants is to fix the typo, not to type the whole path again.
   */
  async function onSubmit(): Promise<void> {
    if (!deps.connId.value) return;
    const target = normaliseTypedPath(draft.value, files.cwd);
    if (target == null) {
      editing.value = false;
      return;
    }
    await files.revealPath(deps.connId.value, target);
    if (files.error == null) editing.value = false;
  }

  return {
    cap,
    query,
    searchOpen,
    searchEl,
    view,
    loadMore,
    focusSearch,
    closeSearch,
    entryListEl,
    upRow,
    rowCount,
    rowTabIndex,
    onRowFocus,
    focusRow,
    onListKeydown,
    creating,
    createName,
    createEl,
    createMenu,
    plusBtn,
    startCreate,
    cancelCreate,
    commitCreate,
    toggleCreateMenu,
    onListContextMenu,
    editing,
    draft,
    inputEl,
    startEditing,
    cancelEditing,
    onSubmit,
  };
}
