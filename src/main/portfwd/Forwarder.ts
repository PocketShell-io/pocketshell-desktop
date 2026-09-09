import { createServer, type Server, type Socket } from 'node:net';
import { LOOPBACK_HOST } from '../../shared/net.js';
import type { Client } from 'ssh2';
import type { ConnectionRegistry } from '../ssh/ConnectionRegistry.js';
import type { ForwardSpec } from '../../shared/types.js';

/**
 * A single port-forward rule over an SSH connection. Supports the three
 * forward types desktop users expect:
 *
 *   - local ('-L'):  listen on localhost, forward each connection out via
 *                    ssh2 `forwardOut` to (destHost:destPort) from the server.
 *   - remote ('-R'): ask the server to listen on (destHost:destPort) via
 *                    `forwardIn`; incoming connections arrive as 'tcp'
 *                    channels dispatched by {@link RemoteChannelDispatcher}.
 *   - dynamic ('-D'): run a local SOCKS5 server; per SOCKS request, open a
 *                    `forwardOut` to the requested host:port.
 *
 * The Android app implements local-only; remote + dynamic are net-new here.
 */

/** Where a forward came from. Drives what the UI may do with the row. */
export type ForwardOrigin = 'auto' | 'manual' | 'ssh-config';

/** Presentation metadata the AutoForwarder attaches to a live forward. */
export interface ForwardMeta {
  /** User-chosen friendly name for the remote port, or null. */
  name: string | null;
  /** Remote process name, from the port scan. */
  process: string | null;
  /** Remote process working directory, from the port scan. */
  cwd: string | null;
  /** True when listenPort !== destPort (mirroring was not possible/wanted). */
  remapped: boolean;
}

export interface ForwardState extends ForwardMeta {
  /** Stable identity of this forward. Always {@link forwardKey}(spec). */
  key: string;
  kind: ForwardSpec['kind'];
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  origin: ForwardOrigin;
  active: boolean;
  /** Bytes received FROM the remote side (download). */
  bytesIn: number;
  /** Bytes sent TO the remote side (upload). */
  bytesOut: number;
  /** Download rate, bytes/sec, since the previous snapshot. */
  rateIn: number;
  /** Upload rate, bytes/sec, since the previous snapshot. */
  rateOut: number;
}

export type ForwardEventListener = (state: ForwardState) => void;

/**
 * The one true identity of a forward.
 *
 * This string was previously rebuilt in three places in two different formats
 * (`local:8080->8080` in the auto path vs `local:8080->127.0.0.1:8080` in the
 * removal path and the renderer), so auto-created forwards could never be
 * removed from the UI. Everything now goes through here; the format is the
 * one `PortPanelView.vue` already builds, so no renderer change is needed.
 */
export function forwardKey(spec: ForwardSpec): string {
  return `${spec.kind}:${spec.listenPort}->${spec.destHost}:${spec.destPort}`;
}

/**
 * Minimum gap between rate samples. Below it, `snapshot()` reuses the last
 * computed rate instead of dividing by a near-zero interval (which would
 * produce absurd spikes whenever the UI polls twice in quick succession).
 */
const RATE_SAMPLE_MIN_MS = 500;

/** Default idle reaper window, ported from `SSH_FORWARD_IDLE_TIMEOUT` (1h). */
const DEFAULT_IDLE_TIMEOUT_MS = 3_600_000;

export interface ForwarderOptions {
  origin?: ForwardOrigin;
  /**
   * Tear down a proxied connection that has been silent in **both**
   * directions for this long, so an abandoned keep-alive socket cannot leak
   * an SSH channel forever (`forwarder.py:201-203`, `:246-247`).
   * 0 disables the reaper, matching the Python's semantics.
   */
  idleTimeoutMs?: number;
}

