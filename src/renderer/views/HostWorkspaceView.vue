<script setup lang="ts">
// Host workspace: the shell for a connected host.
//
// Layout: a persistent left panel holding the folder-grouped session list,
// and a right pane showing the selected FOLDER's workspace. The panel never
// goes away — picking a folder only swaps what the right pane renders:
//
//   /host/:name                -> SessionPlaceholderView (nothing selected)
//   /host/:name/folder/:folder -> FolderWorkspaceView (a tab per session, then Files)
//
// There is deliberately NO host topbar. The row that used to sit here —
// back, collapse, `hetzner · alexey@135.181.114.209`, Ports/Usage/Settings,
// disconnect — spent a full --topbar-h above every terminal mostly on an
// identity label, in an app whose whole point is the terminal. It went four
// ways:
//
//   - the IDENTITY is the OS window title now (the `win:setTitle` watch
//     below) — the native title bar was already there, saying "PocketShell";
//   - BACK and COLLAPSE moved into the session panel's own header row, which
//     was already paying for its --topbar-h;
//   - PORTS / USAGE / SETTINGS were a panel-FOOT row, and now sit as controls
//     in that same header — the user asked for them
//     at the top, and since §5.3e each of Ports and Usage is its OWN icon
//     there rather than a row of an overflow menu. The overlays did not move;
//     only their triggers did;
//   - DISCONNECT moved to the host picker's row for the connected host —
//     every disconnect already navigated there, so the button now lives at
//     its own destination, next to where the connection was opened.
//
// Folders are the default view of a host, and tabs belong to the selected
// FOLDER. The two host-scoped panels — port forwarding and
// provider usage — open as overlays, because neither is a property of one
// folder.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAgentsStore } from '../stores/agents';
import { useConnectionStore } from '../stores/connection';
import { useForwardsStore } from '../stores/forwards';
import { api } from '../ipc';
import { useSettingsStore } from '../stores/settings';
import { windowTitle } from '../../shared/windowTitle';
import { isShortcut } from '../../shared/shortcuts';
import { MAX_ATTEMPTS } from '../../shared/reconnectBackoff';
import AppIcon from '../components/AppIcon.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import PopupMenu from '../components/PopupMenu.vue';
import SessionTree from '../components/SessionTree.vue';
import HostPanelButtons from '../components/HostPanelButtons.vue';
import { type HostPanel } from '../hostPanels';
import { type Box } from '../../shared/popupPlacement';
import { requestWorkspaceFocus } from '../workspaceFocus';
import { useFolderTree } from '../folderTree';
import { adjacentIndex } from '../../shared/listNavigation';
import { editingTarget } from '../editingTarget';
import PortPanelView from './PortPanelView.vue';
import SettingsView from './SettingsView.vue';
import UsageView from './UsageView.vue';
import type { SessionDirectory } from '../sessionTree';
import { usePaneWidth } from '../usePaneWidth';

const route = useRoute();
const router = useRouter();
const connection = useConnectionStore();
const agents = useAgentsStore();
// Subscribed only while the ports overlay is open — see the autoFwd watch
// below for why its `autoOn` is mirrored rather than rendered directly.
const forwards = useForwardsStore();
// Read for the chord table only; see the panel comment below for why settings
// is otherwise not this view's business.
const settings = useSettingsStore();

/**
 * The host's identity, projected into the OS title bar. Watched rather than
 * set once: a reconnect can swap `activeHost` while this view stays mounted.
 * There is deliberately no reset on unmount — the picker claims the title in
 * its own onMounted, so the handoff cannot depend on Vue's mount/unmount
 * ordering during a route swap.
 */
watch(
  () => connection.activeHost,
  (host) => api.win.setTitle(windowTitle(host)),
  { immediate: true },
);

/**
 * Which panel is open as an overlay, if any.
 *
 * `settings` is the odd one out and is here anyway: most settings are app
 * level, while the project-root section is scoped to this connected host. A
 * route would unmount this view and take the terminal's scrollback with it,
 * and the panel has to be reachable from a connected host as well as from the
 * picker. One shared `SettingsView`, two callers, no navigation. See the
 * header comment in views/SettingsView.vue.
 */
