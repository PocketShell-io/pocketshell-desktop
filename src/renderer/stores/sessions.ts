import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, SessionSummary } from '../../shared/types';
import { errorMessage } from '../../shared/errors';

/**
 * Sessions store: the live session tree for the active connection.
 * Refreshed from `a snapshot --json` merged over `pocketshell sessions list`
 * (with a raw-tmux fallback baked into the main process).
 */
export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionSummary[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * Re-read the host's live session list.
   *
   * `quiet` exists for the session panel's background poll and it toggles ONE
   * thing: whether `loading` moves. `loading` is not "a request is in flight",
   * it is "the user asked for this and is waiting" — it spins the panel's
   * Refresh glyph and disables the button. A poll that set it would spin that
   * glyph for a fraction of a second every few seconds forever, which reads as
   * the panel permanently working rather than as it quietly keeping up.
   *
   * `error` is deliberately NOT quietened, and that is the half that matters
   * for correctness. A poll that fails leaves the previous list in place —
   * there is nothing better to show, and blanking the panel on one bad round
   * trip would be worse than showing a list that is a few seconds old — so the
   * only thing standing between the user and a stale tree is this message. A
   * folder row that should have vanished and did not is exactly the state that
   * has to come with a reason attached.
   */
  async function refresh(connectionId: ConnectionId, options?: { quiet?: boolean }): Promise<void> {
    if (!options?.quiet) loading.value = true;
    error.value = null;
    try {
      sessions.value = await api.helper.sessionsList(connectionId, 'activity');
    } catch (e) {
      error.value = errorMessage(e);
    } finally {
      if (!options?.quiet) loading.value = false;
    }
  }

  // There is deliberately NO `create(name, cwd)` here any more.
  //
  // It existed only for SessionTree's bare "new session name" field, which had
  // the model backwards: a session belongs to a project FOLDER and its name is
  // derived from that folder, so a typed name produced sessions the Android
  // client and `tmuxctl` could not group with anything. The field and this
  // action went together; creation now runs through
  // `useProjectsStore().start()` -> `projects:startSession`, which derives the
  // name host-side. `helper.sessionsCreate` survives on the preload as the
  // escape hatch for a caller that already knows the exact tmux name it wants.

  function clear(): void {
    sessions.value = [];
    error.value = null;
  }

  return { sessions, loading, error, refresh, clear };
});
