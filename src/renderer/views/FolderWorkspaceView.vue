<script setup lang="ts">
// FolderWorkspaceView: everything scoped to ONE project FOLDER, rendered in
// the host workspace's right pane. It replaces SessionWorkspaceView, which was
// scoped to one session.
//
// The tab bar is the whole idea:
//
//   [ main ] [ import ] [ main 2 ] [ Files ] [+]
//
// one tab per tmux session in the folder, then one or more Files tabs, session
// tabs first. A session tab IS a terminal — there is no sub-navigation inside
// one, because the Conversation view that used to compete for that space has
// been deleted.
//
// Four structural notes, three of them inherited from the view this replaces
// because the reasons have not changed:
//
//   - ONE TerminalView PER SESSION TAB the user has visited, all of them left
//     mounted, only the active one shown. Main keeps a tmux client per session
//     and holds it for the life of the tab (src/main/ssh/TmuxClientPool.ts), so
//     each pane already holds its own session's screen and moving between tabs
//     is a `v-show` and nothing else — no SSH, no redraw, no bytes.
//
//     This is the reverse of what this file said until now, and the reason is
//     measured. One re-pointed TerminalView meant every tab click cost a
//     `tmux switch-client` exec plus a full-screen repaint over SSH: p50 210 ms
//     on the user's host when it worked, and it mostly did not, falling back to
//     a ~2 s re-join. A switch cannot be made to feel like changing tabs in an
//     editor, because an editor does not ask another machine for the tab.
//
//     Panes are mounted LAZILY — a tab gets its TerminalView the first time it
//     is selected, never before. Mounting one while hidden would have xterm's
//     FitAddon measure a 0x0 box and push its 2x1 minimum at the remote.
//   - The terminals stay mounted (`v-show`, not `v-if`) while a Files tab is
//     showing; unmounting one would close its SSH shell and drop the attach.
//   - Identity and tabs share ONE bar, for the 40px of window it gives back to
//     the pane.
//   - `.workspace-body` is the composer's stage: the card floats over the tab
//     content inside it rather than docking below, so no composer state can
//     change the terminal's row count.
//
// The composer is mounted ONCE, outside `.tab-body` and never behind a `v-if`,
// so a tab switch cannot cost a draft. It follows the ACTIVE SESSION TAB — its
// per-session record is keyed on the session name, so switching session tabs
// swaps the draft and switching back restores it.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../ipc';
import { registerWorkspaceFocus, unregisterWorkspaceFocus } from '../workspaceFocus';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { useProjectsStore } from '../stores/projects';
import { useFilesStore } from '../stores/files';
import { useComposerStore } from '../stores/composer';
import { useSettingsStore } from '../stores/settings';
import { useShellsStore } from '../stores/shells';
import AppIcon from '../components/AppIcon.vue';
import TerminalView from '../components/TerminalView.vue';
import PromptComposer from '../components/PromptComposer.vue';
import FilesView from './FilesView.vue';
import PopupMenu from '../components/PopupMenu.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import LaunchSessionDialog from '../components/LaunchSessionDialog.vue';
import { pointAnchor, type Box } from '../../shared/popupPlacement';
import type { ConnectionId } from '../../shared/types';
import { composerAgentKind } from '../../shared/composerSend';
import { agentMark } from '../../shared/agentBadge';
import { isShortcut } from '../../shared/shortcuts';
import { sanitisePart, sessionBaseName } from '../../shared/sessionNameParts';
import { adjacentIndex } from '../../shared/listNavigation';
import { editingTarget } from '../editingTarget';
import {
  buildWorkspaceTabs,
  applyTabOrder,
  canDropTabAt,
  pruneTabIds,
  pushMru,
  reorderTabs,
  renamedSessionName,
  tabAfterClose,
  type WorkspaceTab,
} from '../../shared/workspaceTabs';
import { rootHostPath } from '../sessionRoots';
import { sessionIdentityKey } from '../sessionIdentity';
import { UNTRACKED_PATH } from '../sessionGrouping';
import { useFolderTree } from '../folderTree';
import { parkedAgentLaunch, takeAgentLaunch } from '../pendingAgentLaunch';
import {
  readWorkspaceMemory,
  workspaceMemoryKey,
  writeLastFolder,
  writeWorkspaceMemory,
  type FilesTabRecord,
  type WorkspaceMemoryRecord,
} from '../workspaceState';
import {
  buildLaunchCommand,
  KIND_LABELS,
  launchBlocker,
  type LaunchChoice,
} from '../../shared/agentLaunch';
import { errorMessage } from '../../shared/errors';
import { useStripDrag } from '../useStripDrag';

const route = useRoute();
const connection = useConnectionStore();
const sessions = useSessionsStore();
const projects = useProjectsStore();
const files = useFilesStore();
const composer = useComposerStore();
const settings = useSettingsStore();
const shells = useShellsStore();
const { folders } = useFolderTree();

/**
 * Per-workspace UI state that must survive leaving and coming back: which
 * Files tabs are open, and which tab was selected.
 *
 * Module-scoped rather than a Pinia store, deliberately. It is view state with
 * exactly one reader — this component — and no action anywhere else in the app
 * needs to read or write it. A store would buy nothing but a file, and the
 * thing that genuinely IS shared (each Files tab's browsing position) already
 * lives in the files store, keyed by the tab id this map hands out.
 *
 * Keyed by the HOST ALIAS and the folder, so one host's tabs cannot appear on
 * another — and so an entry outlives a reconnect, which a connection-id key
 * cannot do: a re-dial mints a fresh connection id, but it is the same host
 * and the same tmux sessions, so the workspace should come back as it was. The
 * alias is also what the persisted copy in ../workspaceState keys on, which is
 * why a relaunch can find this map's contents on disk at all. It is never
 * pruned: an entry is two small strings, and the alternative is a teardown
 * hook that has to guess when a workspace will not be revisited.
 *
 * The record's shape — what a Files tab carries, why the MRU is a stack — is
 * documented with `WorkspaceMemoryRecord` in ../workspaceState, which is the
 * same shape at a longer lifetime: `persist()` writes the map entry to
 * localStorage verbatim, and `remembered()` seeds a missing entry from it.
 */
type FilesTabState = FilesTabRecord;
type WorkspaceMemory = WorkspaceMemoryRecord;
const memory = new Map<string, WorkspaceMemory>();

/** The folder key from the route — `~/git/dtc-website`. */
const folderKey = computed(() => String(route.params['folder'] ?? ''));

/** The host alias from the route — the stable identity the tab state keys on. */
const hostAlias = computed(() => String(route.params['name'] ?? ''));

const memoryKey = computed(() => `${hostAlias.value}/${folderKey.value}`);

function remembered(): WorkspaceMemory {
  const existing = memory.get(memoryKey.value);
  if (existing) return existing;
  // Nothing in memory for this workspace — its first visit in this window.
  // What a previous window persisted seeds it, so a relaunch opens the folder
  // with the tabs it closed with; a first visit ever finds nothing on disk
  // and starts bare.
  const restored = readWorkspaceMemory(workspaceMemoryKey(hostAlias.value, folderKey.value));
  // No Files tab to start with. A workspace opens showing its sessions, and a
  // Files tab appears only when something asks for one: "New Files tab" on the
  // `+` menu, "open in a new tab" from the file tree, or a path clicked in the
  // terminal — the reveal watcher below opens one when none is standing.
  const fresh: WorkspaceMemory = restored ?? { filesTabs: [], activeTab: null, mru: [] };
  memory.set(memoryKey.value, fresh);
  return fresh;
}

const filesTabs = ref<FilesTabState[]>([]);
/** Which tab id is selected. Null means "the first one", resolved on read. */
const selected = ref<string | null>(null);
/** Selection history for {@link selectAfterClose}. See {@link WorkspaceMemory.mru}. */
const mru = ref<string[]>([]);

// ---------------------------------------------------------------------------
// The manual tab order, and where it lives
// ---------------------------------------------------------------------------

/**
 * `localStorage` key for one folder's hand-arranged tab order.
 *
 * Two decisions in one string.
 *
 * **`localStorage`, not the settings store**, following the precedent the
 * session panel's width and the file tree's width already set: the settings
 * store is for preferences a user sets BY NAME in the Settings overlay, and an
 * arrangement you reach by dragging until it looks right is not one of those.
 * It is raw layout state, and raw layout state has been going here.
 *
 * **Keyed on the HOST ALIAS and the folder, never on the connection id.** A
 * connection id is an opaque handle minted per connect, so a key built from it
 * would be a fresh key on every launch and the order would never survive a
 * restart — and even within one window a re-dial mints a new id, which would
 * orphan the arrangement. The route's `:name` is the `~/.ssh/config` alias,
 * which is exactly as stable as the folder path beside it; the workspace's own
 * memory map and its persisted copy key on the same alias for the same reason.
 * Same reasoning as the port panel's preference keys, which key on the alias
 * too.
 */
function tabOrderKey(): string {
  return `ps.tabOrder.${String(route.params['name'] ?? '')}.${folderKey.value}`;
}

/**
 * The stored order for this workspace, or `[]` when the user has arranged
 * nothing.
 *
 * Empty is a real and common answer, not a missing one: it means "use the
 * derived order", which is what `applyTabOrder` does with it.
 */
const tabOrder = ref<string[]>([]);

function loadTabOrder(): void {
  tabOrder.value = readTabOrder(tabOrderKey());
}

