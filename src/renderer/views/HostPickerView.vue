<script setup lang="ts">
// Host picker: reads ~/.ssh/config, lists hosts, and connects on click.
// After a successful connect it navigates to the host workspace, where the
// session tree + terminal live.
//
// It is also the launch screen, so it owns the auto-connect to the user's
// default host. The rules for that decision are in ../autoConnect.ts; what
// lives here is only the dialling and the escape hatches, which are the part
// that matters:
//
//   - THE PICKER IS NEVER REPLACED BY A SPINNER. The host list stays on screen
//     for the whole attempt, with a banner above it. There is no state in which
//     the user is looking at a screen with nothing to press.
//   - CANCEL IS ALWAYS VISIBLE while dialling — for ANY dial, clicked or
//     automatic. A clicked dial hangs exactly as long as an automatic one (the
//     30s backstop below is one layer down from both), and every row is
//     disabled while one is out, so a picker without this strip is a picker
//     with nothing to press for half a minute. Pressing it abandons the
//     attempt immediately from the user's point of view, and hangs up on the
//     connection if it lands afterwards, so a cancelled dial cannot leave a
//     live link the user no longer wants.
//   - NO EXTRA RENDERER-SIDE TIMEOUT. `SshService.connect` already caps the
//     dial at DEFAULT_TIMEOUT_MS (30s) and resolves — never rejects — with a
//     real diagnostic. A second timer here would race it and would usually win,
//     replacing "All configured authentication methods failed" with a useless
//     "timed out". A bounded backstop plus an instant manual escape is what
//     "escapable" needs, and the bound already exists one layer down.
//   - A FAILED AUTO-CONNECT LEAVES THE DEFAULT ALONE. The error is shown on the
//     picker; the setting stays set, because a host being down is not a reason
//     to forget which host the user wants.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useSettingsStore } from '../stores/settings';
import { useSyncStore } from '../stores/sync';
import { api } from '../ipc';
import { windowTitle } from '../../shared/windowTitle';
import {
  autoConnectAttempted,
  decideAutoConnect,
  defaultHostStatus,
  markAutoConnectAttempted,
} from '../autoConnect';
import AppIcon from '../components/AppIcon.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import SettingsView from './SettingsView.vue';
import { readLastFolder } from '../workspaceState';
import type { HostEntry } from '../../shared/types';

const router = useRouter();
const connection = useConnectionStore();
const settings = useSettingsStore();
const sync = useSyncStore();
const connectError = ref<string | null>(null);
const connectingTo = ref<string | null>(null);
const settingsOpen = ref(false);
const reloadingHosts = ref(false);
const hostReloadError = ref<string | null>(null);

/** True while the in-flight dial was started by the app, not by a click.
 *  Only the banner's wording reads it now — "(your default host)" is the one
 *  thing an automatic dial says that a clicked one does not. */
const autoConnecting = ref(false);
/**
 * The in-flight dial's cancellation token, flipped by the banner's Cancel.
 *
 * A token per dial rather than the shared boolean this used to be, because a
 * boolean has to be reset by SOMETHING and every choice goes wrong once a
 * second dial can start while the first is still out — which is exactly what
 * Cancel enables, by re-enabling the rows. Reset at the next dial's start, and
 * cancelling A then clicking B un-cancels A the moment B begins, so A's late
 * success navigates after all; reset on resolution, and an abandoned dial's
 * verdict leaks into the next one. Each dial closes over its own token, so a
 * Cancel press can only ever mean the dial whose banner was on screen.
 */
let activeDial: { cancelled: boolean } | null = null;

const defaultMissing = computed(
  () => defaultHostStatus(settings.defaultHost, connection.hosts) === 'missing',
);

const accountSignedIn = computed(() => sync.status?.loggedIn === true);
const accountEmail = computed(() => sync.status?.email || 'Signed in');
const accountUnavailable = computed(
  () => sync.status !== null && sync.status !== undefined && !sync.status.keychainAvailable,
);
const accountAriaLabel = computed(() =>
  accountSignedIn.value
    ? `Google account: ${accountEmail.value}. Open account and sync settings`
    : sync.busy
      ? 'Signing in with Google'
      : 'Sign in with Google',
);

