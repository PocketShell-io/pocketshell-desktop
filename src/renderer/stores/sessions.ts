import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, SessionSummary } from '../../shared/types';
import { errorMessage } from '../../shared/errors';
import type { StartSessionResult } from '../../main/projects/ProjectsService';

/**
 * Sessions store: the live session tree for the active connection.
 * Refreshed from `a snapshot --json` merged over `pocketshell sessions list`
 * (with a raw-tmux fallback baked into the main process).
 *
 * ## Pending rows: a session is on the bar the moment the host names it
 *
 * A create used to sit the renderer in front of a full listing before the new
 * session existed anywhere in the UI: start → `sessions.refresh` → derive the
 * tree → select the tab → open the terminal. The refresh is the slowest call
 * in the app (`pocketshell sessions list` is a Python program under a login
 * shell, twice over on a tmux host), and it stood between the click and the
 * terminal on the app's latency-critical path. The user's bar is "agent
 * working inside a second".
 *
 * So the create hands back everything the row needs — name, folder, backend,
 * aplexer UUID (`StartSessionResult`) — and {@link addPending} files it here.
 * {@link sessions} merges pending rows over the fetched list, so the panel
 * tree, the workspace tab bar, `sessionMeta` and the aplexer join all see the
 * new session with zero round trips, and the first refresh — the panel's
 * five-second poll, most likely — replaces the optimistic row with the
 * authoritative one. A pending row that a refresh NEVER confirms is dropped
 * after {@link PENDING_TTL_MS}: the create is over by then, and a row only the
 * optimist believes in must not sit on the bar forever.
 */
export const useSessionsStore = defineStore('sessions', () => {
  const fetched = ref<SessionSummary[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * How long a pending row survives without a refresh confirming it.
   *
   * Generous against the poll (5s) because the poll skips a hidden window —
   * a laptop in a bag must not come back to a bar that pruned its newest tab
   * while it slept. Thirty seconds is still far past any point at which an
   * unconfirmed row is likelier to be a failed create than a slow listing.
   */
  const PENDING_TTL_MS = 30_000;

  /** A pending row: the optimistic summary and when it was filed. */
  interface PendingRow {
    summary: SessionSummary;
    at: number;
  }
  const pending = ref<PendingRow[]>([]);

  /**
   * The identity two rows must agree on to be the same session.
   *
   * Name alone is the tmux identity and near enough for the merge — a name is
   * host-unique among live tmux sessions, and an aplexer tag is filed under
   * its workspace, which the pending row always carries. The workspace is in
   * the key so a same-named tag from another folder can never make a refresh
   * "confirm" the wrong pending row.
   */
  function identity(s: Pick<SessionSummary, 'name' | 'workspace'>): string {
    return `${s.workspace ?? ''}\u0000${s.name}`;
  }

  /** The live list: pending rows not yet confirmed, over the fetched tree. */
  const sessions = computed<SessionSummary[]>(() => {
    if (pending.value.length === 0) return fetched.value;
    const seen = new Set(fetched.value.map(identity));
    const optimistic = pending.value
      .filter((row) => !seen.has(identity(row.summary)))
      .map((row) => row.summary);
    return [...optimistic, ...fetched.value];
  });

  /**
   * File an optimistic row for a session the host just confirmed.
   *
   * Replaces any pending row with the same identity first — a second create
   * for the same folder under the same name is the replace-the-slot case, not
   * a duplicate.
   */
  function addPending(summary: SessionSummary, now: number = Date.now()): void {
    const id = identity(summary);
    pending.value = [
      ...pending.value.filter((row) => identity(row.summary) !== id),
      { summary, at: now },
    ];
  }

  /** Drop pending rows past their TTL, and ones the fetched list confirmed. */
  function prunePending(now: number = Date.now()): void {
    if (pending.value.length === 0) return;
    const seen = new Set(fetched.value.map(identity));
    pending.value = pending.value.filter(
      (row) => now - row.at <= PENDING_TTL_MS && !seen.has(identity(row.summary)),
    );
  }

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
      fetched.value = await api.helper.sessionsList(connectionId, 'activity');
      prunePending();
    } catch (e) {
      error.value = errorMessage(e);
    } finally {
      if (!options?.quiet) loading.value = false;
    }
  }

  /**
   * Project a start result into the row the tree files under its folder.
   *
   * The one place that knows how `StartSessionResult` maps onto
   * `SessionSummary`, so the dialog's create and the workspace's `+` cannot
   * build two different shapes of the same optimism. Timestamps are floor'd to
   * epoch SECONDS — the field the panel's relative clock reads. `agentKind`
   * stays null on purpose: the agent the launch will type has not run yet, and
   * the next authoritative refresh carries what the host recorded.
   */
  function summaryFromStartResult(
    result: StartSessionResult,
    fallbackFolder: string | null,
    now: number = Date.now(),
  ): SessionSummary | null {
    if (!result.ok || !result.sessionName) return null;
    const seconds = Math.floor(now / 1000);
    const folder = result.folder ?? fallbackFolder;
    const aplexer = result.via === 'aplexer';
    return {
      name: result.sessionName,
      created: seconds,
      activity: seconds,
      attached: false,
      path: folder,
      ...(aplexer
        ? {
            backend: 'aplexer' as const,
            workspace: result.folder,
            tag: result.sessionName,
            aplexerId: result.aplexerId,
            aplexerPhase: 'running',
          }
        : {}),
    };
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
    fetched.value = [];
    pending.value = [];
    error.value = null;
  }

  return {
    sessions,
    loading,
    error,
    refresh,
    addPending,
    summaryFromStartResult,
    clear,
  };
});