function readTabOrder(key: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    // Validated rather than trusted. This is user-writable JSON on disk, and a
    // non-array (or an array of objects) would otherwise reach `applyTabOrder`
    // and rank tabs by whatever `Map` made of it.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

function writeTabOrder(next: string[]): void {
  tabOrder.value = next;
  if (typeof localStorage === 'undefined') return;
  try {
    // An empty order is REMOVED rather than stored as `[]`. "The user has
    // arranged nothing" and "there is no entry" are the same state, and keeping
    // one spelling of it means a workspace whose tabs were all closed does not
    // leave a key behind forever.
    if (next.length === 0) localStorage.removeItem(tabOrderKey());
    else localStorage.setItem(tabOrderKey(), JSON.stringify(next));
  } catch {
    // Quota, or a locked profile. Losing a tab arrangement on restart beats
    // throwing out of a drop handler.
  }
}

/**
 * The folder node this workspace is showing, out of the same grouping the
 * panel renders.
 *
 * Read from the same projection as the session panel rather than filtering
 * sessions on `path`. The shared projection is where `~/git/foo` and
 * `/home/me/git/foo` are folded into one key, where a session with no cwd
 * becomes a folder of its own, and where a sibling-inferred path has already
 * been applied. Keeping one computed list for both surfaces prevents the
 * panel from showing a folder whose workspace has a different set of tabs.
 */
const folder = computed(() => {
  return folders.value.find((dir) => dir.key === folderKey.value) ?? null;
});

/** The folder's real path, or null for an untracked session's pseudo-folder. */
const folderPath = computed(() => {
  const path = folder.value?.path ?? folderKey.value;
  return path === UNTRACKED_PATH ? null : path;
});

/**
 * The prefix the tab labels strip.
 *
 * `sessionBaseName` is the SAME function the main process derives a new
 * session's name with — that is why it was moved into `shared/`. Deriving the
 * prefix any other way (the sessions' literal common prefix, say) would make
 * the labels depend on which sessions happen to be running rather than on the
 * folder, and would relabel a session that was never named after this folder
 * at all.
 *
 * The key is home-relative (`~/git/foo`), so it is expanded before derivation
 * when `$HOME` is known. When it is not, `sessionBaseName` handles the `~/`
 * form directly and produces the same answer for everything under home — the
 * one case it gets wrong without `$HOME` is the home directory ITSELF, whose
 * real name is `home-<basename>`.
 */
const prefix = computed(() => {
  const key = folderKey.value;
  const home = projects.home;
  if (home && key === '~') return sessionBaseName(home, home);
  if (home && key.startsWith('~/')) return sessionBaseName(`${home}/${key.slice(2)}`, home);
  return sessionBaseName(key, home);
});

const tabs = computed<WorkspaceTab[]>(() =>
  // Derived first, then the user's own arrangement on top. The order of the two
  // steps IS the resolution of the two instructions: §3.2's automatic order is
  // what a tab gets until the user moves it, and a manual position wins once
  // there is one.
  applyTabOrder(
    buildWorkspaceTabs(
      (folder.value?.rows ?? []).map((row) => ({
        name: row.session.name,
        created: row.session.created,
      })),
      prefix.value,
      // `path: null` means "this tab was never given a seed", which resolves
      // to the folder.
      filesTabs.value.map((tab) => ({ id: tab.id, path: tab.path ?? folderPath.value })),
    ),
    tabOrder.value,
  ),
);

/** The selected tab, falling back to the first one the bar has. */
const activeTab = computed<WorkspaceTab | null>(() => {
  const found = tabs.value.find((tab) => tab.id === selected.value);
  return found ?? tabs.value[0] ?? null;
});

/** The session the composer and the terminal are pointed at, if any. */
const activeSession = computed(() =>
  activeTab.value?.kind === 'session' ? activeTab.value.session : null,
);

/**
 * A session tab's tooltip.
 *
 * It names the session, and — when the session is not standing in the folder
 * the tab is filed under — it names where it IS. That second line exists
 * because grouping and location came apart deliberately
 *: a git worktree files under its repository, so a tab
 * under `dtc-website` may be running in `~/git/merry-sniffing-token`. Without
 * the line the user would open Files expecting the worktree and get the main
 * checkout, with nothing on screen to explain the difference.
 */
function sessionTabTitle(session: string): string {
  const row = sessions.sessions.find((s) => s.name === session);
  const lines = [session];
  const mark = agentMark(row?.agentKind);
  // The agent is named here as well as on the mark's own `<title>`, because the
  // marks are arbitrary (src/shared/agentBadge.ts) and this is the tooltip a
  // user actually lands on — the icon is 12px and hovering it precisely is not
  // a thing to require of anyone.
  if (mark) lines.push(mark.label);
  const path = row?.path ?? null;
  if (path && path !== folderPath.value) lines.push(`running in ${path}`);
  if (row?.pathInferred) lines.push('folder inferred from the session name, not reported by tmux');
  lines.push('double-click to rename, right-click for more');
  return lines.join('\n');
}

/**
 * The mark a session tab wears, or null for a shell and for the common,
 * legitimate `unknown`.
 *
 * Looked up from the session store per tab rather than carried on the
 * `WorkspaceTab`. The tab model is the LAYOUT of the bar — what is called what,
 * in what order — and it is pure and unit-tested as such; the agent kind is a
 * live fact that the refresh timer changes underneath it, so folding it in
 * would make `buildWorkspaceTabs` recompute the whole bar every time a badge
 * moved.
 */
function tabMark(session: string): ReturnType<typeof agentMark> {
  return agentMark(sessions.sessions.find((s) => s.name === session)?.agentKind);
}

/** The session tab that is (or was last) showing — which pane is visible. */
const terminalSession = ref<string | null>(null);
/**
 * Every session tab that has been visited, one mounted TerminalView each, for
 * as long as this workspace is open.
 *
 * A record rather than a bare name, and the reason is the RENAME. A pane's Vue
 * key has to survive its session getting a new name: a tab's id IS the session
 * name, so a name-keyed v-for reads a committed rename as "one pane gone,
 * another appeared" — unmounting the old TerminalView (closing its SSH shell)
 * and mounting a fresh one that pays a full re-join, which is the reconnect a
 * rename used to cost. The record's `id` is minted when the pane is opened and
 * never changes; `session` is the name the pane is pointed at RIGHT NOW, and a
 * rename rewrites it in place, so the diff keeps the instance and only the
 * props move — and the pool, which the rename re-keyed on the host side,
 * answers the re-point with the SAME PTY and no host work at all.
 *
 * Append-only on purpose. A pane is added the first time its session is
 * selected and is never removed while the workspace lives, because removing it
 * is precisely the cost this design exists to avoid: unmounting closes the SSH
 * shell, and coming back would pay a full `tmuxctl` join (1.5-2 s on the
 * user's host). The list is bounded by the session tabs of ONE folder, and
 * main bounds the channels underneath it independently — the pool evicts its
 * least recently used client when a connection runs out of SSH channels, and a
 * pane whose shell was evicted re-joins itself when it is next looked at.
 *
 * A session that disappears from the tab bar keeps its record here and simply
 * renders nothing, since `sessionPanes` filters against the live tabs — the
 * one removal that DOES happen is the kill, which drops the record by hand so
 * a new session reusing the name cannot inherit a pane that was never torn
 * down.
 */
interface SessionPane {
  /** Stable for the pane's life; the v-for key. Never the session name. */
  id: string;
  /** The session this pane is currently pointed at. A rename rewrites this. */
  session: string;
}
const openPanes = ref<SessionPane[]>([]);
let nextPaneId = 1;
watch(
  activeSession,
  (name) => {
    if (!name) return;
    terminalSession.value = name;
    if (!openPanes.value.some((pane) => pane.session === name)) {
      openPanes.value.push({ id: `pane-${nextPaneId++}`, session: name });
    }
  },
  { immediate: true },
);

/**
 * The session tabs that currently have a mounted pane, in visit order.
 *
 * The panes are filtered against the live tabs rather than trusted, so a
 * session that was killed on the host stops rendering the moment it leaves the
 * bar, while a RENAME keeps the pane rendering straight through: the row and
 * the pane record are rewritten in the same tick, so from the filter's point of
 * view the pane's session never stopped being on the bar.
 */
const sessionPanes = computed(() =>
  openPanes.value.filter((pane) =>
    tabs.value.some((tab) => tab.kind === 'session' && tab.session === pane.session),
  ),
);

const summary = computed(() => {
  // This folder's row first: a same-named tag in another folder must not lend
  // this workspace its agent badge. The global lookup is the fallback for a
  // tab whose row already left the listing.
  const local = (folder.value?.rows ?? []).find((row) => row.session.name === terminalSession.value);
  if (local) return local.session;
  return sessions.sessions.find((s) => s.name === terminalSession.value) ?? null;
});

/** This folder's address for the active session tab, for the composer's identity props. */
const activeSessionMeta = computed(() =>
  activeSession.value ? sessionMeta.value.get(activeSession.value) : undefined,
);

/**
 * What the pool needs to address each of this folder's sessions, by name.
 *
 * Tabs are keyed by session name and names are unique within a folder, so a
 * name lookup is exact here. The backend decides the join the pane opens
 * (tmux vs `a attach`) and the key the pool holds the client under; the
 * workspace and id address an aplexer tag, which repeats across workspaces.
 * Read from the folder's own rows — the same projection the tabs are built
 * from — so the two cannot disagree about what a tab names.
 */
const sessionMeta = computed(() => {
  const meta = new Map<
    string,
    { backend: 'tmux' | 'aplexer'; workspace: string | null; aplexerId: string | null }
  >();
  for (const row of folder.value?.rows ?? []) {
    const s = row.session;
    meta.set(s.name, {
      backend: s.backend ?? 'tmux',
      workspace: s.workspace ?? null,
      aplexerId: s.aplexerId ?? null,
    });
  }
  return meta;
});

/**
 * The aplexer ref a kill/rename carries for [name], or undefined for a tmux
 * row. Undefined is not "unknown" — it is the tmux address, which is the bare
 * name — so callers pass the result straight through.
 */
function aplexerRefFor(
  name: string,
): { backend: 'tmux' | 'aplexer'; workspace?: string; aplexerId?: string } | undefined {
  const m = sessionMeta.value.get(name);
  if (!m || m.backend !== 'aplexer') return undefined;
  return {
    backend: 'aplexer',
    ...(m.workspace ? { workspace: m.workspace } : {}),
    ...(m.aplexerId ? { aplexerId: m.aplexerId } : {}),
  };
}

/**
 * The registry identity for [name] — the key the shells map and the composer
 * store file it under.
 *
 * Resolved through this folder's rows, so an aplexer tag carries its
 * workspace and same-named tags in other folders do not collide. [like] names
 * the row to resolve through when [name] itself is not on the bar yet (the
 * target of a rename); otherwise the name resolves through its own row. A
 * name with no row falls back to itself — the tmux identity — which is the
 * only answer available for a tab whose session already left the listing.
 */
function identityFor(name: string, like?: string): string {
  const m = sessionMeta.value.get(like ?? name);
  return sessionIdentityKey(name, { backend: m?.backend, workspace: m?.workspace ?? undefined });
}

/**
 * The engine recorded host-side for the active session, narrowed to what the
 * composer can route to. An agent session gets the slash-command catalog, a
 * shell never does (docs/COMPOSER.md §18).
 */
const agentKind = computed(() => composerAgentKind(summary.value?.agentKind));

/**
 * Load this folder's remembered tabs into the live refs.
 *
 * Called from `onMounted` AND from a watch on the folder key, because
 * vue-router REUSES this component instance when only the `:folder` param
 * changes — `onMounted` does not fire on a folder-to-folder navigation, and
 * without the watch the second folder would inherit the first one's Files tabs
 * and selection.
 */
function loadFolderState(): void {
  const state = remembered();
  // BEFORE the refs the tab list is derived from, so `tabs` is never computed
  // once with this folder's sessions and the previous folder's arrangement.
  loadTabOrder();
  filesTabs.value = state.filesTabs;
  selected.value = (route.query['tab'] as string | undefined) ?? state.activeTab;
  mru.value = state.mru;
  // Seed the stack with the tab that is actually in front, which the watcher
  // below cannot do for us: on entry `activeTab` resolves without ever
  // CHANGING, so nothing would record the tab the user landed on — and the
  // first close would then find an empty stack and fall through to adjacency,
  // which is the behaviour the MRU exists to replace. Read after the three
  // assignments above, so the computed answers with this folder's state.
  const active = activeTab.value?.id ?? null;
  if (active !== null) mru.value = pushMru(mru.value, active);
  persist();
  // Every arrival at a folder is "take me to this workspace" — a row click in
  // the panel, a `Ctrl+↑`/`Ctrl+↓` step, the session panel's `?tab=` hand-off,
  // the first open from the empty state — and each one used to land with the
  // keyboard wherever it had been, which is the same defect a tab click had
  // (bc86cf7): the first keystrokes went nowhere the user was looking. So the
  // keyboard goes to the pane in front. At a cold mount the bar is still empty
  // and this no-ops — `focusActiveTab` finds no tab rather than trusting the
  // first-tab fallback, so a boot restore never grabs focus on a guess.
  void focusActiveTab();
}

/**
 * Write the tab state back.
 *
 * Called explicitly by the four things that change it rather than from a watch
 * on the refs. A watch would fire during a folder switch, between the key
 * changing and the refs being reloaded, and would stamp the OUTGOING folder's
 * tabs onto the incoming folder's memory entry.
 *
 * The record goes two places at once: the in-memory map, for the rest of this
 * window, and `localStorage`, for the next one — the same object, so the two
 * copies cannot disagree. `writeLastFolder` beside it is what lets a
 * relaunched app navigate here at all: without it a workspace would restore
 * faithfully but nothing would know to open it.
 */
function persist(): void {
  const record: WorkspaceMemory = {
    filesTabs: filesTabs.value.map((tab) => ({ ...tab })),
    activeTab: selected.value,
    mru: [...mru.value],
  };
  memory.set(memoryKey.value, record);
  writeWorkspaceMemory(workspaceMemoryKey(hostAlias.value, folderKey.value), record);
  writeLastFolder(hostAlias.value, folderKey.value);
}

/**
 * The MRU is fed from the RESOLVED active tab, not from the click handlers.
 *
 * There are six routes that change which tab is in front — a click, the two
 * chord families, creating a session, committing a rename, and closing a tab —
 * and a seventh that changes it without anyone asking: `activeTab` falls back
 * to the first tab whenever `selected` names a tab that is not on the bar, which
 * is what happens when the active session is killed from somewhere else. A push
 * per route would have to cover all seven and would silently miss the eighth.
 *
 * Watching the answer instead of the requests covers every one of them by
 * construction, and it records what the user is actually LOOKING at, which is
 * the only thing "most recently used" can honestly mean.
 *
 * Deliberately NOT `immediate`. An immediate run would fire during `setup`,
 * before `loadFolderState` has restored anything, and its `persist()` would
 * stamp the empty `filesTabs` of a component that has not loaded yet over the
 * memory entry it is about to read. {@link loadFolderState} seeds the stack
 * itself instead, at the point where every input to it is already correct.
 */
watch(
  () => activeTab.value?.id ?? null,
  (id) => {
    if (id === null) return;
    // Already on top is the overwhelmingly common case; bailing keeps this from
    // rewriting the memory map on every reactive tick.
    if (mru.value[mru.value.length - 1] === id) return;
    mru.value = pushMru(mru.value, id);
    persist();
  },
);

/**
 * Keep the MRU honest against the bar as it actually is.
 *
 * The stack must never be able to name a tab that is gone — the brief's own
 * words, and the reason is sharper than "it would point at nothing": a session
 * tab's id IS its tmux session name, and `sessions create` derives that name
 * from the folder, so a killed session's name is very likely to come back
 * attached to a DIFFERENT session. A stale entry would then resurrect as a
 * live-looking target.
 *
 * Driven by the tabs rather than by the close handlers, because a tab can leave
 * the bar without anything here closing it: killed from the user's own
 * terminal, killed from the phone, or the host restarted. Watching the tabs
 * covers every one of those with one rule instead of enumerating them.
 */
watch(tabs, (list) => {
  // Guarded on the HOST's session list having arrived, not on the bar being
  // non-empty — and guarding BOTH stored lists now. A workspace whose sessions
  // have not loaded yet — a deep link, a reload, and since the tabs persist, a
  // relaunch, where the bar can hold its Files tabs alone for the first round
  // trip — would have every session id pruned as dead before the session list
  // that proves them alive ever landed. That was a harmless scratch when the
  // MRU lived only in memory; persisted, it would be a wipe ON DISK. So the
  // guard the manual order already carried now stands over the stack too.
  if (sessions.sessions.length === 0) return;
  const pruned = pruneTabIds(mru.value, list);
  if (pruned.length !== mru.value.length) {
    mru.value = pruned;
    persist();
  }
  // The manual order needs the identical treatment, and for a sharper reason
  // than the MRU: a stored id that no longer names a tab is inert TODAY, but a
  // session killed and re-created keeps its name (`sessions create` derives it
  // from the folder), so an unpruned entry would silently re-pin a brand new
  // session to the dead one's old position. Same rule, same function, one
  // definition of "this id has died".
  const keptOrder = pruneTabIds(tabOrder.value, list);
  if (keptOrder.length !== tabOrder.value.length) writeTabOrder(keptOrder);
});

onMounted(async () => {
  loadFolderState();
  // Deep-linking straight to a folder (or a reload) can leave the stores empty,
  // and BOTH matter here: without the session list there are no tabs at all,
  // and without `$HOME` the label prefix is derived from the `~/` form.
  if (connection.connectionId) {
    if (!sessions.sessions.length) await sessions.refresh(connection.connectionId);
    await projects.ensureHome(connection.connectionId);
  }
});

watch(folderKey, () => {
  cancelRename();
  addAnchor.value = null;
  createError.value = null;
  // The dialog is bound to the OUTGOING folder's path; leaving it open would
  // let a confirm create a session in the folder we just left.
  launching.value = false;
  // A launch armed for the folder we are leaving must not fire a message into
  // the folder we are arriving at.
  pendingLaunch.value = null;
  clearLaunchTimer();
  loadFolderState();
});

/**
 * This folder's root as an ABSOLUTE host path, or null when there is not one to
 * be had.
 *
 * `rootHostPath` is the grouping's own inverse of `directoryKey`, reused rather
 * than re-derived: `~/git/foo` and `/home/alexey/git/foo` are one directory
 * everywhere else in the app precisely because that function decides it, and a
 * second expansion written here is how the two spellings drift apart again.
 *
 * Null has two causes and one meaning. The host's `$HOME` may not be resolved
 * yet (`projects.ensureHome` is asked for it on mount but a workspace opened by
 * deep link renders first), and the untracked pseudo-folder has no path at all.
 * Either way: no root, so nothing can be shown to be outside it.
 */
const rootPath = computed(() => rootHostPath(folderPath.value ?? folderKey.value, projects.home));

/**
 * A reveal target as an absolute host path, or null when it cannot be made one.
 *
 * What `requestReveal` parks is what SFTP needs — either absolute, or relative
 * to the LOGIN HOME, because an SFTP session's relative root is that home. That
 * is why a `~/…` path printed by an agent opens correctly without anyone
 * expanding `$HOME` (see `resolveRemotePath`/`stripTilde` in stores/files.ts),
 * and it is why this function exists only for the COMPARISON below: telling
 * inside-the-folder from outside is the one job that does need the home spelled
 * out. When the host has not reported one, there is no comparison to make.
 */
function absoluteRevealTarget(target: string): string | null {
  if (target.startsWith('/')) return target;
  const home = projects.home;
  if (!home) return null;
  const base = home.replace(/\/+$/, '');
  return target === '.' ? base : `${base}/${target}`;
}

/** Is [abs] the directory [root] itself, or something under it? */
function isUnder(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(`${root}/`);
}

/**
 * A path clicked in the terminal brings a Files tab forward.
 *
 * The store only PARKS the request; FilesView takes it in its own onMounted,
 * after `files.open()` has restored the remembered directory. Whichever Files
 * tab is already selected takes it, and when none is, the first one does —
 * revealing into the tab the user last used beats opening a new one for every
 * click.
 */
watch(
  () => files.reveal,
  (target) => {
    if (target == null) return;
    if (openDedicatedRevealTab(target)) return;
    if (activeTab.value?.kind === 'files') return;
    const first = tabs.value.find((tab) => tab.kind === 'files');
    if (first) {
      selected.value = first.id;
      persist();
      return;
    }
    // Every Files tab is closable now, so "the first one" can be NONE of
    // them — and the click must still land somewhere. `onOpenInNewTab` is
    // already written to open a tab and hand it the reveal, ordering and
    // all; this branch is why that helper, not `addFilesTab`, is the call.
    onOpenInNewTab(target, 'file');
  },
);

/**
 * A path OUTSIDE this folder gets a Files tab of its own. Returns true when it
 * took one.
 *
 * The user's report is the whole specification: "also note that this image is
 * outside of the current repo. I still want to see it. we can open it in a
 * separate new tab."
 *
 * Nothing ever stopped it OPENING. The files store browses by absolute path
 * over SFTP and has no notion of a root — `revealPath` realpaths, stats and
 * `goTo`s anywhere on the host. What it did was open it in the FOLDER's own
 * Files tab, and because §3.5 gives every Files tab its own remembered
 * directory, that tab then stayed re-rooted in `~/.codex/generated_images/…`
 * the next time it was opened. Which is the complaint underneath the request.
 *
 * The tab is seeded at the target's PARENT rather than the target, which is
 * `onOpenInNewTab`'s answer to the same question and works for either kind:
 * a parent always lists, and `revealPath` then either opens the file in it or,
 * for a directory, walks the listing on into the directory itself.
 */
function openDedicatedRevealTab(target: string): boolean {
  const root = rootPath.value;
  const abs = absoluteRevealTarget(target);
  // Not knowing where the root is, or where the target is, is not evidence that
  // they are apart. Falling back leaves the click doing what it did before
  // rather than spraying tabs at a host whose `$HOME` never resolved.
  if (root === null || abs === null) return false;
  if (isUnder(abs, root)) return false;

  const active = activeTab.value;
  // A tab already standing over this directory serves the next click in it too.
  // A folder of generated images gets looked at more than once and "a separate
  // new tab" did not mean one tab per image. It is also what stops the re-park
  // below from re-entering this branch.
  if (active?.kind === 'files' && active.path != null && isUnder(abs, active.path)) return false;

  // The order is `onOpenInNewTab`'s, for its reason: the new tab has to BE the
  // selected one before the request is parked, so that the FilesView which
  // mounts into it is the one that takes it. Re-parking cannot corrupt the
  // path — `resolveRemotePath` is idempotent on its own output, returning an
  // absolute path untouched and leaving a home-relative one alone when there is
  // no base to join it to.
  files.takeReveal();
  addFilesTab(abs.slice(0, abs.lastIndexOf('/')) || '/');
  files.requestReveal(target);
  return true;
}

/** A click selects. The rename gesture is the tab's double-click (template). */
function selectTab(tab: WorkspaceTab): void {
  goToTab(tab.id);
}

/**
 * Make [id] the visible tab and put the keyboard in it.
 *
 * The ONE selection path. A click reaches it through {@link selectTab}, and the
 * tab chords reach it directly, so a chord cannot end up doing something subtly
 * different from a click — which is the specific way the two would drift, since
 * focus is the half that is easy to forget.
 */
function goToTab(id: string): void {
  if (id === activeTab.value?.id) return;
  selected.value = id;
  persist();
  void focusActiveTab();
}

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
  if (renaming.value !== null) return;
  startDrag(tab.id, e);
}

