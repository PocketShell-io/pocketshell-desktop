import { createServer } from 'node:net';
import type { SshService } from '../ssh/SshService.js';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ForwardSpec } from '../../shared/types.js';
import { LOOPBACK_HOST, MAX_PORT } from '../../shared/net.js';
import { Forwarder, forwardKey, type ForwardState, type ForwardOrigin } from './Forwarder.js';
import { scanRemoteListeners, type RemotePort, type ScanResult } from './scanRemotePorts.js';
import type { PortIntent } from './PortfwdStore.js';

/** How far past the preferred (mirror) port the +1..+999 sweep walks. */
const MIRROR_SWEEP_DISTANCE = 1_000;

/** Re-exported so the IPC/preload layer imports the type from one place. */
export type { ForwardState };

/**
 * Auto-forward engine: periodically scans the remote host for listening TCP
 * ports and mirrors each one to localhost. Ported from the behaviour of
 * `ssh-auto-forward`, onto the single authenticated
 * connection this app already owns.
 *
 * Local port resolution, in order (`forwarder.py:879-898`):
 *   1. a user remap, if one exists — always wins
 *   2. the same number (mirror), if it is bindable
 *   3. preferred+1 .. preferred+999
 *   4. a linear sweep of `localPortRange`
 *   5. give up: the port is recorded as failed and retried after a TTL
 */

/** A remote port the scan saw, whether or not it is forwarded. */
export interface DiscoveredPort extends RemotePort {
  /** True when a live forward exists for this remote port. */
  forwarded: boolean;
  /** Local port in use, when forwarded. */
  localPort: number | null;
  /** Explicit user intent, when one is set. */
  intent: PortIntent | null;
  /** Friendly name, when one is set. */
  name: string | null;
  /** True when auto policy alone would forward it (ignoring intent). */
  eligible: boolean;
  /** Set when the last attempt to open this port failed. */
  lastError: string | null;
}

export interface AutoForwardConfig {
  /** Seconds between scans. `cli.py:42` default is 5. */
  scanIntervalSec: number;
  /** Highest port auto-forwarded, INCLUSIVE (`forwarder.py:1051`). */
  maxAutoPort: number;
  /**
   * Ports strictly below this are never auto-forwarded.
   *
   * Deliberate divergence: the Python skips 0-999 (`DEFAULT_SKIP_PORTS`,
   * `forwarder.py:19`) — an arbitrary round number. 1024 is the real
   * privileged-port boundary and matches the Android engine. The only ports
   * affected are 1000-1023.
   */
  skipPortsBelow: number;
  /** Extra ports never auto-forwarded (the Python `--skip` list). */
  skipPorts: number[];
  /**
   * Sweep bounds for the last-resort allocation. `[3000, 65535]` is what the
   * Python's hardcoded `range(3000, 65535)` actually does; its advertised
   * `-p 3000:10000` flag is dead config (`forwarder.py:533` vs `:894`).
   */
  localPortRange: [number, number];
  /** Retry a port that failed to bind after this long. Android used 60s. */
  failedPortTtlMs: number;
  /** Scans a port may be missing before its tunnel is torn down. */
  missingScansBeforeStop: number;
}

export const DEFAULT_AUTO_CONFIG: AutoForwardConfig = {
  scanIntervalSec: 5,
  maxAutoPort: 10_000,
  skipPortsBelow: 1024,
  skipPorts: [],
  localPortRange: [3_000, 65_535],
  failedPortTtlMs: 60_000,
  missingScansBeforeStop: 2,
};

export interface AutoForwarderOptions {
  config?: AutoForwardConfig;
  /** remotePort -> pinned localPort. */
  remappings?: Record<number, number>;
  /** remotePort -> friendly name. */
  names?: Record<number, string>;
  /** Explicit per-port user intents. */
  intents?: Record<number, PortIntent>;
  /**
   * `LocalForward`/`RemoteForward` entries from `~/.ssh/config` for this host.
   * Excluded from the auto policy (SSH itself owns those local ports —
   * `forwarder.py:916-922`) and surfaced with `origin: 'ssh-config'`.
   */
  configForwards?: ForwardSpec[];
}

