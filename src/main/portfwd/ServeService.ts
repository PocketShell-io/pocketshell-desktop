import type { SshService } from '../ssh/SshService.js';
import { LOOPBACK_HOST } from '../../shared/net.js';
import type { ForwardService } from './ForwardService.js';
import type { ShellId } from '../../shared/types.js';
import { pathAwareCommand } from '../helper/bootstrap.js';
import { forwardKey } from './Forwarder.js';
import {
  choosePort,
  classifyServeOutput,
  parseServeProbe,
  pythonIsUsable,
  serveCommand,
  serveErrorMessage,
  serveLabel,
  serveProbeCommand,
  serveUrl,
  type ServeOutcome,
  type ServeProbe,
} from './serveCommand.js';

/**
 * "Serve this folder": run a static HTTP server on the host for a directory
 * the user right-clicked in the Files tab, tunnel it, and hand back a local
 * URL.
 *
 * Which server and why is argued in `serveCommand.ts`; the bind address and
 * what it protects against is argued at `SERVE_BIND_ADDRESS` there. This file
 * owns the three things that are not string manipulation: the channel the
 * server runs on, the forward that reaches it, and what happens to both when
 * something goes away.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TUNNEL IS THE EXISTING ONE
 * ---------------------------------------------------------------------------
 *
 * Nothing here opens a socket. The server binds 127.0.0.1 on the host, the
 * port scan that `AutoForwarder` already runs every 5s sees it like any other
 * listener (the scan keys on the port, not the bind address), and we express
 * "forward this one" as the `force-on` INTENT the panel's own toggle uses. So:
 *
 *   - the served folder appears in the Ports panel as a row, with a name,
 *     byte counters and a status, because it IS an ordinary row;
 *   - it is stoppable from there, because rows are;
 *   - there is exactly one kind of tunnel in the app, and one place where
 *     local-port allocation, collision handling and reconnect live.
 *
 * The side effect is the documented one: forcing a port on lazily starts the
 * whole auto-forward engine for that host (`ForwardService.setIntent` ->
 * `ensure`), and that is persisted. Serving a folder therefore turns
 * auto-forwarding on. That is the app's existing contract for this action, not
 * something invented here.
 *
 * ---------------------------------------------------------------------------
 * LIFETIME — THE PART THAT MATTERS ON SOMEONE ELSE'S PRODUCTION BOX
 * ---------------------------------------------------------------------------
 *
 * The server is NOT detached. It runs on a PTY channel opened by
 * {@link SshService.openTrackedShell}, having `exec`'d the login shell away so
 * python is the session leader on that pty. Closing the channel is a hangup,
 * and a hangup on a pty kills its session — so every way this app can go away
 * kills the server with it, without any bookkeeping that could be wrong:
 *
 *   - the user presses Stop        -> `shellClose` ends the channel
 *   - the connection is dropped    -> `SshService.close` calls
 *                                     `ShellTracker.closeAllForConnection`
 *   - the transport dies under us  -> sshd tears the channel down its end
 *   - the app quits                -> `registry.clear()` ends every client
 *
 * `execBackground` + `setsid` + a pidfile was the alternative, and it is the
 * wrong trade here: it survives all four of those, so the failure mode becomes
 * an orphaned `http.server` still publishing a directory on a live box after
 * the app that started it is gone, recoverable only by a pidfile that is
 * itself a thing that can be wrong. Surviving a reconnect is not worth that;
 * re-serving is one right-click.
 *
 * The cost is honest and small: a dropped connection stops the server. The
 * panel says so (the record goes to `state: 'stopped'`) rather than leaving a
 * URL that quietly answers nothing.
 */

/** Candidate ports tried before reporting failure (each loses a bind race). */
const MAX_PORT_ATTEMPTS = 3;

/** The two waits, injectable so tests do not have to sit through them. */
export interface ServeTimings {
  /** How long to wait for `Serving HTTP on` before giving up on a candidate. */
  readyTimeoutMs: number;
  /** How long to wait for the auto-forwarder to open the tunnel. */
  forwardTimeoutMs: number;
  forwardPollMs: number;
}

const DEFAULT_SERVE_TIMINGS: ServeTimings = {
  readyTimeoutMs: 8_000,
  // Comfortably more than two scan intervals (`scanIntervalSec` is 5s but
  // `setIntent` triggers a pass immediately), so a scan that loses the
  // single-flight race still gets a second chance inside the window.
  forwardTimeoutMs: 6_000,
  forwardPollMs: 300,
};