function onAccountAction(): void {
  if (accountSignedIn.value) {
    settingsOpen.value = true;
    return;
  }
  void sync.login();
}

/**
 * The host we are connected to right now, if any. Back from the workspace
 * keeps the link alive, so this list can be looked at WHILE connected — and
 * that row then behaves differently in three ways: its dot is green, clicking
 * it re-enters the workspace instead of dialling a second connection over the
 * first, and it carries the Disconnect button. Disconnect lives here rather
 * than in the workspace because every disconnect already navigated here — the
 * button now sits at its own destination, beside where the connection was
 * opened.
 */
const connectedName = computed(() =>
  connection.state === 'connected' && connection.connectionId
    ? (connection.activeHost?.name ?? null)
    : null,
);

onMounted(async () => {
  // Reclaim the OS window title from the workspace, which sets the host's
  // identity on it and deliberately does not reset it on unmount (mount order
  // during a route swap is not something to depend on).
  api.win.setTitle(windowTitle(null));
  // The picker only needs the small account state. Detailed sync controls stay
  // in Settings, but the header must know which compact action to show.
  void sync.refreshStatus().catch(() => {
    // A status read failure leaves the safe, signed-out presentation in place.
  });
  try {
    await connection.loadHosts();
  } catch {
    // A mount-time failure must not take auto-connect down with it: a
    // rejected read of ~/.ssh/config used to abort this handler before
    // `decideAutoConnect` ran, and the picker then rendered its "no hosts
    // found" empty state for what is really a load failure. Report it in the
    // same slot the reload path uses and let the decision run on whatever
    // loaded.
    hostReloadError.value = 'Could not read ~/.ssh/config';
  }
  const decision = decideAutoConnect({
    defaultHost: settings.defaultHost,
    hosts: connection.hosts,
    attempted: autoConnectAttempted(),
    connected: connection.connectionId !== null,
  });
  if (decision.action === 'connect') await runAutoConnect(decision.host);
});

async function runAutoConnect(host: HostEntry): Promise<void> {
  // Latch BEFORE dialling: whatever happens next — success, failure, cancel,
  // a hang that the user escapes — this launch has had its one attempt. This
  // is what stops Back from the workspace bouncing straight back in.
  markAutoConnectAttempted();
  autoConnecting.value = true;
  // Cancellation lives inside `dial` now: a cancelled attempt reports false
  // (and has already hung up on a late success), so this stays a plain
  // succeeded-or-not question and a cancelled auto-connect cannot navigate.
  let ok = false;
  try {
    ok = await dial(host);
  } finally {
    // `finally`, not the line after: if the dial ever throws, the latch must
    // still lift or the picker's rows stay disabled until remount.
    autoConnecting.value = false;
  }
  if (ok) enterWorkspace(host);
}

/** Re-read ~/.ssh/config without disturbing an existing connection or dial. */
async function onReloadHosts(): Promise<void> {
  if (reloadingHosts.value) return;
  reloadingHosts.value = true;
  hostReloadError.value = null;
  try {
    await connection.loadHosts();
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    hostReloadError.value = `Could not reload ~/.ssh/config${detail}`;
  } finally {
    reloadingHosts.value = false;
  }
}

/**
 * The banner's Cancel, one handler for both kinds of dial. The user's half is
 * instant — the banner goes, the rows re-enable, they can click elsewhere at
 * once — while `dial` is left holding the token, to notice it whenever the
 * attempt finally resolves and clean up whatever it produced.
 */
function onCancelConnect(): void {
  if (activeDial) activeDial.cancelled = true;
  autoConnecting.value = false;
  connectingTo.value = null;
}

