import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import { errorMessage } from '../../shared/errors';
import type { ConnectionId } from '../../shared/types';
import type { AplexerWarning } from '../../shared/aplexer';

/**
 * Crash warnings store: the unacknowledged aplexer crash/OOM warnings for
 * the active connection, as `a warnings --json` reports them.
 *
 * Deliberately its own store rather than a corner of the sessions store: a
 * warning OUTLIVES its session — `a prune` drops the record, the warning
 * stays — so its lifecycle is not the session list's. `refresh` is total
 * (never throws): a failed read keeps the previous list, because blanking
 * the strip on one bad round trip is how a crash stops being visible, and
 * visibility is the whole point. The panel's poll calls it every tick, so
 * a dropped tick costs five seconds, not the feature.
 */
export const useWarningsStore = defineStore('warnings', () => {
  const warnings = ref<AplexerWarning[]>([]);
  const ackError = ref<string | null>(null);

  async function refresh(connectionId: ConnectionId): Promise<void> {
    try {
      warnings.value = await api.helper.warnings(connectionId);
    } catch {
      // Keep the previous list; the next poll tick asks again.
    }
  }

  /**
   * `a ack [SESSION]`, then re-read. A real failure surfaces in the strip
   * (`ackError`); `notFound` — another client acked first — is not an
   * error, and the refresh that follows settles the list either way: the
   * goal state "no warning showing" is already true in that race.
   */
  async function ack(connectionId: ConnectionId, target?: string): Promise<void> {
    ackError.value = null;
    try {
      const outcome = await api.helper.ackWarnings(connectionId, target);
      if (outcome.error) {
        ackError.value = outcome.error;
        return;
      }
    } catch (e) {
      ackError.value = errorMessage(e);
      return;
    }
    await refresh(connectionId);
  }

  return { warnings, ackError, refresh, ack };
});
