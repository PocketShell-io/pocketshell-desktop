import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { agentMark } from '../shared/agentBadge';
import { applyTabOrder, buildWorkspaceTabs, pushMru, tabAfterClose, type WorkspaceTab } from '../shared/workspaceTabs';
import type { SessionSummary } from '../shared/types';
import type { useFilesStore } from './stores/files';
import type { useSessionsStore } from './stores/sessions';
import { prunePanes, upsertPane, type SessionPaneRecord } from './sessionPanes';
import { sessionIdentityKey } from './sessionIdentity';
import type { SessionDirectory } from './sessionTree';
import type { useWorkspaceMemory } from './useWorkspaceMemory';

/** The mounted-pane handles, keyed by the pane's own identity — what rename
 *  re-keys and what focus and Redraw look up. */
export interface TerminalPane {
  focus: () => void;
  /** Re-assert geometry and repaint — see TerminalView's `resyncDisplay`. */
  resyncDisplay: () => void;
}

export interface WorkspaceTabsDeps {
  /** The folder node this workspace is showing, out of the shared grouping. */
  folder: ComputedRef<SessionDirectory | null>;
  /** The folder key from the route — `~/git/dtc-website`. */
  folderKey: ComputedRef<string>;
  /** The folder's real path, or null for an untracked session's pseudo-folder. */
  folderPath: ComputedRef<string | null>;
  sessions: ReturnType<typeof useSessionsStore>;
  files: ReturnType<typeof useFilesStore>;
  /** The remembered tab state and its persistence machinery (useWorkspaceMemory). */
  memory: ReturnType<typeof useWorkspaceMemory>;
  /** Put the keyboard where the user just looked; the view owns the pane refs. */
  focusActiveTab: () => Promise<void>;
}

/**
 * The folder workspace's tab model: the bar, the panes behind the session
 * tabs, the identities that key them, selection, and the Files tabs. Extracted
 * from FolderWorkspaceView.vue with its reasoning; the view keeps the chrome —
 * header, menus, error strip, composer — and binds what this returns.
 */