async function onConnect(host: HostEntry): Promise<void> {
  // Already connected to this host: go back in, don't dial again. A second
  // dial would open a second connection and orphan the first — the session
  // panel, terminal pool and forwards all key off the old id.
  if (host.name === connectedName.value) {
    enterWorkspace(host);
    return;
  }
  if (await dial(host)) enterWorkspace(host);
}

/** Hang up. Stays on the picker — the row's dot going grey is the feedback. */
async function onDisconnect(): Promise<void> {
  await connection.disconnect();
}

/**
 * The one dialling path, shared by the click and by auto-connect, so the two
 * cannot drift. In particular `connection.connect` is what supplies
 * `privateKeyPath` (it falls back to the host's `identityFile`) and the TOFU
 * decision, and neither has an auto-connect-specific variant — an automatic
 * dial gets exactly the credentials and exactly the host-key treatment a
 * clicked one does.
 *
 * Cancellation lives here too, for the same reason: both kinds of dial hang
 * the same way and must escape the same way. A cancelled attempt reports
 * FALSE whatever the transport eventually said, which is the one bit both
 * callers act on — neither can navigate to a workspace the user walked out of.
 */
async function dial(host: HostEntry): Promise<boolean> {
  connectError.value = null;
  connectingTo.value = host.name;
  const token = { cancelled: false };
  activeDial = token;
  const ok = await connection.connect(host);
  // Only put the picker back if a newer dial has not claimed it: after a
  // cancel the rows re-enable, so by the time this resolves `connectingTo`
  // and the error slot may belong to a dial the user started since, and a
  // slow failure here must not wipe that dial's banner or its diagnostic.
  if (activeDial === token) {
    activeDial = null;
    connectingTo.value = null;
    if (!ok && !token.cancelled) connectError.value = connection.error ?? 'Connection failed';
  }
  if (token.cancelled) {
    // The dial won the race with the Cancel click. Hang up rather than leaving
    // a connection the user explicitly abandoned — but only if this is still
    // the connection in hand. `connect()` claims `activeHost` synchronously, so
    // a different name here means the user already started dialling somewhere
    // else in the meantime and tearing "the" connection down would tear down
    // theirs. The abandoned link then survives until the app exits, which is
    // the cheaper of the two failures by a wide margin.
    if (ok && connection.activeHost?.name === host.name) await connection.disconnect();
    return false;
  }
  return ok;
}

function enterWorkspace(host: HostEntry): void {
  // Land in the folder this host was last open on, when there is one — the
  // whole point of relaunching into the same tabs. The workspace restores the
  // rest of its own state (Files tabs, selection) from the same store, so the
  // folder route alone is the entire handoff. A host never opened, or a
  // record that names nothing, keeps the old landing below.
  const folder = readLastFolder(host.name);
  if (folder) {
    void router.push({ name: 'folder', params: { name: host.name, folder } });
    return;
  }
  // Land on the host's default view: the session list. `void`: vue-router
  // rejects on aborted/redirected navigation, neither of which is an error.
  void router.push({ name: 'host-sessions', params: { name: host.name } });
}

/** The star on a row: make this host the default, or clear it. */
function onToggleDefault(host: HostEntry): void {
  settings.set('defaultHost', settings.defaultHost === host.name ? null : host.name);
}
</script>

