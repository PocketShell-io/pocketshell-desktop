import type { SshService } from '../ssh/SshService.js';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ForwardSpec } from '@pocketshell/core';
import {
  AutoForwarder,
  DEFAULT_AUTO_CONFIG,
  type AutoForwardConfig,
  type AutoForwarderStatus,
  type DiscoveredPort,
  type ForwardState,
} from './AutoForwarder.js';
import { scanRemotePorts, type RemotePort } from './scanRemotePorts.js';
import { PortfwdStore, hostKeyFor, type PortIntent } from './PortfwdStore.js';

/**
 * Per-connection forward manager. Owns one {@link AutoForwarder} (the scan
 * loop) per connection plus the persistent {@link PortfwdStore}, and exposes
 * the surface the IPC layer calls.
 *
 * Everything here is a thin pass-through by design: adding an IPC verb means
 * one `ipcMain.handle` line, not any logic.
 *
 * Reconnect is handled by subscribing to `SshService.onCloseConnection`
 * rather than by opening a second SSH connection — this app holds exactly one
 * authenticated connection per host and that property is load-bearing.
 */
export class ForwardService {
  /** One AutoForwarder per connectionId. */
  private readonly forwarders = new Map<string, AutoForwarder>();
  private readonly listeners = new Set<(connectionId: string, states: ForwardState[]) => void>();
  private readonly store: PortfwdStore;
  private readonly unsubscribeClose: () => void;

  constructor(
    private readonly ssh: SshService,
    private readonly registry: ConnectionRegistry,
    store: PortfwdStore = PortfwdStore.default(),
    private readonly config: AutoForwardConfig = DEFAULT_AUTO_CONFIG,
  ) {
    this.store = store;
    this.unsubscribeClose = ssh.onCloseConnection((connectionId, reason) => {
      const fwd = this.forwarders.get(connectionId);
      if (!fwd) return;
      // Suspend keeps names/remaps/intents; only the live listeners and the
      // byte counters go (`_clear_stale_state`, forwarder.py:1093-1108).
      fwd.suspend();
      if (reason !== 'lost') this.forwarders.delete(connectionId);
      for (const l of this.listeners) l(connectionId, []);
    });
  }

  /** Detach the connection-close subscription (app shutdown). */
  dispose(): void {
    this.unsubscribeClose();
    for (const id of [...this.forwarders.keys()]) this.stopAuto(id);
  }