function onTabDragOver(index: number, e: DragEvent): void {
  const from = dragging.value;
  if (from === null) return;
  const gap = gapFor(index, e);
  // REFUSED VISIBLY, not accepted and snapped back. A drag that appears to
  // cross the session/files boundary and then undoes itself reads as a bug; a
  // drag that shows no indicator and a `no-drop` cursor reads as a rule.
  if (!canDropTabAt(tabs.value, from, gap)) {
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
  const next = reorderTabs(tabs.value, from, gap);
  // Null for a no-op — a drag that ended where it started, which is most
  // cancelled drags — and writing then would persist an order for nothing.
  if (next) writeTabOrder(next);
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

// ---------------------------------------------------------------------------
// Tab chords
// ---------------------------------------------------------------------------

/**
 * `Ctrl+[` / `Ctrl+]` to step one tab left or right.
 *
 * ## Why this is a WINDOW listener and not the terminal's key handler
 *
 * The chord has to work with focus in the terminal, the Files tree or the
 * composer, and those are three different keyboard owners: xterm consults its
 * own custom handler, CodeMirror runs a keymap, and the composer's textarea is
 * an ordinary field. Routing the chord through each of them would be three
 * implementations of one gesture — and the third one added later would be the
 * one that forgot to `preventDefault`.
 *
 * A `keydown` in CAPTURE on `window` runs before ANY of them, whatever holds
 * focus, because capture descends from the window to the target. So there is
 * one handler and it cannot be reached around. It is the same shape the
 * composer's own `Ctrl+\`` uses (PromptComposer's `onGlobalKey`), deliberately.
 *
 * ## `preventDefault` AND `stopPropagation`, and why both are load-bearing
 *
 * `stopPropagation` is what stops the event ever reaching xterm's textarea, so
 * xterm never gets to encode it. `preventDefault` is what stops CHROMIUM acting
 * on it — Electron still has a browser underneath. Leaving either off is the
 * defect that has now landed three times in this app (bc86cf7's doubled first
 * letter, 3628090's doubled paste, and the Ctrl+V route after them): one
 * keystroke, two paths.
 *
 * ## The terminal is NOT a safe place to let this fall through
 *
 * The brief's premise was that a tab chord is affordable "because terminals
 * cannot encode it". Measured against the xterm this app ships (@xterm/xterm 6,
 * `evaluateKeyboardEvent`), that is not true for THIS chord either, which is why
 * TerminalView also declines it: **`Ctrl+[` is C0.ESC (`0x1B`)** — THE physical
 * escape of older keyboards and readline's meta-prefix — **and `Ctrl+]` is
 * C0.GS**. That is a real cost, in vim sessions most of all, and it is stated
 * rather than assumed; meta sequences remain reachable through Alt.
 *
 * ## What went, and what came back with it
 *
 * `Ctrl+1`..`Ctrl+9` (jump to the Nth tab), `Ctrl+Shift+PageUp`/`PageDown`
 * (move the active tab) and the CYCLE — `Ctrl+Tab` / `Ctrl+Shift+Tab` — were
 * removed at the user's request: "remove ctrl 1 2 3 hotkey", "Move the active
 * tab left or right remove this too", "remove these hotkeys let's keep only
 * ctrl left and ctrl right".
 *
 * Removing them GIVES KEYS BACK to the pane, which is the part worth writing
 * down: `Ctrl+3`..`Ctrl+8` are the C0 controls `ESC`, `FS`, `GS`, `RS`, `US`
 * and `DEL` (`Ctrl+3` is a widely used stand-in for Escape);
 * `Ctrl+Shift+PageUp`/`PageDown` reach xterm's own scrollback; and `Ctrl+Tab`
 * is C0.HT — completion at a shell prompt, since xterm ignores Ctrl on Tab —
 * while `Ctrl+Shift+Tab` is ESC [ Z, back-tab. All of them were being
 * swallowed for chords that no longer exist, so the declines in TerminalView
 * went with them (`nextWorkspaceTabId` went with the cycle).
 *
 * Moving a tab from the keyboard went with the chord. The drag
 * is unaffected and is still the way to reorder.
 *
 * ## What it deliberately does not touch
 *
 * Anything with Alt or Meta. `Ctrl+Alt` is how AltGr arrives on European
 * layouts, where `[` and `]` carry printable characters on several of them —
 * the same reason TerminalView's Ctrl+V branch demands `!e.altKey`. And a
 * rename in progress owns the keyboard: the field is a one-word edit with
 * Enter/Escape of its own, and stepping out of it would leave an orphaned edit
 * on a tab the user can no longer see.
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey) return;
  if (renaming.value !== null) return;

  // The chord is DATA (src/shared/shortcuts.ts). This copy and the decline
  // branch in TerminalView's `onCustomKey` are the two that would otherwise
  // drift; reading the same table is what keeps them saying the same thing.
  const bindings = settings.shortcutBindings;

  // The old hand-spelled `if (e.shiftKey) return;` went with the inline chords:
  // it was a stand-in for "these are all Shift-free", which is now each chord's
  // own business in the registry. Keeping it would silently refuse any rebinding
  // that wears Shift.

  // `Ctrl+[` / `Ctrl+]`: the tab to the left, the tab to the right.
  //
  // First carried by `Ctrl+←`/`Ctrl+→`, moved here at the user's word —
  // "ctrl+left and right conflicts with jumping over words". The original ask
  // stands underneath: step left / step right within THIS workspace, while
  // `Ctrl+↑`/`Ctrl+↓` walks workspaces, which `HostWorkspaceView` owns. The
  // horizontal axis is the tab bar and the vertical one is the panel down the
  // side, which is where those two things actually sit on screen.
  //
  // THEY CLAMP, and that is deliberate (see `adjacentIndex`). A direction, not
  // a cycle: landing at the opposite end of the bar is not what "further left"
  // asks for.
  //
  // WHAT IT COSTS is stated rather than assumed: `Ctrl+[` is Escape at a shell
  // prompt and `Ctrl+]` is GS (see the registry note). Vim users lose the
  // bracket escape inside panes of this workspace; meta chords keep working
  // through Alt.
  //
  // Still not in a real text field — see `editingTarget`. No editing gesture
  // rides these keys, but prose being typed should not be interrupted by
  // navigation either. The direction reads off `e.key`: which HALF of the pair
  // fired, and only the registry knows that pair exists.
  if (isShortcut(bindings, 'tabs.stepLeftRight', e)) {
    if (editingTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const index = adjacentIndex(
      tabs.value.length,
      tabs.value.findIndex((t) => t.id === activeTab.value?.id),
      e.key === ']' ? 1 : -1,
    );
    const target = index === null ? null : (tabs.value[index]?.id ?? null);
    if (target !== null) goToTab(target);
  }
}


onMounted(() => window.addEventListener('keydown', onWindowKeydown, { capture: true }));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, { capture: true }));

/**
 * Put the keyboard where the user just looked.
 *
 * Clicking a tab left focus on the tab BUTTON, so the first keystroke went to
 * the button and the user had to click a second time, into the pane, before
 * typing worked. That is the same defect bc86cf7 fixed for the composer, whose
 * comment says it plainly: without it "the feature would have looked broken
 * from the first try". It matters more here because `typingOpensComposer`
 * means a keystroke in a focused terminal is supposed to OPEN the composer with
 * that character in it — a feature that simply never fires if the terminal was
 * not focused, which is exactly the case the user hits first.
 *
 * `nextTick` because the pane that should take focus may not be rendered yet:
 * a session tab visited for the first time is mounted by this very selection.
 *
 * A FILES tab hands focus to its own surface rather than to nothing, so arrow
 * keys work on the tree without a second click — but only through the same
 * ref-and-ask shape used for terminals, so there is ONE path here and the
 * hotkeys below cannot diverge from the click. The Files pane declines the
 * focus when an editor is open with unsaved content: moving the caret out of a
 * dirty buffer to a tree the user did not ask for would be worse than doing
 * nothing, and that judgement belongs to the pane that knows it is dirty.
 */
async function focusActiveTab(): Promise<void> {
  await nextTick();
  const tab = activeTab.value;
  if (!tab) return;
  if (tab.kind === 'session') {
    terminalRefs.get(tab.session)?.focus();
    return;
  }
  filesRef.value?.focus?.();
}

/**
 * The host workspace asks for this when the user clicks THIS folder's row in
 * the panel while already inside it: there is no navigation to arrive with
 * (same folder, same route), but the click is still "take me to this
 * workspace", so the keyboard lands the way a fresh arrival's does. Registered
 * for the mount's lifetime (workspaceFocus.ts) — the one channel the host may
 * use, and unmounting it must revoke. The wrapper is one function handed to
 * both ends so the slot can tell its own registration from any other, and it
 * stays `void`: the registry's contract is a synchronous ask.
 */
const requestFocus = (): void => {
  void focusActiveTab();
};
onMounted(() => registerWorkspaceFocus(requestFocus));
onBeforeUnmount(() => unregisterWorkspaceFocus(requestFocus));

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------
/** The tab being renamed, and the text in its field. */
const renaming = ref<{ id: string; session: string; remainder: string | null } | null>(null);
const renameText = ref('');
const renameError = ref<string | null>(null);

function beginRename(tab: WorkspaceTab): void {
  if (tab.kind !== 'session') return;
  renaming.value = { id: tab.id, session: tab.session, remainder: tab.remainder };
  // The field edits the LABEL, and for a derived name the label is the
  // remainder — so what is in the box is the part that is actually the user's
  // to change. A non-derived name has no prefix to re-apply, so it edits whole.
  renameText.value = tab.remainder ?? tab.session;
  renameError.value = null;
}

function cancelRename(): void {
  renaming.value = null;
  renameError.value = null;
}

/**
 * Strip illegal characters AS THE USER TYPES, with the same sanitiser the host
 * will apply. What is on screen is then what the session will be called, so a
 * rename never silently produces a different name from the one that was typed.
 */
function onRenameInput(event: Event): void {
  const el = event.target as HTMLInputElement;
  const cleaned = sanitisePart(el.value);
  if (cleaned !== el.value) el.value = cleaned;
  renameText.value = cleaned;
}

async function commitRename(): Promise<void> {
  const target = renaming.value;
  const connectionId = connection.connectionId;
  if (!target || !connectionId) return cancelRename();

  const next = renamedSessionName(renameText.value, prefix.value, target.remainder, sanitisePart);
  if (next === null) {
    renameError.value = 'that leaves nothing a session can be called';
    return;
  }
  if (next === target.session) return cancelRename();

  const aplexerRef = aplexerRefFor(target.session);
  const result = await projects.renameSession(connectionId, target.session, next, aplexerRef);
  if (!result.ok || !result.sessionName) {
    renameError.value = result.error ?? 'rename failed';
    return;
  }
  adoptRenamedSession(connectionId, target.session, result.sessionName, aplexerRef?.workspace);
  cancelRename();
  // Confirmation, not revelation: the row is already renamed locally (that is
  // what made the bar move on the tick above), so this runs fire-and-forget
  // purely to pull the authoritative row — activity, agentKind — and to fold
  // the rename into the list wholesale. Nothing waits on it.
  void sessions.refresh(connectionId);
}

/**
 * Move everything the desktop keeps under the session's old name to the new
 * one, in ONE synchronous tick.
 *
 * The pieces are moved together rather than left to the next `sessions.refresh`
 * because the pieces that make a rename feel like a relabel — the tab bar, the
 * mounted pane, the composer draft — are all keyed on the name, and a refresh
 * is seconds of the old name on screen followed by a pane the v-for no longer
 * recognises, which it tears down and re-joins. Done in one tick instead, the
 * flush after this function returns sees a fully consistent world: the pane
 * record and the row agree on the new name, the v-for key never changed, and
 * the TerminalView's own `sessionKey` watcher does the only thing left —
 * re-point at the new name, which the pool answers with the PTY it already
 * holds. That is the whole "a rename is just a label" trick.
 *
 * Selection follows only when it pointed HERE. The double-click gesture has
 * already selected the tab before the field opens, so the common rename keeps
 * its selection; a right-click rename of a background tab keeps it background —
 * committing a label is not a request to be moved.
 */
function adoptRenamedSession(
  connectionId: ConnectionId,
  from: string,
  to: string,
  workspace?: string,
): void {
  // The composer's per-session record is keyed on the session identity, so it
  // has to move or the draft is orphaned under a key nothing will ever ask
  // for again. Both ends resolve through the SAME row: this runs before the
  // local rename below, so the new key borrows the old row's workspace.
  composer.rekey(
    composer.targetKey(connectionId, from, identityFor(from)),
    composer.targetKey(connectionId, to, identityFor(to, from)),
  );
  // The row, so the tab bar, the panel tree and `sessionMeta` re-derive now.
  sessions.renameLocal(from, to, workspace);
  // The mounted pane keeps its instance — its v-for key is the record id, not
  // the name — and its TerminalView re-points itself off the prop change.
  const pane = openPanes.value.find((p) => p.session === from);
  if (pane) pane.session = to;
  // The pane refs are keyed by name for the same historical reason; move the
  // entry so focus and Redraw do not have to know a rename happened.
  const paneRef = terminalRefs.get(from);
  if (paneRef) {
    terminalRefs.delete(from);
    terminalRefs.set(to, paneRef);
  }
  if (selected.value === from) selected.value = to;
  if (terminalSession.value === from) terminalSession.value = to;
  // The persisted layout is a ranking of tab IDS, and a tab id is a session
  // name: remap rather than let the prune watcher read the old id as a death,
  // or the rename would silently drop the tab's manual position and MRU entry.
  if (mru.value.includes(from)) mru.value = mru.value.map((id) => (id === from ? to : id));
  if (tabOrder.value.includes(from)) {
    writeTabOrder(tabOrder.value.map((id) => (id === from ? to : id)));
  }
  persist();
}

// ---------------------------------------------------------------------------
// Creating a session in this folder
// ---------------------------------------------------------------------------
/**
 * True while the launch dialog is up.
 *
 * The `+` menu used to list the engines itself and start one on a single
 * click. It no longer can: a launch needs a directory, and it may want a
 * profile and a permissions answer, none of which fit in a menu row. So the
 * menu collapsed to "New session…" — the ellipsis is the usual promise that a
 * dialog follows — and "New Files tab", which STAYS a direct action because it
 * creates nothing on the host and has nothing to configure. Putting a free
 * action behind a dialog would make it feel expensive.
 *
 * The menu also used to offer Grok, which at the time could not have worked:
 * 0.4.44's `pocketshell agent` has no `grok` subcommand. That fact still
 * holds, but it is no longer a reason to leave Grok out — the dialog now asks
 * the HOST which subcommands its helper actually has and offers Grok only
 * where the answer says yes, explaining itself where it says no (see
 * `kindUnavailableReason` in shared/agentLaunch.ts). Which is the deeper
 * reason the engines belong behind the dialog rather than in this menu: the
 * answer is per-host and has to be fetched, and a menu row cannot wait for a
 * round trip or carry the sentence that comes back when it is no.
 */
const launching = ref(false);

function openLaunchDialog(): void {
  addAnchor.value = null;
  createError.value = null;
  launching.value = true;
}

/**
 * The `+` menu's anchor box, or null when it is shut.
 *
 * A measured rect rather than a boolean, because the menu is teleported out of
 * the tab strip and positioned `fixed`. It has to be: the strip scrolls
 * horizontally, which makes it clip vertically too, and the original
 * `position: absolute; top: 100%` dropdown was laid out exactly at that clip
 * edge — invisible, which is why the user reported that clicking `+` did
 * nothing. See src/shared/popupPlacement.ts for the measurement.
 */
const addAnchor = ref<Box | null>(null);
const addButtonEl = ref<HTMLElement | null>(null);
const createError = ref<string | null>(null);

/**
 * What the strip under the tab bar shows: the rename's refusal when there is
 * one, otherwise the create's.
 *
 * A refused rename used to surface only as a tooltip on the field and a 1px
 * border tint — a user who pressed Enter and got a host-side refusal saw a
 * field that just stayed there, subtly red, with nothing on screen saying why.
 * Worst on the `@blur` commit, where the field is not even focused any more,
 * so there was nothing to hover and nothing to read. A refused CREATE has been
 * a visible sentence in this strip all along ("a failed create is a sentence,
 * not a dialog" — see `.bar-error` below), and a refused rename is the same
 * shape of news about the same bar, so it borrows the strip rather than
 * growing a second one. The field keeps its `.invalid` tint — the strip says
 * WHY, the tint says WHERE.
 *
 * Rename wins when both are somehow set (a failed create left its sentence up
 * and the user then started a rename that also failed): the rename field is
 * the edit that is open NOW, so its complaint is the one the user can act on.
 */
const barError = computed(() => renameError.value ?? createError.value);

/**
 * Clear the strip by hand. Until now the sentence persisted until the next
 * action or a folder switch — tolerable for the short refusals, but the
 * launch-timeout remedy runs to three lines and otherwise sat there for the
 * life of the folder. Both sources are cleared, not just the one showing:
 * the button's promise is "make this strip go away", and leaving the other
 * message queued behind the first would have the strip survive its own
 * dismissal.
 */
function dismissBarError(): void {
  createError.value = null;
  renameError.value = null;
}

function toggleAddMenu(): void {
  if (addAnchor.value) {
    addAnchor.value = null;
    return;
  }
  const box = addButtonEl.value?.getBoundingClientRect();
  if (box) addAnchor.value = { left: box.left, top: box.top, width: box.width, height: box.height };
}

/**
 * A launch waiting for its session's PTY to exist.
 *
 * The desktop cannot set `@ps_agent_kind` — the helper's `pocketshell agent`
 * wrapper writes it in the process that BECOMES the agent.
 * So choosing an engine means starting a session and then running the wrapper
 * inside it, which cannot happen until the terminal has actually attached. The
 * watch below is that wait; it is one-shot, and a session whose PTY never comes
 * up simply gets a shell, which is what it would have been anyway.
 */
const pendingLaunch = ref<{
  session: string;
  backend: 'tmux' | 'aplexer';
  workspace: string | null;
  choice: LaunchChoice;
} | null>(null);
/** Cleared when the launch lands; fires if it never does. See below. */
let launchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long to wait for the new session's PTY before giving up on the launch.
 *
 * Generous, because this is a fresh SSH channel plus a login shell plus
 * `tmuxctl` (a Python program — ~250 ms of interpreter startup before it execs
 * `tmux attach`, per the measurements in src/shared/attachCommand.ts), and on a
 * real link the whole sequence has been observed at 1.5-2 s. Twelve seconds is
 * far beyond that, so expiring means something is actually wrong rather than
 * merely slow.
 */
const LAUNCH_TIMEOUT_MS = 12_000;

function clearLaunchTimer(): void {
  if (launchTimer !== null) clearTimeout(launchTimer);
  launchTimer = null;
}

watch(
  () =>
    pendingLaunch.value
      ? shells.shellIdFor(
          sessionIdentityKey(pendingLaunch.value.session, {
            backend: pendingLaunch.value.backend,
            workspace: pendingLaunch.value.workspace ?? undefined,
          }),
        )
      : null,
  (shellId) => {
    const pending = pendingLaunch.value;
    if (!pending || !shellId) return;
    pendingLaunch.value = null;
    clearLaunchTimer();
    // Through the wrapper, never the bare `claude`/`codex` binary: the wrapper
    // is what records the kind, and a session started around it shows up as
    // `unknown` forever.
    //
    // The line itself is built in shared/agentLaunch.ts against the captured
    // `--help`, never assembled here. It used to be a template string, and it
    // was WRONG — a bare `pocketshell agent claude` with no `--dir`, which the
    // helper rejects with exit 2 and a usage message, so the session came up as
    // a plain shell every single time.
    void api.shell.input(shellId, `${buildLaunchCommand(pending.choice)}\r`);
  },
);

/**
 * Arm the launch, and arm a deadline with it.
 *
 * The deadline is the whole point of this function existing rather than one
 * assignment. Before it, a launch whose PTY never came up did NOTHING, silently
 * and forever: the session existed, the tab appeared, and the engine the user
 * picked simply never started — with no message, because the only failure path
 * was a watcher that never fired. "I asked for Claude and got a shell" is not a
 * bug anyone can report usefully.
 *
 * The session itself is real either way, which is why this is a message and not
 * a rollback: the user has a working shell in the right folder and can start
 * the agent by hand. Telling them that is the entire remedy.
 */
function armLaunch(session: string, choice: LaunchChoice): void {
  clearLaunchTimer();
  const meta = sessionMeta.value.get(session);
  pendingLaunch.value = {
    session,
    backend: meta?.backend ?? 'tmux',
    workspace: meta?.workspace ?? null,
    choice,
  };
  launchTimer = setTimeout(() => {
    if (pendingLaunch.value?.session !== session) return;
    pendingLaunch.value = null;
    launchTimer = null;
    // The remedy is the EXACT line we would have typed, so the user can paste
    // it rather than reconstruct which flags their choices implied.
    createError.value =
      `Started "${session}", but its terminal did not come up in time, so ` +
      `${KIND_LABELS[choice.kind]} was not launched. The session is a plain shell - run ` +
      `\`${buildLaunchCommand(choice)}\` in it to start the agent.`;
  }, LAUNCH_TIMEOUT_MS);
}

onBeforeUnmount(clearLaunchTimer);

/**
 * Collect a launch the SESSION PANEL parked, and run it here.
 *
 * The panel can create a session but has no terminal to type into, so
 * NewSessionDialog parks the agent choice and the navigation it was already
 * making delivers it (docs/SESSIONLIST.md §13a). This is the other end. The
 * launch machinery below is NOT duplicated — the slot hands over a
 * `LaunchChoice` and `armLaunch` does exactly what it does for the `+`.
 *
 * Watching the SLOT rather than hooking a lifecycle, because two arrivals have
 * to be covered and only one of them is a mount: creating a session in the
 * folder that is already open re-uses this component instance and changes only
 * the route query, so neither `onMounted` nor the `folderKey` watch fires. A
 * reactive slot covers both with one watcher.
 *
 * Watching `tabs` with it is the guard that keeps the launch off the wrong
 * terminal: the session must actually be on this bar before the slot is taken.
 * A workspace the user merely passes through leaves the slot alone —
 * `takeAgentLaunch` only clears on a match — so the launch survives the trip.
 *
 * `immediate` because the panel files the created session as a pending row
 * BEFORE navigating, so the tab is usually already present at mount and
 * `tabs` may never change.
 */
watch(
  [parkedAgentLaunch, tabs],
  () => {
    const parked = parkedAgentLaunch.value;
    if (!parked) return;
    if (!tabs.value.some((tab) => tab.kind === 'session' && tab.session === parked.session)) return;
    // The workspace proves the launch is this folder's: a same-named tag in
    // another folder matches the tab above but must not steal the slot. Read
    // from this folder's own rows; unknown (a row that lost its backend info)
    // matches leniently rather than stranding the launch.
    const workspace = sessionMeta.value.get(parked.session)?.workspace ?? null;
    const choice = takeAgentLaunch(connection.connectionId, parked.session, Date.now(), workspace);
    if (!choice) return;
    // Through the one selection path, so arriving on a launched session leaves
    // the keyboard where a click would have — and the PTY the launch is
    // waiting for is the pane this mounts.
    goToTab(parked.session);
    armLaunch(parked.session, choice);
  },
  { immediate: true },
);

/**
 * A create in the folder that is ALREADY open changes only the route query.
 *
 * `onMounted` and the `folderKey` watch do not fire — the same route-reuse fact
 * the parked-launch watcher above works around — so the panel's hand-off,
 * `?tab=<session>`, selected nothing: the agent case has its own watcher, and
 * this is the plain shell's. HostWorkspaceView's `onSelectFolder` states the
 * intent this completes — a navigation that names a session exists to move to
 * the new tab — and {@link goToTab} brings the keyboard with the selection, the
 * way a click would. A tab already in front declines (a folder change selected
 * it while loading state, and {@link loadFolderState} owns that arrival's
 * focus), and a name that is not on the bar yet is ignored rather than raced:
 * the panel refreshes the session list before navigating, so a miss means the
 * session is gone, not slow.
 */
watch(
  () => route.query['tab'],
  (routed) => {
    if (typeof routed !== 'string' || routed === activeTab.value?.id) return;
    if (!tabs.value.some((tab) => tab.kind === 'session' && tab.session === routed)) return;
    goToTab(routed);
  },
);

/**
 * Create a session here, and launch [choice] in it once its PTY exists.
 *
 * [choice] is null for a plain shell. It arrives already validated — the
 * dialog will not let a broken one be confirmed — but it is re-checked here
 * anyway, because this is the last point at which nothing has been created
 * yet. That ordering is the fix for the old flow's worst property: it created
 * a session and only then found out the command was malformed, so a failed
 * launch still cost the user a stray session and an error to read in a
 * terminal.
 *
 * ## Every exit from here is either a new tab or a sentence
 *
 * There used to be a third kind, and it was the whole of the reported bug. The
 * host can answer a `unique` start with the name of a session this bar is
 * ALREADY showing — see ProjectsService.startSession for the socket-blindness
 * that made it do so — and this function trusted the name it was handed. Both
 * symptoms fell out of that one line:
 *
 *  - a shell create assigned `selected` the tab that was already selected, so
 *    the dialog closed and nothing else visibly happened at all;
 *  - an agent create armed the launch against a session whose PTY was already
 *    up and registered, so the watcher below fired on the spot and typed
 *    `pocketshell agent …` into the terminal the user was working in.
 *
 * The second is the serious one: it is this app writing a command into a live
 * session nobody pointed it at. So the name is checked against the bar BEFORE
 * anything is armed or selected, and the launch is armed LAST — after the
 * refresh, after the tab is known to exist, and with no `await` between the
 * selection and the arming, so no PTY can register in the gap and fire the
 * watcher against a session this function has not vouched for.
 *
 * A refusal is always a sentence in `createError`, which renders directly under
 * the tab strip. "Nothing happened" is not an outcome this function is allowed
 * to have.
 */
async function createSession(choice: LaunchChoice | null): Promise<void> {
  addAnchor.value = null;
  launching.value = false;
  createError.value = null;
  const connectionId = connection.connectionId;
  const path = folderPath.value;
  if (!connectionId || !path) {
    createError.value =
      'This folder has no known directory on the host, so a session cannot be started in it.';
    return;
  }
  // Fail BEFORE creating anything, never after.
  const blocker = choice ? launchBlocker(choice) : null;
  if (blocker) {
    createError.value = blocker;
    return;
  }
  // `unique` and not `reuse`: the folder's default session already has a tab,
  // so "new session" here can only mean a genuinely new one. The host walks
  // `<base>-2`, `<base>-3`, which is what makes the new tab read `Terminal 2`.
  //
  // Wrapped, even though `projects.start` resolves a result object rather than
  // throwing: the IPC call underneath it CAN reject (a closed window, a
  // serialisation failure), and an unhandled rejection here would leave the
  // user exactly where they started — a menu that closed and nothing else —
  // which is the same "nothing happens" symptom this whole change is fixing.
  //
  // The bar is read BEFORE the await, because `tabs` is derived from the session
  // store and the refresh below moves it. What is wanted is the set of sessions
  // that were already here when the user asked for another one.
  const before = new Set(
    tabs.value.filter((tab) => tab.kind === 'session').map((tab) => tab.session),
  );
  let result;
  try {
    result = await projects.start(connectionId, path, undefined, 'unique');
  } catch (e) {
    createError.value = `Could not start a session here: ${errorMessage(e)}`;
    return;
  }
  if (!result.ok || !result.sessionName) {
    createError.value = result.error ?? 'Could not start a session here.';
    return;
  }
  const created = result.sessionName;
  // The host answered with something that is already on this bar. Main refuses
  // the cases it can see (ProjectsService.startSession), and this is the same
  // refusal made from the only place that knows what is on screen — which is a
  // fact main does not have and cannot be given. Nothing is armed and nothing is
  // re-selected: the user asked for another session and did not get one, and the
  // one thing worse than saying so is typing an agent into the session they were
  // using.
  if (result.reused || before.has(created)) {
    createError.value =
      `The host answered with "${created}", which is already open in this folder, so no ` +
      `new session was started` +
      (choice ? ` and ${KIND_LABELS[choice.kind]} was not launched.` : '.');
    return;
  }
  // The row is filed as a pending session (`sessions.addPending`) rather than
  // confirmed by a listing first: the refresh used to be awaited right here,
  // and it is the slowest call in the app — a full `pocketshell sessions
  // list` under a login shell — sitting between the click and the terminal
  // the launch is waiting for. The result carries the row's backend, workspace
  // and aplexer id, so the tab bar and the join have everything they need
  // without a snapshot; the panel's poll reconciles the optimistic row with
  // the authoritative one a few seconds later.
  const pendingRow = sessions.summaryFromStartResult(result, path);
  if (pendingRow) sessions.addPending(pendingRow);
  if (!tabs.value.some((tab) => tab.kind === 'session' && tab.session === created)) {
    // The session exists on the host — main confirmed the create — but it is not
    // filed under this folder, so there is no tab to select and no pane for a
    // launch to wait on. Grouping is by the directory tmux reports, so the usual
    // cause is a session whose working directory is not the one this workspace
    // is keyed on. Saying which name to look for is the whole remedy.
    createError.value =
      `Started "${created}" on the host, but it did not appear in this folder, so there ` +
      `is no tab for it here` +
      (choice ? ` and ${KIND_LABELS[choice.kind]} was not launched.` : '.');
    return;
  }
  selected.value = created;
  persist();
  // Armed last, and deliberately after the selection rather than before it: the
  // pane this mounts is the PTY the launch waits for, and there is no `await`
  // between the two, so the watcher cannot fire against anything else.
  if (choice) armLaunch(created, choice);
  // The dialog's OverlayPanel hands focus back to the `+` that opened it as it
  // unmounts, so without this the user's first keystrokes go to that button. A
  // create that ends in a new tab ends the way a tab click does: keyboard in
  // the pane. `focusActiveTab` resolves after `nextTick`, so it lands after the
  // panel's restore — the terminal wins the hand-off, not the button.
  void focusActiveTab();
}

// Monotonic within the workspace, never a length-derived index: closing tab 2
// and adding one would otherwise reuse its id and inherit its directory.
// The counter rides behind Date.now() because tab ids persist to
// workspaceState: a bare counter restarts with the app and could collide with
// a restored id, while two tabs minted inside the SAME millisecond (a scripted
// drop, a double action) would collide on the timestamp alone and the second
// would silently replace the first in `filesTabs`.
let filesTabSeq = 0;

/**
 * Another Files tab, with its own directory memory.
 *
 * [seed] is where it opens. It defaults to the ACTIVE SESSION's own working
 * directory when there is one, falling back to the folder. That distinction is
 * not pedantry now that worktrees group under their repository
 *: a session in `~/git/dtc-website-decisions` shows up
 * under the `dtc-website` folder, and "open a file browser" while looking at
 * that session must mean the worktree the session is actually standing in, not
 * the main checkout.
 */
function addFilesTab(seed?: string | null): void {
  addAnchor.value = null;
  const next = {
    id: `${folderKey.value}::files:${Date.now()}:${++filesTabSeq}`,
    path: seed ?? summary.value?.path ?? folderPath.value,
  };
  filesTabs.value = [...filesTabs.value, next];
  selected.value = next.id;
  persist();
}

/**
 * Open [path] in a NEW Files tab — the file tree's "open in a new tab" action.
 *
 * Routed through the workspace rather than done inside FilesView because a
 * Files tab is a WORKSPACE-level thing: the tree can say "open this somewhere
 * else", but only the tab bar can create the somewhere.
 *
 * A DIRECTORY seeds the tab and that is all. A FILE seeds the tab at its PARENT
 * and then rides the existing reveal channel to open the file itself — the same
 * path a clicked file link in the terminal takes, so there is one implementation
 * of "land in a directory and open this thing" rather than two.
 *
 * Order matters and is the one subtle line here. `selected` is set BEFORE the
 * reveal is requested, so that by the time the `files.reveal` watcher below
 * runs, the active tab is already the new Files tab and the watcher declines to
 * redirect the request at some other tab.
 */
function onOpenInNewTab(path: string, kind: 'dir' | 'file'): void {
  if (kind === 'dir') {
    addFilesTab(path);
    return;
  }
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  addFilesTab(parent);
  files.requestReveal(path);
}

/**
 * A tab has gone: choose what is selected now.
 *
 * Written to hold for EITHER kind, because it now serves both — a Files tab
 * closed with its `×`, and a session tab whose session was just killed — and
 * because the two must not answer the question differently. The decision itself
 * is `tabAfterClose` in `shared/workspaceTabs.ts`, where it is a table with a
 * unit test rather than three branches inside a handler.
 *
 * Called with the bar as it still IS, before the tab is removed, so the
 * adjacency fallback can see where the closed tab sat.
 */
function selectAfterClose(id: string): void {
  const next = tabAfterClose(tabs.value, id, activeTab.value?.id ?? null, mru.value);
  // Popped, not merely filtered on read. The stack is persisted, so a dead
  // entry left in it would outlive this workspace visit.
  mru.value = mru.value.filter((entry) => entry !== id);
  selected.value = next;
  persist();
  if (next !== null) void focusActiveTab();
}

function closeFilesTab(id: string): void {
  selectAfterClose(id);
  filesTabs.value = filesTabs.value.filter((tab) => tab.id !== id);
  persist();
}

// ---------------------------------------------------------------------------
// The session tab's context menu, and stopping a session
// ---------------------------------------------------------------------------

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
const tabMenu = ref<{ session: string; label: string; anchor: Box } | null>(null);

function openTabMenu(tab: WorkspaceTab, e: MouseEvent): void {
  if (tab.kind !== 'session') return;
  // A right-click does not select. The menu's items name the tab they came
  // from, so acting on a background tab is unambiguous — and selecting first
  // would mean a right-click that the user then dismisses had already moved
  // them, and moved the composer's key with it.
  addAnchor.value = null;
  tabMenu.value = {
    session: tab.session,
    label: tab.label,
    anchor: pointAnchor(e.clientX, e.clientY),
  };
}

/** Start a rename from the menu — the double-click's discoverable sibling. */
function renameFromMenu(): void {
  const target = tabMenu.value;
  tabMenu.value = null;
  if (!target) return;
  const tab = tabs.value.find((t) => t.kind === 'session' && t.session === target.session);
  if (tab) beginRename(tab);
}

/**
 * The session a confirmed Stop would kill, or null when nothing is being asked.
 *
 * **The only destructive action in this app.** The file tree's menu (c614e7e)
 * deliberately omits delete as "destructive-adjacent with no undo"; this was
 * asked for explicitly, so it ships — but a tmux session is usually an agent in
 * the middle of a task, and there is no undo of any kind: the scrollback, the
 * process tree and whatever was uncommitted in that shell all go at once.
 *
 * It has a sibling now: the session panel's folder row stops every session in a
 * folder in one confirm (SessionTree.vue). The two ask
 * the same question and must keep looking like one feature — same word (`Stop`,
 * never `Close`), same tinted item, same quiet-Cancel/error-fill sheet. Any
 * change to the wording here belongs there too.
 *
 * The dialog names the SESSION, not the tab label. The label is a projection
 * that strips the folder prefix (§3.3), so two folders' tabs can both read
 * `main` — and the one moment a user must be certain which thing is being
 * destroyed is the moment they are asked to confirm destroying it.
 */
const stopping = ref<string | null>(null);
const stopBusy = ref(false);

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
  if (target) terminalRefs.get(target.session)?.resyncDisplay();
}

function askStop(): void {
  const target = tabMenu.value;
  tabMenu.value = null;
  if (target) stopping.value = target.session;
}

/**
 * The `×` on a session tab: {@link askStop} for a tab the user is pointing at
 * directly instead of one they right-clicked.
 *
 * It arms the same {@link stopping} ref, so the same named and confirmed
 * dialog opens (§14.1) and the kill itself stays in `confirmStop` — the `×`
 * is a handle on the destructive action, never the action. The `+` menu is
 * dismissed here for the reason `openTabMenu` dismisses it: the strip's
 * `click.stop` keeps the event from reaching the menu's own outside-click
 * close, so a menu left standing would outlive the click that should have
 * dismissed it.
 */
function askStopTab(tab: Extract<WorkspaceTab, { kind: 'session' }>): void {
  addAnchor.value = null;
  stopping.value = tab.session;
}

/**
 * Kill the session, then take down everything the DESKTOP keeps under its name.
 *
 * Three pieces, and they are the same three a rename has to move (61753d7);
 * this is the only other operation in the app that invalidates a session name,
 * so the two lists must stay in step:
 *
 *  1. **the pool's live tmux client and its PTY** — released main-side by the
 *     ipc handler through `TmuxClientPool.killed`, because that is where the
 *     pool is in scope;
 *  2. **the mounted terminal pane** — dropped from `openPanes` here.
 *     `sessionPanes` already filters against the live tabs, so the pane stops
 *     rendering the moment the row leaves the store; removing the entry as
 *     well is what stops a NEW session that reuses the name inheriting a pane
 *     that was never torn down (the folder-derived names make that reuse
 *     likely, not hypothetical);
 *  3. **the composer's per-session record** — `composer.forget`, the kill's
 *     counterpart to the rename's `composer.rekey`. A draft under a key nothing
 *     will ever ask for again would persist to `localStorage` forever and would
 *     be handed to the next session of that name.
 *
 * The store's row is the fourth piece and the one the others hang from: the
 * tab bar, the panel tree and `sessionMeta` all derive from it. It comes off
 * through `sessions.removeLocal` the moment the kill resolves rather than on
 * the refresh the call ends with, because the host's listing can lag the kill
 * by seconds — `a kill` answers ok when the worker ACCEPTS the stop, and the
 * record leaves the snapshot only when the worker has finished terminating
 * the workload — and inside that window a dead session that still looks live
 * keeps its tab on the bar above a pane that already says "[process exited]".
 * The ledger `removeLocal` files the identity into is what keeps the
 * follow-up refresh (and the panel's poll) from putting the corpse back.
 *
 * The selection moves through the SAME `selectAfterClose` a Files tab uses —
 * called while the bar still holds the closing tab, so its adjacency fallback
 * can see where the tab sat — so the MRU rule holds for a killed session tab
 * exactly as it does for a closed Files tab, and the focus lands in the newly
 * selected tab's surface.
 *
 * A session the host says is already gone (`not-found`) is treated as a
 * SUCCESS here, because the user's intent is satisfied and the state they asked
 * for is the state that exists. The tab bar refreshes on a timer, so the race is
 * ordinary rather than exotic.
 */
async function confirmStop(): Promise<void> {
  const session = stopping.value;
  const connectionId = connection.connectionId;
  if (!session || !connectionId) {
    stopping.value = null;
    return;
  }
  stopBusy.value = true;
  try {
    let result: Awaited<ReturnType<typeof projects.killSession>>;
    try {
      result = await projects.killSession(connectionId, session, aplexerRefFor(session));
    } catch (e) {
      // A rejected invoke is a failed kill like any other. Let it escape and
      // `stopBusy` stays latched — the Stop button dead until remount.
      createError.value = errorMessage(e);
      return;
    }
    if (!result.ok && result.code !== 'not-found') {
      createError.value = result.error ?? `Could not stop "${session}".`;
      return;
    }
    selectAfterClose(session);
    // The row comes off the bar NOW, not when the refresh lands — the host's
    // listing can still carry the session it is tearing down (doc comment
    // above).
    sessions.removeLocal(session, sessionMeta.value.get(session)?.workspace ?? undefined);
    openPanes.value = openPanes.value.filter((pane) => pane.session !== session);
    composer.forget(composer.targetKey(connectionId, session, identityFor(session)));
  } finally {
    stopBusy.value = false;
    stopping.value = null;
  }
  await sessions.refresh(connectionId);
}

// ---------------------------------------------------------------------------
// Terminal / composer plumbing — unchanged from the per-session workspace
// ---------------------------------------------------------------------------
/**
 * The panes, by session name, so the composer's Escape ladder can un-focus the
 * one on screen.
 *
 * A MAP rather than a template ref, because there is now a pane per visited
 * session tab. A `v-for` with a plain string `ref` collects an ARRAY in DOM
 * order, which would have to be indexed by position and would silently point at
 * the wrong pane the moment a tab appeared or disappeared; a session name
 * cannot drift like that.
 *
 * `el` is `unknown` for the same reason the old ref named only the method it
 * called: `*.vue` is declared as a `DefineComponent<…, any>` in env.d.ts, so
 * naming the instance type here would collapse the call site to `any` instead
 * of checking anything.
 */
const terminalRefs = new Map<string, TerminalPane>();
interface TerminalPane {
  focus: () => void;
  /** Re-assert geometry and repaint — see TerminalView's `resyncDisplay`. */
  resyncDisplay: () => void;
}
function setTerminalRef(session: string, el: unknown): void {
  if (el) terminalRefs.set(session, el as TerminalPane);
  else terminalRefs.delete(session);
}
/** Same reasoning for the composer, whose `typeInto` the terminal feeds. */
const composerRef = ref<{
  typeInto: (text: string) => void;
  pasteFromSystemClipboard: () => Promise<void>;
  acceptDroppedFiles: (files: File[]) => Promise<void>;
} | null>(null);
/**
 * The Files pane, for {@link focusActiveTab}.
 *
 * Optional `focus` in the type rather than required: this is a `.vue` default
 * export, so the instance type is `any` at the call site and a required member
 * would be checked against nothing anyway. Written as optional so the call
 * reads as what it is — an ask, which the pane may decline.
 */
const filesRef = ref<{ focus?: () => void } | null>(null);

/**
 * Whether the terminal should withhold printable keystrokes instead of sending
 * them to the shell (docs/COMPOSER.md §26). The halves of the condition live
 * here rather than in either component: the SETTING is app-level, and "only
 * while the composer is closed" is a fact about the composer.
 *
 * `terminalOwnsTyping` is the short-draft hand-off (§12.2): the composer just
 * put its draft at the shell prompt, so typing belongs to the pane until the
 * composer is summoned again — re-catching the next keystroke would fight the
 * text it just put there. Opening the panel clears the flag in the store, so
 * this returns on its own.
 */
const interceptTyping = computed(
  () =>
    settings.typingOpensComposer &&
    composer.mode === 'hidden' &&
    !composer.terminalOwnsTyping &&
    activeTab.value?.kind === 'session',
);

/** A keystroke the terminal withheld: it belongs in the draft, not the shell. */
function onTyped(text: string): void {
  composerRef.value?.typeInto(text);
}

/**
 * Ctrl+V at the terminal: the clipboard belongs in the composer, not the shell.
 *
 * The terminal has already cancelled the chord and withheld the bytes; what is
 * on the clipboard, whether it can be staged, and whether it is worth opening
 * the panel for are the composer's questions, because the composer is where the
 * answer is acted on. Routing an EVENT rather than the clipboard's contents is
 * what keeps a second clipboard-to-attachment path out of TerminalView — the
 * composer's own `onPaste` already owns that path.
 *
 * Unlike `interceptTyping` this is deliberately NOT gated on the composer being
 * closed or unsuppressed. An explicit Ctrl+V is a summons, like Ctrl+`, so it
 * lifts a dismissal rather than deferring to one.
 */
function onPasteIntoComposer(): void {
  void composerRef.value?.pasteFromSystemClipboard();
}

/**
 * A file dropped on the terminal pane routes to the composer for staging, the
 * same join the paste chords use. The File objects must ride the event — a
 * DataTransfer is dead once the drop event returns, so the composer cannot
 * re-read them the way it re-reads a clipboard — but nothing else crosses:
 * opening, naming, mime fallback and the single-flight upload are all the
 * composer's, through the one `stageFiles` path every other entry point uses.
 */
function onDropIntoComposer(dropped: File[]): void {
  void composerRef.value?.acceptDroppedFiles(dropped);
}

/** Put the keyboard back in the pane after a key or button closed the composer. */
function onFocusTerminal(): void {
  if (activeTab.value?.kind !== 'session') return;
  const session = terminalSession.value;
  if (session) terminalRefs.get(session)?.focus();
}

</script>

<template>
  <div class="folder-workspace">
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
              autofocus
              @input="onRenameInput"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
          </span>
          <button
            v-else
            :class="[
              'tab',
              {
                active: tab.id === activeTab?.id,
                files: tab.kind === 'files',
                dragging: dragging === tab.id,
                'drop-before': dropGap === i,
                'drop-after': dropGap === tabs.length && i === tabs.length - 1,
              },
            ]"
            :title="tab.kind === 'session' ? sessionTabTitle(tab.session) : 'File browser'"
            draggable="true"
            @click="selectTab(tab)"
            @dblclick="beginRename(tab)"
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

                 A FILES tab's `×` closes the view and nothing else (§12), and
                 every one of them has it — the first included. The old rule
                 spared the first tab because closing it would leave the
                 workspace no way to look at the folder, and that reason is
                 gone: `+` re-opens a Files tab in two clicks, and a file link
                 clicked in the terminal with none standing opens its own (the
                 reveal watcher below).

                 A SESSION tab's `×` is the context menu's Stop, one click
                 closer. It opens the SAME named, confirmed dialog the menu
                 does rather than killing on the click, because §14's argument
                 survives the affordance: the thing behind the tab is a live
                 process on another machine, and the control that can destroy
                 it must say so and ask. The tooltip says Stop, never Close —
                 the one word this app reserves for the kill (§14.4) — and the
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
              @click.stop="closeFilesTab(tab.id)"
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
          @click="toggleAddMenu"
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
          @close="addAnchor = null"
        >
          <ul>
            <li>
              <button class="menu-item" @click="openLaunchDialog">New session…</button>
            </li>
            <li class="menu-sep" />
            <li>
              <button class="menu-item" @click="addFilesTab()">New Files tab</button>
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

    <!-- Create and rename refusals share this one strip; see `barError` in the
         script for why. The dismiss is the app's ghost `.icon-btn sm` register
         (App.vue) and nothing louder: the strip is already error-tinted, and a
         button that outshouted the sentence would make the remedy read like a
         second problem. `@mousedown.prevent` is load-bearing, not tidiness:
         while a rename field is open, an unprevented mousedown here would blur
         the field, the blur would re-run the failing commit, and the message
         would be re-set moments after the click cleared it — a dismiss button
         that un-dismisses itself. -->
    <p v-if="barError" class="bar-error">
      <span class="bar-error-text">{{ barError }}</span>
      <button
        class="icon-btn sm bar-error-dismiss"
        title="Dismiss"
        aria-label="Dismiss this message"
        @mousedown.prevent
        @click="dismissBarError"
      >
        <AppIcon name="close" :size="12" />
      </button>
    </p>

    <div class="workspace-body">
      <div class="tab-body">
        <!-- One terminal per visited session tab, all kept mounted. Hiding
             rather than re-pointing is what makes a tab switch instant, and
             keeping them mounted while a Files tab shows is what stops a tab
             switch dropping an attach. The v-for is over the PANE RECORDS, not
             the tabs, and the key is the record's stable id: a tab's own id is
             the session name, so keying on it would read a rename as "one pane
             gone, another appeared" and pay a full re-join for a relabel.
             `sessionPanes` filters the records against the live tabs, so a
             session killed on the host stops rendering. -->
        <div class="terminal-area" v-show="activeTab?.kind === 'session'">
          <div
            v-for="pane in sessionPanes"
            :key="pane.id"
            v-show="pane.session === terminalSession"
            class="terminal-slot"
          >
            <TerminalView
              v-if="connection.connectionId"
              :ref="(el) => setTerminalRef(pane.session, el)"
              :connection-id="connection.connectionId"
              :session-key="pane.session"
              :backend="sessionMeta.get(pane.session)?.backend"
              :workspace="sessionMeta.get(pane.session)?.workspace"
              :aplexer-id="sessionMeta.get(pane.session)?.aplexerId"
              :intercept-typing="interceptTyping && pane.session === terminalSession"
              @typed="onTyped"
              @paste-into-composer="onPasteIntoComposer"
              @drop-into-composer="onDropIntoComposer"
            />
          </div>
        </div>

        <FilesView
          ref="filesRef"
          v-if="activeTab?.kind === 'files' && connection.connectionId"
          :key="activeTab.id"
          :start-path="activeTab.path ?? undefined"
          :session-key="activeTab.id"
          @open-in-new-tab="onOpenInNewTab"
        />

        <!-- No tabs at all. Most often this is just a folder with nothing in
             it — the ordinary entry state now that no Files tab is seeded —
             and it is also where a killed-off session list or an outlived deep
             link lands. There is exactly one useful thing to do here, so the
             empty state IS the create affordance. It opens the same dialog the
             `+` does rather than starting a bare shell, so there is ONE way to
             create a session in a folder and it is the one that can also start
             an agent; browsing files without a session stays on the `+` menu.
             Held off while the session list is still loading, so a deep link
             does not announce "nothing is running" a beat before the tabs
             arrive. -->
        <div v-if="!tabs.length && !sessions.loading" class="empty">
          <p class="muted">{{ folderPath ?? folderKey }}</p>
          <p class="muted">nothing is running in this folder</p>
          <button class="btn-ghost" @click="openLaunchDialog">Start a session here</button>
        </div>
      </div>

      <!-- The prompt composer FLOATS over the tab content rather than docking
           below it. Mounted once, v-show (never v-if) so a tab switch cannot
           cost the user a draft. It follows the ACTIVE SESSION TAB. -->
      <div
        v-if="connection.connectionId && activeSession"
        v-show="activeTab?.kind === 'session'"
        class="composer-dock"
      >
        <PromptComposer
          ref="composerRef"
          :connection-id="connection.connectionId"
          :session-name="activeSession"
          :backend="activeSessionMeta?.backend"
          :workspace="activeSessionMeta?.workspace"
          :agent-kind="agentKind"
          :connected="connection.state === 'connected'"
          @focus-terminal="onFocusTerminal"
        />
      </div>
    </div>

    <!-- THE ONLY DESTRUCTIVE CONFIRMATION IN THIS APP.

         It names the SESSION rather than the tab label, deliberately: the label
         is a projection that strips the folder's prefix (§3.3), so two folders
         can both show a tab called `main`, and the moment a user is asked
         to destroy something is the moment they must be certain which thing it
         is. It also says what goes, because "Stop" undersells it — a session
          is usually an agent mid-task, and its scrollback and process
          tree go with it.

         Escape and the backdrop cancel, and Cancel is the DEFAULT-looking
         button while Stop carries the error tint, so the dangerous half of the
         dialog is the half that has to be aimed at. -->
    <OverlayPanel v-if="stopping" title="Stop session" size="sm" @close="stopping = null">
      <div class="stop-confirm">
        <p>Stop <code>{{ stopping }}</code> ?</p>
        <p class="muted">
          This kills the session on the host. Anything running in it stops, its scrollback goes,
          and there is no undo.
        </p>
        <footer class="actions">
          <button class="btn-secondary" @click="stopping = null">Cancel</button>
          <button class="btn-danger" :disabled="stopBusy" @click="confirmStop">
            {{ stopBusy ? 'Stopping…' : 'Stop session' }}
          </button>
        </footer>
      </div>
    </OverlayPanel>

    <!-- Nothing is created until `confirm` fires, so Escape, the backdrop and
         Cancel all cost the user exactly nothing. -->
    <LaunchSessionDialog
      v-if="launching"
      :folder-path="folderPath"
      :folder-label="folder?.label ?? folderKey"
      @confirm="createSession"
      @close="launching = false"
    />
  </div>
