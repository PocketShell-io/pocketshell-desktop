import { ref, type Ref } from 'vue';
import { errorMessage } from '../shared/errors';
import { sessionIdentityKey } from './sessionIdentity';
import type { useComposerStore } from './stores/composer';
import type { useConnectionStore } from './stores/connection';
import type { useProjectsStore } from './stores/projects';
import type { useSessionsStore } from './stores/sessions';
import type { FolderMenuState } from './useFolderMenu';

/** What a confirmed Stop would kill: the folder's label and its snapshotted sessions. */
export interface FolderStopTarget {
  label: string;
  sessions: { name: string; workspace: string | null; aplexerId: string | null; backend: 'tmux' | 'aplexer' }[];
}

export interface FolderStopDeps {
  /** The row menu; `askStopFolder` consumes its snapshot and closes it. */
  folderMenu: Ref<FolderMenuState | null>;
  connection: ReturnType<typeof useConnectionStore>;
  projects: ReturnType<typeof useProjectsStore>;
  sessions: ReturnType<typeof useSessionsStore>;
  composer: ReturnType<typeof useComposerStore>;
}

/**
 * Stopping every session in a folder: the named confirmation and the
 * sequential kill that reports what survived. The session panel's mirror of
 * `useSessionStop` (the tab bar's single kill); extracted from SessionTree.vue
 * with its reasoning.
 */