/** One folder being served on one host. */
export interface ServedFolder {
  connectionId: string;
  /** Absolute remote directory. */
  dir: string;
  /** Port on the HOST. Bound to 127.0.0.1 only — see SERVE_BIND_ADDRESS. */
  remotePort: number;
  /** Local port the tunnel listens on; null until the forward opens. */
  localPort: number | null;
  /** `http://127.0.0.1:<localPort>/`, or null while there is no tunnel. */
  url: string | null;
  startedAt: number;
  state: 'running' | 'stopped' | 'failed';
  /** Why it is not running, when it is not. */
  error: string | null;
}

/** Thrown by {@link ServeService.start}; the message is user-facing prose. */
export class ServeError extends Error {}

export class ServeService {
  /** connectionId -> remotePort -> record. */
  private readonly served = new Map<string, Map<number, ServedFolder>>();
  /** remotePort -> the channel its server runs on. Keyed with connectionId. */
  private readonly channels = new Map<string, ShellId>();
  private readonly listeners = new Set<
    (connectionId: string, served: ServedFolder[]) => void
  >();
  private readonly unsubscribeClose: () => void;

  constructor(
    private readonly ssh: SshService,
    private readonly forwards: ForwardService,
    private readonly timings: ServeTimings = DEFAULT_SERVE_TIMINGS,
  ) {
    // Subscribed here rather than wired in `index.ts` for the same reason
    // `ForwardService` does it: the service knows what a closed connection
    // means to it, and nothing else should have to remember.
    this.unsubscribeClose = ssh.onCloseConnection((connectionId) => {
      this.evict(connectionId);
    });
  }

  dispose(): void {
    this.unsubscribeClose();
    for (const connectionId of [...this.served.keys()]) {
      for (const port of [...(this.served.get(connectionId)?.keys() ?? [])]) {
        this.closeChannel(connectionId, port);
      }
    }
    this.served.clear();
  }

