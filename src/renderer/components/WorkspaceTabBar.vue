<script setup lang="ts">
// WorkspaceTabBar: the folder workspace's one row of chrome — the tab strip
// with its rename field, the drag-to-reorder wiring, the `+` menu and the
// session tab's context menu. Extracted from FolderWorkspaceView.vue with its
// reasoning; the view keeps the tab model, the selection and the composables,
// and binds them through the props and events below.
//
// Scoped styles do not cross a component boundary, so every rule this markup
// uses is carried here from FolderWorkspaceView.vue's stylesheet; the parent
// keeps only the rules for the body it still renders.
import { ref, type VNode } from 'vue';
import AppIcon from './AppIcon.vue';
import PopupMenu from './PopupMenu.vue';
import { pointAnchor, type Box } from '../../shared/popupPlacement';
import { agentMark } from '../../shared/agentBadge';
import { canDropTabAt, reorderTabs, type WorkspaceTab } from '../../shared/workspaceTabs';
import { useStripDrag } from '../useStripDrag';

const props = defineProps<{
  /** The bar, in draw order — session tabs first, then the Files tabs. */
  tabs: WorkspaceTab[];
  /** The selected tab's id, after the first-tab fallback. */
  activeTabId: string | null;
  /** The tab being renamed, if any — its field replaces the tab in place. */
  renaming: { id: string; session: string } | null;
  /** Live text of the rename field. */
  renameText: string;
  /** The rename's refusal, tinting the field while it stands. */
  renameError: string | null;
  /**
   * The `+` menu's anchor box, owned by the view: the launch composable closes
   * it when the dialog opens, so the state cannot live on both sides.
   */
  addAnchor: Box | null;
  /** A session tab's tooltip (the view resolves it against its own rows). */
  sessionTabTitle: (session: string) => string;
  /** The mark a session tab wears, or null for a shell / unknown. */
  tabMark: (session: string) => ReturnType<typeof agentMark>;
  /** The workspace-qualified identity for a session name. */
  identityFor: (name: string, like?: string) => string;
}>();

/**
 * The bar announces; the view disposes. A click selects, a double-click begins
 * a rename, the field's Enter/Escape/blur commit or cancel it, a `×` or a menu
 * item arms the stop, a drag commits a ranking, and the `+` menu's two items
 * open the launch dialog and mint a Files tab.
 */
const emit = defineEmits<{
  select: [tab: WorkspaceTab];
  beginRename: [tab: WorkspaceTab];
  commitRename: [];
  cancelRename: [];
  renameFieldMounted: [vnode: VNode];
  renameInput: [event: Event];
  stop: [session: string];
  closeFiles: [id: string];
  launch: [];
  addFiles: [];
  addToggle: [box: Box | null];
  addMenuClose: [];
  redraw: [identity: string];
  reorder: [next: string[]];
}>();

// ---------------------------------------------------------------------------
// Dragging a tab to rearrange the bar
// ---------------------------------------------------------------------------

/**
 * The app's own drag flavour, so nothing else in the window mistakes a tab for
 * a payload it can accept.
 *
 * The composer takes file drops anywhere on its root, and the tab strip sits
 * directly above it — so a tab dragged past the composer used to light up its
 * "drop a file here" affordance. That is fixed on the composer's side by
 * testing for `Files` in `dataTransfer.types` (PromptComposer's `onDragOver`),
 * and this is the other half: a tab drag advertises a type nothing else claims,
 * so the two can never be confused in either direction without either of them
 * knowing about the other.
 */
const TAB_DRAG_TYPE = 'application/x-pocketshell-tab';

// The drag MECHANICS (payload, midpoint rule, drop-target marking) live in
// useStripDrag; what stays here is the strip's own policy — when a drag may
// start, where a tab may land, and what a landed drop commits.
const { dragging, startDrag, gapFor, markDroppable, endDrag } = useStripDrag({
  dragType: TAB_DRAG_TYPE,
  axis: 'x',
});
/** The gap the drop indicator is sitting in; null means no indicator. */
const dropGap = ref<number | null>(null);

function onTabDragStart(tab: WorkspaceTab, e: DragEvent): void {
  // A rename in progress owns the strip; dragging the field would be a drag of
  // a text selection wearing a tab's clothes.
  if (props.renaming !== null) return;
  startDrag(tab.id, e);
}

function onTabDragOver(index: number, e: DragEvent): void {
  const from = dragging.value;
  if (from === null) return;
  const gap = gapFor(index, e);
  // REFUSED VISIBLY, not accepted and snapped back. A drag that appears to
  // cross the session/files boundary and then undoes itself reads as a bug; a
  // drag that shows no indicator and a `no-drop` cursor reads as a rule.
  if (!canDropTabAt(props.tabs, from, gap)) {
    dropGap.value = null;
    return;
  }
  markDroppable(e);
  dropGap.value = gap;
}

