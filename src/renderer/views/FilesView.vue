<script setup lang="ts">
// FilesView: the SFTP browser. Left = FileTree; right = whatever the selected
// file actually is.
//
// That right-hand side used to be a textarea and nothing else, which is what
// froze the app on an mp3: every click decoded the whole file as UTF-8 and
// asked a textarea to lay it out. It is now one of five terminal states, and
// which one is chosen is decided in the store before any bytes move (see
// stores/files.ts and fileKind.ts). The only one that can hold text is the
// editor, and nothing falls back INTO it — a file we cannot render ends in
// the binary panel with a reason and a download button, never in mojibake.
//
// The editor is CodeEditor.vue (CodeMirror 6). Monaco was rejected on a
// measurement rather than a preference: the packaged renderer runs from a
// file:// document whose CSP refuses a blob: worker (`script-src 'self'`, and
// `worker-src` falls back to it), which is exactly what Monaco's language
// services need — the dev-works/packaged-dies failure. See the header of
// components/CodeEditor.vue for the probe output.
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useFilesStore, hasPreview, isEditable } from '../stores/files';
import { formatBytes } from '../../shared/byteSize';
import { useSettingsStore } from '../stores/settings';
import { resolveTheme } from '../themes';
import { isShortcut } from '../../shared/shortcuts';
import {
  fitPercent,
  formatImageZoom,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  overflowsPane,
  sliderToZoom,
  stepImageZoom,
  zoomToSlider,
} from '../imageZoom';
import FileTree from '../components/FileTree.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import EnvPanelView from './EnvPanelView.vue';
import { usePaneWidth } from '../usePaneWidth';

/**
 * Loaded on demand. CodeMirror is ~680 KB of the renderer, and a workspace
 * that never opens a text file must not pay for it at startup: imported
 * eagerly the entry chunk grows by 684 KB, asynchronously by 7 KB — and the
 * editor arrives with the first file that needs it. Each grammar is a further
 * chunk of its own, fetched only for the language actually opened.
 */
const CodeEditor = defineAsyncComponent(() => import('../components/CodeEditor.vue'));

const emit = defineEmits<{
  /**
   * The tree asked for a path in a NEW Files tab. Forwarded straight to the
   * workspace, which owns the tab bar — see FileTree's own comment for why the
   * tree cannot do this itself.
   */
  openInNewTab: [path: string, kind: 'dir' | 'file'];
}>();

const props = defineProps<{
  /** Directory to open first (e.g. the selected session's cwd). Defaults to home. */
  startPath?: string;
  /**
   * Identity of the session this tab belongs to, so the browsed directory is
   * remembered per session. Optional: when the parent has no name to give,
   * the start directory identifies the session well enough — two sessions
   * rooted in the same folder sharing a browsing position is not a bug.
   */
  sessionKey?: string;
}>();

const connection = useConnectionStore();
const files = useFilesStore();
const settings = useSettingsStore();
const connId = computed(() => connection.connectionId);