const panel = ref<HostPanel | null>(null);

/**
 * Whether auto-forward is on for this host — the state behind the Ports
 * button's ring-and-dot indicator.
 *
 * Deliberately NOT read off the forwards store's own `autoOn`: that ref is
 * only live while the ports overlay is mounted (PortPanelView subscribes on
 * mount and the store `clear()`s on unmount), and the indicator has to be
 * right the rest of the time — which is most of it. So this asks the engine's
 * own question — `isAutoEnabled`: forwarder running, else the persisted
 * per-host flag — whenever the connection or the overlay changes, and while
 * the overlay IS open the store's live flips are mirrored straight through, so
 * a toggle inside the panel reaches the header button without waiting for a
 * reopen.
 */
const autoFwd = ref(false);
watch(
  () => [connection.connectionId, panel.value] as const,
  async ([conn]) => {
    if (!conn) {
      autoFwd.value = false;
      return;
    }
    const on = await api.forwards.isAutoEnabled(conn);
    // A late answer for a connection that has since been replaced must not
    // win — reconnect mints a new id, and the old flag is about a dead link.
    if (connection.connectionId === conn) autoFwd.value = on;
  },
  { immediate: true },
);
watch(
  () => forwards.autoOn,
  (on) => {
    if (panel.value === 'ports') autoFwd.value = on;
  },
);

/**
 * How many forwards are live for this host — the Ports button's count pill
 *. Same home as `autoFwd` for the same reason: the
 * forwards store is only fresh while the ports overlay is mounted, and the
 * badge has to be right the rest of the time.
 *
 * The engine already BROADCASTS every state change — `forwards:states` goes
 * out on each scan pass and, importantly, an empty array on engine stop and
 * on a dropped link — so this is one subscription and one initial snapshot
 * (`list`, a main-process map read), not a poll and not a new IPC verb. The
 * empty-array push is what empties the badge in every teardown transition
 * without a line of code here.
 *
 * A push for a connection other than the active one is dropped: reconnect
 * mints a new id, and the dead link's last count is not the new host's.
 */
const fwdCount = ref(0);
let unwatchStates: (() => void) | null = null;
watch(
  () => connection.connectionId,
  (conn) => {
    unwatchStates?.();
    unwatchStates = null;
    if (!conn) {
      fwdCount.value = 0;
      return;
    }
    // Covers the gap before the engine's next push: an engine already running
    // (panel opened and closed, manual forward added) has states right now.
    void api.forwards.list(conn).then((s) => {
      if (connection.connectionId === conn) fwdCount.value = s.length;
    });
    unwatchStates = api.forwards.onStates(({ connectionId: id, states }) => {
      if (id !== conn) return;
      fwdCount.value = states.length;
      // A lazy start outside the panel (a manual add, a port forced on) runs
      // the engine without the mount-time `isAutoEnabled` ask ever being
      // repeated; live forwards ARE the engine running, so the ring follows.
      if (states.length > 0) autoFwd.value = true;
    });
  },
  { immediate: true },
);
onBeforeUnmount(() => unwatchStates?.());

/** Session-panel geometry. Collapsed hides it entirely; width is drag-resized. */
const panelCollapsed = ref(false);
/**
 * Seven controls in the header strip pin this floor: 7×28px squares + 6×4px
 * gaps = 220, plus the header's asymmetric padding of 12 — the arithmetic is
 * written out in SessionTree's template. It was 200 until §5.3e expanded the
 * overflow menu into its two icons; dragging below 232 would clip the strip.
 */
const MIN_PANEL_WIDTH = 232;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 280;
// usePaneWidth owns the restore/clamp/drag/write mechanics that the Files
// tree's splitter used to duplicate line for line.
const { width: panelWidth, onDragStart } = usePaneWidth({
  storageKey: 'pocketshell.sessionPanelWidth',
  min: MIN_PANEL_WIDTH,
  max: MAX_PANEL_WIDTH,
  defaultWidth: DEFAULT_PANEL_WIDTH,
});

