<script setup lang="ts">
// FileTree: the SFTP directory listing for the current path. Click a dir to
// enter it; click a file to open it in the editor. Includes a one-line
// breadcrumb, a summonable search box, a capped row list with "Load more",
// refresh, and a "new folder/file" affordance wired to the store.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon, { type AppIconName } from './AppIcon.vue';
import PopupMenu from './PopupMenu.vue';
import { api } from '../ipc';
import { useConnectionStore } from '../stores/connection';
import { useFilesStore, normaliseTypedPath } from '../stores/files';
import { formatBytes } from '../../shared/byteSize';
import { useSettingsStore } from '../stores/settings';
import { splitLabel } from '../sessionGrouping';
import { buildCrumbs, FILE_ROW_CAP, viewFileRows, type Crumb } from '../fileListView';
import { listStep, type ListStepKey } from '../../shared/listNavigation';
import { isShortcut } from '../../shared/shortcuts';
import { pointAnchor, type Box } from '../../shared/popupPlacement';
import type { DirEntry } from '../../main/sftp/SftpService';
import { errorMessage } from '../../shared/errors';

const emit = defineEmits<{
  openFile: [path: string];
  /**
   * Open [path] in a NEW Files tab rather than replacing this one.
   *
   * Emitted rather than done here because a Files TAB belongs to the folder
   * workspace: the tree can say "somewhere else", but only the tab bar can
   * create the somewhere. [kind] lets the workspace decide what "open" means
   * for a file versus a directory — see the menu below.
   */
  openInNewTab: [path: string, kind: 'dir' | 'file'];
  /**
   * The folder has an env file and the user asked for the env editor
   * (FEATURES.md F16). Emitted for the same reason as `openInNewTab`: the
   * overlay lives above the whole Files tab, which is FilesView's to mount.
   */
  openEnv: [];
}>();

const connection = useConnectionStore();
const files = useFilesStore();
const connId = computed(() => connection.connectionId);

/**
 * The current folder holds an env file the server-side editor can open.
 *
 * Read straight off the listing — `sftp.readdir` returns dot entries and the
 * store filters nothing — so the button's visibility costs no extra round
 * trip. Neither file is REQUIRED: the helper's `env list` merges both, and a
 * folder with only `.envrc` (direnv layouts) is exactly as editable.
 */
const envAvailable = computed(() =>
  files.entries.some((e) => e.name === '.env' || e.name === '.envrc'),
);

/**
 * The path as cells, on ONE line, always — as many whole segments as the
 * measured width holds, and the rest behind the `…` menu.
 *
 * THE WIDTH IS MEASURED, and that is the substance of this. The strip used to
 * collapse to a fixed four cells whatever the pane was, and then run each
 * survivor through `splitLabel` on top, so a 250px pane produced
 * `~ / … / v…previews / olya-…`: two truncations of one fact, with the folder
 * you are standing in the one that got cut. A cell count cannot be right at
 * both 180px and 640px, which is the whole range this splitter covers, so it
 * was wrong nearly everywhere and character truncation was left to finish a
 * job the collapse should have done. `fileListView.ts` carries the sources —
 * Carbon, Spectrum, WinUI, Nautilus, Grafana, VS Code — and the ladder they
 * agree on: collapse WHOLE segments first, cut characters only out of what
 * survives, and only ever out of one label.
 *
 * The hidden segments are not lost: the `…` opens a menu listing them, each
 * one still a link to that directory. That is what keeps this a breadcrumb
 * rather than a decorative string, and NN/g's tooltip guidance is explicit
 * that a tooltip cannot be the only route to something you need in order to
 * act. The full path is also always one click away in the editable path bar
 * (the pencil, or Ctrl+L), and on the strip's own `title`.
 */
const stripEl = ref<HTMLElement | null>(null);
/** Pixels the crumb strip has to itself. `null` until the observer has run. */
const stripWidth = ref<number | null>(null);
const breadcrumbs = computed<Crumb[]>(() =>
  buildCrumbs(files.cwd, files.home, { width: stripWidth.value ?? Number.POSITIVE_INFINITY }),
);