<template>
  <div class="picker">
    <header>
      <h1>PocketShell</h1>
      <div class="header-actions">
        <button
          class="account-action"
          :class="{ 'signed-in': accountSignedIn }"
          :disabled="sync.busy || accountUnavailable"
          :aria-busy="sync.busy"
          :aria-label="accountAriaLabel"
          :title="accountAriaLabel"
          @click="onAccountAction"
        >
          <span class="account-status-dot" :class="{ 'signed-in': accountSignedIn }" aria-hidden="true" />
          <span class="account-copy">
            <span class="account-provider">Google</span>
            <span class="account-state">{{ accountSignedIn ? accountEmail : 'Sign in' }}</span>
          </span>
        </button>
        <button
          class="icon-btn"
          :disabled="reloadingHosts"
          :aria-busy="reloadingHosts"
          title="Reload hosts"
          aria-label="Reload hosts"
          @click="onReloadHosts"
        >
          <AppIcon name="refresh" :class="{ spin: reloadingHosts }" />
        </button>
        <button class="icon-btn" title="Settings" @click="settingsOpen = true">
          <AppIcon name="settings" />
        </button>
      </div>
    </header>
    <main>
      <p v-if="sync.message?.kind === 'error'" class="account-banner" role="alert">
        {{ sync.message.text }}
      </p>
      <!-- The escape hatch, for ANY dial — automatic or clicked. It sits
           above the list, and the list stays usable underneath, so a dial is
           something happening ON the picker rather than instead of it. It used
           to render only for auto-connect, which made the header's "cancel is
           always visible" promise false for the commonest case: a clicked row
           disables every row and, on a typo'd Host or a sleeping box, held the
           whole picker for the 30s backstop with nothing to press. Only the
           wording knows which kind of dial it is. -->
      <p v-if="connectingTo !== null" class="auto-banner">
        <span v-if="autoConnecting">
          Connecting to <strong>{{ connectingTo }}</strong> (your default host)…
        </span>
        <span v-else>Connecting to <strong>{{ connectingTo }}</strong>…</span>
        <button class="btn-ghost" @click="onCancelConnect">Cancel</button>
      </p>
      <!-- `connectingTo`, not `autoConnecting`: any dial's banner displaces
           this one, so the two strips can never stack. -->
      <p v-if="defaultMissing && connectingTo === null" class="auto-banner stale">
        <AppIcon name="alert-triangle" :size="14" />
        <span>
          Your default host <strong>{{ settings.defaultHost }}</strong> is not in
          <code>~/.ssh/config</code> any more.
        </span>
        <button class="btn-ghost" @click="settings.set('defaultHost', null)">Clear</button>
      </p>
      <p v-if="hostReloadError" class="error">{{ hostReloadError }}</p>
      <p v-if="!connection.hosts.length && !connection.error && !hostReloadError" class="muted">
        No hosts found in <code>~/.ssh/config</code>. Add one there to get started.
      </p>
      <ul class="host-list">
        <!-- The card is the <li>, not the row button: the "make this the
             default" star is a second control on the same card, and a button
             inside a button is invalid. -->
        <li v-for="host in connection.hosts" :key="host.name" class="host-item">
          <button
            class="host-row"
            :disabled="connectingTo !== null"
            @click="onConnect(host)"
          >
            <!-- Mirrors the Android StatusDot: the desktop used to show
                 connection state only as the word "connecting…". -->
            <span
              class="status-dot"
              :class="{
                connecting: connectingTo === host.name,
                connected: connectedName === host.name,
              }"
            />
            <span class="host-name">{{ host.name }}</span>
            <span class="host-detail">
              {{ host.user || '(default user)' }}@{{ host.hostname }}:{{ host.port }}
            </span>
            <span v-if="connectingTo === host.name" class="muted">connecting…</span>
            <!-- A list row that goes somewhere gets a chevron, not an arrow
                 (VS Code / macOS convention). Kept on the connected row too:
                 it still goes somewhere — back into the workspace. -->
            <AppIcon v-else name="chevron-right" class="chevron" />
          </button>
          <button
            v-if="connectedName === host.name"
            class="btn-ghost disconnect"
            @click="onDisconnect"
          >
            Disconnect
          </button>
          <button
            class="icon-btn star"
            :class="{ on: settings.defaultHost === host.name }"
            :title="
              settings.defaultHost === host.name
                ? 'Stop connecting to this host on startup'
                : 'Connect to this host on startup'
            "
            :aria-pressed="settings.defaultHost === host.name"
            @click="onToggleDefault(host)"
          >
            <AppIcon :name="settings.defaultHost === host.name ? 'star-filled' : 'star'" />
          </button>
        </li>
      </ul>
      <p v-if="connectError" class="error">{{ connectError }}</p>
    </main>

    <!-- Settings remains reachable here with no connection: default-host is
         about startup, and the project-root section lets the user choose an
         SSH alias before editing its instance-specific roots. -->
    <OverlayPanel v-if="settingsOpen" title="Settings" size="md" @close="settingsOpen = false">
      <SettingsView />
    </OverlayPanel>
  </div>
