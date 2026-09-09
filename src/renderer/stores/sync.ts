import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import { useConnectionStore } from './connection';
import { mergeHostLists, parseSyncPayload, serializeSyncPayload } from '../../shared/syncMerge';
import { SYNC_SLOT } from '../../shared/syncConfig';
import type { SyncStatus } from '../../shared/sync';
import type { HostEntry } from '../../shared/types';

/**
 * The Account & sync section's model.
 *
 * Login state lives in MAIN (safeStorage-protected token file); this store
 * holds only what the UI renders — the status answer, one in-flight flag,
 * and the last outcome. The ONE thing this store owns persistently is
 * nothing: the sync passphrase lives in a plain ref, in memory, for the
 * session. It is deliberately NOT in the settings store / localStorage, for
 * the same reason it is not sent to the server — writing it to disk would
 * undo the zero-knowledge property the whole design is built on. A user who
 * syncs again after a relaunch types it again, which the section says out
 * loud.
 *
 * `syncNow` is the whole feature in one action: pull the account's blob,
 * merge (union by alias, local wins), push the merged list, and add any
 * hosts missing from ~/.ssh/config. A 409 from a concurrent writer is
 * re-based and retried — the merge is idempotent over its own output, so a
 * retry cannot compound.
 */

export interface SyncMessage {
  kind: 'ok' | 'error';
  text: string;
}

/** How many times a 409 (another device pushed first) is re-based before giving up. */
const CONFLICT_RETRIES = 3;

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus | null>(null);
  const passphrase = ref('');
  const busy = ref(false);
  const message = ref<SyncMessage | null>(null);

  async function refreshStatus(): Promise<void> {
    status.value = await api.sync.status();
  }

  async function login(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    message.value = null;
    try {
      const email = await api.sync.login();
      await refreshStatus();
      message.value = { kind: 'ok', text: `Signed in as ${email ?? 'your Google account'}.` };
    } catch (err) {
      message.value = { kind: 'error', text: (err as Error).message };
    } finally {
      busy.value = false;
    }
  }

  async function logout(): Promise<void> {
    busy.value = true;
    try {
      await api.sync.logout();
      passphrase.value = '';
      message.value = null;
      await refreshStatus();
    } finally {
      busy.value = false;
    }
  }

  async function syncNow(): Promise<void> {
    if (busy.value) return;
    if (!status.value?.loggedIn) {
      message.value = { kind: 'error', text: 'Sign in first.' };
      return;
    }
    if (passphrase.value === '') {
      message.value = { kind: 'error', text: 'Enter your sync passphrase.' };
      return;
    }
    const connection = useConnectionStore();
    busy.value = true;
    message.value = null;
    try {
      // 1. What the account holds. A wrong passphrase rejects here with
      // SyncCryptoError's message — that IS the user feedback.
      let baseVersion = 0;
      let remoteHosts: HostEntry[] = [];
      const pulled = await api.sync.pull(SYNC_SLOT, passphrase.value);
      if (pulled.kind === 'ok') {
        baseVersion = pulled.version;
        remoteHosts = parseSyncPayload(pulled.plaintext);
      }

      // 2. Union (local wins per alias) and push with conflict re-basing.
      let merged = mergeHostLists(connection.hosts, remoteHosts);
      for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt++) {
        const pushed = await api.sync.push(SYNC_SLOT, serializeSyncPayload(merged.hosts), passphrase.value, baseVersion);
        if (pushed.kind === 'ok') break;
        if (pushed.kind === 'error') throw new Error(pushed.message);
        // Someone else pushed first: re-read, re-merge, retry.
        if (attempt === CONFLICT_RETRIES) throw new Error('the account kept changing — try again in a moment');
        const repulled = await api.sync.pull(SYNC_SLOT, passphrase.value);
        if (repulled.kind !== 'ok') throw new Error('the account changed while syncing — try again');
        baseVersion = repulled.version;
        merged = mergeHostLists(merged.hosts, parseSyncPayload(repulled.plaintext));
      }

      // 3. Restore path: anything the account knows that ~/.ssh/config does
      // not is appended by main (which re-checks against the FILE, not this
      // list — a host hand-added since loadHosts is never duplicated).
      const applied = await api.sync.applyHosts(merged.hosts);
      await connection.loadHosts();

      const total = merged.hosts.length;
      const parts: string[] = [`${total} host${total === 1 ? '' : 's'} in your account`];
      if (applied.added.length > 0) parts.push(`added ${applied.added.length} to ~/.ssh/config`);
      message.value = { kind: 'ok', text: `Synced: ${parts.join(', ')}.` };
    } catch (err) {
      message.value = { kind: 'error', text: (err as Error).message };
    } finally {
      busy.value = false;
    }
  }

  return { status, passphrase, busy, message, refreshStatus, login, logout, syncNow };
});