function onTabDrop(): void {
  const from = dragging.value;
  const gap = dropGap.value;
  endDrag();
  dropGap.value = null;
  if (from === null || gap === null) return;
  const next = reorderTabs(props.tabs, from, gap);
  // Null for a no-op — a drag that ended where it started, which is most
  // cancelled drags — and writing then would persist an order for nothing.
  if (next) emit('reorder', next);
}

function onTabDragEnd(): void {
  endDrag();
  dropGap.value = null;
}

// `nudgeActiveTab` — the keyboard counterpart of the drag — is GONE with the
// chord that called it (`Ctrl+Shift+PageUp`/`PageDown`), removed at the user's
// request: "Move the active tab left or right remove this too". The DRAG is
// untouched and is now the only way to reorder;
// `nudgeTabOrder` stays in the shared module, unused here, still pinned by
// workspaceTabs.test.ts, because the ordering rule it encodes is the drag's
// too.

/**
 * The tab a right-click opened a menu on, with the box to hang it off.
 *
 * A measured POINT rather than the tab's rect, because a context menu belongs
 * under the cursor. `PopupMenu` is reused rather than a second menu written
 * here for the same reason it exists at all: the tab strip is
 * `overflow-x: auto`, which per CSS makes `overflow-y` compute to `auto` too,
 * so an `absolute` menu inside it is laid out exactly at the clip edge and is
 * invisible. That is the bug the `+` menu shipped with. PopupMenu teleports to
 * `body` and positions from a measured viewport rect, which is exactly what a
 * menu on a scrolling strip needs.
 */
const tabMenu = ref<{ session: string; identity: string; label: string; anchor: Box } | null>(
  null,
);

function openTabMenu(tab: WorkspaceTab, e: MouseEvent): void {
  if (tab.kind !== 'session') return;
  // A right-click does not select. The menu's items name the tab they came
  // from, so acting on a background tab is unambiguous — and selecting first
  // would mean a right-click that the user then dismisses had already moved
  // them, and moved the composer's key with it.
  emit('addMenuClose');
  // The pane's identity is resolved NOW, while the row stands; Redraw reaches
  // the ref map through it.
  tabMenu.value = {
    session: tab.session,
    identity: props.identityFor(tab.session),
    label: tab.label,
    anchor: pointAnchor(e.clientX, e.clientY),
  };
}

/** Start a rename from the menu — the double-click's discoverable sibling. */
function renameFromMenu(): void {
  const target = tabMenu.value;
  tabMenu.value = null;
  if (!target) return;
  const tab = props.tabs.find((t) => t.kind === 'session' && t.session === target.session);
  if (tab) emit('beginRename', tab);
}

/**
 * "Redraw" from the tab menu: put this pane and the far end back in agreement.
 *
 * The reported picture is tmux's status line drawn in the middle of the pane
 * with stale rows beneath it — the far end working to a smaller screen than we
 * have. The pane's own `resyncDisplay` explains why that state is unreachable
 * from this side once it starts (another tmux client became "latest" and shrank
 * the window; nothing here moved, so nothing here re-sends) and why the lever is
 * manual rather than a timer.
 *
 * It sits in the tab menu with Rename and Stop, and its position in that list is
 * the point: it is the only NON-destructive item, so it goes above the
 * separator, next to the other thing that changes nothing you can lose.
 *
 * Only a session tab has a pane to redraw. The menu is opened from a Files tab
 * too, and the item is simply not rendered there — an item that greys out on
 * half the tabs teaches the eye to skip the whole menu.
 */
function redrawFromMenu(): void {
  const target = tabMenu.value;
  tabMenu.value = null;
  if (target) emit('redraw', target.identity);
}

function askStop(): void {
  const target = tabMenu.value;
  tabMenu.value = null;
  if (target) emit('stop', target.session);
}

/**
 * The `×` on a session tab: the menu's Stop for a tab the user is pointing at
 * directly instead of one they right-clicked.
 *
 * It arms the same stop flow, so the same named and confirmed
 * dialog opens and the kill itself stays behind the confirm — the `×`
 * is a handle on the destructive action, never the action. The `+` menu is
 * dismissed here for the reason `openTabMenu` dismisses it: the strip's
 * `click.stop` keeps the event from reaching the menu's own outside-click
 * close, so a menu left standing would outlive the click that should have
 * dismissed it.
 */
