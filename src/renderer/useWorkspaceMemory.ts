import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { pushMru, pruneTabIds, type WorkspaceTab } from '../shared/workspaceTabs';
import {
  readWorkspaceMemory,
  workspaceMemoryKey,
  writeLastFolder,
  writeWorkspaceMemory,
  type FilesTabRecord,
  type WorkspaceMemoryRecord,
} from './workspaceState';

/** What a Files tab carries while it is open. */
type FilesTabState = FilesTabRecord;
type WorkspaceMemory = WorkspaceMemoryRecord;

export interface WorkspaceMemoryDeps {
  /** The folder key from the route — `~/git/dtc-website`. */
  folderKey: ComputedRef<string>;
  /** The host alias from the route — the stable identity the tab state keys on. */
  hostAlias: ComputedRef<string>;
  /** The `?tab=` hand-off the panel navigates with, when present. */
  routedTab: () => string | undefined;
  /**
   * The resolved active tab. Read only inside {@link useWorkspaceMemory}'s
   * commands — never during setup — because the bar itself is derived from the
   * refs this composable returns.
   */
  getActiveTab: () => WorkspaceTab | null;
  /** Run after a folder's state is loaded; the workspace focuses the pane. */
  focusActiveTab: () => void | Promise<void>;
}

/**
 * The folder workspace's remembered tab state: the Files tabs, the selection,
 * the selection history, and the hand-arranged tab order — with the
 * localStorage persistence and the restore path that go with them.
 *
 * Per-workspace UI state that must survive leaving and coming back: which
 * Files tabs are open, and which tab was selected. Owned by this composable's
 * caller — one folder-workspace instance — rather than a Pinia store,
 * deliberately: it is view state with exactly one reader, and no action
 * anywhere else in the app needs to read or write it. A store would buy
 * nothing but a file, and the thing that genuinely IS shared (each Files
 * tab's browsing position) already lives in the files store, keyed by the tab
 * id the map hands out. The map's per-instance lifetime is what carries the
 * state across a folder-to-folder navigation: vue-router reuses the component
 * there, so the composable — and the map with it — survives.
 *
 * Keyed by the HOST ALIAS and the folder, so one host's tabs cannot appear on
 * another — and so an entry outlives a reconnect, which a connection-id key
 * cannot do: a re-dial mints a fresh connection id, but it is the same host
 * and the same tmux sessions, so the workspace should come back as it was. The
 * alias is also what the persisted copy in ./workspaceState keys on, which is
 * why a relaunch can find this map's contents on disk at all. It is never
 * pruned: an entry is two small strings, and the alternative is a teardown
 * hook that has to guess when a workspace will not be revisited.
 *
 * The record's shape — what a Files tab carries, why the MRU is a stack — is
 * documented with `WorkspaceMemoryRecord` in ./workspaceState, which is the
 * same shape at a longer lifetime: `persist()` writes the map entry to
 * localStorage verbatim, and `remembered()` seeds a missing entry from it.
 */