  /** Subscribe to per-connection snapshots. */
  onChanged(listener: (connectionId: string, served: ServedFolder[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Everything currently (or most recently) served on a connection. */
  list(connectionId: string): ServedFolder[] {
    return [...(this.served.get(connectionId)?.values() ?? [])];
  }

  /**
   * Start serving `dir`, forward it, and return the record with its URL.
   *
   * Rejects with a {@link ServeError} whose message is meant to be shown
   * verbatim. Nothing here reports success for a server that is not listening
   * or a tunnel that is not open — both are waited for and both time out.
   */
  async start(connectionId: string, dir: string): Promise<ServedFolder> {
    const existing = this.findByDir(connectionId, dir);
    if (existing && existing.state === 'running') return existing;

    const probe = await this.probe(connectionId, dir);

    // Everything we already know is wrong is refused before a channel is
    // opened, so the common failures cost one round trip and produce a
    // sentence instead of a dead URL.
    if (!probe.python) {
      throw new ServeError('No python3 on the host — the folder server needs it.');
    }
    if (!pythonIsUsable(probe.versionLine)) {
      throw new ServeError(
        `The host's python (${probe.versionLine ?? 'unknown version'}) is too old to serve a ` +
          'folder; 3.7 or newer is needed.',
      );
    }
    switch (probe.dir) {
      case 'missing':
        throw new ServeError(`${dir} is not there on the host.`);
      case 'not-a-directory':
        throw new ServeError(`${dir} is a file, not a folder.`);
      case 'unreadable':
        throw new ServeError(`${dir} is not readable on the host.`);
      case 'unknown':
        throw new ServeError(`Could not check ${dir} on the host.`);
      case 'ok':
        break;
    }

    // Ports this process handed out but the scan above could not have seen.
    const taken = new Set<number>(probe.taken);
    for (const rec of this.list(connectionId)) {
      if (rec.state === 'running') taken.add(rec.remotePort);
    }

    let lastOutcome: ServeOutcome | null = null;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = choosePort(taken);
      if (port === null) {
        throw new ServeError(serveErrorMessage({ kind: 'port-taken' }, dir));
      }
      const outcome = await this.launch(connectionId, dir, port, probe.python, probe.versionLine);
      if (outcome.kind === 'ready') {
        return await this.publish(connectionId, dir, port);
      }
      lastOutcome = outcome;
      // Only a lost bind race is worth another candidate — the rest would
      // fail identically on every port in the range.
      if (outcome.kind !== 'port-taken') break;
      taken.add(port);
    }

    throw new ServeError(
      lastOutcome ? serveErrorMessage(lastOutcome, dir) : 'The folder server did not start.',
    );
  }

  /**
   * Stop a served folder: kill the server, then take the tunnel down.
   *
   * The tunnel has to go EXPLICITLY. A `force-on` port is forwarded with
   * `origin: 'manual'`, and `AutoForwarder.stopPass` deliberately never reaps
   * manual forwards — so without this the local listener would outlive the
   * server and answer with a connection refused from the far end, which is
   * exactly the "silently not running" shape this feature must not have.
   *
   * The intent is then cleared rather than left at the `force-off` that
   * `remove` sets, so serving the same folder again is not blocked by the
   * last time it was stopped.
   */
  async stop(connectionId: string, remotePort: number): Promise<void> {
    const rec = this.served.get(connectionId)?.get(remotePort);
    this.closeChannel(connectionId, remotePort);
    if (rec) {
      rec.state = 'stopped';
      rec.error = null;
    }
    await this.teardownForward(connectionId, remotePort, rec?.localPort ?? null);
    // The record is kept only as long as it has something to say. A stopped
    // row that lingers is a second thing the user has to dismiss.
    this.served.get(connectionId)?.delete(remotePort);
    this.emit(connectionId);
  }

  /** Drop everything for a connection. The channels died with it. */
  evict(connectionId: string): void {
    const map = this.served.get(connectionId);
    if (!map) return;
    for (const port of map.keys()) this.channels.delete(channelKey(connectionId, port));
    this.served.delete(connectionId);
    this.emit(connectionId);
  }

  // -----------------------------------------------------------------------

  private async probe(connectionId: string, dir: string): Promise<ServeProbe> {
    const res = await this.ssh.exec(connectionId, pathAwareCommand(serveProbeCommand(dir)));
    // A non-zero exit here means the shell itself failed; the probe's own
    // branches all end in `true`. Report the stderr rather than parsing
    // whatever partial output came back.
    if (res.exitCode !== 0 && !res.stdout.includes('<<<')) {
      throw new ServeError(res.stderr.trim() || `could not reach the host (exit ${res.exitCode})`);
    }
    return parseServeProbe(res.stdout);
  }

  /**
   * Open the channel and wait for the server to say it is listening.
   *
   * Resolves with the outcome; a candidate that did not become ready has had
   * its channel closed by the time this returns, so a lost bind race leaves
   * nothing behind.
   */
  private launch(
    connectionId: string,
    dir: string,
    port: number,
    python: string,
    versionLine: string | null,
  ): Promise<ServeOutcome> {
    const command = serveCommand({ python, dir, port, versionLine });
    return new Promise<ServeOutcome>((resolve) => {
      let buffer = '';
      let settled = false;
      let shellId: ShellId | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      // Held because the channel id and the verdict can arrive in either
      // order: the PTY's first chunk is delivered by the same microtask queue
      // that resolves `openTrackedShell`, so a server that says "Serving HTTP
      // on" immediately can be classified BEFORE we know its shell id. Whoever
      // arrives second does the disposal — otherwise a successful serve
      // silently closed its own channel and `stop` had nothing left to kill.
      let verdict: ServeOutcome | null = null;

      const dispose = (): void => {
        if (!shellId || !verdict) return;
        if (verdict.kind === 'ready') this.channels.set(channelKey(connectionId, port), shellId);
        else this.ssh.shellClose(shellId);
      };

      const finish = (outcome: ServeOutcome): void => {
        if (settled) return;
        settled = true;
        verdict = outcome;
        if (timer) clearTimeout(timer);
        dispose();
        resolve(outcome);
      };

      // No ready line and no recognisable error inside the window: report what
      // the host actually said (its last line) rather than a bare "timed out",
      // because on the hosts where this happens the output IS the diagnosis.
      timer = setTimeout(() => {
        finish({
          kind: 'failed',
          message: buffer.trim().split(/\r?\n/).slice(-1)[0]?.trim() || 'the server did not start',
        });
      }, this.timings.readyTimeoutMs);
      timer.unref?.();

      this.ssh
        .openTrackedShell(connectionId, {
          command,
          onData: (chunk) => {
            buffer += chunk.toString('utf8');
            // Bounded: a server that logs every request would otherwise grow
            // this string for the lifetime of the connection. Only the head
            // matters — the ready line and any traceback are both at the top.
            if (buffer.length > 8_192) buffer = buffer.slice(0, 8_192);
            const outcome = classifyServeOutput(buffer);
            if (outcome) finish(outcome);
          },
          onExit: () => {
            if (settled) {
              // Died AFTER we reported it running: that is the "the process
              // dying" case, and the panel has to learn about it.
              this.onServerExited(connectionId, port);
              return;
            }
            finish(
              classifyServeOutput(buffer) ?? {
                kind: 'failed',
                message: buffer.trim().split(/\r?\n/).slice(-1)[0]?.trim() || 'the server exited',
              },
            );
          },
        })
        .then(
          (id) => {
            shellId = id;
            // A verdict that raced ahead of this resolve could not dispose of
            // a channel it did not yet have an id for. Do it now.
            if (settled) dispose();
          },
          (e: unknown) => finish({ kind: 'failed', message: (e as Error).message }),
        );
    });
  }

  /** Name the port, force it on, wait for the tunnel, record the result. */
  private async publish(connectionId: string, dir: string, port: number): Promise<ServedFolder> {
    const rec: ServedFolder = {
      connectionId,
      dir,
      remotePort: port,
      localPort: null,
      url: null,
      startedAt: Date.now(),
      state: 'running',
      error: null,
    };
    let byPort = this.served.get(connectionId);
    if (!byPort) {
      byPort = new Map();
      this.served.set(connectionId, byPort);
    }
    byPort.set(port, rec);

    // Name first, so the row is already labelled the moment it appears rather
    // than showing as an anonymous port for one scan interval.
    this.forwards.setName(connectionId, port, serveLabel(dir));
    await this.forwards.setIntent(connectionId, port, 'force-on');

    const localPort = await this.waitForForward(connectionId, port);
    if (localPort === null) {
      // The server is up but unreachable from here. Tear the whole thing down
      // rather than hand back a record with a null URL: a served folder you
      // cannot open is indistinguishable from one that never started, and the
      // process would sit on the host either way.
      this.closeChannel(connectionId, port);
      byPort.delete(port);
      await this.teardownForward(connectionId, port, null);
      this.emit(connectionId);
      throw new ServeError(
        `The server started on the host but the tunnel for port ${port} did not open.`,
      );
    }
    rec.localPort = localPort;
    rec.url = serveUrl(localPort);
    this.emit(connectionId);
    return rec;
  }

  /**
   * Poll until the auto-forwarder has opened our port, and report its local
   * port. Null on timeout.
   *
   * A poll rather than one `await`: `setIntent` does trigger a scan, but
   * `AutoForwarder` drops a scan that overlaps the periodic one (its
   * single-flight guard), so the first pass is not guaranteed to be ours.
   */
  private async waitForForward(connectionId: string, remotePort: number): Promise<number | null> {
    const deadline = Date.now() + this.timings.forwardTimeoutMs;
    for (;;) {
      const hit = this.forwards
        .list(connectionId)
        .find((f) => f.kind === 'local' && f.destPort === remotePort);
      if (hit) return hit.listenPort;
      if (Date.now() >= deadline) return null;
      await delay(this.timings.forwardPollMs);
      await this.forwards.refresh(connectionId);
    }
  }

  /** The server died on its own. Record it and take the tunnel with it. */
  private onServerExited(connectionId: string, remotePort: number): void {
    const rec = this.served.get(connectionId)?.get(remotePort);
    this.channels.delete(channelKey(connectionId, remotePort));
    if (!rec || rec.state !== 'running') return;
    rec.state = 'failed';
    rec.error = 'The server on the host stopped.';
    // Best-effort: the connection may be the thing that went away, in which
    // case `evict` has already run and this is a no-op.
    void this.teardownForward(connectionId, remotePort, rec.localPort).finally(() => {
      this.emit(connectionId);
    });
    this.emit(connectionId);
  }

  private async teardownForward(
    connectionId: string,
    remotePort: number,
    localPort: number | null,
  ): Promise<void> {
    try {
      if (localPort !== null) {
        await this.forwards.remove(
          connectionId,
          forwardKey({
            kind: 'local',
            listenHost: LOOPBACK_HOST,
            listenPort: localPort,
            destHost: LOOPBACK_HOST,
            destPort: remotePort,
          }),
        );
      }
      await this.forwards.setIntent(connectionId, remotePort, null);
      this.forwards.setName(connectionId, remotePort, null);
    } catch {
      // The connection is gone. Nothing to tear down that has not already
      // been torn down by the transport closing.
    }
  }

  private closeChannel(connectionId: string, remotePort: number): void {
    const key = channelKey(connectionId, remotePort);
    const shellId = this.channels.get(key);
    if (!shellId) return;
    this.channels.delete(key);
    this.ssh.shellClose(shellId);
  }

  private findByDir(connectionId: string, dir: string): ServedFolder | null {
    for (const rec of this.list(connectionId)) {
      if (rec.dir === dir) return rec;
    }
    return null;
  }

  private emit(connectionId: string): void {
    const snapshot = this.list(connectionId);
    for (const l of this.listeners) l(connectionId, snapshot);
  }
}

function channelKey(connectionId: string, remotePort: number): string {
  return `${connectionId}:${remotePort}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