export class Forwarder {
  readonly spec: ForwardSpec;
  readonly key: string;
  readonly origin: ForwardOrigin;
  private server: Server | null = null;
  private listeners = new Set<ForwardEventListener>();
  private bytesIn = 0;
  private bytesOut = 0;
  private remoteAccepted = false;
  private readonly idleTimeoutMs: number;
  private meta: ForwardMeta = { name: null, process: null, cwd: null, remapped: false };
  private unregisterRemote: (() => void) | null = null;
  // Live proxied connections, so `stop()` can end them instead of waiting for
  // each one to end itself (see `adopt` / `stop`).
  private readonly inbound = new Set<Socket>();
  private readonly channels = new Set<{ destroy(): void }>();
  // Rate sampling state (see RATE_SAMPLE_MIN_MS).
  private lastSampleAt = Date.now();
  private lastBytesIn = 0;
  private lastBytesOut = 0;
  private rateIn = 0;
  private rateOut = 0;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly connectionId: string,
    spec: ForwardSpec,
    options: ForwarderOptions = {},
  ) {
    this.spec = spec;
    this.key = forwardKey(spec);
    this.origin = options.origin ?? 'manual';
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.meta.remapped = spec.kind === 'local' && spec.listenPort !== spec.destPort;
  }

  onStateChange(listener: ForwardEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Attach presentation metadata (friendly name, remote process, cwd). */
  setMeta(patch: Partial<ForwardMeta>): void {
    this.meta = { ...this.meta, ...patch };
  }

  private emit(): void {
    const state = this.snapshot();
    for (const l of this.listeners) l(state);
  }

  snapshot(): ForwardState {
    this.sampleRates();
    return {
      key: this.key,
      kind: this.spec.kind,
      listenHost: this.spec.listenHost,
      listenPort: this.spec.listenPort,
      destHost: this.spec.destHost,
      destPort: this.spec.destPort,
      origin: this.origin,
      active: this.isActive(),
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      rateIn: this.rateIn,
      rateOut: this.rateOut,
      ...this.meta,
    };
  }

  /**
   * Port of `get_stats()` (`forwarder.py:303-326`): deltas since the previous
   * sample divided by the elapsed wall time. Mutating inside `snapshot()` is
   * deliberate and matches the Python — the alternative is a second timer per
   * forward for a purely cosmetic number.
   */
  private sampleRates(): void {
    const now = Date.now();
    const elapsed = now - this.lastSampleAt;
    if (elapsed < RATE_SAMPLE_MIN_MS) return;
    this.rateIn = Math.max(0, ((this.bytesIn - this.lastBytesIn) * 1000) / elapsed);
    this.rateOut = Math.max(0, ((this.bytesOut - this.lastBytesOut) * 1000) / elapsed);
    this.lastSampleAt = now;
    this.lastBytesIn = this.bytesIn;
    this.lastBytesOut = this.bytesOut;
  }

  private isActive(): boolean {
    if (this.spec.kind === 'remote') return this.remoteAccepted;
    return !!this.server && this.server.listening;
  }

  /** Start the forward. Resolves true on success. */
  async start(): Promise<boolean> {
    try {
      if (this.spec.kind === 'local') return await this.startLocal();
      if (this.spec.kind === 'dynamic') return await this.startDynamic();
      if (this.spec.kind === 'remote') return await this.startRemote();
      return false;
    } catch {
      this.emit();
      return false;
    }
  }

  /** Tear down the forward (idempotent). */
  async stop(): Promise<void> {
    if (this.server) {
      // `close()` stops LISTENING, but its callback waits for every live
      // connection to end on its own — and with the idle reaper's hour as the
      // only other exit, one keep-alive connection could hold this await (a
      // stopPass inside a scan pass, a stopAuto in the disconnect path) for
      // up to that hour. The forward is being discarded: end its connections
      // now. The ssh2 channels are destroyed explicitly, because a destroyed
      // local socket never sends the EOF that would otherwise close them.
      for (const socket of this.inbound) socket.destroy();
      this.inbound.clear();
      for (const channel of this.channels) {
        try {
          channel.destroy();
        } catch {
          // already gone
        }
      }
      this.channels.clear();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (this.spec.kind === 'remote') {
      this.unregisterRemote?.();
      this.unregisterRemote = null;
      const client = this.client();
      if (client) {
        await new Promise<void>((resolve) =>
          client.unforwardIn(this.spec.destHost, this.spec.destPort, () => resolve()),
        );
      }
      this.remoteAccepted = false;
    }
    this.emit();
  }

  // --- local -L -----------------------------------------------------------
  private startLocal(): Promise<boolean> {
    return this.listenAndReport((socket) => {
      this.adopt(socket);
      this.pipeForwardOut(socket);
    });
  }

  // --- dynamic -D (SOCKS5) ------------------------------------------------
  private startDynamic(): Promise<boolean> {
    return this.listenAndReport((socket) => {
      this.adopt(socket);
      handleSocks5(socket, (host, port) => this.forwardOutTo(socket, host, port));
    });
  }

  /**
   * The one listen-and-settle shape both -L and -D share: bind, resolve true
   * on listening, false when the port is refused, and hand every inbound
   * socket to [onConnection]. The kinds differ only in what a connection does
   * — everything about the server's lifetime is the same.
   */
  private listenAndReport(onConnection: (socket: Socket) => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const server = createServer(onConnection);
      server.on('error', () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      server.listen(this.spec.listenPort, this.spec.listenHost, () => {
        this.server = server;
        this.emit();
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
    });
  }

  // --- remote -R ----------------------------------------------------------
  private startRemote(): Promise<boolean> {
    const client = this.client();
    if (!client) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      client.forwardIn(this.spec.destHost, this.spec.destPort, (err, remotePort) => {
        if (err || remotePort !== this.spec.destPort) {
          resolve(false);
          return;
        }
        this.remoteAccepted = true;
        // ONE 'tcp' listener per ssh2 Client, shared by every -R forward on
        // that client and dispatched by bind address. Registering per forward
        // (as this used to) meant N remote forwards each handled every single
        // inbound channel N times.
        this.unregisterRemote = RemoteChannelDispatcher.for(client).register(
          this.spec.destHost,
          this.spec.destPort,
          (accept) => this.onRemoteConnection(accept),
        );
        this.emit();
        resolve(true);
      });
    });
  }

  private onRemoteConnection(accept: () => Socket): void {
    const remote = accept();
    this.adopt(remote);
    // For a basic -R without a local destination we keep the channel open and
    // count bytes. Data arriving from the server is inbound (download).
    remote.on('data', (d: Buffer) => {
      this.bytesIn += d.length;
    });
    remote.on('error', () => remote.destroy());
    remote.on('close', () => this.emit());
    this.armIdleReaper(remote, null);
    this.emit();
  }

  // --- shared helpers -----------------------------------------------------
  private client(): Client | undefined {
    return this.registry.get(this.connectionId)?.client;
  }

  /**
   * Track an inbound socket for the lifetime of its connection. `stop()`
   * destroys what this set holds; without it, `server.close()`'s wait and the
   * idle reaper's hour are the only things that ever end a connection.
   */
  private adopt(socket: Socket): void {
    this.inbound.add(socket);
    socket.on('close', () => this.inbound.delete(socket));
  }

  private pipeForwardOut(socket: Socket): void {
    const client = this.client();
    if (!client) {
      socket.destroy();
      return;
    }
    this.forwardOutTo(socket, this.spec.destHost, this.spec.destPort);
  }

  private forwardOutTo(socket: Socket, destHost: string, destPort: number): void {
    const client = this.client();
    if (!client) {
      socket.destroy();
      return;
    }
    client.forwardOut(
      socket.remoteAddress ?? LOOPBACK_HOST,
      socket.remotePort ?? 0,
      destHost,
      destPort,
      (err, channel) => {
        if (err || !channel) {
          socket.destroy();
          return;
        }
        socket.pipe(channel);
        channel.pipe(socket);
        // DIRECTION: the local socket carries what the user's client SENDS
        // (upload = bytesOut); the SSH channel carries what the remote service
        // REPLIES (download = bytesIn). These were previously swapped, so the
        // panel's "In" column showed upload.
        socket.on('data', (buf: Buffer) => {
          this.bytesOut += buf.length;
        });
        channel.on('data', (buf: Buffer) => {
          this.bytesIn += buf.length;
        });
        const done = (): void => this.emit();
        socket.on('error', () => socket.destroy());
        channel.on('error', () => socket.destroy());
        socket.on('close', done);
        channel.on('close', done);
        // Remembered so `stop()` can destroy the channel: a destroyed local
        // socket never sends the EOF that would close it, and the forward's
        // SSH connection outlives the forward.
        this.channels.add(channel);
        channel.on('close', () => this.channels.delete(channel));
        this.armIdleReaper(socket, channel);
      },
    );
  }

  /**
   * Tear a proxied connection down once it has been silent in BOTH directions
   * for `idleTimeoutMs`. Any data on either side rearms the timer.
   */
  private armIdleReaper(
    socket: Socket,
    channel: { destroy: () => void; on: (e: 'data' | 'close', cb: () => void) => unknown } | null,
  ): void {
    if (this.idleTimeoutMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const kill = (): void => {
      socket.destroy();
      channel?.destroy();
    };
    const rearm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(kill, this.idleTimeoutMs);
      timer.unref?.();
    };
    const clear = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    socket.on('data', rearm);
    socket.on('close', clear);
    channel?.on('data', rearm);
    channel?.on('close', clear);
    rearm();
  }
}