// ---------------------------------------------------------------------------
// Tree pane width
// ---------------------------------------------------------------------------
/**
 * The file tree used to be CONTENT-sized — `min-width: 260px` over an `auto`
 * flex basis — so it grew to the longest filename in whatever directory was
 * open and shrank again on the way back out. Browsing therefore moved the
 * editor beside it on nearly every click, which is what the user objected to.
 *
 * It is a definite basis now, and drag-resizable, because a fixed width that is
 * wrong for your filenames is a different complaint of the same shape. The
 * mechanism is the session panel's, deliberately: same clamp, same
 * clamp-on-READ as well as on write, same one-write-per-drag. See
 * HostWorkspaceView.vue, which explains why the read is clamped too — a stored
 * value can predate a change to the clamp, and a hand-edited or corrupt entry
 * must not be able to strand the pane.
 *
 * ## Why localStorage and not the settings store
 *
 * Because it is a pixel width of a pane in this window, which is what the
 * session panel's width is, and that one lives in localStorage. The settings
 * store is for preferences the user sets in the Settings overlay and reasons
 * about by name; a number you arrive at by dragging until it looks right is not
 * one of those.
 *
 * ## Why it is shared by every Files tab, not stored per tab
 *
 * A Files TAB remembers its own DIRECTORY, because where you are browsing is a
 * fact about that tab. How wide the pane is, is a fact about how you like to
 * look at files — and per-tab widths would mean the pane jumping as you moved
 * between two Files tabs, which is the original complaint wearing a hat. It is
 * app-level for the same reason the composer's geometry is (stores/composer.ts:
 * "PREFERENCES ABOUT THE TOOL").
 */
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 640;
const DEFAULT_TREE_WIDTH = 260;
// The origin is measured at drag START from the pane's own left edge rather
// than from `clientX` directly: this view is inside the workspace, which is
// inside the session panel's splitter, so `clientX` is not the tree's width.
// HostWorkspaceView can use `clientX` because its panel starts at x=0.
const { style: treeStyle, onDragStart: onTreeDragStart } = usePaneWidth({
  storageKey: 'pocketshell.filesTreeWidth',
  min: MIN_TREE_WIDTH,
  max: MAX_TREE_WIDTH,
  defaultWidth: DEFAULT_TREE_WIDTH,
  measureOrigin: (e) =>
    (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().left ?? 0,
});
// `flex: 0 0 <n>px` (the composable's style) and not `width`, because the tree
// is a flex item: a `width` would still be overridden by `flex-shrink` the
// moment the editor beside it wanted room, and the pane would go back to
// moving on its own.

onMounted(async () => {
  if (connId.value) await files.open(connId.value, props.startPath, props.sessionKey);
  // AFTER `open()`, never before: `open()` restores the remembered directory
  // and resets the open file, so a reveal applied first would be undone by the
  // very mount that was triggered to show it.
  await applyReveal();
});

/**
 * Show a path someone clicked in the terminal.
 *
 * Two entry points because the tab may or may not already be mounted when the
 * request lands. Clicking a path in the terminal is the unmounted case — the
 * workspace switches tabs, this view mounts, and `onMounted` above takes the
 * request. The watch covers a request that arrives while Files is already on
 * screen. `takeReveal()` clears the request, so whichever fires first wins and
 * a path is never opened twice.
 */
async function applyReveal(): Promise<void> {
  const target = files.takeReveal();
  if (target == null || !connId.value) return;
  await files.revealPath(connId.value, target);
}

watch(
  () => files.reveal,
  async (next) => {
    if (next != null) await applyReveal();
  },
);

// The session's working directory can arrive AFTER this view mounts — the
// sessions store is refreshed lazily, so a workspace opened by deep link (or
// straight after creating a session) renders with `startPath` undefined and
// only learns the real directory a moment later. Without this watch the tab
// stays wherever it landed, which is the login home, and looks for all the
// world like the session really is in `~`. Re-opening is safe because the
// store prefers a remembered position, so a user who has already navigated
// somewhere is not yanked back.
watch(
  () => props.startPath,
  async (next, prev) => {
    if (!connId.value || next === prev || !next) return;
    await files.open(connId.value, next, props.sessionKey);
  },
);

// Deliberately NO `files.clear()` on unmount. The Files tab lives behind a
// `v-if`, so switching to Terminal unmounts it — and clearing here is what
// made the user lose their place every time they looked at the terminal. The
// guarantee `clear()` exists for (one connection's listing must never be
// shown for another) is kept by clearing on DISCONNECT instead.

// ---------------------------------------------------------------------------
// The env editor (FEATURES.md F16)
// ---------------------------------------------------------------------------
/**
 * The server-side env panel for the folder being browsed. The TREE decides
 * when to offer it (it sees the listing, so `.env` / `.envrc` visibility is
 * free there) and this view owns the overlay — same division as `openInNewTab`,
 * where the tree says "somewhere else" and the parent builds it. The panel
 * edits `files.cwd`'s env: whichever directory this tab is standing in, which
 * is exactly "the folder being browsed" that F16 names.
 */
const envOpen = ref(false);

async function onOpenFile(name: string): Promise<void> {
  if (!connId.value) return;
  await files.openFile(connId.value, name);
}

async function onSave(): Promise<void> {
  if (!connId.value) return;
  await files.save(connId.value);
}

async function onDownload(): Promise<void> {
  if (!connId.value) return;
  await files.download(connId.value);
}

async function onReloadPreview(): Promise<void> {
  if (!connId.value) return;
  await files.reloadPreview(connId.value);
}

/**
 * Re-render an open markdown preview when the theme changes.
 *
 * The frame is a separate document on a separate origin, so the app's tokens
 * do not cascade into it and nothing inside it can be told about a repaint —
 * the palette is baked in at mint time (see the store's `restylePreview`). A
 * markdown preview left over from the previous theme would sit there in the
 * old colours next to a repainted app, which is the sort of thing that reads
 * as a rendering bug rather than as a limitation.
 *
 * Watched on the RESOLVED record's id rather than on `settings.theme`, because
 * `system` is a rule rather than a theme: flipping Windows between light and
 * dark changes what is painted without changing the stored setting, and the
 * preview has to follow that too. Only markdown reacts — an HTML file brings
 * its own styling and is deliberately not themed by us.
 */
watch(
  () => resolveTheme(settings.theme).id,
  async () => {
    if (!connId.value) return;
    await files.restylePreview(connId.value);
  },
);

/**
 * Template ref on the tree, so the chord below can put the caret in its path
 * bar. Typed by the one method called rather than `InstanceType<typeof
 * FileTree>`, for the same reason FolderWorkspaceView types its terminal ref
 * that way: `*.vue` is a `DefineComponent<…, any>` in env.d.ts, so the instance
 * type collapses to `any` and takes the call site with it.
 */
const treeRef = ref<{ editPath: () => void; focusSearch: () => void } | null>(null);

function onKeydown(e: KeyboardEvent): void {
  const bindings = settings.shortcutBindings;
  if (isShortcut(bindings, 'files.save', e)) {
    e.preventDefault();
    if (files.dirty) void onSave();
  }
  // Ctrl+L is the address-bar chord everywhere else the user types a path. The
  // shell's own Ctrl+L (clear screen) is untouched: this handler only ever sees
  // keys from inside the Files pane.
  //
  // This comment used to claim the composer's chords "are not live on this tab,
  // which hides the composer entirely". THAT IS FALSE and it was false when it
  // was written: FolderWorkspaceView mounts the composer once, outside the tab
  // body, behind a `v-show` — precisely so a tab switch cannot cost a draft —
  // and its handler is on `window` with `capture: true`, registered in
  // `onMounted`. Ctrl+backtick on this tab toggles a panel nobody can see. The
  // registry models that overlap (`SURFACE_COLLISIONS`, composer/files) so the
  // next chord chosen here is checked against it rather than against a comment.
  if (isShortcut(bindings, 'files.gotoPath', e)) {
    e.preventDefault();
    treeRef.value?.editPath();
  }
  // Ctrl+F filters the TREE, not the open file: CodeEditor loads no
  // @codemirror/search extension, so nothing else in this pane claims it.
  if (isShortcut(bindings, 'files.filterTree', e)) {
    e.preventDefault();
    treeRef.value?.focusSearch();
  }
}

/**
 * The root element, so the workspace's focus handoff has somewhere to land —
 * the keydown handlers above are bound to it, and handlers on an element
 * nothing can focus are handlers that never hear a key.
 */
const rootEl = ref<HTMLElement | null>(null);

/**
 * Take the keyboard, on the workspace's behalf.
 *
 * FolderWorkspaceView.focusActiveTab() calls this when a Files tab is
 * selected — by click or by Ctrl+arrow — through the same ref-and-ask shape it
 * uses for terminals. Without it, focus stayed on the tab BUTTON and the
 * pane's own chords (Ctrl+S / Ctrl+L / Ctrl+F) were dead until the user
 * clicked inside the pane: the call site existed and did nothing, because
 * nothing here was exposed for it to reach.
 *
 * The one refusal is the workspace's own contract, quoted from its call site:
 * "The Files pane declines the focus when an editor is open with unsaved
 * content" — moving the caret out of a dirty buffer to a container the user
 * did not ask for would be worse than doing nothing, and this pane is the one
 * that knows it is dirty. Declining means doing NOTHING, not blurring:
 * wherever the caret is (usually the editor) is where the unsaved work is.
 */
function focus(): void {
  if (files.dirty && isEditable(files.openMode)) return;
  rootEl.value?.focus();
}

// The workspace types its ref as `{ focus?: () => void }` and calls it
// optionally; this is the other half of that contract.
defineExpose({ focus });

/** Basename of the open file, for the viewer headings. */
const openName = computed(() => files.openPath?.split('/').pop() ?? '');
const sizeLabel = computed(() => (files.openSize > 0 ? formatBytes(files.openSize) : ''));

/**
 * The preview iframe's sandbox, per open document.
 *
 * EMPTY for HTML and SVG — the maximally restrictive sandbox, see the long
 * argument beside the frame. A MARKDOWN preview adds exactly one token,
 * `allow-popups`, and nothing else: markdown source may carry raw-HTML badge
 * links written with `target="_blank"`, and without the token such a click is
 * swallowed by the sandbox itself — no event, no navigation, nothing any
 * handler in main can see. With it, the click arrives at the main window's
 * `setWindowOpenHandler`, which allow-lists web URLs into the system browser
 * and denies every in-app window, so the popup document itself never exists.
 * That is one new capability, and it is the same one plain links already have
 * via `will-frame-navigate`: a click can hand a web URL to the OS. It runs no
 * code, opens no socket, and the frame stays scriptless either way.
 */
const previewSandbox = computed(() =>
  files.openMode === 'markdown' ? 'allow-popups' : '',
);

/**
 * What the preview toolbar says about the render, in the order the reader
 * needs it.
 *
 * This line is not decoration. A page missing its stylesheet and a page that
 * genuinely looks unstyled are IDENTICAL on screen, and shipping a preview
 * that cannot tell them apart is the specific failure this feature was not
 * allowed to have. So every reason a render might be incomplete gets a
 * sentence:
 *
 *   - unsaved edits, which the preview does not show at all (it renders the
 *     host's copy, and the buffer beside it says something else);
 *   - scripts, which never run — a page that builds itself at runtime is a
 *     shell here, and saying so is the difference between "degraded" and
 *     "broken";
 *   - resources on remote origins, which are refused so that rendering a
 *     page cannot tell a third party which file on which host is being
 *     inspected. This one is derived from the SOURCE rather than counted,
 *     and it has to be: the refusal happens inside this renderer, under the
 *     frame's own CSP, so the request never reaches main and main can never
 *     report it. Without the line, a page whose images all live on a CDN
 *     would say "0 blocked" beside a grid of broken-image icons;
 *   - assets refused for being outside the page's own folder, which is the
 *     one real limit of the scoping in HtmlPreviewService and the one a user
 *     can act on (open the page from its project root instead);
 *   - assets that were asked for and are not there, which is usually the
 *     page's own bug and is worth distinguishing from ours;
 *   - the budget cap, which means the render is knowingly partial.
 *
 * The counts come from main and arrive asynchronously as the frame loads, so
 * the line settles a moment after the page paints. That is the honest
 * ordering — we cannot know what a page will ask for until it asks.
 */
const previewNote = computed(() => {
  const parts: string[] = [];
  if (files.dirty) parts.push('showing the saved copy — unsaved edits are not rendered');
  // Raw HTML in a markdown file is passed through by the converter and is
  // subject to exactly the same refusals as an HTML file's own markup, so a
  // README containing a `<script>` gets the same sentence for the same reason.
  if (files.openHasScripts) parts.push('scripts are not run');
  if (files.openHasRemoteRefs) parts.push('remote resources are not loaded');
  const stats = files.previewStats;
  if (stats) {
    if (stats.loaded > 0) parts.push(`${stats.loaded} asset${stats.loaded === 1 ? '' : 's'} loaded`);
    if (stats.blocked > 0) {
      parts.push(`${stats.blocked} outside this folder — not loaded`);
    }
    if (stats.missing > 0) parts.push(`${stats.missing} missing`);
    if (stats.capped) parts.push('asset budget reached — render is partial');
  }
  return parts.join(' · ');
});

// ---------------------------------------------------------------------------
// Image zoom
// ---------------------------------------------------------------------------
/**
 * The image viewer's zoom, shared by the −/+ pair, the slider and the
 * Fit / 100% buttons through ONE number: `zoomOverride` when the user has
 * named a percentage, otherwise the measured fit answer. Nothing stores Fit
 * — it is a function of the decoded size and the pane, so a stored value
 * would go stale the moment the tree splitter moved; it is recomputed and
 * the picture follows the pane.
 *
 * State lives HERE, not in the store, deliberately: it is inspection state
 * for the file on screen, not a preference and not browsing position. A new
 * `openUrl` (a different file, or close) resets to Fit, and so does leaving
 * the tab — the Files tab is behind a `v-if`, and what survives that is the
 * store's `RememberedPosition`, which is about WHERE you are, not how you
 * were looking.
 */
/** Decoded size of the open image, from the `<img>` load event. */
const imageNatural = ref<{ w: number; h: number } | null>(null);
/** CSS size of the pane the image sits in, from a ResizeObserver. */
const imagePane = ref<{ w: number; h: number } | null>(null);
/** Manual zoom in percent of natural size; null = Fit mode. */
const zoomOverride = ref<number | null>(null);

const imageFit = computed(() => {
  const n = imageNatural.value;
  const p = imagePane.value;
  if (!n || !p) return null;
  return fitPercent(n.w, n.h, p.w, p.h);
});
const imageZoom = computed(() => zoomOverride.value ?? imageFit.value);
const imageZoomLabel = computed(() =>
  imageZoom.value == null ? '' : formatImageZoom(imageZoom.value),
);
const zoomSliderValue = computed(() =>
  imageZoom.value == null ? 0 : zoomToSlider(imageZoom.value),
);
const isFit = computed(() => zoomOverride.value === null);
const isActualSize = computed(() => zoomOverride.value === 100);
const canZoomIn = computed(() => imageZoom.value != null && imageZoom.value < IMAGE_ZOOM_MAX);
const canZoomOut = computed(() => imageZoom.value != null && imageZoom.value > IMAGE_ZOOM_MIN);

/**
 * Explicit pixel width — the one style the image needs in every mode, which
 * is why the old `max-width`/`max-height` CSS is gone: a manual zoom has to
 * be allowed to EXCEED the pane (and scroll), and a constraint that only
 * shrinks cannot express that. Height follows the aspect ratio.
 */
const imageStyle = computed(() => {
  const n = imageNatural.value;
  if (!n || imageZoom.value == null) return undefined;
  return { width: `${(n.w * imageZoom.value) / 100}px` };
});

function onImageLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  imageNatural.value = img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
}