export function useFolderStop(deps: FolderStopDeps): {
  stopping: Ref<FolderStopTarget | null>;
  stopBusy: Ref<boolean>;
  stopError: Ref<string | null>;
  stopFolderLabel: (count: number) => string;
  askStopFolder: () => void;
  confirmStopFolder: () => Promise<void>;
} {
  /* ── Stopping every session in a folder ───────────────────────────────
   * The row's second item, and the mirror of the first: `New session…` exists
   * because the row knows a folder the picker would otherwise make the user
   * browse back down to, and this exists because the row stands in for a SET of
   * sessions that has no other single lever. The workspace's tab menu can stop
   * one session; stopping a folder's four means opening
   * that workspace and confirming four times.
   *
   * It is called Stop, not Close, and that is not a synonym chosen at random.
   * `Close` in this app closes a TAB and leaves the session running; the word for
   * killing the tmux session is `Stop`, on the tab menu and in its dialog. Two
   * words for one destructive act, in two menus a click apart, is how a user ends
   * up believing one of them is the safe one.
   *
   * Everything the single-kill rule says holds here and is multiplied: no
   * undo, and each session is usually an agent mid-task. So the item is
   * separated, tinted, and behind a confirmation that NAMES the sessions — which
   * matters more from this panel than from the tab bar, because a folder row does
   * not show them. The one thing the user can see is a count.
   */
  const stopping = ref<FolderStopTarget | null>(null);
  const stopBusy = ref(false);
  /**
   * A refused batch, reported under the tree beside the store's own error.
   *
   * Separate from `sessions.error` on purpose: that ref belongs to the listing
   * and the poll rewrites it every five seconds, so a kill's refusal parked there
   * would be erased by the next successful tick — seconds after the user asked
   * for something that did not happen.
   */
  const stopError = ref<string | null>(null);

  /** `Stop session…` / `Stop all 3 sessions…` — the menu item's words. */
  function stopFolderLabel(count: number): string {
    return count === 1 ? 'Stop session…' : `Stop all ${count} sessions…`;
  }

  function askStopFolder(): void {
    const target = deps.folderMenu.value;
    deps.folderMenu.value = null;
    if (!target || !target.sessions.length) return;
    stopError.value = null;
    stopping.value = { label: target.label, sessions: target.sessions };
  }

  /**
   * Kill the folder's sessions, one at a time, and report what survived.
   *
   * SEQUENTIAL rather than `Promise.all`, for two reasons that both point the
   * same way. Each kill is an ssh exec on the user's host, and firing a folder's
   * worth at once is the load the session poll is already guarded against; and a
   * partial failure has to be reportable by NAME, which a settled array can give
   * but which is much easier to get wrong when the failures interleave.
   *
   * `not-found` counts as success, exactly as the single kill treats it
   *: the panel refreshes on a timer, so a session that
   * went away between the right-click and the confirm is the ordinary case, and
   * the state the user asked for is the state that exists.
   *
   * The refusal is worded as the tab bar words its own (`createError`): the
   * session in double quotes, and the host's sentence carried rather than
   * replaced. It names the sessions instead of counting them — `1 of 2` says how
   * much of the folder is still up, but not WHICH, and the name is the only half
   * of that the user can act on.
   *
   * The local teardown is per session too, and only for the ones that actually
   * died. The row leaves the store through `sessions.removeLocal` the moment
   * its kill resolves: the host's listing can lag the kill by seconds (`a kill`
   * answers ok once the worker accepts the stop, and the record leaves the
   * snapshot only when the worker has finished terminating the workload), and
   * until it catches up, a dead session that still looks live keeps its tab on
   * the bar and its "[process exited]" pane mounted underneath — precisely the
   * state a confirmed Stop exists to end. The composer record is dropped with
   * it, the third step of the stop sequence. The pool's client goes main-side from
   * the ipc handler whatever the caller is, and the workspace's mounted pane
   * unmounts as a consequence of the row: `sessionPanes` is filtered against
   * the live tabs, so a session that leaves the store takes its terminal with
   * it this tick, not on the listing's.
   *
   * The refresh runs even when everything failed. The list is what the user is
   * looking at, and it has to agree with the host whichever way the batch went.
   */
  async function confirmStopFolder(): Promise<void> {
    const target = stopping.value;
    const connectionId = deps.connection.connectionId;
    if (!target || !connectionId) {
      stopping.value = null;
      return;
    }
    stopBusy.value = true;
    const failed: string[] = [];
    let reason: string | null = null;
    try {
      for (const entry of target.sessions) {
        const { name } = entry;
        const killRef =
          entry.backend === 'aplexer'
            ? {
                backend: 'aplexer' as const,
                ...(entry.workspace ? { workspace: entry.workspace } : {}),
                ...(entry.aplexerId ? { aplexerId: entry.aplexerId } : {}),
              }
            : undefined;
        let result: Awaited<ReturnType<typeof deps.projects.killSession>>;
        try {
          result = await deps.projects.killSession(connectionId, name, killRef);
        } catch (e) {
          // A rejected invoke counts as a failed session and the batch moves
          // on — aborting the loop used to leave the remaining sessions
          // untouched with no report of any kind.
          failed.push(name);
          if (reason === null) reason = errorMessage(e);
          continue;
        }
        if (!result.ok && result.code !== 'not-found') {
          failed.push(name);
          if (reason === null) reason = result.error ?? null;
          continue;
        }
        // The row goes now, not when the refresh lands — the listing the
        // refresh asks for can still carry the session for a while after the
        // kill (see this function's doc comment).
        deps.sessions.removeLocal(name, entry.workspace ?? undefined);
        deps.composer.forget(
          deps.composer.targetKey(
            connectionId,
            name,
            sessionIdentityKey(name, { backend: entry.backend, workspace: entry.workspace ?? undefined }),
          ),
        );
      }
    } finally {
      // Whatever the batch did, the latch must lift: a `stopBusy` left true
      // disables the Stop action until the component remounts.
      stopBusy.value = false;
      stopping.value = null;
    }
    if (failed.length) {
      const names = failed.map((name) => `"${name}"`).join(', ');
      stopError.value = `Could not stop ${names} in ${target.label}.` + (reason ? ` ${reason}` : '');
    }
    await deps.sessions.refresh(connectionId);
  }

  return { stopping, stopBusy, stopError, stopFolderLabel, askStopFolder, confirmStopFolder };
}