function askStopTab(tab: Extract<WorkspaceTab, { kind: 'session' }>): void {
  emit('addMenuClose');
  emit('stop', tab.session);
}

/** The `+` button's element, for measuring the menu's anchor. */
const addButtonEl = ref<HTMLElement | null>(null);

function onAddClick(): void {
  emit('addToggle', addButtonEl.value?.getBoundingClientRect() ?? null);
}

/** The rename field runs its mount focus and live normalisation in the view. */
function onFieldMounted(vnode: VNode): void {
  emit('renameFieldMounted', vnode);
}

function onRenameInput(event: Event): void {
  emit('renameInput', event);
}
</script>

<template>
  <!-- ONE row of chrome, and now only one thing in it: the tabs and the `+`.

       The folder's NAME and a `×` that deselected it used to trail here. The
       user circled that end of the strip and said "no need for this part",
       and they are right on both counts.

       The name was the same fact three times over. The selected folder is
       already the highlighted row in the session panel beside this, and the
       window title already carries the host — so a label here named a thing
       the eye had just come from. This app has removed that redundancy twice
       before: from session rows in b841362, and from the merged identity
       header in 38bf971, whose reasoning ("one fact twice") is the same
       reasoning as this. An earlier request to expand the leaf into a full
       `~/git/red-stamp` path is superseded rather than reversed: it was an
       attempt to make this element earn its space, and the user has since
       decided it does not have any to earn.

       The `×` deselected the folder and returned the right pane to its
       placeholder. No way out is lost with it: the session panel is
       persistent, so another folder row switches workspace directly, and the
       panel's own back arrow leaves the host. What is no longer reachable is
       the placeholder state ITSELF once a folder has been picked — a pane
       that says "select a folder" while a folder is selected, which is not a
       destination anyone navigates to on purpose. -->
  <header class="folder-bar">
    <nav class="tabs" @dragend="onTabDragEnd">
      <template v-for="(tab, i) in tabs" :key="tab.id">
        <!-- The rename field REPLACES the tab in place rather than opening a
             dialog: the thing being renamed is the thing under the cursor,
             and a modal for a one-word edit is a heavier promise than the
             edit deserves. -->
        <span v-if="renaming?.id === tab.id" class="tab renaming">
          <input
            class="rename-input"
            :value="renameText"
            :title="renameError ?? 'Enter to rename, Escape to cancel'"
            :class="{ invalid: renameError }"
            @vue:mounted="onFieldMounted"
            @input="onRenameInput"
            @keydown.enter.prevent="emit('commitRename')"
            @keydown.esc.prevent="emit('cancelRename')"
            @blur="emit('commitRename')"
          />
        </span>
        <button
          v-else
          :class="[
            'tab',
            {
              active: tab.id === activeTabId,
              files: tab.kind === 'files',
              dragging: dragging === tab.id,
              'drop-before': dropGap === i,
              'drop-after': dropGap === tabs.length && i === tabs.length - 1,
            },
          ]"
          :title="tab.kind === 'session' ? sessionTabTitle(tab.session) : 'File browser'"
          draggable="true"
          @click="emit('select', tab)"
          @dblclick="emit('beginRename', tab)"
          @contextmenu.prevent="openTabMenu(tab, $event)"
          @dragstart="onTabDragStart(tab, $event)"
          @dragover="onTabDragOver(i, $event)"
          @drop.prevent="onTabDrop"
        >
          <!-- The double-click is the rename gesture (the browser/VS Code
               contract), and it belongs on the TAB rather than in selectTab:
               a single click must never open an editor, and the first click
               of a double-click would fire selectTab before dblclick — so a
               click-again rule and this gesture could not coexist. Files tabs
               have no name on the host; beginRename declines them. -->
          <!-- The agent mark, and NOTHING when the kind is unknown or a plain
               shell (src/shared/agentBadge.ts). A badge on every tab saying
               "we don't know" would cost the same 12px and teach the eye to
               skip the slot; a sparse one means something by being there. -->
          <AppIcon
            v-if="tab.kind === 'session' && tabMark(tab.session)"
            :name="tabMark(tab.session)!.icon"
            :size="12"
            :title="tabMark(tab.session)!.label"
            class="tab-agent"
          />
          {{ tab.label }}
          <!-- Every tab wears an `×`, but the two kinds do not mean the same
               thing by it, and neither one kills directly.

               A FILES tab's `×` closes the view and nothing else, and
               every one of them has it — the first included. The old rule
               spared the first tab because closing it would leave the
               workspace no way to look at the folder, and that reason is
               gone: `+` re-opens a Files tab in two clicks, and a file link
               clicked in the terminal with none standing opens its own (the
               reveal watcher below).

               A SESSION tab's `×` is the context menu's Stop, one click
               closer. It opens the SAME named, confirmed dialog the menu
               does rather than killing on the click, because the tab bar's argument
               survives the affordance: the thing behind the tab is a live
               process on another machine, and the control that can destroy
               it must say so and ask. The tooltip says Stop, never Close —
               the one word this app reserves for the kill — and the
               click stops here, so a background tab's `×` does not also
               move the user to it, the same rule the right-click obeys. -->
          <span
            v-if="tab.kind === 'session'"
            class="tab-close"
            title="Stop this session"
            @click.stop="askStopTab(tab)"
            @dblclick.stop
          >
            <AppIcon name="close" :size="12" />
          </span>
          <span
            v-else
            class="tab-close"
            title="Close this Files tab"
            @click.stop="emit('closeFiles', tab.id)"
            @dblclick.stop
          >
            <AppIcon name="close" :size="12" />
          </span>
        </button>
      </template>
    </nav>

    <!-- The `+` sits OUTSIDE the scrolling strip, which is both a fix and an
         improvement: inside it, a folder with many tabs scrolled its own
         "new tab" button off the end. Its menu is teleported (PopupMenu), so
         the strip's clipping cannot reach it either way. -->
    <div class="add-wrap">
      <button
        ref="addButtonEl"
        class="tab add"
        :class="{ active: addAnchor !== null }"
        title="New session or Files tab"
        aria-haspopup="menu"
        :aria-expanded="addAnchor !== null"
        @click="onAddClick"
      >
        <AppIcon name="plus" :size="14" />
      </button>
      <!-- Two items, and the asymmetry between them is deliberate.
           "New session…" opens a dialog because a launch has real choices
           behind it (engine, permissions, profile) and creates something on
           the host. "New Files tab" stays a DIRECT action: it creates
           nothing, configures nothing, and a dialog would make a free action
           feel expensive.

           Still a menu rather than the folder-first NewSessionDialog: that
           dialog exists to CHOOSE a folder, and inside a folder workspace
           the folder is already chosen. -->
      <PopupMenu
        v-if="addAnchor"
        :anchor="addAnchor"
        :ignore="[addButtonEl]"
        label="New session or Files tab"
        @close="emit('addMenuClose')"
      >
        <ul>
          <li>
            <button class="menu-item" @click="emit('launch')">New session…</button>
          </li>
          <li class="menu-sep" />
          <li>
            <button class="menu-item" @click="emit('addFiles')">New Files tab</button>
          </li>
        </ul>
      </PopupMenu>
    </div>

    <!-- Right-clicking a session tab. Two items, and the gap between them is
         the point: Rename is here because click-to-rename is real but
         undiscoverable, and Stop is here because the user asked for it and
         because a live tmux session is not something to put behind a `×`.
         They are separated and Stop is tinted, so the one thing in this menu
         that can lose work does not look like the one that cannot. -->
    <PopupMenu
      v-if="tabMenu"
      :anchor="tabMenu.anchor"
      :label="`Actions for ${tabMenu.session}`"
      @close="tabMenu = null"
    >
      <ul>
        <li class="menu-head">{{ tabMenu.session }}</li>
        <li>
          <button class="menu-item" @click="renameFromMenu">Rename…</button>
        </li>
        <li>
          <!-- No ellipsis: it acts immediately and asks nothing, which is
               exactly what the ellipsis on its neighbours promises is NOT the
               case for them. -->
          <button
            class="menu-item"
            title="Tell the host our size again and repaint the whole pane"
            @click="redrawFromMenu"
          >
            Redraw
          </button>
        </li>
        <li class="menu-sep" />
        <li>
          <button class="menu-item danger" @click="askStop">Stop session…</button>
        </li>
      </ul>
    </PopupMenu>
  </header>
