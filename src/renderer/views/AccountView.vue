<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { api } from '../ipc';
import { useConnectionStore } from '../stores/connection';
import { useSettingsStore } from '../stores/settings';
import { useSyncStore } from '../stores/sync';

const connection = useConnectionStore();
const settings = useSettingsStore();
const sync = useSyncStore();

const signedIn = computed(() => sync.status?.loggedIn === true);
const accountUnavailable = computed(
  () => sync.status !== null && !sync.status.keychainAvailable,
);
const accountLoaded = computed(() => sync.accountHosts !== null);
const accountCheckLabel = computed(() => (accountLoaded.value ? 'Refresh account' : 'Check account'));

interface HostRow {
  name: string;
  hostname: string;
  local: boolean;
  selected: boolean;
  inAccount: boolean;
  statusLabel: string;
  statusKind: 'synced' | 'pending' | 'muted';
}

/**
 * Join the local config with the last decrypted account copy. Keeping the two
 * sources visible is important: "selected here" is not the same as "already
 * in the account", and a remote-only host is still useful backup data.
 */
const hostRows = computed<HostRow[]>(() => {
  const localByName = new Map(connection.hosts.map((host) => [host.name, host]));
  const remoteByName = new Map((sync.accountHosts ?? []).map((host) => [host.name, host]));
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])];

  return names.map((name) => {
    const local = localByName.get(name);
    const remote = remoteByName.get(name);
    const inAccount = remote !== undefined;
    const selected = settings.syncSelectedHosts.includes(name);
    let statusLabel = selected ? 'Selected here' : 'Not selected';
    let statusKind: HostRow['statusKind'] = selected ? 'pending' : 'muted';

    if (accountLoaded.value) {
      if (inAccount && !local) {
        statusLabel = 'In account · not on this machine';
        statusKind = 'synced';
      } else if (inAccount && !selected) {
        statusLabel = 'In account · remove on sync';
        statusKind = 'synced';
      } else if (inAccount) {
        statusLabel = 'In account';
        statusKind = 'synced';
      } else if (selected) {
        statusLabel = 'Selected here · not synced';
      }
    }

    return {
      name,
      hostname: local?.hostname ?? remote?.hostname ?? '',
      local: local !== undefined,
      selected,
      inAccount,
      statusLabel,
      statusKind,
    };
  });
});

async function refreshStatus(): Promise<void> {
  try {
    await sync.refreshStatus();
  } catch (err) {
    sync.message = { kind: 'error', text: (err as Error).message };
  }
}

onMounted(async () => {
  api.win.setTitle('Account & sync — PocketShell');
  await Promise.all([connection.loadHosts().catch(() => undefined), refreshStatus()]);
});

function onLogin(): void {
  void sync.login();
}

function onLogout(): void {
  void sync.logout().catch((err: unknown) => {
    sync.message = { kind: 'error', text: (err as Error).message };
  });
}

function onCheckAccount(): void {
  void sync.loadAccount();
}
</script>

<template>
  <main class="account-view">
    <div class="account-shell">
      <header class="account-header">
        <p class="account-eyebrow">ACCOUNT &amp; SYNC</p>
        <h1>Account &amp; sync</h1>
        <p class="account-intro">
          Sign in once, then choose which SSH hosts this account keeps available
          across your PocketShell devices.
        </p>
      </header>

      <section class="account-card">
        <div class="card-heading">
          <div>
            <h2>Google account</h2>
            <p class="card-copy">Your Google password is handled only by Google.</p>
          </div>
          <span v-if="signedIn" class="signed-in-mark">Signed in</span>
        </div>

        <div v-if="signedIn" class="account-identity">
          <span class="identity-dot" aria-hidden="true" />
          <span>{{ sync.status?.email ?? 'Your Google account' }}</span>
          <button class="btn-ghost" :disabled="sync.busy" @click="onLogout">Sign out</button>
        </div>
        <div v-else class="account-login">
          <button
            class="account-primary"
            :disabled="sync.busy || accountUnavailable"
            :aria-busy="sync.busy"
            @click="onLogin"
          >
            {{ sync.busy ? 'Opening Google…' : 'Sign in with Google' }}
          </button>
          <p v-if="accountUnavailable" class="card-note error-text">
            This system does not have an OS keychain available, so PocketShell
            cannot store sign-in tokens safely.
          </p>
        </div>
      </section>

      <section class="account-card">
        <div class="card-heading">
          <div>
            <h2>Sync passphrase</h2>
            <p class="card-copy">
              Used to encrypt your selected host entries before they leave this
              device. It is separate from your Google password and stays in
              memory only.
            </p>
          </div>
        </div>
        <label class="passphrase-field">
          <span class="sr-only">Sync passphrase</span>
          <input
            type="password"
            autocomplete="new-password"
            placeholder="Enter a passphrase"
            :value="sync.passphrase"
            :disabled="!signedIn || sync.busy"
            @input="sync.passphrase = ($event.target as HTMLInputElement).value"
          />
        </label>
        <p class="card-note">
          Use the same passphrase on each device. PocketShell does not save it;
          if you forget it, you can create a new encrypted copy but cannot open
          the old one.
        </p>
      </section>

      <section class="account-card">
        <div class="card-heading host-heading">
          <div>
            <h2>Hosts in your account</h2>
            <p class="card-copy">
              See what is already synced, what is selected on this machine, and
              what will be included the next time you sync.
            </p>
          </div>
          <button
            class="btn-ghost"
            :disabled="sync.busy || !signedIn"
            @click="onCheckAccount"
          >
            {{ accountCheckLabel }}
          </button>
        </div>

        <p v-if="signedIn && !accountLoaded" class="account-note">
          Enter your passphrase and choose <strong>Check account</strong> to
          compare this machine with the encrypted account copy.
        </p>
        <ul v-if="hostRows.length" class="account-host-list">
          <li v-for="host in hostRows" :key="host.name" class="account-host-row">
            <label class="host-select">
              <input
                type="checkbox"
                :checked="host.selected"
                :disabled="sync.busy || !signedIn"
                @change="sync.setSelected(host.name, ($event.target as HTMLInputElement).checked)"
              />
              <span class="host-details">
                <span class="host-alias">{{ host.name }}</span>
                <span class="host-destination">{{ host.hostname }}</span>
              </span>
            </label>
            <span class="status-chip" :class="'status-' + host.statusKind">
              {{ host.statusLabel }}
            </span>
          </li>
        </ul>
        <p v-else class="account-note">
          {{ accountLoaded ? 'No hosts are in this account yet.' : 'No hosts loaded yet.' }}
        </p>
      </section>

      <section class="account-actions">
        <div>
          <h2>Sync now</h2>
          <p class="card-copy">
            Uploads the selected hosts and restores account hosts missing from
            this machine's <code>~/.ssh/config</code>.
          </p>
        </div>
        <button
          class="account-primary"
          :disabled="sync.busy || !signedIn || settings.syncSelectedHosts.length === 0"
          @click="sync.syncNow()"
        >
          {{ sync.busy ? 'Syncing…' : 'Sync now' }}
        </button>
      </section>

      <p
        v-if="sync.message"
        class="account-message"
        :class="'message-' + sync.message.kind"
        :role="sync.message.kind === 'error' ? 'alert' : 'status'"
      >
        {{ sync.message.text }}
      </p>
    </div>
  </main>