/**
 * The lost-link banner's own memory of the re-dial it started.
 *
 * The connection store already knows everything about the DROP — its
 * `ssh.onState` subscription flips `state` to 'lost' and stocks `error` — but
 * until this banner existed no view rendered any of it, so the terminal froze,
 * the file browser listed nothing, and the session panel's poll surfaced a raw
 * IPC rejection ("Unknown connection: …") as the only clue. The store's own
 * comment promised "the state flag is enough for the UI to say the link is
 * gone and offer reconnect"; this is that UI.
 *
 * A local ref on top of the store's state, because the store's `state` alone
 * cannot keep the banner up for the whole recovery arc: pressing Reconnect
 * moves it to 'connecting' (no longer 'lost'), and a FAILED re-dial lands on
 * 'idle' — the same value a fresh app has. A banner gated purely on
 * `state === 'lost'` would therefore vanish the moment the button was pressed
 * and stay gone after a failure, which is precisely when the user needs the
 * error and a pressable button most. So the banner shows while the state is
 * 'lost' OR while a re-dial this banner started is unresolved or failed, and
 * only a re-dial that actually lands clears it.
 */
const redial = ref<'none' | 'inflight' | 'failed'>('none');

/**
 * The banner is up for the whole arc: drop, attempt, failure.
 *
 * `connection.recovering` covers the AUTOMATIC half the store now drives:
 * a scheduled retry sits at state 'connecting' while it is
 * on the wire with `redial` still 'none', and without this the strip would
 * blink off during every dial it did not start.
 */
const linkLost = computed(
  () => connection.state === 'lost' || redial.value !== 'none' || connection.recovering,
);

/** True while the re-dial is on the wire — the button says so and disarms. */
const reconnecting = computed(() => connection.state === 'connecting');

/** True while the store's automatic retry is scheduled — the button is "Retry now". */
const autoRetrying = computed(() => connection.autoRetry !== null);

/**
 * What the strip says while a retry is scheduled. Names the host, where in
 * the curve the FSM is, and when the next dial goes out — the countdown the
 * backoff's `retryAtEpochMs` was designed for.
 */
const autoRetryText = computed(() => {
  const host = connection.activeHost?.name ?? 'the host';
  return (
    `Lost the connection to ${host}. Retrying automatically — attempt ` +
    `${connection.autoRetry?.attempt ?? 0} of ${MAX_ATTEMPTS} starts in ` +
    `${connection.retryIn}s.`
  );
});

/**
 * Re-dial the host through the store. The store's `reconnect()` wakes the
 * surfaces that went stale with the dead id — sessions refresh, forwards
 * re-init — so recovery is identical whether the user pressed this or the
 * FSM dialled on its own schedule; this handler only manages the banner.
 *
 * On failure the store has already written `connection.error` (connect() sets
 * it before resolving false), so all that is left here is to keep the banner
 * standing and re-arm the button.
 */
async function onReconnect(): Promise<void> {
  redial.value = 'inflight';
  const ok = await connection.reconnect();
  if (ok) {
    // Drop the banner — the link is back. (The store's surface recovery is
    // awaited inside reconnect(); by the time this resolves it is done or
    // failed soft, and neither is worth an error-toned strip.)
    redial.value = 'none';
  } else {
    redial.value = 'failed';
  }
}

/** The button during a countdown: skip the wait and dial now. */
function onRetryNow(): void {
  void connection.retryNow();
}

/**
 * What the strip says. The standing sentence names the frozen surfaces because
 * that is the question a dead pane actually poses ("did my session die?" — no,
 * the LINK did, the tmux sessions are fine on the host); after a failed
 * re-dial the store's error replaces it, so the user is never shown a stale
 * "connection lost" over a fresher, more specific failure.
 */
const linkLostText = computed(() => {
  if (redial.value === 'failed') return connection.error ?? 'Reconnect failed';
  const host = connection.activeHost?.name;
  return `Connection to ${host ?? 'the host'} was lost. The sessions and terminals on screen are frozen until you reconnect.`;
});

