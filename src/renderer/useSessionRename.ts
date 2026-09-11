import { ref, type Ref } from 'vue';
import { sanitisePart } from '../shared/sessionNameParts';
import { renamedSessionName, type WorkspaceTab } from '../shared/workspaceTabs';
import type { ConnectionId } from '../shared/types';
import type { SessionPaneRecord } from './sessionPanes';
import type { useComposerStore } from './stores/composer';
import type { useConnectionStore } from './stores/connection';
import type { useProjectsStore } from './stores/projects';
import type { useSessionsStore } from './stores/sessions';

/**
 * The aplexer address a rename carries for the host side. Mirrors the view's
 * `aplexerRefFor`: `backend: 'tmux'` is the none-answer — the bare name IS the
 * tmux address — so callers pass the result straight through.
 */
export interface AplexerRef {
  backend: 'tmux' | 'aplexer';
  workspace?: string;
  aplexerId?: string;
}

/** The mounted-pane handles a rename re-keys, by identity. */
export interface RenameablePaneRef {
  focus: () => void;
  resyncDisplay: () => void;
}

export interface SessionRenameDeps {
  connection: ReturnType<typeof useConnectionStore>;
  sessions: ReturnType<typeof useSessionsStore>;
  projects: ReturnType<typeof useProjectsStore>;
  composer: ReturnType<typeof useComposerStore>;
  /** The aplexer address for a session name, or undefined for a tmux row. */
  aplexerRefFor: (name: string) => AplexerRef | undefined;
  /** The workspace-qualified identity for a session name (see the view). */
  identityFor: (name: string, like?: string) => string;
  openPanes: Ref<SessionPaneRecord[]>;
  terminalRefs: Map<string, RenameablePaneRef>;
  selected: Ref<string | null>;
  terminalSession: Ref<string | null>;
  terminalIdentity: Ref<string | null>;
  mru: Ref<string[]>;
  tabOrder: Ref<string[]>;
  writeTabOrder: (next: string[]) => void;
  persist: () => void;
}

/**
 * Renaming a session tab, and moving the whole desktop across with it.
 *
 * The field policy (what may be typed, what a commit is) is the small half;
 * the large half is `adoptRenamedSession`'s one synchronous tick, which is
 * the whole "a rename is just a label" trick documented there. Extracted from
 * the folder workspace so the bar's view keeps rendering, not bookkeeping.
 */