function zoomIn(): void {
  if (imageZoom.value != null) zoomOverride.value = stepImageZoom(imageZoom.value, 1);
}
function zoomOut(): void {
  if (imageZoom.value != null) zoomOverride.value = stepImageZoom(imageZoom.value, -1);
}
function zoomActualSize(): void {
  zoomOverride.value = 100;
}
function zoomFit(): void {
  zoomOverride.value = null;
}
function onZoomSlider(e: Event): void {
  zoomOverride.value = sliderToZoom(Number((e.target as HTMLInputElement).value));
}

// A new URL is a new file: the decoded size and the zoom are about the old
// one. (Fit mode is the default, so resetting the override alone is not
// enough — the stale natural size must not size the next image.)
watch(
  () => files.openUrl,
  () => {
    zoomOverride.value = null;
    imageNatural.value = null;
  },
);

/**
 * Drag-to-pan. Once a manual zoom lets the picture exceed the pane, the
 * native scrollbars are joined by the gesture every image viewer shares:
 * the cursor becomes a hand, and a held drag moves the picture — scrollLeft/
 * scrollTop against the pointer delta, nothing more. The overflow test is
 * the pure `overflowsPane` (same measured inputs as Fit), so the hand
 * appears and disappears with the splitter and the zoom slider; at Fit it
 * never appears, because there the pane holds the whole picture and there
 * is nothing to pan into.
 *
 * The drag is pointer events with capture, not mouse events, so a drag that
 * leaves the pane keeps panning and a lost pointer (button up outside the
 * window, alt-tab) ends it through `pointercancel` rather than sticking.
 */