export function useWorkspaceMemory(deps: WorkspaceMemoryDeps): {
  filesTabs: Ref<FilesTabState[]>;
  selected: Ref<string | null>;
  mru: Ref<string[]>;
  tabOrder: Ref<string[]>;
  loadTabOrder: () => void;
  writeTabOrder: (next: string[]) => void;
  loadFolderState: () => void;
  persist: () => void;
  pruneAgainst: (list: WorkspaceTab[]) => void;
} {
  const memory = new Map<string, WorkspaceMemory>();

  const memoryKey = computed(() => `${deps.hostAlias.value}/${deps.folderKey.value}`);

  function remembered(): WorkspaceMemory {
    const existing = memory.get(memoryKey.value);
    if (existing) return existing;
    // Nothing in memory for this workspace — its first visit in this window.
    // What a previous window persisted seeds it, so a relaunch opens the folder
    // with the tabs it closed with; a first visit ever finds nothing on disk
    // and starts bare.
    const restored = readWorkspaceMemory(
      workspaceMemoryKey(deps.hostAlias.value, deps.folderKey.value),
    );
    // No Files tab to start with. A workspace opens showing its sessions, and a
    // Files tab appears only when something asks for one: "New Files tab" on the
    // `+` menu, "open in a new tab" from the file tree, or a path clicked in the
    // terminal — the reveal watcher opens one when none is standing.
    const fresh: WorkspaceMemory = restored ?? { filesTabs: [], activeTab: null, mru: [] };
    memory.set(memoryKey.value, fresh);
    return fresh;
  }

  const filesTabs = ref<FilesTabState[]>([]);
  /** Which tab id is selected. Null means "the first one", resolved on read. */
  const selected = ref<string | null>(null);
  /** Selection history for the close-adjacent rule. See `WorkspaceMemory.mru`. */
  const mru = ref<string[]>([]);

  // -------------------------------------------------------------------------
  // The manual tab order, and where it lives
  // -------------------------------------------------------------------------

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
    return `ps.tabOrder.${deps.hostAlias.value}.${deps.folderKey.value}`;
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
   * Load this folder's remembered tabs into the live refs.
   *
   * Called from `onMounted` AND from a watch on the folder key, because
   * vue-router REUSES the component instance when only the `:folder` param
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
    selected.value = deps.routedTab() ?? state.activeTab;
    mru.value = state.mru;
    // Seed the stack with the tab that is actually in front, which the MRU
    // watcher cannot do for us: on entry `activeTab` resolves without ever
    // CHANGING, so nothing would record the tab the user landed on — and the
    // first close would then find an empty stack and fall through to adjacency,
    // which is the behaviour the MRU exists to replace. Read after the three
    // assignments above, so the computed answers with this folder's state.
    const active = deps.getActiveTab()?.id ?? null;
    if (active !== null) mru.value = pushMru(mru.value, active);
    persist();
    // Every arrival at a folder is "take me to this workspace" — a row click in
    // the panel, a `Ctrl+↑`/`Ctrl+↓` step, the session panel's `?tab=` hand-off,
    // the first open from the empty state — and each one used to land with the
    // keyboard wherever it had been, which is the same defect a tab click had
    // (bc86cf7): the first keystrokes went nowhere the user was looking. So the
    // keyboard goes to the pane in front. At a cold mount the bar is still empty
    // and this no-ops — the focus step finds no tab rather than trusting the
    // first-tab fallback, so a boot restore never grabs focus on a guess.
    void deps.focusActiveTab();
  }

  /**
   * Write the tab state back.
   *
   * Called explicitly by the things that change it rather than from a watch
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
    writeWorkspaceMemory(workspaceMemoryKey(deps.hostAlias.value, deps.folderKey.value), record);
    writeLastFolder(deps.hostAlias.value, deps.folderKey.value);
  }

  /**
   * Keep the remembered ids honest against the bar as it actually is — the MRU
   * stack and the manual order, each pruned to tabs still on it.
   *
   * The stack must never be able to name a tab that is gone — the brief's own
   * words, and the reason is sharper than "it would point at nothing": a session
   * tab's id IS its tmux session name, and `sessions create` derives that name
   * from the folder, so a killed session's name is very likely to come back
   * attached to a DIFFERENT session. A stale entry would then resurrect as a
   * live-looking target.
   *
   * Driven by the tabs rather than by the close handlers, because a tab can leave
   * the bar without anything closing it: killed from the user's own
   * terminal, killed from the phone, or the host restarted. Watching the tabs
   * covers every one of those with one rule instead of enumerating them.
   *
   * The manual order needs the identical treatment, and for a sharper reason
   * than the MRU: a stored id that no longer names a tab is inert TODAY, but a
   * session killed and re-created keeps its name (`sessions create` derives it
   * from the folder), so an unpruned entry would silently re-pin a brand new
   * session to the dead one's old position. Same rule, same function, one
   * definition of "this id has died".
   *
   * The caller guards on the HOST's session list having arrived, and guards BOTH
   * stored lists through this one call: a workspace whose sessions have not
   * loaded yet — a deep link, a reload, and since the tabs persist, a relaunch,
   * where the bar can hold its Files tabs alone for the first round trip — would
   * have every session id pruned as dead before the session list that proves
   * them alive ever landed. That was a harmless scratch when the MRU lived only
   * in memory; persisted, it would be a wipe ON DISK.
   */
  function pruneAgainst(list: WorkspaceTab[]): void {
    const pruned = pruneTabIds(mru.value, list);
    if (pruned.length !== mru.value.length) {
      mru.value = pruned;
      persist();
    }
    const keptOrder = pruneTabIds(tabOrder.value, list);
    if (keptOrder.length !== tabOrder.value.length) writeTabOrder(keptOrder);
  }

  return {
    filesTabs,
    selected,
    mru,
    tabOrder,
    loadTabOrder,
    writeTabOrder,
    loadFolderState,
    persist,
    pruneAgainst,
  };
}