/**
 * ssh2 emits a single untyped `'tcp'` event per Client for every inbound
 * channel of every active `forwardIn`, so the listener must live on the
 * client, not on the forward. This routes each channel to the one forward
 * that asked for that bind address, and denies anything unclaimed.
 *
 * One instance per Client, held in a WeakMap so a closed connection's entry
 * is collectable.
 */
class RemoteChannelDispatcher {
  private static readonly instances = new WeakMap<Client, RemoteChannelDispatcher>();

  private readonly handlers = new Map<string, (accept: () => Socket) => void>();

  private constructor(client: Client) {
    // @types/ssh2 does not model the 'tcp' event; narrow to the shape we use.
    (
      client as unknown as {
        on(
          event: 'tcp',
          listener: (
            info: { destIP: string; destPort: number; srcIP: string; srcPort: number },
            accept: () => Socket,
            deny: () => void,
          ) => void,
        ): unknown;
      }
    ).on('tcp', (info, accept, deny) => {
      const handler =
        this.handlers.get(bindKey(info.destIP, info.destPort)) ??
        // OpenSSH may report a wildcard bind back as '' or '0.0.0.0'; accept
        // any registration on the same port when the address does not match.
        this.handlers.get(bindKey('*', info.destPort));
      if (!handler) {
        deny();
        return;
      }
      handler(accept);
    });
  }

