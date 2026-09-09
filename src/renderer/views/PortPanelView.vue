<script setup lang="ts">
// PortPanelView: the port-forward table.
//
// One table, two kinds of row, merged on the remote port:
//
//   - a live forward   (`ForwardState`)   — auto, manual, or ssh-config
//   - a discovered port (`DiscoveredPort`) — something listening on the host
//     that we are NOT forwarding, INCLUDING ports above `maxAutoPort` that the
//     auto policy will never pick up on its own. Those are the whole reason
//     `discovered()` exists: without it a port on 19840 was invisible and
//     therefore unreachable.
//
// Per row the panel can now do everything the engine can: rename the port,
// pin it to a chosen local port (or drop the pin), force it on or off, and
// put it back on the automatic policy. Remove is not per row any more — for
// keyed rows it was the same verb as toggle-off (engine remove = stop +
// force-off), so the toggle is the one mark; `-R`/`-D` rows, which have no
// remote port for any of the above, keep remove as their only action.
// `Process` and `Folder` come from the scan's PID attribution, which is
// best-effort on a shared box — a dash there is normal, not a bug.
//
// Two things NOT to re-litigate in here:
//   - Removal uses `ForwardState.key`. The engine now issues that string and
//     it is the format this panel used to build by hand; rebuilding it locally
//     is what made auto-created forwards unremovable.
//   - In/Out were swapped in the ENGINE and are fixed there. `bytesIn` is
//     genuinely download. Do not "correct" them again here.
//
// Arrangement: the panel's face is the LIVE table —
// what is forwarded now. Everything else is one quiet control away: Scan
// moved up into the overlay header beside the close control (where Usage's
// refresh already lives), the manual-add form hides behind an "Add forward"
// expander, and ports that are listening but not forwarded fold under a
// "N not forwarded" disclosure row instead of leading the table.
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useConnectionStore } from '../stores/connection';
import AppIcon from '../components/AppIcon.vue';
import { useForwardsStore } from '../stores/forwards';
import type { ForwardSpec } from '../../shared/types';
import type { DiscoveredPort } from '../../main/portfwd/AutoForwarder';
import type { ForwardState } from '../../main/portfwd/Forwarder';
import { formatBytes } from '../../shared/byteSize';

const connection = useConnectionStore();
const forwards = useForwardsStore();
const connId = computed(() => connection.connectionId);

/**
 * The host's `~/.ssh/config` LocalForward lines. PocketShell is the SSH
 * client, so nothing else opens these — the engine does, and tags them
 * `origin: 'ssh-config'` so this panel can mark them and refuse to remove
 * them (the config, not the user, owns those rows).
 */
const configForwards = computed<ForwardSpec[]>(() =>
  // Rebuilt field by field, NOT passed through. Reading them off the Pinia
  // store hands back reactive Proxies, and `ipcRenderer.invoke` structured-
  // clones its arguments — a Proxy fails that with "An object could not be
  // cloned", which silently killed the whole Auto-forward toggle.
  (connection.activeHost?.localForwards ?? []).map((f) => ({
    kind: f.kind,
    listenHost: f.listenHost,
    listenPort: f.listenPort,
    destHost: f.destHost,
    destPort: f.destPort,
  })),
);

// Manual-add form. Hidden behind the "Add forward" expander: a form for a
// thing most sessions never do must not hold the panel's top row hostage.
const showAdd = ref(false);
const kind = ref<ForwardSpec['kind']>('local');
const localPort = ref<number>(8080);
const remotePort = ref<number>(8080);
const remoteHost = ref('127.0.0.1');

/** Whether the listening-but-not-forwarded rows are folded out. */
const showUnforwarded = ref(false);

/** One table row: a forward, a discovered port, or both for the same port. */
interface PortRow {
  id: string;
  /**
   * The port on the HOST. Null for `-R` and `-D` forwards, which have no
   * remote listener the scanner can attribute — every per-port control
   * (name, remap, intent, toggle) is keyed on this, so those rows get none.
   */
  remotePort: number | null;
  fwd: ForwardState | null;
  disco: DiscoveredPort | null;
}

