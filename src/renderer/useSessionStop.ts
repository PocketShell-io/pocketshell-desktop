import { ref, type ComputedRef, type Ref } from 'vue';
import { errorMessage } from '../shared/errors';
import type { SessionPaneRecord } from './sessionPanes';
import type { SessionMetaValue } from './useSessionLaunch';
import type { AplexerRef } from './useSessionRename';
import type { useComposerStore } from './stores/composer';
import type { useConnectionStore } from './stores/connection';
import type { useProjectsStore } from './stores/projects';
import type { useSessionsStore } from './stores/sessions';

export interface SessionStopDeps {
  connection: ReturnType<typeof useConnectionStore>;
  projects: ReturnType<typeof useProjectsStore>;
  sessions: ReturnType<typeof useSessionsStore>;
  composer: ReturnType<typeof useComposerStore>;
  /** The aplexer address for a session name, or undefined for a tmux row. */
  aplexerRefFor: (name: string) => AplexerRef | undefined;
  /** The workspace-qualified identity for a session name (see the view). */
  identityFor: (name: string, like?: string) => string;
  sessionMeta: ComputedRef<Map<string, SessionMetaValue>>;
  openPanes: Ref<SessionPaneRecord[]>;
  /** The tab strip's error channel — the refusal sentences render under the bar. */
  createError: Ref<string | null>;
  /** The one close-selection path, called while the bar still holds the tab. */
  selectAfterClose: (id: string) => void;
}

/**
 * Stopping a session: the named confirmation and the kill that takes down
 * everything the desktop keeps under the session's name.
 *
 * The only destructive action in this app, which is why the dialog names the
 * SESSION and why the `×` and the menu item only ever arm {@link stopping} —
 * the kill itself stays in `confirmStop`, behind a confirm. Extracted from the
 * folder workspace; the view's menu wiring decides when to arm it.
 */
export function useSessionStop(deps: SessionStopDeps): {
  stopping: Ref<string | null>;
  stopBusy: Ref<boolean>;
  confirmStop: () => Promise<void>;
} {
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
   * The dialog names the SESSION. With labels verbatim this is the same string
   * the tab shows — and it stays the full name, so a folder's tab reading `main`
   * never leaves the user guessing which workspace's `main` is being destroyed.
   */
  const stopping = ref<string | null>(null);
  const stopBusy = ref(false);

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
    const connectionId = deps.connection.connectionId;
    if (!session || !connectionId) {
      stopping.value = null;
      return;
    }
    stopBusy.value = true;
    try {
      let result: Awaited<ReturnType<typeof deps.projects.killSession>>;
      try {
        result = await deps.projects.killSession(connectionId, session, deps.aplexerRefFor(session));
      } catch (e) {
        // A rejected invoke is a failed kill like any other. Let it escape and
        // `stopBusy` stays latched — the Stop button dead until remount.
        deps.createError.value = errorMessage(e);
        return;
      }
      if (!result.ok && result.code !== 'not-found') {
        deps.createError.value = result.error ?? `Could not stop "${session}".`;
        return;
      }
      deps.selectAfterClose(session);
      // Resolved BEFORE the row comes off the bar: the identity reads the row's
      // workspace, and once the row is gone a lookup falls back to the bare
      // name — which for an aplexer session is a different key, and the pane
      // record and the composer draft below would be filed against a key
      // nothing will ever match again.
      const killedIdentity = deps.identityFor(session);
      // The row comes off the bar NOW, not when the refresh lands — the host's
      // listing can still carry the session it is tearing down (doc comment
      // above).
      deps.sessions.removeLocal(
        session,
        deps.sessionMeta.value.get(session)?.workspace ?? undefined,
      );
      deps.openPanes.value = deps.openPanes.value.filter((pane) => pane.identity !== killedIdentity);
      deps.composer.forget(deps.composer.targetKey(connectionId, session, killedIdentity));
    } finally {
      stopBusy.value = false;
      stopping.value = null;
    }
    await deps.sessions.refresh(connectionId);
  }

  return { stopping, stopBusy, confirmStop };
}