/**
 * The host tools that are not installed.
 *
 * `tmuxctl` is listed like the others but it is not like the others: it is
 * the binary the session-join command invokes, and the raw `tmux attach` and
 * `pocketshell sessions` fallbacks are gone, so a host without it can open no
 * session at all. Naming it here is the difference between finding that out
 * now and finding it out after clicking a session and getting a diagnostic in
 * the terminal.
 */
const missingTools = computed(() => {
  const b = connection.bootstrap;
  if (!b) return [];
  return (['pocketshell', 'tmuxctl', 'tmux'] as const).filter((t) => !b[t].installed);
});

/** "tmuxctl", "tmuxctl and tmux", "pocketshell, tmuxctl and tmux". */
const missingToolsText = computed(() => {
  const names = missingTools.value;
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
});

/** Folder named by the route, so the panel can highlight the current row. */
const activeFolder = computed(() => (route.params['folder'] as string | undefined) ?? null);

/**
 * The panel's folder rows, flat and in draw order, for the `Ctrl+↑`/`Ctrl+↓`
 * chords below. The SAME derivation `SessionTree` renders from — see
 * `folderTree.ts` for why deriving it twice is the bug this avoids.
 */
const { folders, roots } = useFolderTree();

/**
 * Open a folder's workspace. [session] names a tab to arrive on, which the
 * panel supplies only when it has a reason to — a session it just created.
 *
 * Re-selecting the folder that is already open is NOT a no-op when a session
 * is named: that is the create case, where the workspace is already on screen
 * and the point of the navigation is to move to the new tab.
 */
function onSelectFolder(folder: SessionDirectory, session?: string): void {
  if (folder.key === activeFolder.value && session === undefined) {
    // A bare re-click of the open row: nothing to navigate to — same folder,
    // same route — but it is still "take me to this workspace", so the
    // keyboard goes to the pane in front, the same landing every fresh
    // arrival gets. Through the workspace's own registration
    // (workspaceFocus.ts): this view cannot focus a terminal it does not own.
    requestWorkspaceFocus();
    return;
  }
  // `void`: vue-router rejects the returned promise on an aborted or
  // redirected navigation, and neither is an error here. Same convention as
  // src/main/index.ts's `void mainWindow.loadURL(...)`.
  void router.push({
    name: 'folder',
    params: { name: route.params['name'] as string, folder: folder.key },
    ...(session === undefined ? {} : { query: { tab: session } }),
  });
}

/* ── The collapsed rail's session switcher ─────────────────────────────────
 * With the panel hidden, the tab bar covers only the OPEN folder's sessions;
 * every other workspace costs "show panel → click its row → hide it again" —
 * two clicks and a trip through a 280px column to move once. The switcher is
 * the panel's list folded into a menu: the SAME `useFolderTree` derivation the
 * panel draws from, in the same order, keyed the same way, so it cannot show
 * a row the panel would not (the argument is folderTree.ts's, and the
 * `Ctrl+↑`/`Ctrl+↓` chords already stand on it).
 *
 * It navigates and creates nothing: a click is `onSelectFolder`, the panel
 * row's own handler, so re-picking the open folder keeps the row's re-click
 * semantics (focus the pane, navigate nowhere), and the rail keeps its no-`+`
 * rule — creating a session is still something you do while looking at the
 * list you are adding to.
 *
 * `PopupMenu` rather than an inline dropdown because it is the app's ONE menu:
 * teleported past every clipping ancestor, placed from a measured box, and
 * capped to the viewport — which a folder list long enough to need a switcher
 * can comfortably outgrow.
 */
const switcherBtn = ref<HTMLButtonElement | null>(null);
/** Open state; carries the anchor box snapshotted from the rail button. */
const switcher = ref<{ anchor: Box } | null>(null);

function toggleSwitcher(): void {
  if (switcher.value) {
    switcher.value = null;
    return;
  }
  // A DOMRect is assignable to Box (popupPlacement.ts); the fallback never
  // fires through the UI — the button owns the handler — and only keeps the
  // type honest.
  const el = switcherBtn.value;
  switcher.value = {
    anchor: el?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 },
  };
}