export function useWorkspaceTabs(deps: WorkspaceTabsDeps): {
  tabs: ComputedRef<WorkspaceTab[]>;
  activeTab: ComputedRef<WorkspaceTab | null>;
  activeSession: ComputedRef<string | null>;
  localRow: (name: string | null) => SessionSummary | null;
  sessionTabTitle: (session: string) => string;
  tabMark: (session: string) => ReturnType<typeof agentMark>;
  terminalSession: Ref<string | null>;
  terminalIdentity: Ref<string | null>;
  openPanes: Ref<SessionPaneRecord[]>;
  liveIdentities: ComputedRef<Set<string>>;
  sessionPanes: ComputedRef<SessionPaneRecord[]>;
  summary: ComputedRef<SessionSummary | null>;
  activeSessionMeta: ComputedRef<
    { backend: 'tmux' | 'aplexer'; workspace: string | null; aplexerId: string | null } | undefined
  >;
  sessionMeta: ComputedRef<
    Map<string, { backend: 'tmux' | 'aplexer'; workspace: string | null; aplexerId: string | null }>
  >;
  aplexerRefFor: (
    name: string,
  ) => { backend: 'tmux' | 'aplexer'; workspace?: string; aplexerId?: string } | undefined;
  identityFor: (name: string, like?: string) => string;
  terminalRefs: Map<string, TerminalPane>;
  setTerminalRef: (identity: string, el: unknown) => void;
  selectTab: (tab: WorkspaceTab) => void;
  goToTab: (id: string) => void;
  selectAfterClose: (id: string) => void;
  addFilesTab: (seed?: string | null) => void;
  onOpenInNewTab: (path: string, kind: 'dir' | 'file') => void;
  closeFilesTab: (id: string) => void;
} {
  const { filesTabs, selected, mru, tabOrder, persist, pruneAgainst } = deps.memory;

  const tabs = computed<WorkspaceTab[]>(() =>
    // Derived first, then the user's own arrangement on top. The order of the two
    // steps IS the resolution of the two instructions: the automatic order is
    // what a tab gets until the user moves it, and a manual position wins once
    // there is one.
    applyTabOrder(
      buildWorkspaceTabs(
        (deps.folder.value?.rows ?? []).map((row) => ({
          name: row.session.name,
          created: row.session.created,
        })),
        // `path: null` means "this tab was never given a seed", which resolves
        // to the folder.
        filesTabs.value.map((tab) => ({ id: tab.id, path: tab.path ?? deps.folderPath.value })),
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
  /**
   * This folder's own row for [name], or null.
   *
   * The one session lookup the workspace is allowed. A bare session name is NOT
   * host-unique — an aplexer tag repeats across workspaces, so `main` is every
   * workspace's default — and a lookup against the host-wide listing returns
   * whoever is listed first: another folder's `main` lends this workspace its
   * path and agent badge, which is how a Files tab came to be seeded at the
   * folder the user had just left. Resolving through the same rows the tabs are
   * built from keeps every answer here this workspace's own; a name with no row
   * here has no answer, which `summary`'s null already renders honestly.
   */
  function localRow(name: string | null): SessionSummary | null {
    return (deps.folder.value?.rows ?? []).find((row) => row.session.name === name)?.session ?? null;
  }

  function sessionTabTitle(session: string): string {
    const row = localRow(session);
    const lines = [session];
    const mark = agentMark(row?.agentKind);
    // The agent is named here as well as on the mark's own `<title>`, because the
    // marks are arbitrary (src/shared/agentBadge.ts) and this is the tooltip a
    // user actually lands on — the icon is 12px and hovering it precisely is not
    // a thing to require of anyone.
    if (mark) lines.push(mark.label);
    const path = row?.path ?? null;
    if (path && path !== deps.folderPath.value) lines.push(`running in ${path}`);
    if (row?.pathInferred) lines.push('folder inferred from the session name, not reported by tmux');
    lines.push('double-click to rename, right-click for more');
    return lines.join('\n');
  }

  /**
   * The mark a session tab wears, or null for a shell and for the common,
   * legitimate `unknown`.
   *
   * Looked up from this folder's rows per tab (`localRow`) rather than carried on
   * the `WorkspaceTab`. The tab model is the LAYOUT of the bar — what is called
   * what, in what order — and it is pure and unit-tested as such; the agent kind
   * is a live fact that the refresh timer changes underneath it, so folding it in
   * would make `buildWorkspaceTabs` recompute the whole bar every time a badge
   * moved.
   */
  function tabMark(session: string): ReturnType<typeof agentMark> {
    return agentMark(localRow(session)?.agentKind);
  }

  /** The session tab that is (or was last) showing — which pane is visible. */
  const terminalSession = ref<string | null>(null);
  /** The identity of that tab — which mounted pane is visible, by `v-show`. */
  const terminalIdentity = ref<string | null>(null);
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
   * `identity` is the workspace-qualified join key, and it is what every pane
   * MATCH reads — the dedupe, the visibility `v-show`, the ref map, the prune.
   * The matches used to read the bare name, and under aplexer that was a real
   * bug: a tag repeats across workspaces, so navigating from a folder whose
   * `main` was mounted straight into a folder with its own `main` found the
   * leftover record and reused it — the tab showed the PREVIOUS workspace's
   * session, and the new workspace's pane was never mounted at all, because
   * TerminalView re-points only on a session-key change and the key had not
   * changed. `aplexer:<workspace>:<tag>` cannot answer for another workspace's
   * same-named tag; the leftover is a foreign identity and is pruned like any
   * other session that is not on the bar.
   *
   * Append-only while the workspace lives — unmounting a pane closes its SSH
   * shell, and coming back would pay a full join (1.5–2 s on the user's host) —
   * but the workspace's lifetime is THIS folder's visit, not the component
   * instance's: vue-router reuses this component folder-to-folder, and the pane
   * of the folder just left is not the arrived-at folder's pane however
   * same-named it looks. The identity prune in the `tabs` watcher retires those
   * records on the switch, along with sessions killed out-of-band. Main bounds
   * the channels underneath independently — the pool evicts its least recently
   * used client when a connection runs out of SSH channels, and a pane whose
   * shell was evicted re-joins itself when it is next looked at.
   */
  const openPanes = ref<SessionPaneRecord[]>([]);
  let nextPaneId = 1;

  /**
   * The identities on this workspace's bar right now.
   *
   * The one live-set every pane filter reads — the render filter below and the
   * prune in the `tabs` watcher — so the two cannot disagree about what "still
   * on the bar" means. Resolved through `identityFor`, the same function that
   * minted the panes' identities, so a rename's rewrite (pane and row in one
   * tick) reads as the pane never having left.
   */
  const liveIdentities = computed(() => {
    const live = new Set<string>();
    for (const tab of tabs.value) {
      if (tab.kind === 'session') live.add(identityFor(tab.session));
    }
    return live;
  });

  /**
   * The session tabs that currently have a mounted pane, in visit order.
   *
   * The panes are filtered against the live identities rather than trusted, so a
   * session that was killed on the host — or left behind on the folder the user
   * just navigated away from — stops rendering the moment it leaves the bar,
   * while a RENAME keeps the pane rendering straight through: the row and the
   * pane record are rewritten in the same tick, so from the filter's point of
   * view the pane's identity never stopped being on the bar.
   */
  const sessionPanes = computed(() =>
    openPanes.value.filter((pane) => liveIdentities.value.has(pane.identity)),
  );

  const summary = computed(() => localRow(terminalSession.value));

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
    for (const row of deps.folder.value?.rows ?? []) {
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
   * The active session's workspace-qualified identity, and the pane watcher
   * keyed on it.
   *
   * Keyed on the IDENTITY, not the name, because across a folder-to-folder
   * navigation the name can stay the same — `main` to `main`, every aplexer
   * workspace's default — and a name-keyed watcher never fires, leaving the
   * previous workspace's pane and state on screen. Identities cannot collide
   * that way: the same name in another workspace is a different identity, which
   * is the whole point of the key.
   *
   * `immediate`, as the pane opener this always was. Kept after `sessionMeta`
   * in the file because the immediate run resolves through it, and a source
   * read before its `const` initializes is a TDZ error, not a stale answer.
   * A null identity — no session tab in front, the Files tab's usual state —
   * changes nothing: the terminal refs and `summary`'s notion of "the session
   * that was last showing" survive a detour through Files.
   */
  const activeSessionIdentity = computed(() =>
    activeSession.value ? identityFor(activeSession.value) : null,
  );
  watch(
    activeSessionIdentity,
    (identity) => {
      const name = activeSession.value;
      if (!identity || !name) return;
      terminalSession.value = name;
      terminalIdentity.value = identity;
      const next = upsertPane(
        openPanes.value,
        { session: name, identity },
        () => `pane-${nextPaneId++}`,
      );
      if (next !== openPanes.value) openPanes.value = next;
    },
    { immediate: true },
  );

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
   * The stack must never be able to name a tab that is gone; the rule and its
   * reasoning live in `pruneAgainst`. Driven by the tabs rather than by the
   * close handlers, because a tab can leave the bar without anything here
   * closing it: killed from the user's own terminal, killed from the phone, or
   * the host restarted. Watching the tabs covers every one of those with one
   * rule instead of enumerating them.
   */
  watch(tabs, (list) => {
    // Guarded on the HOST's session list having arrived, not on the bar being
    // non-empty — and the guard must stand over BOTH remembered lists and the
    // panes. A workspace whose sessions have not loaded yet — a deep link, a
    // reload, and since the tabs persist, a relaunch, where the bar can hold its
    // Files tabs alone for the first round trip — would have every session id
    // pruned as dead before the session list that proves them alive ever landed.
    // That was a harmless scratch when the MRU lived only in memory; persisted,
    // it would be a wipe ON DISK. So the guard the manual order already carried
    // now stands over the stack too.
    if (deps.sessions.sessions.length === 0) return;
    pruneAgainst(list);
    // The panes prune on the same authority and for the same class of reason.
    // A pane whose identity is no longer on the bar retires here — the record
    // and its mounted TerminalView with it — whether the session left out-of-band
    // (killed on the host, stopped from the phone) or belongs to the folder the
    // user just navigated away from: vue-router reuses this component across
    // folders, and without the prune the previous workspace's panes would ride
    // along, same-named aplexer tags answering for each other. Unmounting closes
    // the pane's SSH shell; for a dead or left-behind session that is the honest
    // teardown, and it is what stops a re-created same-named session from
    // inheriting a pane still pointed at a dead PTY. The guard above covers this
    // too: panes exist only once a session list has loaded, so the prune never
    // runs against a bar that is merely waiting for its rows.
    const keptPanes = prunePanes(openPanes.value, liveIdentities.value);
    if (keptPanes.length !== openPanes.value.length) openPanes.value = keptPanes;
  });

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
    void deps.focusActiveTab();
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
    const next = {
      id: `${deps.folderKey.value}::files:${Date.now()}:${++filesTabSeq}`,
      path: seed ?? summary.value?.path ?? deps.folderPath.value,
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
    deps.files.requestReveal(path);
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
    if (next !== null) void deps.focusActiveTab();
  }

  function closeFilesTab(id: string): void {
    selectAfterClose(id);
    filesTabs.value = filesTabs.value.filter((tab) => tab.id !== id);
    persist();
  }

  /**
   * The mounted-pane handles, keyed by the pane's own identity — what rename
   * re-keys and what focus and Redraw look up.
   */
  const terminalRefs = new Map<string, TerminalPane>();

  /**
   * The panes, by session identity, so the composer's Escape ladder can un-focus
   * the one on screen.
   *
   * A MAP rather than a template ref, because there is now a pane per visited
   * session tab. A `v-for` with a plain string `ref` collects an ARRAY in DOM
   * order, which would have to be indexed by position and would silently point at
   * the wrong pane the moment a tab appeared or disappeared; a session identity
   * cannot drift like that — and it has to be the identity rather than the bare
   * name, because a name repeats across workspaces and a map keyed on it would
   * hand one workspace's pane to another. The map's keys move with the pane
   * record: a rename re-keys it, the prune drops it.
   *
   * `el` is `unknown` for the same reason the old ref named only the method it
   * called: `*.vue` is declared as a `DefineComponent<…, any>` in env.d.ts, so
   * naming the instance type here would collapse the call site to `any` instead
   * of checking anything.
   */
  function setTerminalRef(identity: string, el: unknown): void {
    if (el) terminalRefs.set(identity, el as TerminalPane);
    else terminalRefs.delete(identity);
  }

  return {
    tabs,
    activeTab,
    activeSession,
    localRow,
    sessionTabTitle,
    tabMark,
    terminalSession,
    terminalIdentity,
    openPanes,
    liveIdentities,
    sessionPanes,
    summary,
    activeSessionMeta,
    sessionMeta,
    aplexerRefFor,
    identityFor,
    terminalRefs,
    setTerminalRef,
    selectTab,
    goToTab,
    selectAfterClose,
    addFilesTab,
    onOpenInNewTab,
    closeFilesTab,
  };
}