const imageOverflows = computed(() => {
  const n = imageNatural.value;
  const p = imagePane.value;
  if (!n || !p || imageZoom.value == null) return false;
  return overflowsPane(n.w, n.h, imageZoom.value, p.w, p.h);
});
const panDrag = ref<{
  id: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
} | null>(null);
const panning = computed(() => panDrag.value != null);

function onPanStart(e: PointerEvent): void {
  if (!imageOverflows.value || e.button !== 0) return;
  const el = imagePaneEl.value;
  if (!el) return;
  e.preventDefault();
  panDrag.value = {
    id: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    left: el.scrollLeft,
    top: el.scrollTop,
  };
  el.setPointerCapture?.(e.pointerId);
}
function onPanMove(e: PointerEvent): void {
  const d = panDrag.value;
  const el = imagePaneEl.value;
  if (!d || !el || e.pointerId !== d.id) return;
  el.scrollLeft = d.left - (e.clientX - d.startX);
  el.scrollTop = d.top - (e.clientY - d.startY);
}
function onPanEnd(e: PointerEvent): void {
  if (panDrag.value?.id !== e.pointerId) return;
  panDrag.value = null;
}

/**
 * The ground the picture is inspected on: the terminal surface it has always
 * sat on, or white. A drawing authored against one reads wrongly on the
 * other — dark-stroked line art vanishes into the dark ground, white-backed
 * art haloes against white — and which ground is wrong is a fact about the
 * picture, so the viewer offers both.
 *
 * Component state like the zoom, and for the same reason: a fact about
 * LOOKING, not a preference to name in Settings. Unlike the zoom it is NOT
 * reset when a new file opens — the zoom is derived from the file and goes
 * stale, this says nothing about the file at all — so a run of pictures can
 * be checked against the same backdrop. It dies with the tab, as the zoom
 * does.
 */