/** Emitted alongside the state snapshot so the UI can show scan health. */
export interface AutoForwarderStatus {
  scanning: boolean;
  lastScanAt: number | null;
  lastScanOk: boolean;
  lastError: string | null;
}

export class AutoForwarder {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** key: {@link forwardKey}(spec) — the same string the renderer builds. */
  private readonly forwards = new Map<string, Forwarder>();
  /** remotePort -> explicit user intent. Absent = follow the auto policy. */
  private readonly intents = new Map<number, PortIntent>();
  /** remotePort -> pinned localPort. */
  private readonly remappings = new Map<number, number>();
  /** remotePort -> friendly name. */
  private readonly names = new Map<number, string>();
  /** remotePort -> consecutive scans in which it was absent. */
  private readonly missing = new Map<number, number>();
  /** remotePort -> epoch ms of the failure. Expired by `failedPortTtlMs`. */
  private readonly failedPorts = new Map<number, { at: number; error: string }>();
  /** Last scan's ports, so the UI can show discovered-but-unforwarded rows. */
  private discoveredPorts: RemotePort[] = [];
  private readonly configForwards: ForwardSpec[];
  private readonly configPorts = new Set<number>();
  private readonly listeners = new Set<(states: ForwardState[]) => void>();
  private config: AutoForwardConfig;
  /** Single-flight guard: overlapping scans are DROPPED, not queued. */
  private scanning = false;
  private status: AutoForwarderStatus = {
    scanning: false,
    lastScanAt: null,
    lastScanOk: false,
    lastError: null,
  };

  constructor(
    private readonly ssh: SshService,
    private readonly connectionId: string,
    private readonly registry: ConnectionRegistry,
    options: AutoForwarderOptions = {},
  ) {
    this.config = options.config ?? DEFAULT_AUTO_CONFIG;
    for (const [k, v] of Object.entries(options.remappings ?? {})) {
      this.remappings.set(Number(k), v);
    }
    for (const [k, v] of Object.entries(options.names ?? {})) this.names.set(Number(k), v);
    for (const [k, v] of Object.entries(options.intents ?? {})) this.intents.set(Number(k), v);
    this.configForwards = options.configForwards ?? [];
    for (const spec of this.configForwards) {
      if (spec.kind === 'local') this.configPorts.add(spec.destPort);
    }
  }

  /** Subscribe to the forward-state snapshot (called after each scan). */
  onStates(listener: (states: ForwardState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start the scan loop. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scanAndForward(), this.config.scanIntervalSec * 1000);
    this.timer.unref?.();
    void this.scanAndForward();
  }