</template>

<style scoped>
.folder-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;

  /* The gap between the floating composer and this pane's edges — what makes
     it read as hovering rather than as a bar welded to the window. Declared
     here rather than in App.vue's :root because it describes THIS pane's
     relationship with the composer, and custom properties inherit, so
     PromptComposer reads the same number without being handed it. */
  --composer-inset: var(--sp-3);
}
/* ---- one row of chrome ---------------------------------------------------
 * Identity and tabs used to be two full-height bars, 72px of chrome above every
 * terminal. Merged they cost --topbar-h and nothing else.
 *
 * The row has no vertical padding on purpose. The tabs are full-height children
 * of it, which is what lets the active tab's 2px underline sit exactly on the
 * row's own bottom border — the treatment DESIGN.md §5.4 specifies.
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
   segment at 13px is heavy for a mouse UI. See DESIGN.md §5.4.
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
/* The confirm sheet. `sm` OverlayPanel, two paragraphs and two buttons — the
   dialog is short because the decision is, and a longer one would bury the
   session's name. */
.stop-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.stop-confirm p {
  margin: 0;
}
.stop-confirm code {
  font-family: var(--font-mono);
  word-break: break-all;
}
.stop-confirm .actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.stop-confirm .btn-secondary,
.stop-confirm .btn-danger {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition: background var(--dur-fast) var(--ease);
}
.stop-confirm .btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg);
}
.stop-confirm .btn-secondary:hover {
  background: var(--state-hover);
}
/* Solid error, not a tinted ghost. This is the button that destroys the
   session, and a confirm dialog whose dangerous option is the quieter of the
   two is a trap. */