const rows = computed<PortRow[]>(() => {
  const byPort = new Map<number, PortRow>();
  /** `-R`/`-D` rows: no remote port to merge on, so they sit at the end. */
  const unkeyed: PortRow[] = [];

  for (const fwd of forwards.states) {
    if (fwd.kind !== 'local') {
      unkeyed.push({ id: fwd.key, remotePort: null, fwd, disco: null });
      continue;
    }
    byPort.set(fwd.destPort, { id: fwd.key, remotePort: fwd.destPort, fwd, disco: null });
  }
  for (const disco of forwards.discovered) {
    const existing = byPort.get(disco.port);
    if (existing) existing.disco = disco;
    else byPort.set(disco.port, { id: `port:${disco.port}`, remotePort: disco.port, fwd: null, disco });
  }

  const keyed = [...byPort.values()].sort((a, b) => (a.remotePort ?? 0) - (b.remotePort ?? 0));
  return [...keyed, ...unkeyed];
});

/** True when the last scan failed — drives the banner, not a dialog. */
const scanFailed = computed(() => forwards.status !== null && !forwards.status.lastScanOk);

/**
 * The face of the table vs the folded tail. A row with a live tunnel (or a
 * policy verdict that one is coming) is what the panel exists to show, so
 * those lead; the ports that are merely LISTENING follow, and `v-show` in
 * the template folds them away unless the disclosure row is open.
 */
const forwardedRows = computed(() => rows.value.filter((row) => isForwarded(row)));
const unforwardedRows = computed(() => rows.value.filter((row) => !isForwarded(row)));
const displayRows = computed(() => [...forwardedRows.value, ...unforwardedRows.value]);

onMounted(async () => {
  if (!connId.value) return;
  forwards.subscribe(connId.value);
  await forwards.init(connId.value, configForwards.value);
});

onBeforeUnmount(() => {
  forwards.clear();
});

async function onAdd(): Promise<void> {
  if (!connId.value) return;
  const spec: ForwardSpec =
    kind.value === 'dynamic'
      ? { kind: 'dynamic', listenHost: '127.0.0.1', listenPort: localPort.value, destHost: '', destPort: 0 }
      : {
          kind: kind.value,
          listenHost: '127.0.0.1',
          listenPort: localPort.value,
          destHost: remoteHost.value,
          destPort: remotePort.value,
        };
  const ok = await forwards.addManual(connId.value, spec);
  // A made forward is visible in the live table; fold the form away so the
  // panel returns to being a table, not a form with a table under it.
  if (ok) showAdd.value = false;
}

/** Friendly name for a row, from whichever source carries it. */
function nameOf(row: PortRow): string {
  return row.fwd?.name ?? row.disco?.name ?? '';
}

/** The local port in use (or pinned) for a row, blank when there is none. */
function localOf(row: PortRow): string {
  const port = row.fwd?.listenPort ?? row.disco?.localPort ?? null;
  return port === null ? '' : String(port);
}

function processOf(row: PortRow): string {
  return row.fwd?.process ?? row.disco?.process ?? '';
}

/** The folder column, from the scan's `/proc/<pid>/cwd` attribution. */
function cwdOf(row: PortRow): string {
  return row.fwd?.cwd ?? row.disco?.cwd ?? '';
}

/**
 * The browser URL of a row's live local tunnel, null when there is nothing to
 * open — a row the engine is not forwarding, or a `-R`/`-D` forward (a `-R`
 * listens on the HOST, a `-D` is a SOCKS end; neither is a page a local
 * browser can reach).
 *
 * The tunnel binds the local loopback — the auto path and the add-form both
 * bind `127.0.0.1` — so the URL is that, with the forward's own listen host
 * passed through when it names a specific interface. A listen host of "any"
 * (`0.0.0.0`, `::`, empty) still reaches the loopback, so it maps there too
 * rather than putting `0.0.0.0` in an address bar.
 */