  /**
   * Stop the loop and close every forward, but KEEP names, remaps and intents
   * so a reconnect rebuilds the user's setup (`_clear_stale_state`,
   * `forwarder.py:1093-1108`).
   */
  suspend(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const f of this.forwards.values()) void f.stop();
    this.forwards.clear();
    this.missing.clear();
    this.failedPorts.clear();
    this.discoveredPorts = [];
    this.emit();
  }

  /** Alias kept for the existing IPC surface. */
  stop(): void {
    this.suspend();
  }

  /** Manually add a forward (-L/-R/-D). */
  async addManual(spec: ForwardSpec): Promise<boolean> {
    const key = forwardKey(spec);
    const existing = this.forwards.get(key);
    if (existing) {
      this.emit();
      return true; // idempotent, like `forward_port` (forwarder.py:909-910)
    }
    const f = new Forwarder(this.registry, this.connectionId, spec, { origin: 'manual' });
    this.decorate(f, spec.kind === 'local' ? spec.destPort : null);
    const ok = await f.start();
    if (ok) {
      this.forwards.set(key, f);
      if (spec.kind === 'local') {
        this.intents.set(spec.destPort, 'force-on');
        this.failedPorts.delete(spec.destPort);
        this.missing.delete(spec.destPort);
      }
    } else if (spec.kind === 'local') {
      this.failedPorts.set(spec.destPort, {
        at: Date.now(),
        error: `could not bind ${LOOPBACK_HOST}:${spec.listenPort}`,
      });
    }
    this.emit();
    return ok;
  }

  /**
   * Remove a forward by key.
   *
   * The key is {@link forwardKey}'s format — identical to the one
   * `PortPanelView.vue` builds — for auto-created and manual forwards alike.
   */
  async remove(key: string): Promise<void> {
    const f = this.forwards.get(key);
    if (f) {
      await f.stop();
      this.forwards.delete(key);
      // Removing a row is an explicit "off": without this the next scan would
      // re-open an in-policy port immediately and the button would look broken.
      if (f.spec.kind === 'local') this.intents.set(f.spec.destPort, 'force-off');
    }
    this.emit();
  }

  /**
   * Set the user's intent for a remote port: force it on, silence it, or
   * (null) hand it back to the automatic policy. Applied on the next scan,
   * which this triggers immediately.
   */
  async setIntent(remotePort: number, intent: PortIntent | null): Promise<void> {
    if (intent === null) this.intents.delete(remotePort);
    else this.intents.set(remotePort, intent);
    if (intent !== 'force-off') this.failedPorts.delete(remotePort);
    if (intent === 'force-off') await this.stopForwardsFor(remotePort);
    await this.scanAndForward();
  }

  /**
   * Toggle a remote port between forwarded and silenced.
   *
   * Replaces the old `togglePort`, which only manipulated a `manual` set and
   * therefore could not turn OFF a port the auto policy already forwarded.
   */
  async togglePort(remotePort: number): Promise<void> {
    const forwarded = this.localForwardFor(remotePort) !== null;
    await this.setIntent(remotePort, forwarded ? 'force-off' : 'force-on');
  }

  /** Pin a remote port to a specific local port, restarting it if live. */
  async setRemap(remotePort: number, localPort: number): Promise<void> {
    this.remappings.set(remotePort, localPort);
    this.failedPorts.delete(remotePort);
    await this.stopForwardsFor(remotePort);
    await this.scanAndForward();
  }

  /** Drop a pin; the port returns to mirror-then-allocate resolution. */
  async clearRemap(remotePort: number): Promise<void> {
    this.remappings.delete(remotePort);
    this.failedPorts.delete(remotePort);
    await this.stopForwardsFor(remotePort);
    await this.scanAndForward();
  }

  /** Set (or, with a blank/null name, clear) a port's friendly name. */
  setName(remotePort: number, name: string | null): void {
    const trimmed = name?.trim() ?? '';
    if (trimmed) this.names.set(remotePort, trimmed);
    else this.names.delete(remotePort);
    for (const f of this.forwards.values()) {
      if (f.spec.kind === 'local' && f.spec.destPort === remotePort) {
        f.setMeta({ name: trimmed || null });
      }
    }
    this.emit();
  }

  snapshot(): ForwardState[] {
    return [...this.forwards.values()].map((f) => f.snapshot());
  }

  getStatus(): AutoForwarderStatus {
    return { ...this.status, scanning: this.scanning };
  }

  /**
   * Every port the last scan saw, annotated with what we did about it —
   * including ports above `maxAutoPort`, which are shown but not
   * auto-forwarded (`forwarder.py:1053`) so the user can toggle them on.
   */
  discovered(): DiscoveredPort[] {
    return this.discoveredPorts.map((p) => {
      const live = this.localForwardFor(p.port);
      return {
        ...p,
        forwarded: live !== null,
        localPort: live?.spec.listenPort ?? null,
        intent: this.intents.get(p.port) ?? null,
        name: this.names.get(p.port) ?? null,
        eligible: this.matchesAutoPolicy(p.port),
        lastError: this.failedPorts.get(p.port)?.error ?? null,
      };
    });
  }

  /**
   * Open the host's `~/.ssh/config` forwards.
   *
   * Divergence from the Python, which only *reports* them because OpenSSH is
   * a separate process there: PocketShell IS the SSH client, so nothing else
   * will establish them. A bind failure (a real `ssh -L` already holding the
   * port) is recorded and NOT retried — which lands on exactly the Python's
   * read-only view, arrived at honestly.
   */
  async startConfigForwards(): Promise<void> {
    for (const spec of this.configForwards) {
      const key = forwardKey(spec);
      if (this.forwards.has(key)) continue;
      const f = new Forwarder(this.registry, this.connectionId, spec, { origin: 'ssh-config' });
      this.decorate(f, spec.kind === 'local' ? spec.destPort : null);
      const ok = await f.start();
      // Kept in the map either way so the panel can render the inactive row.
      this.forwards.set(key, f);
      if (!ok && spec.kind === 'local') {
        this.failedPorts.set(spec.destPort, {
          at: Number.POSITIVE_INFINITY, // never expires: do not retry
          error: `ssh config forward could not bind ${spec.listenHost}:${spec.listenPort}`,
        });
      }
    }
    this.emit();
  }

  // ---------------------------------------------------------------------
  // Scan loop
  // ---------------------------------------------------------------------

  /**
   * Run one scan pass immediately, without waiting for the interval. Backs
   * the panel's "Scan now" button and is how the state machine is driven in
   * tests. Safe to call concurrently: the single-flight guard drops overlaps.
   */
  async refresh(): Promise<void> {
    await this.scanAndForward();
  }

  private async scanAndForward(): Promise<void> {
    // Overlapping scans are dropped, not queued (`dashboard.py:936-938`).
    // Without this, two slow scans can interleave their teardown decisions.
    if (this.scanning) return;
    this.scanning = true;
    try {
      const result = await this.scan();
      this.status = {
        scanning: false,
        lastScanAt: Date.now(),
        lastScanOk: result.ok,
        lastError: result.error,
      };

      // THE EMPTY-SCAN GUARD (`forwarder.py:1041-1042`).
      // A scan that failed — transport hiccup, missing `ss`, permission error —
      // comes back empty. Reading that as "nothing is listening" tore down
      // every live tunnel mid-transfer. A host with genuinely zero listeners
      // is indistinguishable and equally harmless to leave alone: it cannot
      // have produced any forwards in the first place.
      if (!result.ok || result.ports.length === 0) {
        this.emit();
        return;
      }

      this.discoveredPorts = result.ports;
      const activeRemote = new Map<number, RemotePort>();
      for (const rp of result.ports) activeRemote.set(rp.port, rp);

      await this.startPass(result.ports);
      await this.stopPass(activeRemote);
      this.emit();
    } catch (e) {
      // Nothing in here may throw: `start()` calls this from a bare
      // `void this.scanAndForward()` inside setInterval, so an escaping
      // rejection would be unhandled and kill the loop.
      this.status = {
        scanning: false,
        lastScanAt: Date.now(),
        lastScanOk: false,
        lastError: (e as Error).message,
      };
      this.emit();
    } finally {
      this.scanning = false;
    }
  }

  /** Open a forward for every port the policy wants and we do not have. */
  private async startPass(ports: RemotePort[]): Promise<void> {
    for (const rp of ports) {
      const live = this.localForwardFor(rp.port);
      if (live) {
        live.setMeta({ process: rp.process, cwd: rp.cwd, name: this.names.get(rp.port) ?? null });
        continue;
      }
      if (!this.shouldForward(rp.port)) continue;

      const localPort = await this.resolveLocalPort(rp.port);
      if (localPort === null) {
        // Exhaustion is a reported outcome, never a throw. Recorded with a
        // TTL so the next scan does not retry identically 5 seconds later.
        this.failedPorts.set(rp.port, {
          at: Date.now(),
          error: `no free local port for remote ${rp.port}`,
        });
        continue;
      }

      const spec: ForwardSpec = {
        kind: 'local',
        listenHost: LOOPBACK_HOST,
        listenPort: localPort,
        destHost: LOOPBACK_HOST,
        destPort: rp.port,
      };
      const key = forwardKey(spec);
      if (this.forwards.has(key)) continue;
      const origin: ForwardOrigin = this.intents.get(rp.port) === 'force-on' ? 'manual' : 'auto';
      const f = new Forwarder(this.registry, this.connectionId, spec, { origin });
      f.setMeta({
        name: this.names.get(rp.port) ?? null,
        process: rp.process,
        cwd: rp.cwd,
        remapped: localPort !== rp.port,
      });
      const ok = await f.start();
      if (ok) {
        this.forwards.set(key, f);
        this.failedPorts.delete(rp.port);
        this.missing.delete(rp.port);
      } else {
        this.failedPorts.set(rp.port, {
          at: Date.now(),
          error: `could not bind ${LOOPBACK_HOST}:${localPort}`,
        });
      }
    }
  }

  /**
   * Tear down forwards whose remote port has been gone for
   * `missingScansBeforeStop` consecutive scans.
   *
   * At the 5s default that is ~10s of absence, which rides out a
   * `systemctl restart` or a dev-server reload — precisely the flap the
   * Python thrashes on, since it stops a tunnel the first scan a port is
   * missing. Manual and ssh-config forwards are never torn down here: the
   * user asked for them explicitly.
   */
  private async stopPass(activeRemote: Map<number, RemotePort>): Promise<void> {
    for (const [key, f] of [...this.forwards]) {
      if (f.spec.kind !== 'local') continue;
      if (f.origin !== 'auto') continue;
      const remote = f.spec.destPort;
      if (activeRemote.has(remote)) {
        this.missing.delete(remote);
        continue;
      }
      const misses = (this.missing.get(remote) ?? 0) + 1;
      this.missing.set(remote, misses);
      if (misses < this.config.missingScansBeforeStop) continue;
      await f.stop();
      this.forwards.delete(key);
      this.missing.delete(remote);
      // A port that vanished gets a clean slate if it comes back
      // (`stop_forwarding_port`, forwarder.py:972-983).
      this.failedPorts.delete(remote);
    }
  }

  private async scan(): Promise<ScanResult> {
    return scanRemoteListeners(this.ssh, this.connectionId);
  }

  // ---------------------------------------------------------------------
  // Policy
  // ---------------------------------------------------------------------

  /** The range policy alone, ignoring explicit intent. */
  private matchesAutoPolicy(remotePort: number): boolean {
    if (this.config.skipPorts.includes(remotePort)) return false;
    return (
      remotePort >= this.config.skipPortsBelow && remotePort <= this.config.maxAutoPort
    );
  }

  /**
   * Should we open a forward for this remote port right now?
   *
   * Order matters. `ssh-config` ownership and a live failure both beat an
   * explicit `force-on`: the first because SSH already owns that local port,
   * the second because retrying a failed bind every 5 seconds forever is the
   * exact silent-loop this port was written to remove.
   */
  private shouldForward(remotePort: number): boolean {
    const intent = this.intents.get(remotePort);
    if (intent === 'force-off') return false;
    // SSH config owns that local port already (`forwarder.py:916-922`).
    if (this.configPorts.has(remotePort)) return false;
    if (this.isRecentlyFailed(remotePort)) return false;
    // The remote port collides with a local listen port we already hold, and
    // it is not that forward's own mirror (`forwarder.py:924-929`).
    if (this.collidesWithOwnListener(remotePort)) return false;
    if (intent === 'force-on') return true;
    return this.matchesAutoPolicy(remotePort);
  }

  private isRecentlyFailed(remotePort: number): boolean {
    const failure = this.failedPorts.get(remotePort);
    if (!failure) return false;
    if (Date.now() - failure.at < this.config.failedPortTtlMs) return true;
    // The Python's `failed_ports` never expires, so one transient bind error
    // blacklists a port for the process lifetime. Android used a 60s TTL.
    this.failedPorts.delete(remotePort);
    return false;
  }

  private collidesWithOwnListener(remotePort: number): boolean {
    for (const f of this.forwards.values()) {
      if (f.spec.listenPort !== remotePort) continue;
      if (f.spec.kind === 'local' && f.spec.destPort === remotePort) continue; // own mirror
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Local port allocation (`forwarder.py:861-898`)
  // ---------------------------------------------------------------------

  private async resolveLocalPort(remotePort: number): Promise<number | null> {
    const remap = this.remappings.get(remotePort);
    if (remap !== undefined) return remap; // user choice always wins
    return this.findAvailableLocalPort(remotePort);
  }

  /**
   * Preferred (mirror) -> preferred+1..+999 -> a sweep of `localPortRange`.
   * Returns null when nothing is free; the caller records a failed port.
   */
  async findAvailableLocalPort(preferred: number): Promise<number | null> {
    if (await this.isLocalPortAvailable(preferred)) return preferred;
    for (let offset = 1; offset < MIRROR_SWEEP_DISTANCE; offset++) {
      const candidate = preferred + offset;
      if (candidate > MAX_PORT) break;
      if (await this.isLocalPortAvailable(candidate)) return candidate;
    }
    const [lo, hi] = this.config.localPortRange;
    for (let port = lo; port <= hi; port++) {
      if (await this.isLocalPortAvailable(port)) return port;
    }
    return null;
  }

  /**
   * In use by one of our own forwards, or unbindable by the OS.
   *
   * The bind probe is the whole point: without it a collision surfaced as
   * `Forwarder.start()` resolving false, the forward was dropped silently,
   * and the next scan retried the identical port forever.
   *
   * `exclusive: false` is Node's SO_REUSEADDR equivalent, and the Python's
   * comment for it is worth keeping (`forwarder.py:867-870`): without
   * SO_REUSEADDR a port left in TIME_WAIT by a just-closed forwarded
   * connection reads as busy, and the tool needlessly remaps to port+1.
   * (Node does not set SO_REUSEADDR on Windows by design; there, TIME_WAIT
   * does not block a fresh listen the same way, so the probe is still sound.)
   *
   * There is an inherent TOCTOU between probe and bind. That is fine — the
   * bind-failure path still exists; the probe just makes the common case pick
   * a working port on the first try instead of never.
   */
  isLocalPortAvailable(port: number): Promise<boolean> {
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return Promise.resolve(false);
    for (const f of this.forwards.values()) {
      if (f.spec.listenPort === port) return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const server = createServer();
      server.once('error', () => done(false));
      server.listen({ port, host: LOOPBACK_HOST, exclusive: false }, () => {
        server.close(() => done(true));
      });
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** The live local forward mirroring a remote port, if any. */
  private localForwardFor(remotePort: number): Forwarder | null {
    for (const f of this.forwards.values()) {
      if (f.spec.kind === 'local' && f.spec.destPort === remotePort) return f;
    }
    return null;
  }

  private async stopForwardsFor(remotePort: number): Promise<void> {
    for (const [key, f] of [...this.forwards]) {
      if (f.spec.kind !== 'local' || f.spec.destPort !== remotePort) continue;
      await f.stop();
      this.forwards.delete(key);
    }
  }

  private decorate(f: Forwarder, remotePort: number | null): void {
    if (remotePort === null) return;
    const scanned = this.discoveredPorts.find((p) => p.port === remotePort);
    f.setMeta({
      name: this.names.get(remotePort) ?? null,
      process: scanned?.process ?? null,
      cwd: scanned?.cwd ?? null,
    });
  }

  private emit(): void {
    const states = this.snapshot();
    for (const l of this.listeners) l(states);
  }
}