/**
 * One ResizeObserver, on the strip itself, is the entire cost of measuring.
 *
 * It observes `.crumbs`, whose width is the leftover after the button slot,
 * so nothing here has to know what the buttons cost. That only works because
 * `.crumbs` is `flex: 1 1 0` rather than `1 1 auto`: with an `auto` basis the
 * box would be CONTENT-sized whenever the crumbs were shorter than the space,
 * and a width that depends on the content that depends on the width is a
 * resize loop.
 *
 * Re-attached through a watcher rather than in `onMounted` because the strip
 * is `v-if`'d away while the path bar is open — the element the observer holds
 * would otherwise be a detached node from the first Ctrl+L onwards.
 */
let stripObserver: ResizeObserver | null = null;
watch(stripEl, (el) => {
  stripObserver?.disconnect();
  stripObserver = null;
  if (!el || typeof ResizeObserver === 'undefined') return;
  stripObserver = new ResizeObserver(() => {
    stripWidth.value = el.clientWidth;
  });
  stripObserver.observe(el);
});
onBeforeUnmount(() => {
  stripObserver?.disconnect();
  stripObserver = null;
});

/** Anchor for the `…` menu; null when it is closed. */
const gapMenu = ref<{ hidden: { name: string; path: string }[]; anchor: Box } | null>(null);

function openGap(e: MouseEvent, crumb: Crumb): void {
  if (crumb.kind !== 'gap') return;
  gapMenu.value = { hidden: crumb.hidden, anchor: pointAnchor(e.clientX, e.clientY) };
}

/**
 * Accessors so the template never has to narrow the crumb union itself.
 * `v-if`-based narrowing across sibling bindings is exactly the kind of thing
 * that compiles today and stops compiling on a toolchain bump.
 */
function crumbHidden(crumb: Crumb): { name: string; path: string }[] {
  return crumb.kind === 'gap' ? crumb.hidden : [];
}
function crumbName(crumb: Crumb): string {
  return crumb.kind === 'gap' ? '…' : crumb.name;
}
function crumbPath(crumb: Crumb): string {
  return crumb.kind === 'gap' ? '' : crumb.path;
}

async function onGapCrumb(path: string): Promise<void> {
  gapMenu.value = null;
  await onCrumb(path);
}

/**
 * The row the context menu is acting on, and where to draw the menu.
 *
 * `null` closes it. The ENTRY is held rather than just its path because the
 * menu's items differ for a directory and a file, and re-deriving that from a
 * path would mean guessing from the spelling.
 */
const menu = ref<{ entry: DirEntry; anchor: Box } | null>(null);

/** Absolute remote path of an entry in the current directory. */
function pathOf(entry: DirEntry): string {
  const base = files.cwd.endsWith('/') ? files.cwd.slice(0, -1) : files.cwd;
  return `${base}/${entry.name}`;
}

/**
 * Right-click a row.
 *
 * `.prevent` on the handler stops the browser's own menu, which in a packaged
 * Electron app is the default Chromium one and has nothing useful on it.
 *
 * This deliberately does NOT collide with TerminalView's `contextmenu` handler
 * (which pastes): that listener is bound to the terminal's own container
 * element, and the two elements are in different tabs of the workspace — they
 * are never both on screen, and neither is an ancestor of the other, so there
 * is no bubbling path between them.
 *
 * The menu acts on the entry it was opened on, which is a RENDERED row — so
 * the row cap and the search filter cannot desynchronise it: a row you cannot
 * see is a row you cannot right-click.
 */
function onRowContextMenu(e: MouseEvent, entry: DirEntry): void {
  menu.value = { entry, anchor: pointAnchor(e.clientX, e.clientY) };
}

function closeMenu(): void {
  menu.value = null;
}

// ---------------------------------------------------------------------------
// New file / new folder
// ---------------------------------------------------------------------------
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
  if (!connId.value || kind == null) return;
  // Enter on an empty field dismisses — do nothing, not an error, the same
  // ruling the path bar makes for an empty submit.
  const name = createName.value.trim();
  if (name === '') {
    creating.value = null;
    return;
  }
  const ok =
    kind === 'folder'
      ? await files.createFolder(connId.value, name)
      : await files.createFile(connId.value, name);
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

