import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { formatBytes } from '../shared/byteSize';
import { resolveTheme } from './themes';
import { usePaneWidth } from './usePaneWidth';
import type { useConnectionStore } from './stores/connection';
import type { useFilesStore } from './stores/files';
import type { useSettingsStore } from './stores/settings';

export interface FilesPaneDeps {
  connection: ReturnType<typeof useConnectionStore>;
  files: ReturnType<typeof useFilesStore>;
  settings: ReturnType<typeof useSettingsStore>;
  /** Directory to open first (e.g. the selected session's cwd). */
  startPath: () => string | undefined;
  /** Identity of the session this tab belongs to, for the remembered position. */
  sessionKey: () => string | undefined;
}

/**
 * The Files pane's model: the tree splitter's width, the tab's open-and-reveal
 * lifecycle, the env-overlay state, the store actions the template binds, and
 * the open document's presentation sentences.
 *
 * Extracted from FilesView.vue; the decision records below travelled with
 * their code.
 */
export function useFilesPane(deps: FilesPaneDeps): {
  treeStyle: Ref<{ flex: string }>;
  onTreeDragStart: (e: MouseEvent) => void;
  envOpen: Ref<boolean>;
  openName: ComputedRef<string>;
  sizeLabel: ComputedRef<string>;
  previewSandbox: ComputedRef<string>;
  previewNote: ComputedRef<string>;
  onOpenFile: (name: string) => Promise<void>;
  onSave: () => Promise<void>;
  onDownload: () => Promise<void>;
  onReloadPreview: () => Promise<void>;
} {
  const { files, connection, settings } = deps;
  const connId = computed(() => connection.connectionId);

  // -------------------------------------------------------------------------
  // Tree pane width
  // -------------------------------------------------------------------------
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
    if (connId.value) await files.open(connId.value, deps.startPath(), deps.sessionKey());
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
    deps.startPath,
    async (next, prev) => {
      if (!connId.value || next === prev || !next) return;
      await files.open(connId.value, next, deps.sessionKey());
    },
  );

  // Deliberately NO `files.clear()` on unmount. The Files tab lives behind a
  // `v-if`, so switching to Terminal unmounts it — and clearing here is what
  // made the user lose their place every time they looked at the terminal. The
  // guarantee `clear()` exists for (one connection's listing must never be
  // shown for another) is kept by clearing on DISCONNECT instead.

  // -------------------------------------------------------------------------
  // The env editor (FEATURES.md F16)
  // -------------------------------------------------------------------------
  /**
   * The server-side env panel for the folder being browsed. The TREE decides
   * when to offer it (it sees the listing, so `.env` / `.envrc` visibility is
   * free there) and this pane owns the overlay — same division as
   * `openInNewTab`, where the tree says "somewhere else" and the parent builds
   * it. The panel edits `files.cwd`'s env: whichever directory this tab is
   * standing in, which is exactly "the folder being browsed" that F16 names.
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
      if (stats.loaded > 0) {
        parts.push(`${stats.loaded} asset${stats.loaded === 1 ? '' : 's'} loaded`);
      }
      if (stats.blocked > 0) {
        parts.push(`${stats.blocked} outside this folder — not loaded`);
      }
      if (stats.missing > 0) parts.push(`${stats.missing} missing`);
      if (stats.capped) parts.push('asset budget reached — render is partial');
    }
    return parts.join(' · ');
  });

  return {
    treeStyle,
    onTreeDragStart,
    envOpen,
    openName,
    sizeLabel,
    previewSandbox,
    previewNote,
    onOpenFile,
    onSave,
    onDownload,
    onReloadPreview,
  };
}