</template>

<style scoped>
/* Everything in this block styles THIS component's markup and was carried
   verbatim from FolderWorkspaceView.vue's stylesheet — scoped styles do not
   cross the component boundary, so the rules live beside the bar they draw. */
/* ---- one row of chrome ---------------------------------------------------
 * Identity and tabs used to be two full-height bars, 72px of chrome above every
 * terminal. Merged they cost --topbar-h and nothing else.
 *
 * The row has no vertical padding on purpose. The tabs are full-height children
 * of it, which is what lets the active tab's 2px underline sit exactly on the
 * row's own bottom border — the treatment the session bar uses.
 */
.folder-bar {
  display: flex;
  align-items: stretch;
  gap: var(--sp-3);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-3) 0 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
/* Underline tabs, not Android's filled segmented control: a solid cyan
   segment at 13px is heavy for a mouse UI.
   The bar scrolls rather than wrapping: a second row of tabs would change the
   terminal's height, which is a remote tmux reflow (see .tab-body). */
.tabs {
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0 0 0 var(--sp-3);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: transparent;
  border: none;
  /* The 2px underline lands on the bar's bottom border because the button is
     the bar's full height; the -1px pulls it over that hairline instead of
     stacking a second line under it. */
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--fg-secondary);
  padding: 0 var(--sp-3);
  cursor: pointer;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.tab:hover {
  color: var(--fg);
}
/* ---- dragging a tab -----------------------------
 *
 * The tab being carried fades but STAYS IN PLACE, rather than being removed
 * from the flow. Removing it would reflow every tab after it the moment the
 * drag began, so the strip the user is aiming at would move under the cursor at
 * exactly the wrong moment — and on a scrolling strip it can also change which
 * tabs are visible.
 *
 * The landing place is a 2px rule in the gap, drawn as a border on the tab
 * beside it. An indicator is worth the effort here: without one a reorder is
 * "let go and find out", and the two rules the drag obeys — the midpoint flip
 * and the group boundary — are both invisible unless something draws them.
 * When the drop is refused NOTHING is drawn, which is the refusal.
 */