/** Pick a folder in the switcher: close, then the same answer a row click gets. */
function pickFolder(dir: SessionDirectory): void {
  switcher.value = null;
  onSelectFolder(dir);
}

/**
 * Live sessions on the host, for the button's tooltip — the one place the
 * collapsed state can still answer "how much is running" without opening
 * anything, worded the way HostPanelButtons words its own ("…, 2 ports").
 */
const sessionTotal = computed(() => folders.value.reduce((n, dir) => n + dir.rows.length, 0));

/** The rail button's word, extended while there is something to switch to. */
const switcherTitle = computed(() =>
  sessionTotal.value > 0 ? `Sessions — ${sessionTotal.value}` : 'Sessions',
);

/* ── `Ctrl+↑` / `Ctrl+↓`: the workspace above, the workspace below ─────────
 *
 * Asked for as one gesture with the tab chords — "up and down - different
 * workspaces", "left and right - tabs within workspace" — and that pairing is
 * the whole design. The two axes are the two lists on screen: the tab bar runs
 * across the top of the workspace, the folder rows run down the panel on the
 * left, and each arrow moves along the thing that lies in its own direction.
 * Nobody has to remember which is which, because the keyboard mirrors the
 * layout.
 *
 * ## Why HERE and not in the workspace
 *
 * `FolderWorkspaceView` owns the horizontal pair, because tabs are its own
 * state. The vertical pair changes WHICH workspace is mounted, so it belongs to
 * the thing that owns the route — and this is it (`onSelectFolder`). Putting it
 * in the workspace would mean a component navigating away from itself, and the
 * one case that has to work would be the one it could not serve: an empty
 * panel, or a route with no folder yet, where no workspace is mounted to listen.
 *
 * ## Which rows, and in what order
 *
 * `useFolderTree().folders` — the SAME derivation the panel draws from, in the
 * same order, keyed the same way. Deriving the list a second time here is the
 * one thing this must not do: `$HOME` decides whether a folder is keyed
 * `~/git/foo` or `/home/me/git/foo`, and a chord navigating by a key the panel
 * spells differently lands in a workspace with no tabs and highlights no row.
 * See the header of `folderTree.ts`.
 *
 * The list is FLAT across roots, so `Ctrl+↓` on the last folder of `git` opens
 * the first folder under the next root. The user is stepping down the PANEL,
 * and a root header is a label, not a stop.
 *
 * It CLAMPS at both ends (`adjacentIndex`), same as the tab arrows: an arrow
 * is a direction, and being thrown from the top of the panel to the bottom is
 * not what "up" asked for.
 *
 * ## What it costs, and where it stands down
 *
 * `Ctrl+↑`/`Ctrl+↓` at a shell is `ESC [ 1 ; 5 A` / `ESC [ 1 ; 5 B`, which
 * readline leaves unbound by default — so this is the cheaper half of the two
 * pairs. In a real text field it does nothing at all here: the same
 * `editingTarget` rule the tab arrows follow, kept in step deliberately, or one
 * axis of a single gesture would behave differently from the other in a draft.
 *
 * `capture: true` on `window` for the reason FolderWorkspaceView's handler
 * documents at length: xterm, CodeMirror and the composer are three different
 * keyboard owners, and capture runs before all of them. `preventDefault` and
 * `stopPropagation` both, so neither Chromium nor xterm also acts on it.
 */
function stepWorkspace(direction: 1 | -1): void {
  const rows = folders.value;
  const index = adjacentIndex(
    rows.length,
    rows.findIndex((dir) => dir.key === activeFolder.value),
    direction,
  );
  const target = index === null ? null : rows[index];
  if (target) onSelectFolder(target);
}