</template>

<style scoped>
.picker {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-5);
}
header {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--sp-4);
  margin-bottom: var(--sp-5);
}
h1 {
  margin: 0;
  font-size: var(--fs-600);
  line-height: var(--lh-600);
  font-weight: var(--fw-bold);
  color: var(--fg);
}
/* Keeps the config reload and settings actions together at the trailing edge
   of the wordmark. The shared icon button supplies the square geometry. */
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  align-self: center;
}
/* The account action is the landing screen's one high-discoverability CTA.
   Once signed in it becomes a quiet account chip that opens the detailed
   Account & sync section in Settings rather than duplicating those controls. */
.account-action {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 220px;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.account-action:not(.signed-in) {
  border-color: var(--accent-dim);
  background: var(--accent-soft);
  color: var(--accent);
}
.account-action:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--state-hover);
  color: var(--fg);
}
.account-action:not(.signed-in):hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.account-action:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.account-status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.account-status-dot.signed-in {
  background: var(--success);
}
.account-copy {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: var(--sp-1);
}
.account-provider {
  font-weight: var(--fw-semibold);
}
.account-state {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-banner {
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: var(--error-soft);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  overflow-wrap: anywhere;
}
/* Status strip above the list: the app is doing something, the list is still
   there, and the way out is in the same line as the message. */
.auto-banner {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.auto-banner button {
  margin-left: auto;
}
.auto-banner.stale {
  color: var(--warning);
  background: var(--warning-soft);
  border-color: transparent;
}
.host-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
/* The one place a taller, card-like row is right: this is a landing screen,
   not a dense list. Matches the Android HostCard's 14dp/44dp geometry. */
.host-item {
  display: flex;
  align-items: center;
  min-height: 44px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  margin-bottom: var(--sp-2);
  padding-right: var(--sp-2);
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
/* Hover is a neutral lift + a stronger edge. Accent is reserved for
   *selected*, never for hover. Keyed off the ROW so that hovering the star
   alone does not light up the whole card — they are two different actions. */
.host-item:has(.host-row:hover:not(:disabled)) {
  background: var(--state-hover);
  border-color: var(--border-strong);
}
.host-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  align-self: stretch;
  text-align: left;
  background: transparent;
  color: var(--fg);
  border: none;
  border-radius: var(--r-lg);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.host-row:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Quiet until it means something: an unset star is a decorative mark, a set
   one is the accent because it IS a selection — this host, on startup. */
.star {
  color: var(--fg-muted);
}
.star.on,
.star.on:hover {
  color: var(--accent);
}
.status-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--fg-muted);
}
.status-dot.connecting {
  background: var(--warning);
  animation: pulse 1.2s var(--ease) infinite;
}
.status-dot.connected {
  background: var(--success);
}
/* Destructive: neutral at rest, error-tinted only on hover — the same
   treatment the workspace's disconnect button had before it moved here. No
   border-color line: the button is a ghost and has no border to tint. */
.btn-ghost.disconnect:hover:not(:disabled) {
  background: var(--error-soft);
  color: var(--error);
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
/* No local prefers-reduced-motion block: App.vue carries one global guard
   that covers this pulse along with every other animation. */
.host-name {
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
}
.host-detail {
  color: var(--fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  flex: 1;
}
/* A 2px nudge on row hover — the smallest possible "this row goes somewhere"
   cue. Colour and transform only; the row's own tint does the rest. */
.chevron {
  color: var(--fg-muted);
  transition:
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.host-row:hover:not(:disabled) .chevron {
  color: var(--fg-secondary);
  transform: translateX(2px);
}
.error {
  font-size: var(--fs-300);
}
code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