.tab.dragging {
  opacity: var(--disabled-opacity);
}
.tab.drop-before {
  box-shadow: inset 2px 0 0 0 var(--accent);
}
.tab.drop-after {
  box-shadow: inset -2px 0 0 0 var(--accent);
}
.tab.active {
  color: var(--fg);
  font-weight: var(--fw-semibold);
  border-bottom-color: var(--accent);
}
/* Files tabs are the same control at a lower tone, so the eye can find the
   session half of the bar without reading it. */
.tab.files {
  font-family: var(--font-ui);
  color: var(--fg-muted);
}
.tab.files.active {
  color: var(--fg);
}
/*
 * The agent mark. Muted by default and taking the tab's own colour when the tab
 * is active, so it reads as part of the label rather than as a status light
 * competing with it — the mark says WHICH agent, and the underline already says
 * which tab. It is never tinted per kind: four hues on a 12px outline is a
 * palette nobody can learn, and the mark's shape is the distinguishing feature
 * (src/shared/agentBadge.ts).
 */
.tab-agent {
  color: var(--fg-muted);
}
.tab.active .tab-agent {
  color: var(--accent);
}
.tab-close {
  display: inline-flex;
  align-items: center;
  color: var(--fg-muted);
  border-radius: var(--r-sm);
  /* A 12px glyph is under the fair-hit-target floor, and one of these buttons
     now fronts the stop confirmation — the padding buys the hover square some
     aim without widening the tab's own label row. */
  padding: 2px;
}
.tab-close:hover {
  color: var(--fg);
  background: var(--state-hover);
}
/* The field takes the tab's own box, so committing a rename does not make the
   bar jump: the tab it replaces was the same height and roughly the same
   width. */
.tab.renaming {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-2);
  border-bottom: 2px solid var(--accent);
  margin-bottom: -1px;
}
.rename-input {
  width: 10ch;
  min-width: 6ch;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  padding: 0 var(--sp-1);
}
.rename-input.invalid {
  border-color: var(--error);
}
/* A sibling of the scrolling strip, not a child of it, so the `+` stays put
   while the tabs scroll under it. `position: relative` is deliberately NOT set:
   the menu is teleported and positioned from a measured viewport rect, so this
   element is not a containing block for anything. */
.add-wrap {
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
}
.tab.add {
  color: var(--fg-muted);
}
.tab.add.active {
  color: var(--fg);
  background: var(--state-hover);
}
/* The menu itself is PopupMenu.vue — teleported to <body>, so it has no styles
   here and cannot be clipped by the strip. All that is left is the button. */
/*
 * The one menu item that can lose work, and it has to LOOK like it.
 *
 * `:deep` because PopupMenu's items arrive through its slot and so carry this
 * component's scope id rather than the menu's — the same reason PopupMenu
 * publishes `.menu-item` with `:deep` from its side.
 *
 * Tinted rather than separated-only: the separator says "different group", the
 * colour says "different KIND of thing". The hover fill is the error tint at
 * low alpha rather than the ordinary hover grey, so the row confirms what it is
 * at the moment the cursor lands on it and before it is clicked.
 */
.popup-menu :deep(.menu-item.danger) {
  color: var(--error);
}
.popup-menu :deep(.menu-item.danger:hover) {
  background: var(--error-soft);
}
</style>