  static for(client: Client): RemoteChannelDispatcher {
    let instance = RemoteChannelDispatcher.instances.get(client);
    if (!instance) {
      instance = new RemoteChannelDispatcher(client);
      RemoteChannelDispatcher.instances.set(client, instance);
    }
    return instance;
  }

  /** Register a handler for one bind address. Returns an unregister function. */
  register(
    bindAddress: string,
    bindPort: number,
    handler: (accept: () => Socket) => void,
  ): () => void {
    const key = bindKey(bindAddress, bindPort);
    const wildcard = bindKey('*', bindPort);
    this.handlers.set(key, handler);
    this.handlers.set(wildcard, handler);
    return () => {
      if (this.handlers.get(key) === handler) this.handlers.delete(key);
      if (this.handlers.get(wildcard) === handler) this.handlers.delete(wildcard);
    };
  }
}

function bindKey(address: string, port: number): string {
  return `${address}:${port}`;
}

/**
 * Minimal SOCKS5 (no-auth) handshake: read the connect request, resolve the
 * destination, then hand the socket + target to `connect` for the caller to
 * open a `forwardOut`. Used by the dynamic (-D) forwarder.
 */
function handleSocks5(socket: Socket, connect: (host: string, port: number) => void): void {
  socket.once('data', (buf: Buffer) => {
    // Greeting: ver, nmethods, methods... (we only support no-auth = 0x00).
    if (buf.length < 2 || buf[0] !== 0x05) {
      socket.destroy();
      return;
    }
    socket.write(Buffer.from([0x05, 0x00]));
    socket.once('data', (req: Buffer) => {
      // CONNECT: ver(1) cmd(1) rsv(1) atyp(1) addr... port(2)
      if (req.length < 4 || req[0] !== 0x05 || req[1] !== 0x01) {
        socket.destroy();
        return;
      }
      const atyp = req[3];
      let host = '';
      let port = 0;
      let offset = 4;
      try {
        if (atyp === 0x01) {
          // IPv4
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          // domain
          const len = req[4] ?? 0;
          host = req.subarray(5, 5 + len).toString('ascii');
          offset = 5 + len;
        } else if (atyp === 0x04) {
          // IPv6
          const parts: string[] = [];
          for (let i = 0; i < 16; i++) parts.push(req[4 + i]!.toString(16));
          host = parts.join(':');
          offset = 20;
        } else {
          socket.destroy();
          return;
        }
        port = (req[offset]! << 8) | req[offset + 1]!;
      } catch {
        socket.destroy();
        return;
      }
      // Reply success, then defer to the caller's forwardOut.
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      connect(host, port);
    });
  });
}