const imageBgLight = ref(false);

/**
 * The pane is MEASURED, not assumed: `fitPercent` needs the scroll area's
 * CSS box, which changes under the splitter drag, a window resize and the
 * tree pane's own width. The observer is (re)bound by watching the template
 * ref — the element exists only while an image is open, and a watcher on a
 * ref fires exactly when Vue assigns it.
 *
 * The `typeof` guard is for jsdom, which has no ResizeObserver; the tests
 * stub one, but a bare import-time `new` would still be the wrong place —
 * the element can simply not be there yet.
 */
const imagePaneEl = ref<HTMLElement | null>(null);
let imagePaneObserver: ResizeObserver | null = null;
watch(imagePaneEl, (el) => {
  imagePaneObserver?.disconnect();
  imagePaneObserver = null;
  imagePane.value = null;
  if (!el || typeof ResizeObserver === 'undefined') return;
  imagePaneObserver = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) imagePane.value = { w: box.width, h: box.height };
  });
  imagePaneObserver.observe(el);
});
onUnmounted(() => imagePaneObserver?.disconnect());
</script>

<template>
  <div ref="rootEl" class="files-view" tabindex="-1" @keydown="onKeydown">
    <!-- `tabindex="-1"` on the root above: focusable programmatically,
         invisible to the Tab key. The workspace's focusActiveTab
         (FolderWorkspaceView.vue) hands focus to this element through the
         exposed `focus()` so the @keydown chords are live the moment the tab
         is selected; -1 keeps a bare container out of the tab order, where a
         keyboard user walking the page would land on a box that is not a
         control. The ring is suppressed in the styles below for the same
         reason. (Inside the root rather than above it: a root-level comment
         makes the component a dev-mode fragment, which changes `$el` and
         breaks attribute fallthrough.) -->
    <FileTree
      ref="treeRef"
      :style="treeStyle"
      @open-file="onOpenFile"
      @open-in-new-tab="(path, kind) => emit('openInNewTab', path, kind)"
      @open-env="envOpen = true"
    />
    <!-- Same sash treatment as the session panel's: transparent at rest,
         because the tree draws its own right hairline, and highlighted only
         when the cursor LINGERS so sweeping across never flashes a bar. -->
    <div
      class="tree-splitter"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
      @mousedown.prevent="onTreeDragStart"
    />
    <div class="editor-area">
      <template v-if="files.openPath">
        <div class="editor-bar">
          <span class="path">{{ files.openPath }}</span>
          <span v-if="files.dirty" class="dirty">
            <span class="dirty-dot" />
            unsaved
          </span>
          <!-- The chord comes from the shortcut registry (`files.save`, default
               Ctrl+S); the label used to read `Save (⌘S)` — a macOS glyph on a
               Windows-first app. The chord belongs in the tooltip, in this
               app's Ctrl+... convention. -->
          <button
            v-if="isEditable(files.openMode)"
            class="save-btn"
            :disabled="!files.dirty || files.saving"
            title="Ctrl+S"
            @click="onSave"
          >
            {{ files.saving ? 'Saving…' : 'Save' }}
          </button>
          <button class="close-btn" title="Close file" @click="files.closeFile()">Close</button>
        </div>

        <!-- The open file's OWN error channel: a failed save or download,
             rendered directly under the bar that holds the Save button,
             because that is where the user is looking when Ctrl+S fails.
             These used to land in `files.error`, whose only render is the
             tree's footer in the OTHER pane — a failed save read as a save
             that silently did nothing. Listing failures still go there; the
             store's `fileError` comment carries the split. -->
        <p v-if="files.fileError" class="error file-error">{{ files.fileError }}</p>

        <p v-if="files.opening" class="loading muted">opening {{ openName }}…</p>

        <!-- `:model-value` + `@update:model-value`, NOT `v-model`: v-model
             would assign straight to the store ref and skip `setContent`,
             which is the only thing that raises the dirty flag. That is the
             same trap the textarea avoided by binding `:value` rather than
             two-way. -->
        <CodeEditor
          v-else-if="files.openMode === 'text'"
          :model-value="files.openContent"
          :filename="files.openPath"
          @update:model-value="files.setContent"
        />

        <!-- HTML, markdown and SVG: the three kinds with two presentations.
             ==================================================================
             MARKDOWN GOES THROUGH THE SAME PIPELINE, converted to HTML in main
             before a byte is served (src/main/preview/markdownDocument.ts).
             That is the whole of its security argument and it is a reuse
             rather than a new one: every guarantee below is a property of how
             the bytes are SERVED and framed, not of where they came from. The
             one genuinely new decision — that the converter passes raw HTML
             through instead of escaping it — is argued in that file, and it
             rests on exactly the two mechanisms named here.

             SVG ALSO GOES THROUGH THE PIPELINE UNCHANGED, served as-is at
             `image/svg+xml` (src/main/preview/HtmlPreviewService.ts). It is
             the one that makes the machinery here look least optional: an SVG
             rendered as a document — not through `<img>` — can carry
             `<script>` and remote references, so the empty sandbox and the
             CSP are as load-bearing for a logo as they are for a page. The
             source toggle is what keeps this from being a downgrade: SVG is
             XML, the editor round-trips it losslessly with highlighting, and
             the render is the presentation that did not exist here before.

             The `sandbox` attribute is bound to `previewSandbox` (above):
             EMPTY for HTML and SVG, which is the maximally restrictive one —
             the document lands on an opaque origin (so it is cross-origin to
             this app and cannot touch its DOM), no script runs, no form
             submits, no popup opens, and nothing may navigate the top-level
             page. A markdown preview adds only `allow-popups`, so that
             `target="_blank"` badge links reach the window-open handler
             instead of dying silently in the sandbox. Adding anything more —
             `allow-scripts` above all — would hand a remote host arbitrary
             execution inside the renderer process that holds this app's SSH
             sessions. The reasoning, and what a scripted preview would cost
             and buy, is written out in full at
             src/main/preview/HtmlPreviewService.ts.

             The document is ALSO governed by a strict Content-Security-Policy
             delivered as a real header on every psview: response, because a
             CSP is not inherited across this kind of frame navigation. Two
             independent mechanisms, neither relying on the other.

             MEASURED in the built app rather than assumed, the way the PDF
             embed and the Monaco CSP question were settled. Loading the
             fixture page in the packaged renderer and probing from inside the
             frame:

               window.api                 -> undefined  (no preload in subframes)
               window.parent.document     -> SecurityError
               window.top.location.href   -> SecurityError
               inline <script>            -> "Blocked script execution … the
                                             document's frame is sandboxed and
                                             the 'allow-scripts' permission is
                                             not set"
               <img src="https://…">      -> refused by img-src
               location.origin            -> "psview://<token>"

             That last one is worth writing down because it is NOT the "null"
             a fully sandboxed frame is usually described as having: on this
             Electron, a document on a registered standard scheme keeps a
             serialised origin even under an empty sandbox. It changes
             nothing that matters — the three probes above are the actual
             isolation and all three hold — and it has one pleasant
             consequence: the token sits in the URL's HOST position, so two
             open previews are on different origins from each other as well as
             from the app.

             `referrerpolicy="no-referrer"` is belt-and-braces: with no network
             permitted there is nothing to send a referrer to, but if that ever
             changes, the previewed page's own path — which names a directory
             on the user's server — should not be the thing that leaks first. -->
        <div v-else-if="hasPreview(files.openMode)" class="html-view">
          <div class="viewer-bar">
            <div class="seg" role="group" aria-label="Document view">
              <button
                type="button"
                :class="{ active: files.docView === 'preview' }"
                :disabled="!files.previewUrl"
                @click="files.setDocView('preview')"
              >
                Preview
              </button>
              <button
                type="button"
                :class="{ active: files.docView === 'source' }"
                @click="files.setDocView('source')"
              >
                Source
              </button>
            </div>
            <!-- Recovers a preview that a link click emptied, as well as
                 re-reading a file that changed on the host. See the store's
                 `reloadPreview` for why a preview can end up empty at all —
                 briefly: a remote link is handed to the system browser and
                 the in-app navigation is refused by the app's CSP, and with
                 no scripts in the frame there is nothing to stop Chromium
                 painting its error page in the meantime. -->
            <button
              v-if="files.docView === 'preview'"
              type="button"
              class="reload-btn"
              title="Render again from the host"
              @click="onReloadPreview"
            >
              Reload
            </button>
            <span v-if="files.docView === 'preview' && previewNote" class="html-note muted">
              {{ previewNote }}
            </span>
          </div>

          <!-- `.md-frame`/`.svg-frame` only change what shows THROUGH the
               document while it loads: a markdown or SVG preview paints its
               own ground (the app's for markdown, the image viewer's for a
               drawing), so a white frame would flash white on a dark theme
               for exactly as long as the SFTP read takes. An HTML page is
               left on white — see the rule below for why that is not a
               token. -->
          <iframe
            v-if="files.docView === 'preview' && files.previewUrl"
            class="html-frame"
            :class="{
              'md-frame': files.openMode === 'markdown',
              'svg-frame': files.openMode === 'svg',
            }"
            referrerpolicy="no-referrer"
            :src="files.previewUrl"
            :title="`Preview of ${openName}`"
            :sandbox="previewSandbox"
          />
          <!-- The preview could not be minted at all (the file moved, the
               connection went away). The source is still right there, so this
               says why rather than showing an empty frame. -->
          <div
            v-else-if="files.docView === 'preview'"
            class="viewer binary-panel"
          >
            <p class="binary-title">{{ openName }}</p>
            <p class="muted">{{ files.openNote ?? 'Preview unavailable.' }}</p>
            <button class="save-btn" @click="files.setDocView('source')">View source</button>
          </div>
          <!-- Same binding contract as the plain-text arm: `:model-value` plus
               `@update:model-value`, so edits go through `setContent` and the
               dirty flag and Ctrl+S keep working on an HTML or markdown file
               exactly as they do on any other source file. Highlighting comes
               from the filename as always — `@codemirror/lang-markdown` was
               already bundled and mapped in codeLanguage.ts long before there
               was a preview to toggle away from. -->
          <CodeEditor
            v-else
            :model-value="files.openContent"
            :filename="files.openPath"
            @update:model-value="files.setContent"
          />
        </div>

        <!-- Audio: a real player, not a description of one. The blob URL is
             minted in the store and revoked when the file closes, so the
             element never outlives its bytes. -->
        <div v-else-if="files.openMode === 'audio'" class="viewer audio-viewer">
          <div class="media-head">
            <span class="media-name">{{ openName }}</span>
            <span class="media-meta muted">{{ files.openMime }} · {{ sizeLabel }}</span>
          </div>
          <audio v-if="files.openUrl" class="audio" controls :src="files.openUrl" />
        </div>

        <!-- PDF: Chromium's own viewer. `<embed>` rather than `<iframe>`
             because the PDF plugin is what is being asked for, and object-src
             is the directive that governs it. Requires `plugins: true` on the
             BrowserWindow — see src/main/index.ts. -->
        <div v-else-if="files.openMode === 'pdf'" class="viewer pdf-viewer">
          <embed
            v-if="files.openUrl"
            class="pdf"
            type="application/pdf"
            :src="files.openUrl"
          />
        </div>

        <!-- Image: a toolbar over a scrolling canvas. Three named states —
             Fit (the default, computed from the decoded size and the pane,
             never stored), 100% (one file pixel per CSS pixel) and any
             manual percentage, where the pane scrolls — all written through
             the one `zoomOverride` ref; bounds, ladder and slider mapping
             live in imageZoom.ts with their tests. -->
        <div v-else-if="files.openMode === 'image'" class="viewer image-viewer">
          <div class="viewer-bar">
            <div class="seg" role="group" aria-label="Zoom step">
              <button type="button" title="Zoom out" :disabled="!canZoomOut" @click="zoomOut">
                −
              </button>
              <button type="button" title="Zoom in" :disabled="!canZoomIn" @click="zoomIn">
                +
              </button>
            </div>
            <input
              class="zoom-slider"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="zoomSliderValue"
              :disabled="!imageNatural"
              aria-label="Zoom"
              :aria-valuetext="imageZoomLabel"
              @input="onZoomSlider"
            />
            <span class="zoom-label">{{ imageZoomLabel }}</span>
            <div class="seg bar-end" role="group" aria-label="Fit or actual size">
              <button
                type="button"
                :class="{ active: isFit }"
                title="Fit to window"
                @click="zoomFit"
              >
                Fit
              </button>
              <button
                type="button"
                :class="{ active: isActualSize }"
                title="Actual size (100%)"
                @click="zoomActualSize"
              >
                100%
              </button>
            </div>
            <div class="seg" role="group" aria-label="Backdrop">
              <button
                type="button"
                :class="{ active: !imageBgLight }"
                title="Dark backdrop"
                @click="imageBgLight = false"
              >
                Dark
              </button>
              <button
                type="button"
                :class="{ active: imageBgLight }"
                title="Light backdrop"
                @click="imageBgLight = true"
              >
                Light
              </button>
            </div>
          </div>
          <div
            ref="imagePaneEl"
            class="image-scroll"
            :class="{ 'on-light': imageBgLight, pan: imageOverflows && !panning, panning }"
            @pointerdown="onPanStart"
            @pointermove="onPanMove"
            @pointerup="onPanEnd"
            @pointercancel="onPanEnd"
          >
            <!-- `draggable="false"`: the img's native HTML5 drag would win
                 the gesture the pane exists to own — a held drag pans the
                 picture — and dropping it outside the app would "save" it
                 to whatever surface the drop landed on. -->
            <img
              v-if="files.openUrl"
              class="image"
              :src="files.openUrl"
              :alt="openName"
              :style="imageStyle"
              draggable="false"
              @load="onImageLoad"
            />
          </div>
        </div>

        <!-- The single honest terminus. Everything that is not text and
             cannot be rendered lands here, with its type, its size and the
             reason — and an offer to take it somewhere that can open it. -->
        <div v-else class="viewer binary-panel">
          <p class="binary-title">{{ openName }}</p>
          <p class="muted">
            {{ files.openNote ?? 'This is a binary file.' }}
          </p>
          <p class="muted small">
            {{ files.openMime ?? 'unknown type' }}<template v-if="sizeLabel"> · {{ sizeLabel }}</template>
          </p>
          <button class="save-btn" @click="onDownload">Download…</button>
        </div>
      </template>
      <div v-else class="placeholder">
        <p class="muted">select a file to edit</p>
        <p class="muted small">changes save back over SFTP</p>
      </div>
    </div>

    <!-- The folder's env editor. `files.cwd`, not the tab's seed path: the
         panel edits the folder the user is STANDING in when they press the
         button, and the overlay's modal grab means the directory cannot move
         underneath it while it is open. -->
    <OverlayPanel v-if="envOpen && connId" title="Env" size="md" @close="envOpen = false">
      <EnvPanelView :connection-id="connId" :dir="files.cwd" />
    </OverlayPanel>
  </div>
