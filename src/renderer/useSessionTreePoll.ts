import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import type { useConnectionStore } from './stores/connection';
import type { useSessionsStore } from './stores/sessions';

export interface SessionTreePollDeps {
  connection: ReturnType<typeof useConnectionStore>;
  sessions: ReturnType<typeof useSessionsStore>;
}

/**
 * The session panel's two timers: the cosmetic minute clock behind the
 * relative timestamps, and the five-second poll that re-reads the host's
 * session list. Extracted from SessionTree.vue with their reasoning; the
 * panel calls this once and feeds `now` to the rows as a prop.
 */
export function useSessionTreePoll(deps: SessionTreePollDeps): { now: Ref<number> } {
  /**
   * Clock for the relative timestamps. The activity values only change when the
   * store refreshes, so this tick is cosmetic: it is what turns `59s` into `1m`
   * without a store round-trip.
   */
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | null = null;

  /**
   * How often the panel re-reads the host's session list.
   *
   * ## Why this exists at all
   *
   * Because the rest of the app already believed it did.
   * refers to "the refresh timer" a dozen times over — the
   * argument against keying a row's shape off `directories.length`, the
   * rule that expansion state must never watch the root list, the tab order
   * being stored as a RANKING because "sessions arrive on the refresh timer, and
   * vanish when they are killed here, from the phone or from the user's own
   * terminal", and the repo-root cache recording negatives so it does not put a
   * git process on the host "every few seconds forever". Every one of those is a
   * decision taken to survive a poll. The poll was not here. The only
   * `setInterval` in the whole renderer was the cosmetic clock above.
   *
   * The symptom is precisely the one reported: a session that goes away leaves
   * its folder row sitting in the panel. The store is only re-read on mount, on
   * the Refresh button, and at the few call sites that follow their own write —
   * so a session stopped from the phone, from a terminal, by an agent exiting,
   * or by a stop whose follow-up refresh did not land, stays on screen until the
   * user hits Refresh or navigates somewhere that happens to re-read it. The
   * folder row is not wrong about anything; nothing ever told it.
   *
   * ## Why five seconds
   *
   * It is the "every few seconds" the repo-root cache was already designed
   * against, and it is the interval the port dashboard settled on for the same
   * kind of question. It has to be well under a minute for "I stopped it and it
   * is still there" to stop being a bug report, and well over one second for the
   * two execs a listing costs not to be a load on someone's box.
   */
  const POLL_MS = 5_000;
  let poll: ReturnType<typeof setInterval> | null = null;
  /**
   * Guards against a second listing being issued while the first is still out.
   *
   * A slow host is the case this is for: five seconds is shorter than a round
   * trip over a bad link, and without the guard each tick would stack another
   * pair of execs on a connection that is already struggling — the classic way a
   * poll turns a slow host into an unusable one.
   */
  let polling = false;

  /**
   * One tick of the poll.
   *
   * Four things are skipped rather than merely tolerated:
   *
   *   - no connection, because there is nothing to ask;
   *   - `document.hidden`, because a window in the background has no reader and
   *     a laptop in a bag should not be holding an SSH connection busy;
   *   - a listing already in flight (see {@link polling});
   *   - a transport main has reported dead (`connection.state === 'lost'`),
   *     because the failure has already been surfaced once and a poll cannot
   *     revive a dead link — only the reconnect can. Ticking on would fail
   *     every five seconds forever, rewriting `sessions.error` with a raw IPC
   *     message each time, over the top of the one report that explains it.
   *
   * `quiet` keeps the Refresh glyph still: `loading` means "the user asked", and
   * a poll did not. See the store for the half of that decision that matters —
   * the error message is deliberately NOT quietened, because a stale tree with
   * no explanation is the state this whole timer exists to prevent.
   */
  async function pollSessions(): Promise<void> {
    const connectionId = deps.connection.connectionId;
    if (!connectionId || polling || document.hidden || deps.connection.state === 'lost') return;
    polling = true;
    try {
      await deps.sessions.refresh(connectionId, { quiet: true });
    } finally {
      polling = false;
    }
  }

  onMounted(() => {
    clock = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    // Two timers, not one, because they answer to different costs. The clock
    // above is free and only has to be fast enough to turn `59s` into `1m`; the
    // poll below costs two execs on the user's host and has to be fast enough
    // that a stopped session stops being on screen. Folding them together would
    // force one of those two numbers to be wrong.
    poll = setInterval(() => void pollSessions(), POLL_MS);
  });

  onBeforeUnmount(() => {
    if (clock !== null) clearInterval(clock);
    if (poll !== null) clearInterval(poll);
  });

  return { now };
}
