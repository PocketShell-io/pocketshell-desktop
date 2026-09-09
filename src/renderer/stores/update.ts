import { defineStore } from 'pinia';
import { api } from '../ipc';

/** Why the update banner is (or is not) on screen — see main/release. */
type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'failed';

interface UpdateState {
  status: UpdateStatus;
  tagName: string | null;
  downloadUrl: string | null;
  notesUrl: string | null;
  currentVersion: string | null;
  reason: string | null;
}

/**
 * The update banner's model, and nothing more.
 *
 * One check per launch, fired from App.vue's mount, plus an explicit re-check
 * from the settings screen. The checker in main never throws (it answers
 * `failed` with a reason), so the store's job is only to hold the answer and
 * to keep `failed` from being a silent state — the last failure reason stays
 * readable where the check was asked for.
 */
export const useUpdateStore = defineStore('update', {
  state: (): UpdateState => ({
    status: 'idle',
    tagName: null,
    downloadUrl: null,
    notesUrl: null,
    currentVersion: null,
    reason: null,
  }),
  actions: {
    async check(): Promise<void> {
      this.status = 'checking';
      try {
        const result = await api.update.check();
        this.currentVersion = result.currentVersion;
        if (result.status === 'available') {
          this.status = 'available';
          this.tagName = result.tagName;
          this.downloadUrl = result.downloadUrl;
          this.notesUrl = result.notesUrl;
          this.reason = null;
        } else if (result.status === 'up-to-date') {
          this.status = 'up-to-date';
          this.tagName = null;
          this.downloadUrl = null;
          this.notesUrl = null;
          this.reason = null;
        } else {
          this.status = 'failed';
          this.tagName = null;
          this.downloadUrl = null;
          this.notesUrl = null;
          this.reason = result.reason;
        }
      } catch (err) {
        // The checker never throws by design; a throw here is a transport
        // failure in the bridge itself, and the store still must not dangle
        // in `checking`.
        this.status = 'failed';
        this.reason = err instanceof Error ? err.message : String(err);
      }
    },
  },
});