</template>

<style scoped>
/* `flex: 1` because the parent `.tab-body` is a flex row. */
.tree-splitter {
  flex: 0 0 auto;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background var(--dur-fast) var(--ease);
}
.tree-splitter:hover {
  background: var(--accent-dim);
  transition-delay: 250ms;
}
.files-view {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
}
/* The root takes programmatic focus (see the tabindex on it) but is a
   container, not a control. App.vue's designed focus treatment matches every
   `[tabindex]` element, so without this the whole pane would grow an outline
   on each tab switch — a ring around everything announces focus nowhere. The
   controls inside keep the global ring untouched. */
.files-view:focus-visible {
  outline: none;
}
.editor-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.editor-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  height: var(--tabbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-200);
}
.path {
  font-family: var(--font-mono);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A status pip, not an icon: it should stop scaling with font metrics, so it
   is a CSS circle rather than a bullet character. */
.dirty {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--warning);
  font-size: var(--fs-100);
}
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.save-btn {
  height: var(--control-h-sm);
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: var(--r-md);
  padding: 0 var(--sp-3);
  font-family: var(--font-ui);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  font-size: var(--fs-200);
  transition: background var(--dur-fast) var(--ease);
}
.save-btn:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.save-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Quiet next to Save: closing is never the action being encouraged. */
.close-btn {
  height: var(--control-h-sm);
  background: transparent;
  color: var(--fg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 0 var(--sp-3);
  font-family: var(--font-ui);
  cursor: pointer;
  font-size: var(--fs-200);
}
.close-btn:hover {
  color: var(--fg);
  background: var(--state-hover);
}
/* Colour and size come from the global `.error` primitive (App.vue); this
   only gives the line the bar's own horizontal rhythm so it reads as part of
   the editor chrome rather than a stray paragraph. */
.file-error {
  flex: 0 0 auto;
  padding: var(--sp-2) var(--sp-3) 0;
}
.loading {
  padding: var(--sp-4);
}
.viewer {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--term-bg);
}
.audio-viewer {
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  padding: var(--sp-5);
}
.media-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  text-align: center;
}
.media-meta {
  font-size: var(--fs-100);
}
.audio {
  width: min(480px, 100%);
}
/* HTML: a strip of controls over whichever half is showing. */
.html-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* One control strip for every viewer that has controls: the HTML/markdown
   bar and the image zoom bar share the mechanism, so they share the class —
   same height, same gaps, same surface. */