.stop-confirm .btn-danger {
  background: var(--error);
  border: 1px solid var(--error);
  color: var(--on-accent);
}
.stop-confirm .btn-danger:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* A failed create is a sentence, not a dialog: the tab bar is still usable and
   the message is about the one action that did not happen. A failed rename
   rents the same line now, for the same reason (see `barError` in the script).
   Flex, so the dismiss button sits at the end of the strip; the TEXT is the
   flexible child, so the three-line launch-timeout remedy wraps under itself
   rather than under the button. */
.bar-error {
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--error);
  background: var(--error-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
.bar-error-text {
  flex: 1;
  min-width: 0;
}
/* The shared `.icon-btn` is square by construction; pinned rigid here so a
   long message cannot squeeze it below its tap target. */
.bar-error-dismiss {
  flex: 0 0 auto;
}
.workspace-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* Containing block for .composer-dock, which is positioned against it. */
  position: relative;
}
/*
 * NO ROOM IS RESERVED FOR THE COMPOSER, and the terminal is sized once by the
 * pane. That is what keeps opening, closing, dragging and resizing the card
 * free of an SSH window-change and a remote tmux reflow. See the same block in
 * the view this replaced; the reasoning is unchanged.
 */
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.terminal-area {
  flex: 1;
  min-width: 0;
  display: flex;
}
/*
 * One of these per live session pane. They are siblings in the same flex row
 * and all but one are `display: none`, so the visible one takes the whole area
 * exactly as the single terminal used to. `min-width: 0` for the usual reason —
 * a flex item defaults to `min-width: auto` and would refuse to shrink below
 * its content, which for an xterm canvas means the pane can grow but not shrink.
 */
.terminal-slot {
  flex: 1;
  min-width: 0;
  display: flex;
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-size: var(--fs-300);
}
.empty p {
  margin: 0;
}

/* ---- the composer floats over the tab content --------------------------- */
/*
 * Why an overlay and not a docked row: docked, the composer was a flex sibling
 * of the tab body, so every open, close and resize changed the terminal's pixel
 * height — which changes its ROW COUNT, which is an SSH window-change the
 * remote tmux has to redraw and reflow for. Typing a prompt should not reflow
 * the session behind it.
 *
 * Why the dock is the WHOLE body and not a strip at the bottom: because the
 * card MOVES. Every clamp in src/shared/composerGeometry.ts is measured against
 * this element.
 */
.composer-dock {
  position: absolute;
  /* INSET rather than padded. An absolutely positioned child resolves its
     offsets against its containing block's PADDING box, so padding here would
     not have held the card off the pane's edges — and insetting the dock itself
     makes `right: 0; bottom: 0` mean "the resting corner". */
  inset: var(--composer-inset);
  z-index: 5;
  pointer-events: none;
}
</style>
