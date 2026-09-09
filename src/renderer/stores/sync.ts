import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import { useConnectionStore } from './connection';
import { useSettingsStore } from './settings';
import {
  aliasesToAutoCheck,
  assembleSyncSet,
  parseSyncPayload,
  serializeSyncPayload,
} from '../../shared/syncMerge';
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
 * WHICH hosts sync is the settings store's `syncSelectedHosts`, persisted
 * per machine — persisting the selection is the opposite trade from the
 * passphrase: a forgotten selection is the dangerous direction, since a
 * relaunch that reset every tick to off would let an innocent "Sync now"
 * push an empty list and wipe the account.
 *
 * `syncNow` is the whole feature in one action: pull the account, absorb
 * its aliases into the selection (a sync never silently drops another
 * machine's hosts), assemble the ticked set (local entry when the config
 * has the alias, the account's when it does not), push, and add anything
 * the config file is missing. A 409 from a concurrent writer is re-based
 * and retried; each retry re-absorbs, so it cannot compound.
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

  /** Tick or untick one alias. Unticked hosts never leave this machine. */
  function setSelected(alias: string, selected: boolean): void {
    const settings = useSettingsStore();
    const has = settings.syncSelectedHosts.includes(alias);
    // A redundant tick must not MOVE the alias: the list's order is the
    // user's, and a re-click on an already-ticked box is not a reorder.
    if (selected === has) return;
    const rest = settings.syncSelectedHosts.filter((name) => name !== alias);
    settings.syncSelectedHosts = selected ? [...rest, alias] : rest;
  }

  /**
   * Pulled aliases join the selection — but only ones this machine's config
   * lacks. An alias the config has is one the user can see and has decided
   * about, so their untick must survive the next pull; an unknown alias is
   * another machine's host arriving, and it ticks on so the push re-uploads
   * the account instead of wiping it.
   */
  function absorbRemoteAliases(remote: readonly HostEntry[]): void {
    const settings = useSettingsStore();
    const missing = aliasesToAutoCheck(
      remote,
      settings.syncSelectedHosts,
      useConnectionStore().hosts.map((host) => host.name),
    );
    if (missing.length > 0) settings.syncSelectedHosts = [...settings.syncSelectedHosts, ...missing];
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
    const settings = useSettingsStore();
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
        absorbRemoteAliases(remoteHosts);
      }
      if (settings.syncSelectedHosts.length === 0) {
        message.value = { kind: 'error', text: 'Tick at least one host to sync.' };
        return;
      }

      // 2. The payload IS the selection — unticked hosts never leave the
      // machine — so this push replaces the account's content with the
      // ticked set.
      let set = assembleSyncSet(connection.hosts, remoteHosts, settings.syncSelectedHosts);
      if (set.length === 0) {
        message.value = { kind: 'error', text: 'None of the ticked hosts exists here or in the account.' };
        return;
      }

      // 3. Push on the version just pulled; a 409 (another device pushed
      // first) re-pulls, absorbs its aliases, re-assembles, retries.
      for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt++) {
        const pushed = await api.sync.push(SYNC_SLOT, serializeSyncPayload(set), passphrase.value, baseVersion);
        if (pushed.kind === 'ok') break;
        if (pushed.kind === 'error') throw new Error(pushed.message);
        if (attempt === CONFLICT_RETRIES) throw new Error('the account kept changing — try again in a moment');
        const repulled = await api.sync.pull(SYNC_SLOT, passphrase.value);
        if (repulled.kind !== 'ok') throw new Error('the account changed while syncing — try again');
        baseVersion = repulled.version;
        const reparsed = parseSyncPayload(repulled.plaintext);
        absorbRemoteAliases(reparsed);
        set = assembleSyncSet(connection.hosts, reparsed, settings.syncSelectedHosts);
      }

      // 4. Restore path: the synced set is offered to main, which appends
      // whatever ~/.ssh/config is actually missing (it re-checks against the
      // FILE, not this list — a host hand-added since loadHosts is never
      // duplicated).
      const applied = await api.sync.applyHosts(set);
      await connection.loadHosts();

      const total = set.length;
      const parts: string[] = [`${total} host${total === 1 ? '' : 's'} in your account`];
      if (applied.added.length > 0) parts.push(`added ${applied.added.length} to ~/.ssh/config`);
      message.value = { kind: 'ok', text: `Synced: ${parts.join(', ')}.` };
    } catch (err) {
      message.value = { kind: 'error', text: (err as Error).message };
    } finally {
      busy.value = false;
    }
  }

  return {
    status,
    passphrase,
    busy,
    message,
    refreshStatus,
    setSelected,
    login,
    logout,
    syncNow,
  };
});