  /** Subscribe to forward-state snapshots per connection. */
  onStates(listener: (connectionId: string, states: ForwardState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run a one-shot remote port scan (does not require the forwarder running). */
  async scan(connectionId: string): Promise<RemotePort[]> {
    return scanRemotePorts(this.ssh, connectionId);
  }

  /** Start the auto-forwarder for a connection (idempotent). */
  startAuto(connectionId: string, configForwards: ForwardSpec[] = []): void {
    if (this.forwarders.get(connectionId)) {
      this.forwarders.get(connectionId)!.start();
      return;
    }
    const hostKey = this.hostKey(connectionId);
    const persisted = this.store.read(hostKey);
    const intents: Record<number, PortIntent> = {};
    for (const p of persisted.forceOn) intents[p] = 'force-on';
    for (const p of persisted.forceOff) intents[p] = 'force-off';

    const fwd = new AutoForwarder(this.ssh, connectionId, this.registry, {
      config: this.config,
      remappings: numericKeys(persisted.remaps),
      names: numericKeys(persisted.names),
      intents,
      configForwards,
    });
    fwd.onStates((states) => {
      for (const l of this.listeners) l(connectionId, states);
    });
    this.forwarders.set(connectionId, fwd);
    if (configForwards.length > 0) void fwd.startConfigForwards();
    fwd.start();
    this.store.setAutoEnabled(hostKey, true);
  }

  stopAuto(connectionId: string): void {
    const fwd = this.forwarders.get(connectionId);
    if (fwd) {
      fwd.stop();
      this.forwarders.delete(connectionId);
    }
    this.store.setAutoEnabled(this.hostKey(connectionId), false);
    for (const l of this.listeners) l(connectionId, []);
  }

  /** Whether auto-forward was left enabled for this connection's host. */
  isAutoEnabled(connectionId: string): boolean {
    if (this.forwarders.has(connectionId)) return true;
    return this.store.read(this.hostKey(connectionId)).autoEnabled;
  }

  /** Add a manual forward (-L/-R/-D). */
  async addManual(connectionId: string, spec: ForwardSpec): Promise<boolean> {
    return (await this.ensure(connectionId).addManual(spec)) ?? false;
  }

  /** Remove a forward by key (the `kind:listenPort->destHost:destPort` form). */
  async remove(connectionId: string, key: string): Promise<void> {
    const fwd = this.forwarders.get(connectionId);
    if (fwd) await fwd.remove(key);
    for (const l of this.listeners) l(connectionId, fwd?.snapshot() ?? []);
  }

  /**
   * Run one scan pass now, applying the forward policy — what the panel's
   * "Scan" button should call. Unlike {@link scan}, which only lists ports,
   * this opens and closes forwards. A no-op when auto is not running.
   */
  async refresh(connectionId: string): Promise<void> {
    await this.forwarders.get(connectionId)?.refresh();
  }

  /** Current snapshot for a connection. */
  list(connectionId: string): ForwardState[] {
    return this.forwarders.get(connectionId)?.snapshot() ?? [];
  }

  /** Ports the last scan saw, annotated — including ones we do not forward. */
  discovered(connectionId: string): DiscoveredPort[] {
    return this.forwarders.get(connectionId)?.discovered() ?? [];
  }

  /** Scan health, so the panel can distinguish "idle" from "scan failing". */
  status(connectionId: string): AutoForwarderStatus | null {
    return this.forwarders.get(connectionId)?.getStatus() ?? null;
  }

  /** Set or clear a port's friendly name. Persisted per host. */
  setName(connectionId: string, remotePort: number, name: string | null): void {
    this.store.setName(this.hostKey(connectionId), remotePort, name);
    this.forwarders.get(connectionId)?.setName(remotePort, name);
  }

  /** Pin a remote port to a local port. Persisted per host. */
  async setRemap(connectionId: string, remotePort: number, localPort: number): Promise<void> {
    this.store.setRemap(this.hostKey(connectionId), remotePort, localPort);
    await this.forwarders.get(connectionId)?.setRemap(remotePort, localPort);
  }

  /** Drop a pin. Persisted per host. */
  async clearRemap(connectionId: string, remotePort: number): Promise<void> {
    this.store.clearRemap(this.hostKey(connectionId), remotePort);
    await this.forwarders.get(connectionId)?.clearRemap(remotePort);
  }

  /**
   * Force a port on, off, or back to the automatic policy. Persisted.
   *
   * `ensure`, not `forwarders.get(...)?`: forcing a port on is one of the two
   * ways a user starts the engine from a cold panel, and the renderer already
   * documents it as such (stores/forwards.ts re-reads `isAutoEnabled` after
   * this call precisely because "forcing a single port on lazily starts the
   * whole engine"). With the optional call it did not — the intent was
   * persisted, nothing opened, and the call reported success. Its sibling
   * `togglePort` has always used `ensure`; this is the same operation reached
   * from the other affordance.
   */
  async setIntent(
    connectionId: string,
    remotePort: number,
    intent: PortIntent | null,
  ): Promise<void> {
    this.store.setIntent(this.hostKey(connectionId), remotePort, intent);
    await this.ensure(connectionId).setIntent(remotePort, intent);
  }

  /** Toggle a remote port between forwarded and silenced. Persisted. */
  async togglePort(connectionId: string, remotePort: number): Promise<void> {
    const fwd = this.ensure(connectionId);
    await fwd.togglePort(remotePort);
    const intent = fwd.discovered().find((p) => p.port === remotePort)?.intent ?? null;
    this.store.setIntent(this.hostKey(connectionId), remotePort, intent);
  }

  /** Tear down everything for a connection (on disconnect). */
  evict(connectionId: string): void {
    this.stopAuto(connectionId);
  }

  /**
   * The persistence key for a connection: the `~/.ssh/config` alias when the
   * connection carries one, else `user@host:port`. {@link hostKeyFor} owns
   * that choice; this only supplies the record.
   */
  private hostKey(connectionId: string): string {
    const rec = this.registry.get(connectionId);
    if (!rec) return connectionId;
    return hostKeyFor(rec);
  }

  /** Lazily create the forwarder so a manual forward works before auto is on. */
  private ensure(connectionId: string): AutoForwarder {
    const existing = this.forwarders.get(connectionId);
    if (existing) return existing;
    this.startAuto(connectionId);
    return this.forwarders.get(connectionId)!;
  }
}

/** `{"8080": x}` -> `{8080: x}`, dropping any key that is not a port number. */
function numericKeys<T>(source: Record<string, T>): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^\d+$/.test(key)) continue;
    out[Number.parseInt(key, 10)] = value;
  }
  return out;
}