function localUrlOf(row: PortRow): string | null {
  const fwd = row.fwd;
  if (!fwd || fwd.kind !== 'local' || fwd.listenPort <= 0) return null;
  const anyHost = fwd.listenHost === '' || fwd.listenHost === '0.0.0.0' || fwd.listenHost === '::';
  const host = anyHost ? '127.0.0.1' : fwd.listenHost;
  return `http://${host}:${fwd.listenPort}/`;
}

/**
 * The one-click open — the action the Android app and ssh-auto-forward both
 * taught: a forwarded port is a URL, and the commonest thing to do with a URL
 * is look at it. `window.open` rather than an IPC verb: main's
 * `setWindowOpenHandler` already allow-lists http(s) into `shell.openExternal`
 * (index.ts), the same route every other in-app link takes.
 */
function openLocal(row: PortRow): void {
  const url = localUrlOf(row);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The last two segments of a working directory, which is the part that
 * identifies the project; the full path is on the cell's tooltip.
 *
 * Done here rather than with `direction: rtl` + `text-overflow`, which is the
 * usual CSS trick for keeping a path's tail: it reorders the bidi run, so
 * `/home/x/y` rendered as `home/x/y/` with the leading slash moved to the end.
 */
function cwdLabel(row: PortRow): string {
  const full = cwdOf(row);
  if (!full) return '';
  const parts = full.split('/').filter(Boolean);
  return parts.length <= 2 ? full : `…/${parts.slice(-2).join('/')}`;
}

/** True when the row's local port was pinned/reassigned away from a mirror. */
function isRemapped(row: PortRow): boolean {
  if (row.fwd) return row.fwd.remapped;
  const disco = row.disco;
  return disco?.localPort != null && disco.localPort !== disco.port;
}

function isForwarded(row: PortRow): boolean {
  return row.fwd !== null || row.disco?.forwarded === true;
}

/** Origin chip text. `auto` is the unremarkable case and gets no chip. */
function originLabel(row: PortRow): string | null {
  switch (row.fwd?.origin) {
    case 'ssh-config':
      return 'Auto (SSH Config)';
    case 'manual':
      return 'manual';
    default:
      return null;
  }
}

interface StatusCell {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  title: string;
}

function statusOf(row: PortRow): StatusCell {
  const lastError = row.disco?.lastError ?? null;
  if (lastError) return { text: 'failed', tone: 'bad', title: lastError };
  if (row.fwd) {
    return row.fwd.active
      ? { text: 'forwarding', tone: 'ok', title: 'tunnel open' }
      : { text: 'idle', tone: 'warn', title: 'tunnel open, no traffic yet' };
  }
  if (row.disco?.intent === 'force-off') {
    return { text: 'silenced', tone: 'muted', title: 'you turned this port off; it stays off' };
  }
  if (!forwards.annotated) {
    return { text: 'not forwarded', tone: 'muted', title: 'auto-forward is off — turn it on or toggle this port' };
  }
  return row.disco?.eligible === true
    ? { text: 'pending', tone: 'warn', title: 'in policy — the next scan should open it' }
    : {
        text: 'not forwarded',
        tone: 'muted',
        title: 'outside the auto range; use the toggle to force it on',
      };
}

async function onRename(row: PortRow, event: Event): Promise<void> {
  if (!connId.value || row.remotePort === null) return;
  const value = (event.target as HTMLInputElement).value;
  // Blank deletes the name; the engine takes null for that.
  await forwards.rename(connId.value, row.remotePort, value.trim() ? value : null);
}

async function onLocalPort(row: PortRow, event: Event): Promise<void> {
  if (!connId.value || row.remotePort === null) return;
  const raw = (event.target as HTMLInputElement).value.trim();
  const port = Number.parseInt(raw, 10);
  // An emptied field means "stop pinning", not "bind port 0".
  if (raw === '' || Number.isNaN(port) || port <= 0 || port > 65_535) {
    await forwards.clearRemap(connId.value, row.remotePort);
    return;
  }
  await forwards.remap(connId.value, row.remotePort, port);
}

async function onToggle(row: PortRow): Promise<void> {
  if (!connId.value || row.remotePort === null) return;
  await forwards.togglePort(connId.value, row.remotePort);
}

async function onClearIntent(row: PortRow): Promise<void> {
  if (!connId.value || row.remotePort === null) return;
  await forwards.setIntent(connId.value, row.remotePort, null);
}

async function onClearRemap(row: PortRow): Promise<void> {
  if (!connId.value || row.remotePort === null) return;
  await forwards.clearRemap(connId.value, row.remotePort);
}


/** Rate line under a byte count. Sub-1 KB/s is noise; show nothing. */
function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return '';
  return `${formatBytes(bytesPerSec)}/s`;
}