/**
 * A field the user is editing keeps its own arrow keys — see
 * `editingTarget.ts`, where the rule lives now that a third chord needs it.
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey) return;
  // The chord lives in the registry (`workspaces.stepUpDown`). The old
  // hand-spelled `e.shiftKey` exit went with the inline spelling, for the same
  // reason FolderWorkspaceView's did: a stand-in for "this chord wears no Shift"
  // would silently refuse any rebinding that does.
  if (!isShortcut(settings.shortcutBindings, 'workspaces.stepUpDown', e)) return;
  if (editingTarget(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  stepWorkspace(e.key === 'ArrowDown' ? 1 : -1);
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, { capture: true }));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, { capture: true }));

function onBack(): void {
  void router.push({ name: 'hosts' });
}

/**
 * The usage panel's refresh lives in the OVERLAY header, beside the close
 * control, rather than floating at the top of the panel body where it read as
 * orphaned debris. The overlay owns the chrome, so the host owns this button.
 */
async function onRefreshUsage(): Promise<void> {
  if (connection.connectionId) await agents.loadUsage(connection.connectionId);
}
</script>

<template>
  <div class="workspace">
    <!-- The lost-link strip. Same shape as the install-ask below but
         error-toned, because the two are different in kind: missing tools are
         an instruction the user can act on later, a dead transport is the
         reason everything on screen has stopped answering. It carries the ONE
         recovery action right where the symptom is — before this, the only
         route back was guessing to navigate to hosts and reconnect by hand. -->
    <p v-if="linkLost" class="link-lost">
      <AppIcon name="alert-triangle" :size="14" />
      <span class="link-lost-text">{{ autoRetrying ? autoRetryText : linkLostText }}</span>
      <button
        class="reconnect-btn"
        :disabled="reconnecting"
        @click="autoRetrying ? onRetryNow() : onReconnect()"
      >
        {{ reconnecting ? 'Reconnecting…' : autoRetrying ? 'Retry now' : 'Reconnect' }}
      </button>
    </p>

    <!-- Only rendered when something is actually missing. The always-on
         chip row this replaces spent header space telling the user their
         host was fine, which is the case that needs no words at all. -->
    <p v-if="missingTools.length" class="install-ask">
      <AppIcon name="close" :size="14" />
      <span>
        This host is missing {{ missingToolsText }}. Install
        {{ missingTools.length === 1 ? 'it' : 'them' }} on the host to use PocketShell here.
      </span>
    </p>

    <div class="body">
      <!-- Collapsed: a slim rail, not nothing. With the topbar gone, a
           zero-width collapse would take the expand toggle (and with it every
           host-level control) off the screen entirely; the rail keeps expand
           and back one click away and still returns ~90% of the panel's width
           to the terminal. v-if, not v-show — it must never match a selector
           while the expanded header's twin buttons do. -->
      <aside v-if="panelCollapsed" class="collapsed-rail">
        <button class="icon-btn" title="Show session panel" @click="panelCollapsed = false">
          <AppIcon name="panel-left" :size="14" />
        </button>
        <button class="icon-btn" title="Back to hosts" @click="onBack">
          <AppIcon name="arrow-left" :size="14" />
        </button>
        <!-- The session switcher (the block comment in the script). Under the
             nav pair with it, because it IS navigation — the jump the panel
             hidden makes expensive — and above the separator, leaving the
             host-overlay half of the rail untouched. The `folder` mark is the
             menu's own contents: the panel's folder rows, one list. -->
        <button
          ref="switcherBtn"
          class="icon-btn"
          :title="switcherTitle"
          @click="toggleSwitcher"
        >
          <AppIcon name="folder" :size="14" />
        </button>
        <!-- The rail exists so host controls are not stranded when the panel is
             hidden (ca79ae2). The header holds Ports and Usage as their own
             icon buttons since §5.3e, so the rail carries the same pair
             (components/HostPanelButtons.vue) plus the gear — mirroring the
             header's arrangement rather than inventing its own. Not fewer
             icons than the header, and no menu row between them and their
             overlays: a 36px rail has no room for text either way, and the
             words live in each tooltip exactly as they do in the header.

             There is still no `+` here. The rail is an ESCAPE HATCH — show
             the panel, go back, switch workspace, reach the host overlays —
             and creating a session is a thing you do while looking at the list
             you are about to add to. One click on the top button brings that
             list back; the switcher below reads it without it. -->
        <div class="rail-sep" />
        <HostPanelButtons
          :auto-forward="autoFwd"
          :forward-count="fwdCount"
          @select="panel = $event"
        />
        <button class="icon-btn" title="Settings" @click="panel = 'settings'">
          <AppIcon name="settings" :size="14" />
        </button>
      </aside>

      <!-- The switcher's menu. Teleported to `body` by PopupMenu; `ignore`
           names the trigger so a press on it is not read as "outside" first —
           without it the mousedown would close the menu and the button's own
           click would reopen it, and the toggle would look frozen open
           (PopupMenu.vue's header documents the mechanism). -->
      <PopupMenu
        v-if="switcher"
        :anchor="switcher.anchor"
        :ignore="[switcherBtn]"
        label="Sessions"
        @close="switcher = null"
      >
        <ul>
          <!-- One head per root, one item per folder: the panel's two levels,
               in the panel's order. A root holding no folders is skipped — its
               header is a label over rows that are not there, and a switcher
               item you cannot switch to is noise (the expanded panel, which
               can explain an empty registered root in words, still draws it). -->
          <template v-for="root in roots" :key="root.key">
            <li v-if="root.directories.length" class="menu-head switch-root">
              {{ root.key }}
            </li>
            <li v-for="dir in root.directories" :key="dir.key">
              <button
                class="menu-item switch-item"
                :class="{ current: dir.key === activeFolder }"
                @click="pickFolder(dir)"
              >
                <!-- The panel row's two marks, same meanings: the dot says
                     something live is in here, the check says this is the
                     workspace already on screen. -->
                <span class="dot" :class="{ active: dir.active }" />
                <span class="switch-label">{{ dir.label }}</span>
                <span v-if="dir.rows.length > 1" class="switch-count muted">
                  {{ dir.rows.length }}
                </span>
                <AppIcon
                  v-if="dir.key === activeFolder"
                  name="check"
                  :size="14"
                  class="current-check"
                />
              </button>
            </li>
          </template>
          <li v-if="!folders.length" class="menu-head switch-root">no sessions</li>
        </ul>
      </PopupMenu>

      <!-- Persistent session panel: always mounted, never navigated away from.
           v-show, not v-if — collapsing must not cost the tree its disclosure
           and scroll state. A flex column: the tree above, host actions below. -->
      <aside
        v-show="!panelCollapsed"
        class="session-panel"
        :style="{ width: `${panelWidth}px` }"
      >
        <!-- The host destinations moved INTO this component's header as an
             overflow menu; it emits which overlay was asked for and this view
             still owns them. -->
        <SessionTree
          :active-folder="activeFolder"
          :auto-forward="autoFwd"
          :forward-count="fwdCount"
          @select="onSelectFolder"
          @back="onBack"
          @collapse="panelCollapsed = true"
          @panel="panel = $event"
        />
      </aside>
      <div
        v-show="!panelCollapsed"
        class="splitter"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="onDragStart"
      />

      <!-- Right pane: the selected folder's workspace, or the empty state. -->
      <main class="session-pane">
        <router-view />
      </main>
    </div>

    <!-- Host-level panels: overlays, never peers of the session tabs. -->
    <OverlayPanel v-if="panel === 'ports'" title="Port forwarding" @close="panel = null">
      <!-- Scan lives HERE, in the overlay's action row beside the close
           control — the same seat Usage's refresh occupies — rather than in
           the panel's face: the engine rescans on its
           own every few seconds, so an always-visible Scan button spent the
           panel's best row on a thing you almost never open the panel to do.
           One policy-applying pass is what a press means (forwards.ts). -->
      <template #actions>
        <button
          class="icon-btn"
          :disabled="forwards.loading || !connection.connectionId"
          title="Scan the host's ports now"
          @click="connection.connectionId && forwards.scan(connection.connectionId)"
        >
          <AppIcon name="refresh" :class="{ spin: forwards.loading }" />
        </button>
      </template>
      <PortPanelView v-if="connection.connectionId" />
    </OverlayPanel>
    <OverlayPanel v-if="panel === 'usage'" title="Provider usage" size="md" @close="panel = null">
      <template #actions>
        <button
          class="icon-btn"
          :disabled="agents.loading"
          title="Refresh"
          @click="onRefreshUsage"
        >
          <AppIcon name="refresh" :class="{ spin: agents.loading }" />
        </button>
      </template>
      <!-- `embedded`: the overlay header renders the title AND the refresh. -->
      <UsageView v-if="connection.connectionId" embedded />
    </OverlayPanel>
    <OverlayPanel v-if="panel === 'settings'" title="Settings" size="md" @close="panel = null">
      <SettingsView />
    </OverlayPanel>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
/* Error-toned twin of .install-ask below, and a strip rather than a modal on
   purpose: the scrollback in the frozen panes is still worth reading — the
   store keeps `connectionId` alive through 'lost' precisely so those panes
   stay mounted — and a dialog would sit on top of the very thing the user
   wants to look at while deciding whether to reconnect. */
.link-lost {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--error);
  background: var(--error-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
/* The text takes the slack so the button keeps its place at the right edge —
   the strip's message changes length (lost sentence vs. a failure reason) and
   the one control must not wander with it. */
.link-lost-text {
  flex: 1;
  min-width: 0;
}
/* Solid error, like the stop-confirm's danger button: this is the strip's one
   action and the whole reason it exists, so it must not read as a tinted
   afterthought beside its own message. */
.reconnect-btn {
  flex: 0 0 auto;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
  background: var(--error);
  border: 1px solid var(--error);
  color: var(--on-accent);
  transition: opacity var(--dur-fast) var(--ease);
}
.reconnect-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Warning-toned but not an alarm: it is an instruction, and the user can
   still use every other part of the app while it stands. With the topbar gone
   it is the workspace's top strip — rendered only when it applies, so the
   usual cost is zero rows. */
.install-ask {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--warning);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* Surface and the right hairline live on the aside, not on SessionTree: the
   panel is a column of [tree, host-actions] and the seam has to run past
   both. The splitter sits just outside it, transparent at rest. */
.session-panel {
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
}
/* Divides the NAVIGATION half of the rail (show panel, back) from the
   HOST-OVERLAY half, so three icons in a column do not read as one list of
   five unrelated things. */
.rail-sep {
  width: 16px;
  height: 1px;
  margin: var(--sp-1) 0;
  background: var(--border);
}
/* Expand-affordance column for the collapsed state. Same surface and hairline
   as the panel it stands in for. */
.collapsed-rail {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface);
  border-right: 1px solid var(--border);
}
/* The switcher menu's own register, on top of PopupMenu's `.menu-item`. The
   root head is a PATH (`~/git`), not a label — uppercasing it would spell the
   directory wrong, so it opts out of the menu-head transform the way the
   panel's own `path-prefix` keeps `~/` in its lower-case voice. */
.switch-root {
  text-transform: none;
  letter-spacing: 0;
}
/* The panel row's marks at menu size: the same 8px dot with the same two
   states (grey quiet, green something-live), and a label that ellipsises
   rather than pushes the count and check off the menu. */
.switch-item .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex: none;
}
.switch-item .dot.active {
  background: var(--success);
}
.switch-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Count hugs its label the way the panel's row count does, and the check —
   the open workspace's mark — takes the far end. */
.switch-count {
  flex: none;
  font-size: var(--fs-200);
}
.current-check {
  margin-left: auto;
  color: var(--accent);
  flex: none;
}
.switch-item.current {
  background: var(--state-selected);
}
.switch-item.current .switch-label {
  color: var(--accent);
  font-weight: var(--fw-medium);
}
/* Transparent at rest: the session panel's own 1px right border is the visual
   seam, and the 4px --bg band this used to paint read as a dark gutter
   doubling that hairline. VS Code's sash behaviour, including the hover-in
   delay — the highlight appears only when the cursor LINGERS, so sweeping
   across the app never flashes a cyan bar. The delay is enter-only; leaving
   transitions immediately. */
.splitter {
  flex: 0 0 auto;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background var(--dur-fast) var(--ease);
}
.splitter:hover {
  background: var(--accent-dim);
  transition-delay: 250ms;
}
/* No border-left here: the session panel draws its own right hairline and the
   splitter sits between them. */
.session-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