export function useSessionRename(deps: SessionRenameDeps): {
  renaming: Ref<{ id: string; session: string } | null>;
  renameText: Ref<string>;
  renameError: Ref<string | null>;
  beginRename: (tab: WorkspaceTab) => void;
  cancelRename: () => void;
  commitRename: () => Promise<void>;
} {
  /** The tab being renamed, and the text in its field. */
  const renaming = ref<{ id: string; session: string } | null>(null);
  const renameText = ref('');
  const renameError = ref<string | null>(null);

  function beginRename(tab: WorkspaceTab): void {
    if (tab.kind !== 'session') return;
    renaming.value = { id: tab.id, session: tab.session };
    // The label IS the session's name, so what is in the box is what the host
    // will be asked to rename.
    renameText.value = tab.session;
    renameError.value = null;
  }

  function cancelRename(): void {
    renaming.value = null;
    renameError.value = null;
  }

  async function commitRename(): Promise<void> {
    const target = renaming.value;
    const connectionId = deps.connection.connectionId;
    if (!target || !connectionId) return cancelRename();

    // An untouched field is a cancel, not a commit. Blur calls this as readily
    // as Enter does.
    if (renameText.value === target.session) return cancelRename();

    // The field edits the name and commits the name, for both backends alike —
    // a tmux session and an aplexer tag are each called exactly what their tab
    // says. The aplexer ref rides along because the HOST side needs it to
    // address `workspace:tag`; it no longer changes what the name is.
    const aplexerRef = deps.aplexerRefFor(target.session);
    const next = renamedSessionName(renameText.value, sanitisePart);
    if (next === null) {
      renameError.value = 'that leaves nothing a session can be called';
      return;
    }
    if (next === target.session) return cancelRename();

    const result = await deps.projects.renameSession(connectionId, target.session, next, aplexerRef);
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
    void deps.sessions.refresh(connectionId);
  }

  /**
   * Move everything the desktop keeps under the session's old name to the new
   * one, in ONE synchronous tick.
   *
   * The pieces are moved together rather than left to the next
   * `sessions.refresh` because the pieces that make a rename feel like a
   * relabel — the tab bar, the mounted pane, the composer draft — are all
   * keyed on the name, and a refresh is seconds of the old name on screen
   * followed by a pane the v-for no longer recognises, which it tears down and
   * re-joins. Done in one tick instead, the flush after this function returns
   * sees a fully consistent world: the pane record and the row agree on the
   * new name, the v-for key never changed, and the TerminalView's own
   * `sessionKey` watcher does the only thing left — re-point at the new name,
   * which the pool answers with the PTY it already holds. That is the whole
   * "a rename is just a label" trick.
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
    // Both identities resolve BEFORE the local rename below, while `sessionMeta`
    // still carries the `from` row to read the workspace off; after it, a
    // from-row lookup falls back to the bare name and the aplexer key would lose
    // its workspace.
    const fromIdentity = deps.identityFor(from);
    const toIdentity = deps.identityFor(to, from);
    // The composer's per-session record is keyed on the session identity, so it
    // has to move or the draft is orphaned under a key nothing will ever ask
    // for again. Both ends resolve through the SAME row: this runs before the
    // local rename below, so the new key borrows the old row's workspace.
    deps.composer.rekey(
      deps.composer.targetKey(connectionId, from, fromIdentity),
      deps.composer.targetKey(connectionId, to, toIdentity),
    );
    // The row, so the tab bar, the panel tree and `sessionMeta` re-derive now.
    deps.sessions.renameLocal(from, to, workspace);
    // A pane record can outlive its session: a session that left the bar any
    // other way than an in-app kill usually has its record retired by the
    // identity prune, but a rename can still land on a name whose leftover
    // record has not been flushed yet. Renaming onto that identity must drop
    // the leftover first, or two records answer `to`: both pass
    // `sessionPanes`' filter, both match the pane's `v-show`, and the flex row
    // splits between two terminals subscribed to the same PTY — the session
    // painted twice, side by side.
    deps.openPanes.value = deps.openPanes.value.filter((p) => p.identity !== toIdentity);
    // The mounted pane keeps its instance — its v-for key is the record id, not
    // the name — and its TerminalView re-points itself off the session-key prop
    // change, which the identity rewrite below is.
    const pane = deps.openPanes.value.find((p) => p.identity === fromIdentity);
    if (pane) {
      pane.session = to;
      pane.identity = toIdentity;
    }
    // The pane refs are keyed by identity, the pane's own key; move the entry
    // so focus and Redraw do not have to know a rename happened.
    const paneRef = deps.terminalRefs.get(fromIdentity);
    if (paneRef) {
      deps.terminalRefs.delete(fromIdentity);
      deps.terminalRefs.set(toIdentity, paneRef);
    }
    if (deps.selected.value === from) deps.selected.value = to;
    if (deps.terminalSession.value === from) deps.terminalSession.value = to;
    if (deps.terminalIdentity.value === fromIdentity) deps.terminalIdentity.value = toIdentity;
    // The persisted layout is a ranking of tab IDS, and a tab id is a session
    // name: remap rather than let the prune watcher read the old id as a death,
    // or the rename would silently drop the tab's manual position and MRU entry.
    if (deps.mru.value.includes(from)) {
      deps.mru.value = deps.mru.value.map((id) => (id === from ? to : id));
    }
    if (deps.tabOrder.value.includes(from)) {
      deps.writeTabOrder(deps.tabOrder.value.map((id) => (id === from ? to : id)));
    }
    deps.persist();
  }

  return { renaming, renameText, renameError, beginRename, cancelRename, commitRename };
}