.viewer-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: 0 0 auto;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-100);
}
/* A segmented control rather than two buttons: the two are mutually exclusive
   views of one file, and a pair of independent buttons reads as two actions. */
.seg {
  display: inline-flex;
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}
.seg button {
  height: var(--control-h-sm);
  padding: 0 var(--sp-3);
  border: none;
  background: transparent;
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.seg button + button {
  border-left: 1px solid var(--border);
}
.seg button:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.seg button.active {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-semibold);
}
.seg button:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Quiet, like Close: reloading is a recovery, never the encouraged action. */
.reload-btn {
  flex: 0 0 auto;
  height: var(--control-h-sm);
  padding: 0 var(--sp-3);
  background: transparent;
  color: var(--fg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  cursor: pointer;
}
.reload-btn:hover {
  color: var(--fg);
  background: var(--state-hover);
}
.html-note {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* White, not `--term-bg`: a page authored for a browser assumes a light canvas
   and specifies only the colours it cares about, so painting the frame in the
   app's dark surface makes unstyled black text invisible — a "broken preview"
   with no cause the user could ever find. The frame is a document viewport,
   not part of the app's own surface, and is treated as one. */
.html-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: none;
  background: #fff;
}
/* A markdown preview is OUR document, painted in the app's tokens, so the
   reasoning above inverts: white here would flash white on a dark theme for
   the length of the SFTP read, and would show as a white margin if the
   document ever failed to paint. `--bg` and not `--term-bg` because the
   rendered document is prose on the app's ground, not a terminal surface —
   the same token the generated stylesheet uses for its own body. */
.md-frame {
  background: var(--bg);
}
/* An SVG preview is a DRAWING, not a page, so the reasoning above inverts the
   way markdown's does — but to a different token. Most SVGs leave their
   background transparent and expect to sit on whatever the viewer paints, so
   the honest ground is the one every other picture in this tab sits on: the
   image viewer's `--term-bg`. White would be a plausible reading of "a browser
   shows it on white", but it would make dark-stroked icons invisible while
   looking exactly like a broken file, and the app has already answered this
   question for pictures. */
.svg-frame {
  background: var(--term-bg);
}
/* The PDF plugin fills the pane; it brings its own chrome and scrolling. */
.pdf {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: none;
}
/* The image canvas: a scroll area, because a manual zoom is ALLOWED to
   exceed the pane — that is what zooming into a large image is. `display:
   flex` on the scroll container plus `margin: auto` on the image centers a
   picture smaller than the pane WITHOUT the top-left clipping that plain
   flex centering inflicts once the content overflows: with margin auto the
   overflow scrolls back to the top-left corner like any document. */
.image-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  padding: var(--sp-4);
}
/* The pan gesture's cursor, armed by the component's `overflowsPane`
   answer: a hand when there is picture beyond the pane to drag in, a
   closed hand while the drag is held — the vocabulary every image viewer
   shares. At Fit neither applies: the whole picture is visible, and a
   hand promising a drag that cannot move anything would be a lie. */