</template>

<style scoped>
.account-view {
  min-height: 100vh;
  box-sizing: border-box;
  padding: var(--sp-6) var(--sp-5) var(--sp-8);
  background: var(--bg);
}
.account-shell {
  width: min(100%, 680px);
  margin: 0 auto;
}
.account-header {
  padding-bottom: var(--sp-5);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--sp-4);
}
.account-eyebrow {
  margin: 0 0 var(--sp-2);
  color: var(--fg-muted);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.12em;
}
h1,
h2,
p {
  margin-top: 0;
}
h1 {
  margin-bottom: var(--sp-2);
  color: var(--fg);
  font-size: var(--fs-600);
  line-height: var(--lh-600);
}
h2 {
  margin-bottom: var(--sp-1);
  color: var(--fg);
  font-size: var(--fs-400);
  line-height: var(--lh-400);
}
.account-intro,
.card-copy,
.card-note,
.account-note {
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.account-intro {
  max-width: 54ch;
  margin-bottom: 0;
}
.account-card {
  margin-bottom: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--surface);
}
.card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}
.card-copy {
  max-width: 58ch;
  margin-bottom: 0;
}
.signed-in-mark {
  flex: none;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--success-soft);
  color: var(--success);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
}
.account-identity,
.account-login {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
.account-identity .btn-ghost {
  margin-left: auto;
}
.identity-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
}
.account-primary {
  min-height: var(--control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--sp-3);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  color: var(--on-accent);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.account-primary:hover:not(:disabled) {
  border-color: var(--accent-dim);
  background: var(--accent-dim);
  color: var(--fg);
}
.account-primary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.error-text {
  color: var(--error);
}
.passphrase-field {
  display: block;
  margin-top: var(--sp-4);
}
.passphrase-field input {
  width: min(100%, 360px);
  box-sizing: border-box;
  height: var(--control-h);
  padding: 0 var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--fg);
  font: inherit;
}
.passphrase-field input:focus {
  outline: 2px solid var(--accent-dim);
  outline-offset: 1px;
}
.passphrase-field input:disabled {
  opacity: var(--disabled-opacity);
}
.card-note {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-200);
}
.host-heading {
  align-items: center;
}
.host-heading .btn-ghost {
  flex: none;
}
.account-note {
  margin: var(--sp-3) 0 0;
}
.account-host-list {
  max-height: 18rem;
  overflow-y: auto;
  margin: var(--sp-4) 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
}
.account-host-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: 3.25rem;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
}
.account-host-row:last-child {
  border-bottom: none;
}
.host-select {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: var(--sp-2);
  cursor: pointer;
}
.host-select input {
  flex: none;
  accent-color: var(--accent);
}
.host-details {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.host-alias,
.host-destination {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-alias {
  color: var(--fg);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
}
.host-destination {
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.status-chip {
  flex: none;
  max-width: 15rem;
  overflow: hidden;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-synced {
  background: var(--success-soft);
  color: var(--success);
}
.status-pending {
  background: var(--accent-soft);
  color: var(--accent);
}
.status-muted {
  background: var(--surface-2);
  color: var(--fg-muted);
}
.account-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-1) 0;
}
.account-actions h2,
.account-actions .card-copy {
  margin-bottom: 0;
}
.account-actions .account-primary {
  flex: none;
}
.account-message {
  margin: var(--sp-3) 0 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.message-ok {
  background: var(--success-soft);
  color: var(--success);
}
.message-error {
  background: var(--error-soft);
  color: var(--error);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
code {
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
@media (max-width: 560px) {
  .account-view {
    padding: var(--sp-4) var(--sp-3) var(--sp-6);
  }
  .card-heading,
  .account-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .host-heading .btn-ghost,
  .account-actions .account-primary {
    align-self: flex-start;
  }
  .account-host-row {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .status-chip {
    margin-left: calc(var(--sp-2) + 16px);
  }
}
</style>