/**
 * "Open in a new tab" — the user's "open in new panel".
 *
 * A DIRECTORY opens a Files tab standing in it. A FILE opens a Files tab in its
 * PARENT directory with the file itself open, which is the reading that makes
 * the phrase true: you asked for a panel showing that thing, so the panel shows
 * it. Seeding at the file's own path instead would ask the SFTP layer to list a
 * regular file, and landing in the parent with nothing open would make the
 * action indistinguishable from right-clicking the folder.
 */
function openInNewTab(entry: DirEntry): void {
  const path = pathOf(entry);
  emit('openInNewTab', path, entry.type === 'dir' ? 'dir' : 'file');
  closeMenu();
}

/**
 * Save an entry to this machine, through the native dialog.
 *
 * The store's own `download()` only ever acts on the OPEN file, so it cannot
 * serve a row the user has merely right-clicked. This calls the same channel
 * with the row's path instead of adding a second "open it first" step to a
 * menu whose whole point is acting on something you have not opened.
 */
async function downloadEntry(entry: DirEntry): Promise<void> {
  const connectionId = connId.value;
  closeMenu();
  if (!connectionId) return;
  try {
    await api.sftp.saveAs({ connectionId, remotePath: pathOf(entry) });
  } catch (e) {
    // Deliberately the LISTING channel, not `files.fileError`. The store's
    // own `download()` reports beside the editor because its button lives
    // there — but this download acts on a ROW, reached through the tree's own
    // context menu, so the user's eyes are on the tree when it fails and the
    // footer below it is the message's honest home. Each channel follows
    // where the action was taken, not what kind of action it was.
    files.error = errorMessage(e);
  }
}

/** Put the absolute path on the clipboard — the thing a terminal wants next. */
async function copyPath(entry: DirEntry): Promise<void> {
  const path = pathOf(entry);
  closeMenu();
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    // A clipboard a user has denied is not worth an error banner over a path
    // that is already visible in the row's tooltip.
  }
}