function fmtScanTime(epochMs: number | null): string {
  if (!epochMs) return 'never';
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
</script>

<template>
  <div class="port-panel">
    <div class="panel-bar">
      <!-- Scan lives in the OVERLAY HEADER now, beside the close control
           (HostWorkspaceView), where Usage's refresh already sits — the
           engine rescans on its own every few seconds, so the button was
           occupying the panel's best row for a thing that is almost never
           the thing you opened the panel to do. -->
      <button
        :class="['toggle', { on: forwards.autoOn }]"
        @click="forwards.toggleAuto(connId!, configForwards)"
      >
        Auto-forward: {{ forwards.autoOn ? 'ON' : 'OFF' }}
      </button>
      <span class="muted hint">
        auto mirrors remote ports 1024–10000; anything outside that range waits
        under "not forwarded" and can be forced on from there
      </span>
      <!-- The add form, folded. A quiet expander rather than a permanent
           form-row: adding a forward is a now-and-then act, and the top of
           the panel belongs to the table it serves. -->
      <button :class="['add-toggle', { open: showAdd }]" @click="showAdd = !showAdd">
        <AppIcon name="plus" :size="12" />
        Add forward
      </button>
      <span v-if="forwards.status" class="muted scan-time">
        last scan {{ fmtScanTime(forwards.status.lastScanAt) }}
      </span>
    </div>

    <!-- A failing scan is a banner, not a modal: the tunnels that are already
         up keep working, and the user needs to know the table has gone stale
         rather than be interrupted. -->
    <p v-if="scanFailed" class="scan-banner">
      <AppIcon name="alert-triangle" :size="14" />
      <span>
        The remote port scan is failing, so this list may be stale.
        <span class="scan-reason">{{ forwards.status?.lastError ?? 'no reason reported' }}</span>
      </span>
    </p>

    <section v-show="showAdd" class="add-form">
      <select v-model="kind">
        <option value="local">-L local</option>
        <option value="remote">-R remote</option>
        <option value="dynamic">-D SOCKS</option>
      </select>
      <label>local <input v-model.number="localPort" type="number" /></label>
      <template v-if="kind !== 'dynamic'">
        <!-- Decorative: this is a DIRECTION (local -> remote), not navigation,
             so an arrow is the right mark here. -->
        <label>
          <AppIcon name="arrow-right" :size="12" class="dir" />
          <input v-model="remoteHost" class="host" />
        </label>
        <label>: <input v-model.number="remotePort" type="number" /></label>
      </template>
      <button class="add-btn" @click="onAdd">Add</button>
    </section>

    <div class="table-wrap">
      <table class="fwd-table">
        <thead>
          <tr>
            <th class="c-port">Port</th>
            <th class="c-name">Name</th>
            <th class="c-local">Local</th>
            <th class="c-proc">Process</th>
            <th class="c-folder">Folder</th>
            <th class="c-status">Status</th>
            <th class="c-bytes">In</th>
            <th class="c-bytes">Out</th>
            <th class="c-actions" />
          </tr>
        </thead>
        <tbody>
          <!-- The live table first: every visible row here has a tunnel or is
               about to. Listening-but-not-forwarded ports keep their cells but
               fold away (`v-show`, so expanding costs no fetch and no refetch
               churn) behind the disclosure row at the table's foot — they are
               the long tail, a dozen passive listeners for every forward, and
               they used to push the rows the user opened the panel for off the
               top of the list. -->
          <tr
            v-for="row in displayRows"
            :key="row.id"
            v-show="showUnforwarded || isForwarded(row)"
            :class="{ busy: forwards.pending !== null && forwards.pending === row.remotePort }"
          >
            <td class="c-port">
              <span class="port-num">{{ row.remotePort ?? '—' }}</span>
              <!-- `local` is the table's whole furniture — the badge named the
                   default and read as noise. `-R`/`-D` are the rare
                   shapes and keep their word. -->
              <span
                v-if="row.fwd && row.fwd.kind !== 'local'"
                :class="['kind', row.fwd.kind]"
              >
                {{ row.fwd.kind }}
              </span>
              <span v-if="originLabel(row)" class="origin">{{ originLabel(row) }}</span>
              <span v-if="row.disco?.intent === 'force-on'" class="origin forced">forced on</span>
            </td>

            <!-- Uncontrolled on purpose: bound to :value and committed on
                 change, so a push-driven state refresh mid-typing cannot yank
                 the caret out of the field. -->
            <td class="c-name">
              <input
                class="cell-input"
                :value="nameOf(row)"
                :disabled="row.remotePort === null"
                placeholder="name"
                :title="row.remotePort === null ? 'only remote ports can be named' : 'Rename this port'"
                @change="onRename(row, $event)"
                @keyup.enter="($event.target as HTMLInputElement).blur()"
              />
            </td>

            <td class="c-local">
              <div class="local-cell">
                <input
                  class="cell-input num"
                  type="number"
                  :value="localOf(row)"
                  :disabled="row.remotePort === null"
                  placeholder="auto"
                  title="Pin this port to a local port; clear the field to unpin"
                  @change="onLocalPort(row, $event)"
                  @keyup.enter="($event.target as HTMLInputElement).blur()"
                />
                <!-- One-click open lives HERE, beside the port number
                     it opens, not out in the actions column: the open is an
                     attribute of the local end — the URL IS this port — so
                     the mark reads as "this number, in a browser" rather
                     than as one more row verb. A live LOCAL tunnel only. -->
                <button
                  v-if="localUrlOf(row)"
                  class="icon-btn sm"
                  :title="`Open ${localUrlOf(row)} in your browser`"
                  @click="openLocal(row)"
                >
                  <AppIcon name="external-link" :size="14" />
                </button>
                <button
                  v-if="isRemapped(row) && row.remotePort !== null"
                  class="icon-btn sm"
                  title="Clear the pinned local port"
                  @click="onClearRemap(row)"
                >
                  <AppIcon name="close" :size="12" />
                </button>
              </div>
            </td>

            <td class="c-proc" :title="processOf(row)">{{ processOf(row) || '—' }}</td>
            <td class="c-folder" :title="cwdOf(row)">{{ cwdLabel(row) || '—' }}</td>

            <td class="c-status">
              <span :class="['status', statusOf(row).tone]" :title="statusOf(row).title">
                {{ statusOf(row).text }}
              </span>
            </td>

            <td class="c-bytes">
              <span class="bytes">{{ row.fwd ? formatBytes(row.fwd.bytesIn) : '—' }}</span>
              <span v-if="row.fwd && fmtRate(row.fwd.rateIn)" class="rate">
                {{ fmtRate(row.fwd.rateIn) }}
              </span>
            </td>
            <td class="c-bytes">
              <span class="bytes">{{ row.fwd ? formatBytes(row.fwd.bytesOut) : '—' }}</span>
              <span v-if="row.fwd && fmtRate(row.fwd.rateOut)" class="rate">
                {{ fmtRate(row.fwd.rateOut) }}
              </span>
            </td>

            <td class="c-actions">
              <div class="actions">
                <!-- The opens live in the Local column now, beside the port
                     they open. What is left here is the row's VERBS:
                     the on/off toggle, the forgotten-override "auto", and
                     remove for the rows the toggle cannot reach. -->
                <!-- A real two-state mark: the knob moves, so on/off differ in
                     shape and not only in colour. -->
                <button
                  class="icon-btn sm"
                  :class="{ on: isForwarded(row) }"
                  :disabled="row.remotePort === null"
                  :title="isForwarded(row) ? 'Turn this port off' : 'Force this port on'"
                  @click="onToggle(row)"
                >
                  <AppIcon :name="isForwarded(row) ? 'toggle-right' : 'toggle-left'" :size="16" />
                </button>
                <button
                  v-if="row.disco?.intent"
                  class="btn-auto"
                  title="Forget this override and follow the automatic policy again"
                  @click="onClearIntent(row)"
                >
                  auto
                </button>
                <!-- The remove mark survives ONLY where the toggle cannot act:
                     a `-R`/`-D` row has no remote port, so the toggle is
                     disabled and this is the one way to take it down. On
                     keyed rows remove was the same verb as toggle-off (the
                     engine's remove = stop + force-off), two marks for one
                     operation, and the toggle won. -->
                <button
                  v-if="row.remotePort === null"
                  class="icon-btn sm"
                  :disabled="!row.fwd || row.fwd.origin === 'ssh-config'"
                  :title="
                    row.fwd?.origin === 'ssh-config'
                      ? 'Defined by ~/.ssh/config — remove it there'
                      : 'Remove forward'
                  "
                  @click="row.fwd && forwards.remove(connId!, row.fwd.key)"
                >
                  <AppIcon name="close" :size="12" />
                </button>
              </div>
            </td>
          </tr>

          <!-- The fold's label. One row, while there is a tail: the count is
               the honest summary ("the scan sees more than this table
               shows"), and the chevron is this app's disclosure mark. -->
          <tr v-if="unforwardedRows.length" class="more-row">
            <td colspan="9">
              <button
                class="more-btn"
                :title="
                  showUnforwarded
                    ? 'Hide the ports that are listening but not forwarded'
                    : 'Show the ports that are listening but not forwarded'
                "
                @click="showUnforwarded = !showUnforwarded"
              >
                <AppIcon :name="showUnforwarded ? 'chevron-down' : 'chevron-right'" :size="12" />
                {{ unforwardedRows.length }} not forwarded
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="9" class="muted empty">
              nothing listening and nothing forwarded — enable auto-forward or add a forward
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="forwards.error" class="error">{{ forwards.error }}</p>
  </div>
</template>

<style scoped>
.port-panel {
  padding: var(--sp-4) var(--sp-5);
  overflow-y: auto;
  height: 100%;
}
.panel-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}
.toggle,
.add-btn {
  height: var(--control-h);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  padding: 0 var(--sp-3);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.toggle:hover {
  color: var(--fg);
}
/* The add-form expander is a lower tier than the bordered toggle beside it:
   ghost, muted, accent while its form is open. */
.add-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--control-h);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  padding: 0 var(--sp-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition: color var(--dur-fast) var(--ease);
}
.add-toggle:hover {
  color: var(--fg);
}
.add-toggle.open {
  color: var(--accent);
}
.toggle.on {
  background: var(--accent-soft);
  border-color: var(--accent-dim);
  color: var(--accent);
}
.hint {
  font-size: var(--fs-200);
  flex: 1 1 16rem;
  min-width: 0;
}
.scan-time {
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* Warning, not error: the tunnels already open keep carrying traffic. */
.scan-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: var(--fs-200);
}
.scan-reason {
  display: block;
  color: var(--fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  margin-top: var(--sp-1);
}
.add-form {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
  flex-wrap: wrap;
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
.add-form select,
.add-form input {
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: controls need a >=3:1 boundary; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
}
.add-form label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
/* Decorative direction mark, not an affordance. */
.dir {
  color: var(--fg-muted);
}
.add-form input[type='number'] {
  width: 5rem;
}
.add-form input.host {
  width: 9rem;
}
.add-btn {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
  font-weight: var(--fw-semibold);
}
.add-btn:hover {
  background: var(--accent-dim);
  color: var(--fg);
}
/* Nine columns do not fit an overlay at every window width. The TABLE scrolls
   sideways inside this box; the panel itself never does. */
.table-wrap {
  overflow-x: auto;
}
.fwd-table {
  width: 100%;
  min-width: 860px;
  border-collapse: collapse;
  font-size: var(--fs-200);
}
.fwd-table th,
.fwd-table td {
  text-align: left;
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
  vertical-align: middle;
}
.fwd-table th {
  background: var(--surface-2);
  color: var(--fg-muted);
  font-weight: var(--fw-semibold);
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.fwd-table td {
  font-family: var(--font-mono);
}
.fwd-table tbody tr:hover {
  background: var(--state-hover);
}
/* A row with a mutation in flight dims rather than disappearing, so the table
   does not reflow underneath the cursor that just clicked it. */
.fwd-table tbody tr.busy {
  opacity: var(--disabled-opacity);
}
/* The fold's label row: quieter than a data row in every register — no hover
   fill, no side padding beyond the button's — so it reads as table furniture
   rather than a ninth-column-less entry. */
.more-row td {
  padding: 0 var(--sp-2);
  border-bottom: none;
}
/* Outweighs `.fwd-table tbody tr:hover` (three class selectors beat two). */
.fwd-table tr.more-row:hover {
  background: transparent;
}
.more-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: transparent;
  border: none;
  padding: var(--sp-1) 0;
  color: var(--fg-muted);
  font-family: var(--font-ui);
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease);
}
.more-btn:hover {
  color: var(--fg-secondary);
}
.c-port {
  white-space: nowrap;
}
.port-num {
  font-variant-numeric: tabular-nums;
  margin-right: var(--sp-1);
}
.c-name {
  width: 9rem;
}
/* Room for the port input plus the open and clear-pin buttons that live in
   this cell now. */
.c-local {
  width: 8rem;
}
.c-proc {
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The leaf-first shortening happens in `cwdLabel()`, not here — see the note
   on that function for why `direction: rtl` is the wrong tool. */
.c-folder {
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-secondary);
}
.c-status {
  white-space: nowrap;
}
.c-bytes {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.c-actions {
  width: 1%;
  white-space: nowrap;
}
/* Row-level inputs are quieter than form inputs: transparent until hovered or
   focused, so nine columns of boxes do not read as a form. */
.cell-input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.cell-input::placeholder {
  color: var(--fg-muted);
}
.cell-input:hover:not(:disabled),
.cell-input:focus {
  background: var(--surface-2);
  /* WCAG 1.4.11: once it looks like a control it needs a >=3:1 boundary. */
  border-color: var(--border-strong);
}
.cell-input:disabled {
  opacity: var(--disabled-opacity);
}
.cell-input.num {
  font-variant-numeric: tabular-nums;
}
.local-cell {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  justify-content: flex-end;
}
.icon-btn.on {
  color: var(--success);
}
.btn-auto {
  height: var(--control-h-sm);
  padding: 0 var(--sp-1);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-100);
  cursor: pointer;
}
.btn-auto:hover {
  color: var(--fg);
}
/* One badge metric across the app. */
.kind,
.origin {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  font-family: var(--font-ui);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
}
.kind.remote {
  color: var(--warning);
}
.kind.dynamic {
  color: var(--agent);
}
.origin {
  color: var(--fg-secondary);
  margin-left: var(--sp-1);
}
.origin.forced {
  color: var(--success);
  background: var(--success-soft);
  border-color: transparent;
}
.status {
  font-family: var(--font-ui);
}
.status.ok {
  color: var(--success);
}
.status.warn {
  color: var(--warning);
}
.status.bad {
  color: var(--error);
}
.status.muted {
  color: var(--fg-muted);
}
.bytes {
  color: var(--fg-secondary);
}
.rate {
  display: block;
  color: var(--fg-muted);
  font-size: var(--fs-100);
}
.empty {
  padding: var(--sp-4) var(--sp-2);
}
.error {
  padding-top: var(--sp-2);
}
</style>
