import { defineStore } from 'pinia';
import { ref } from 'vue';
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
 * aplexer UUID (`StartSessionResult`) — and {@link addPending} files it here,
 * straight into {@link sessions}. The panel tree, the workspace tab bar,
 * `sessionMeta` and the aplexer join all see the new session with zero round
 * trips, and the next refresh replaces the list wholesale — the optimistic
 * row gives way to the authoritative one, wherever it came from (the panel's
 * five-second poll, most likely). A pending row that no refresh confirms is
 * dropped after {@link PENDING_TTL_MS}: the create is over by then, and a row
 * only the optimist believes in must not sit on the bar forever.
 */
export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionSummary[]>([]);
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
  const pendingRows = ref<PendingRow[]>([]);

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

  /**
   * File an optimistic row for a session the host just confirmed.
   *
   * It goes straight onto {@link sessions} — the tree re-derives this tick —
   * and onto the pending ledger, which is what lets the NEXT refresh tell
   * "confirmed" from "never came true". Replaces any pending row with the
   * same identity first: a second create under the same name is the
   * replace-the-slot case, not a duplicate.
   */
  function addPending(summary: SessionSummary, now: number = Date.now()): void {
    const id = identity(summary);
    pendingRows.value = [
      ...pendingRows.value.filter((row) => identity(row.summary) !== id),
      { summary, at: now },
    ];
    sessions.value = [summary, ...sessions.value.filter((s) => identity(s) !== id)];
  }

  /**
   * Fold the pending ledger into a freshly fetched list.
   *
   * A pending row whose identity the host now lists is confirmed — drop the
   * ledger entry, the fetched row is the truth. One the host does not list is
   * kept ONLY while it is inside its TTL, prepended so it stays at the top of
   * the recency sort; past the TTL it was never real and is dropped.
   */
  function mergePending(fetched: SessionSummary[], now: number = Date.now()): SessionSummary[] {
    if (pendingRows.value.length === 0) return fetched;
    const seen = new Set(fetched.map(identity));
    const stillPending: PendingRow[] = [];
    const unconfirmed: SessionSummary[] = [];
    for (const row of pendingRows.value) {
      if (seen.has(identity(row.summary))) continue;
      if (now - row.at > PENDING_TTL_MS) continue;
      stillPending.push(row);
      unconfirmed.push(row.summary);
    }
    pendingRows.value = stillPending;
    return [...unconfirmed, ...fetched];
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
      sessions.value = mergePending(await api.helper.sessionsList(connectionId, 'activity'));
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
    sessions.value = [];
    pendingRows.value = [];
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