async function onEntry(entry: DirEntry): Promise<void> {
  if (!connId.value) return;
  if (entry.type === 'dir') {
    await files.cd(connId.value, entry.name);
  } else if (entry.type === 'file' || entry.type === 'symlink') {
    emit('openFile', entry.name);
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation over the entry list (FEATURES.md F18 — "the tree is
// fully keyboard-navigable")
// ---------------------------------------------------------------------------
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

const settings = useSettingsStore();
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
  if (!connId.value) return;
  if (i < upRow.value) {
    void files.cd(connId.value, '..');
    return;
  }
  const entry = view.value.rows[i - upRow.value];
  if (entry) void onEntry(entry);
}

function onListKeydown(e: KeyboardEvent): void {
  // Only when a ROW holds focus — the search box and the path field keep
  // their own arrows, and nothing here may steal them.
  const row = (e.target as HTMLElement | null)?.closest?.('[data-idx]');
  if (!row) return;
  if (isShortcut(settings.shortcutBindings, 'files.treeStep', e)) {
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

async function onCrumb(path: string): Promise<void> {
  if (!connId.value) return;
  // `goTo` rather than setting `cwd` and refreshing by hand, so a breadcrumb
  // jump is remembered as this session's position like any other move.
  await files.goTo(connId.value, path);
}

/**
 * The row's icon NAME. It doubles as the row icon's CSS
 * class, which is how the three entry types get their three token colours —
 * something the colour emoji this replaced could never do, because emoji
 * rasterisation ignores `color` entirely.
 */
function icon(entry: DirEntry): AppIconName {
  return entry.type === 'dir' ? 'folder' : entry.type === 'symlink' ? 'symlink' : 'file';
}

/**
 * Entry names middle-truncate, the same way session and folder labels do.
 *
 * They used to end-truncate (`text-overflow: ellipsis`), which was tolerable
 * while the pane was content-sized and simply grew to fit. Now that the pane
 * has a fixed width the truncation actually bites, and the END of a filename is
 * the part that distinguishes it — `report-2026-01.csv` and
 * `report-2026-02.csv` are one character apart, and it is the last one before
 * the extension. `splitLabel` is reused rather than reimplemented so this is
 * the app's ONE truncation rule and not a third variant of it.
 *
 * The breadcrumb uses it on EXACTLY ONE cell — the current folder, and only
 * when that folder alone is wider than the strip. Ancestors do not go through
 * it at all any more: a crumb that has already been narrowed to fit and is
 * then cut mid-name reads as a directory that does not exist (`v…previews`),
 * which is the reverse of every implementation surveyed in `fileListView.ts`
 * and is what Spectrum means by "Don't truncate multiple labels
 * simultaneously". An ancestor that does not fit is DROPPED, whole, into the
 * `…` menu, where its real name is still readable and still clickable.
 *
 * That the surviving cut is a MIDDLE one is the other half of the finding:
 * every filesystem UI that cuts a path segment cuts the middle — Nautilus's
 * `PANGO_ELLIPSIZE_MIDDLE`, Finder's path bar, Grafana's "center truncation",
 * whose stated reason is ours: "a simple end truncation isn't all that useful
 * given the types of naming schemes people use". `olya-merin` and
 * `olya-merina` differ in their last character; `olya-…` distinguishes neither.
 */
function nameParts(name: string): { labelHead: string; labelTail: string } {
  return splitLabel(name);
}

// ---------------------------------------------------------------------------
// Row cap + search
// ---------------------------------------------------------------------------
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

/** `3946` -> `3,946`. Thousands in a count are the whole point of showing it. */
function count(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// The path bar
// ---------------------------------------------------------------------------
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
  if (!connId.value) return;
  const target = normaliseTypedPath(draft.value, files.cwd);
  if (target == null) {
    editing.value = false;
    return;
  }
  await files.revealPath(connId.value, target);
  if (files.error == null) editing.value = false;
}

/** Lets FilesView put the caret in either field from its keydown handler. */
defineExpose({ editPath: startEditing, focusSearch });
</script>

<template>
  <div class="file-tree">
    <div class="breadcrumb">
      <!-- Enter goes, Escape gives up, and blur gives up too: leaving the pane
           with a half-typed path should not commit it. -->
      <input
        v-if="editing"
        ref="inputEl"
        v-model="draft"
        class="path-input"
        spellcheck="false"
        autocomplete="off"
        placeholder="/path/to/file"
        aria-label="Go to path"
        @keydown.enter.prevent="onSubmit"
        @keydown.esc.stop.prevent="cancelEditing"
        @blur="cancelEditing"
      />
      <template v-else>
        <!-- One scrolling-free line. `.crumbs` is the measured box: its width
             is what `buildCrumbs` fits the path into, which is why the ref is
             here and not on `.breadcrumb`. `:title` carries the full path, as
             a supplement to the `…` menu and never as a substitute for it. -->
        <span ref="stripEl" class="crumbs" :title="files.cwd">
          <span v-for="(c, i) in breadcrumbs" :key="i" class="crumb" :class="`is-${c.kind}`">
            <button
              v-if="c.kind === 'gap'"
              class="gap"
              :title="`${crumbHidden(c).length} folders not shown`"
              aria-label="Show the hidden path segments"
              @click="openGap($event, c)"
            >
              …
            </button>
            <!-- WHERE YOU ARE, and therefore not a link. NN/g guideline #5,
                 USWDS and the ARIA authoring practices all say the current
                 item should not link; here it would also be a click that
                 navigates to the directory already on screen. It is the one
                 cell allowed to truncate its own text — see `nameParts`. -->
            <span v-else-if="c.kind === 'current'" class="here" aria-current="page">
              <span class="nm-head">{{ nameParts(crumbName(c)).labelHead }}</span>
              <span v-if="nameParts(crumbName(c)).labelTail" class="nm-tail">
                {{ nameParts(crumbName(c)).labelTail }}
              </span>
            </span>
            <!-- An ancestor is whole or it is in the menu, so it renders as
                 one unsplit string with no ellipsis of its own. -->
            <a v-else :title="crumbPath(c)" @click="onCrumb(crumbPath(c))">{{ crumbName(c) }}</a>
            <!-- No separator after the `/` root: it IS the separator, and
                 `/ / srv / www` says the same thing twice in a strip whose
                 whole problem is space. `~` still takes one. -->
            <span v-if="i < breadcrumbs.length - 1 && crumbName(c) !== '/'" class="sep">/</span>
          </span>
        </span>
        <span class="strip-actions">
          <!-- Conditional, not summonable like search: a folder without env
               files has no editor to offer, and an always-present control
               would spend the strip's scarce width on a permanent no. -->
          <button
            v-if="envAvailable"
            class="icon-btn sm"
            title="Edit env for this folder"
            @click="emit('openEnv')"
          >
            <AppIcon name="type" :size="14" />
          </button>
          <button
            class="icon-btn sm"
            :class="{ on: searchOpen }"
            title="Search this folder"
            @click="searchOpen ? closeSearch() : focusSearch()"
          >
            <AppIcon name="search" :size="14" />
          </button>
          <button ref="plusBtn" class="icon-btn sm" title="New file or folder" @click="toggleCreateMenu">
            <AppIcon name="plus" :size="14" />
          </button>
          <button class="icon-btn sm" title="Go to path (Ctrl+L)" @click="startEditing">
            <AppIcon name="edit-2" :size="14" />
          </button>
          <button
            class="icon-btn sm"
            :disabled="files.loading"
            title="Refresh"
            @click="files.refresh(connId!)"
          >
            <AppIcon name="refresh" :size="14" :class="{ spin: files.loading }" />
          </button>
        </span>
      </template>
    </div>

    <!-- Summoned, not permanent. The strip above already carries a path and
         three buttons; a fourth always-on control in a pane that can be
         dragged narrow would crowd the one line the breadcrumb just won. -->
    <div v-if="searchOpen" class="search">
      <AppIcon name="search" :size="12" />
      <input
        ref="searchEl"
        v-model="query"
        class="search-input"
        spellcheck="false"
        autocomplete="off"
        :placeholder="`Filter ${count(files.entries.length)} entries`"
        aria-label="Filter this folder"
        @keydown.esc.stop.prevent="closeSearch"
      />
      <button class="icon-btn sm" title="Close search" @click="closeSearch">
        <AppIcon name="close" :size="12" />
      </button>
    </div>

    <ul
      ref="entryListEl"
      class="entries"
      role="listbox"
      aria-label="Files in this folder"
      @keydown="onListKeydown"
      @contextmenu.prevent="onListContextMenu"
    >
      <!-- The naming row for a pending create. First, where a new name sorts
           anyway, and a row rather than a dialog so the listing stays
           readable while typing. Outside the roving-tabindex walk on purpose:
           while it exists it holds real focus, and arrows belong to the
           field's own caret until Enter or Escape settles it. -->
      <li v-if="creating" class="entry creating">
        <AppIcon
          :name="creating === 'folder' ? 'folder' : 'file'"
          :class="creating === 'folder' ? 'folder' : 'file'"
        />
        <input
          ref="createEl"
          v-model="createName"
          class="create-input"
          spellcheck="false"
          autocomplete="off"
          :placeholder="creating === 'folder' ? 'folder name' : 'file name'"
          :aria-label="creating === 'folder' ? 'Name of the new folder' : 'Name of the new file'"
          @keydown.enter.prevent="commitCreate"
          @keydown.esc.stop.prevent="cancelCreate"
          @blur="cancelCreate"
        />
      </li>
      <!-- `..` sits OUTSIDE the v-for on purpose: it is navigation, not
           content, so neither the cap nor the filter may take it away. -->
      <li
        v-if="files.cwd !== '/'"
        class="entry up"
        role="option"
        :aria-selected="false"
        :tabindex="rowTabIndex(0)"
        data-idx="0"
        @click="files.cd(connId!, '..')"
        @focusin="onRowFocus(0)"
      >
        <AppIcon name="folder" />
        <span class="nm muted">..</span>
      </li>
      <li
        v-for="(e, i) in view.rows"
        :key="e.name"
        class="entry"
        role="option"
        :aria-selected="Boolean(files.openPath && files.openPath.endsWith('/' + e.name))"
        :class="{ active: files.openPath && files.openPath.endsWith('/' + e.name) }"
        :tabindex="rowTabIndex(upRow + i)"
        :data-idx="upRow + i"
        @click="onEntry(e)"
        @focusin="onRowFocus(upRow + i)"
        @contextmenu.prevent="onRowContextMenu($event, e)"
      >
        <AppIcon :name="icon(e)" :class="icon(e)" />
        <!-- Two spans, no measurement code: the head shrinks and ellipsises,
             the tail is protected. Same pattern as the session panel. -->
        <span class="nm" :title="e.name">
          <span class="nm-head">{{ nameParts(e.name).labelHead }}</span>
          <span v-if="nameParts(e.name).labelTail" class="nm-tail">
            {{ nameParts(e.name).labelTail }}
          </span>
        </span>
        <span v-if="e.type === 'file'" class="sz">{{ formatBytes(e.size) }}</span>
      </li>

      <!-- The count is the useful half: "Load more" alone does not say whether
           it is 12 rows away or 3,846. -->
      <li v-if="view.hidden > 0" class="more">
        <button class="more-btn" @click="loadMore">
          Load more — showing {{ count(view.rows.length) }} of {{ count(view.total) }}
        </button>
      </li>

      <li v-if="view.filtered && view.total === 0" class="empty muted">
        nothing matches “{{ query }}”
      </li>
      <li v-else-if="!files.entries.length && !files.loading" class="empty muted">
        empty directory
      </li>
    </ul>
    <p v-if="files.error" class="error">{{ files.error }}</p>

    <!-- Teleported, so the scrolling `.entries` list cannot clip it — the same
         reason the workspace's `+` menu is (src/shared/popupPlacement.ts). -->
    <PopupMenu
      v-if="menu"
      :anchor="menu.anchor"
      :label="menu.entry.name"
      @close="closeMenu"
    >
      <ul>
        <li class="menu-head">{{ menu.entry.name }}</li>
        <li>
          <button class="menu-item" @click="openInNewTab(menu.entry)">
            <AppIcon name="plus" :size="14" />
            Open in a new tab
          </button>
        </li>
        <li>
          <button class="menu-item" @click="onEntry(menu.entry), closeMenu()">
            <AppIcon :name="icon(menu.entry)" :size="14" />
            {{ menu.entry.type === 'dir' ? 'Open here' : 'Open in this tab' }}
          </button>
        </li>
        <li class="menu-sep" />
        <li>
          <button class="menu-item" @click="copyPath(menu.entry)">
            <AppIcon name="edit-2" :size="14" />
            Copy path
          </button>
        </li>
        <!-- Download is a FILE action. A directory would need a recursive
             transfer the SFTP layer does not offer, and an item that silently
             does nothing is worse than one that is not there. -->
        <li v-if="menu.entry.type !== 'dir'">
          <button class="menu-item" @click="downloadEntry(menu.entry)">
            <AppIcon name="download" :size="14" />
            Save to this computer…
          </button>
        </li>
      </ul>
    </PopupMenu>

    <!-- Creation's menu: opened by the strip's `+` and by a right-click on
         the listing's empty ground. `ignore` names the `+` so the press that
         toggles it shut is not counted as "outside" first. -->
    <PopupMenu
      v-if="createMenu"
      :anchor="createMenu.anchor"
      :ignore="[plusBtn]"
      label="New"
      @close="createMenu = null"
    >
      <ul>
        <li>
          <button class="menu-item" @click="startCreate('file')">
            <AppIcon name="file" :size="14" />
            New file
          </button>
        </li>
        <li>
          <button class="menu-item" @click="startCreate('folder')">
            <AppIcon name="folder" :size="14" />
            New folder
          </button>
        </li>
      </ul>
    </PopupMenu>

    <!-- The `…` crumb's contents. Collapsing part of a path is only acceptable
         because the segments it hides are still HERE and still navigate; a
         plain ellipsis with no way back would have turned the breadcrumb into
         decoration. A menu rather than a tooltip for the reason NN/g gives:
         information a user needs in order to ACT has to be on screen, and a
         hover target is not available to everyone. -->
    <PopupMenu
      v-if="gapMenu"
      :anchor="gapMenu.anchor"
      label="Path"
      @close="gapMenu = null"
    >
      <ul>
        <li class="menu-head">Folders not shown</li>
        <li v-for="seg in gapMenu.hidden" :key="seg.path">
          <button class="menu-item" :title="seg.path" @click="onGapCrumb(seg.path)">
            <AppIcon name="folder" :size="14" />
            {{ seg.name }}
          </button>
        </li>
      </ul>
    </PopupMenu>
  </div>
</template>

<style scoped>
/* WIDTH IS SET BY THE PARENT, as an inline `flex` basis (FilesView.vue).
   It used to be `min-width: 260px` with an `auto` basis, which made the pane
   CONTENT-sized: it grew to the longest filename in the directory and shrank
   again when you left, so the editor beside it moved every time the user
   browsed. That is the complaint this fixed basis answers; `min-width: 0` is
   what lets the basis actually win over the content. */
.file-tree {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
  height: 100%;
}
/* ONE LINE, ALWAYS — a rule every design system surveyed states outright
   (Carbon: "Breadcrumbs should never wrap onto a second line"; Atlassian:
   "always display on a single line"; NN/g guideline #9). `flex-wrap: wrap`
   here is what made a deep path render as three rows of chrome above the list;
   the measured collapsing in `buildCrumbs` is what lets `nowrap` be honest
   rather than merely clipping the tail. */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--tabbar-h);
  padding: var(--sp-1) var(--sp-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  flex-wrap: nowrap;
  overflow: hidden;
}
/* Takes the leftover width and clips inside itself, so overflow never reaches
   the button slot.

   `flex: 1 1 0` and NOT `1 1 auto`: the zero basis makes this box exactly the
   leftover space whatever it contains. With an `auto` basis it would be
   content-sized whenever the crumbs were short, and since the crumbs are
   chosen FROM this box's measured width (see the ResizeObserver in the
   script), a content-sized width is a resize loop. */
.crumbs {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
/* Ancestors yield, the current folder does not. `buildCrumbs` has already
   picked cells that fit, so this is the belt to that braces: a few pixels of
   estimation error must cost the LEFT of the strip, never the folder you are
   standing in. `text-overflow` is left at `clip` here on purpose — an ellipsis
   on an ancestor is the second truncation this redesign removed, and a clipped
   cell that only appears on a rounding error should not advertise itself as a
   deliberate shortening.

   The shrink FACTORS are the priority order, and the order is the whole point:
   ancestors 100, current 1, the `…` zero. Flex shares a deficit in proportion
   to `base x factor`, so a 100:1 ratio makes the ancestors absorb essentially
   all of it and bottom out at `min-width: 0` before the current gives up a
   single pixel. The `…` never yields at all — it is the only route back to
   the folders it stands for, so it outranks every cell it hides. */
.crumb {
  display: flex;
  align-items: center;
  flex: 0 100 auto;
  min-width: 0;
  overflow: hidden;
}
.crumb.is-gap {
  flex: 0 0 auto;
}
.crumb.is-current {
  flex: 0 1 auto;
  min-width: 0;
}
/* The buttons get a slot that never shrinks — being pushed off the end of the
   strip is the failure this replaces. */
.strip-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  margin-left: auto;
}
/* Navigation, not selection: accent is reserved for the selected row (see
   HostPickerView and ). An all-cyan crumb row made pure
   wayfinding the loudest thing on the Files screen. */
.crumb a {
  display: flex;
  min-width: 0;
  cursor: pointer;
  color: var(--fg-secondary);
  transition: color var(--dur-fast) var(--ease);
}
.crumb a:hover {
  color: var(--fg);
  text-decoration: underline;
}
/* "You are here" (NN/g, *Navigation: You Are Here*): the current folder is the
   one cell that is not a link, so it needs to LOOK unlike one or it reads as a
   crumb that has stopped working. Full `--fg` against the ancestors'
   `--fg-secondary`, and the weight lift is the same signal Nautilus's path bar
   gives its `current-dir` button while dimming everything left of it.
   Still no accent: accent is reserved for the selected ROW.
   The head/tail spans inside it pick up the SAME `.nm-head`/`.nm-tail` rules
   the entry rows use, further down; that is the point: one truncation
   mechanism, applied to one cell instead of four. */
.crumb.is-current .here {
  display: flex;
  min-width: 0;
  overflow: hidden;
  color: var(--fg);
  font-weight: var(--fw-medium);
}
/* The collapsed middle. Styled as a control rather than as text because it
   opens a menu — a `…` that looks like punctuation would never be clicked. */
.gap {
  flex: none;
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1;
}
.gap:hover {
  color: var(--fg);
}
.sep {
  color: var(--fg-muted);
  margin: 0 2px;
  flex: none;
}
/* Layout only — the size comes from the shared `.icon-btn.sm` primitive. */
.icon-btn.on {
  color: var(--accent);
}
/* Takes the strip's whole width while it is open — it replaces the crumbs
   rather than sharing the row with them. */
.path-input {
  flex: 1 1 auto;
  min-width: 0;
  height: var(--control-h-sm);
  background: var(--surface-2);
  /* WCAG 1.4.11: a control needs a >=3:1 boundary; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.path-input::placeholder {
  color: var(--fg-muted);
}
/* The summoned filter row. Its own line rather than a fourth control on the
   breadcrumb strip, and only present while it is in use. */
.search {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-3);
  border-bottom: 1px solid var(--border);
  color: var(--fg-muted);
}
.search-input {
  flex: 1 1 auto;
  min-width: 0;
  height: var(--control-h-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.search-input::placeholder {
  color: var(--fg-muted);
}
.entries {
  list-style: none;
  margin: 0;
  padding: var(--sp-1) 0;
  flex: 1;
  overflow-y: auto;
}
.entry {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--row-h);
  /* 2px of the left inset is the selection rail's slot, same as
     SessionTree's .session-row, so the two lists mark selection alike. */
  padding: var(--row-pad-y) var(--row-pad-x) var(--row-pad-y) var(--sp-2);
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.entry:hover {
  background: var(--state-hover);
}
.entry.active {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* Entry icons. The folder carries the most weight so
   the dir/file hierarchy reads at a glance; files sit quietest (decorative —
   the filename beside them carries the information); symlinks sit one step up
   because "this is not a real file" is worth a glance.
   Nothing changes on HOVER by design: icon colour flicker under a sweeping
   cursor reads as smear, and the row's --state-hover fill is the feedback.
   On SELECTED only the file icon lifts, so it does not read disabled against
   the accent fill. The 16px icon box IS the column — the old `.ic` rem width
   was sized for an emoji. */
.entry .app-icon {
  color: var(--fg-muted);
}
.entry .app-icon.folder {
  color: var(--warning);
}
.entry .app-icon.symlink {
  color: var(--fg-secondary);
}
.entry.up .app-icon {
  color: var(--fg-muted);
}
.entry.active .app-icon {
  color: var(--fg-secondary);
}
.entry.active .app-icon.folder {
  color: var(--warning);
}
.entry.active .app-icon.symlink {
  color: var(--fg-secondary);
}
/* A flex row of [head, tail] rather than one ellipsising box — see
   `nameParts`. `min-width: 0` is what allows the head to shrink below its
   content width, which is the whole mechanism. */
.nm {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-family: var(--font-mono);
}
/* The shrinkable half. */
.nm-head {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Protected: for a filename the distinguishing text is the tail — the counter
   before the extension, and the extension itself. */
.nm-tail {
  flex: none;
  white-space: nowrap;
}
.sz {
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  text-align: right;
  white-space: nowrap;
}
.more {
  padding: var(--sp-1) var(--sp-2);
}
.more-btn {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-100);
  cursor: pointer;
}
.more-btn:hover {
  color: var(--fg);
  background: var(--state-hover);
}
.empty {
  padding: var(--sp-4) var(--sp-3);
}
.error {
  padding: 0 var(--sp-3) var(--sp-2);
}
/* The naming row's field. The row keeps its entry metrics; the input takes
   the name's slot and shares the path bar's control treatment (surface-2 over
   border-strong, mono) so this pane's two "type a name" fields read alike. */
.entry.creating {
  cursor: default;
}
.create-input {
  flex: 1;
  min-width: 0;
  height: var(--control-h-sm);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.create-input::placeholder {
  color: var(--fg-muted);
}
</style>