.image-scroll.pan {
  cursor: grab;
}
.image-scroll.panning {
  cursor: grabbing;
}
/* The light backdrop is WHITE and not a token, for the reason .html-frame
   states: the point is the canvas a picture's author assumed, and the app
   has no light surface of its own to lend. Only the canvas changes — the
   toolbar keeps the app's surface, because it is app chrome, not ground. */
.image-scroll.on-light {
  background: #fff;
}
.image {
  margin: auto;
  /* Load-bearing against the flex context above: as a flex item the img
     carries flex-shrink: 1, and a picture whose explicit width exceeds the
     pane shrinks — floored not at that width but at the automatic minimum
     size, which for a replaced element is its INTRINSIC size. Every zoom
     past 100% therefore rendered at exactly natural size and the slider
     appeared to stop there. `flex: none` puts the explicit width back in
     charge; margin: auto still centers the small case and still collapses
     to scroll-to-top-left on overflow, as described on .image-scroll. */
  flex: none;
}
/* The slider rides on Chromium's native range control (this is Electron, so
   there is exactly one engine to paint it), tinted with the app accent —
   custom track/thumb pseudo-elements would buy nothing but ~40 lines to
   maintain. Log-scaled by the component's mapping, not here. */
.zoom-slider {
  flex: 0 1 180px;
  accent-color: var(--accent);
}
.zoom-label {
  flex: none;
  min-width: 5ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--fg-secondary);
}
.bar-end {
  margin-left: auto;
}
.binary-panel {
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-5);
  text-align: center;
}
.binary-title {
  font-family: var(--font-mono);
  font-size: var(--fs-300);
}
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
}
.small {
  font-size: var(--fs-200);
  color: var(--fg-muted);
}
</style>
