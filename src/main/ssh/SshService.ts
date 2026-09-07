import { readFileSync } from 'node:fs';
import type { ClientChannel, PseudoTtyOptions } from 'ssh2';
import type { ConnectResult, ExecResult, ShellId } from '../../shared/types.js';
import { newClient, ConnectionRegistry, type ConnectionRecord } from './ConnectionRegistry.js';
import { ShellTracker } from './ShellTracker.js';
import type { KnownHosts } from '../ssh-config/KnownHosts.js';
import { log } from '../log.js';

/**
 * SSH connection service wrapping `ssh2`. Mirrors the contract of the
 * Android `RealSshSession`: connect with publickey auth + 15s keepalive +
 * 30s timeout; exec returns `{stdout, stderr, exitCode}` and **never
 * throws on non-zero exit** (exit codes are semantic, e.g. `command -v`);
 * tail spawns `tail -F`; shell opens a PTY (`xterm-256color`, 80×24).
 *
 * All methods return result objects rather than throwing for expected
 * failures (auth refused, host unreachable, transport drop). Hard
 * programming errors (bad arguments) still throw.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_KEEPALIVE_INTERVAL_SEC = 15;
export const PTY_TERM = 'xterm-256color';
export const PTY_DEFAULT_COLS = 80;
export const PTY_DEFAULT_ROWS = 24;

export interface ConnectOptions {
  host: string;
  port?: number;
  user: string;
  /**
   * The `~/.ssh/config` `Host` alias this connection came from
   * (`HostEntry.name`). Optional — a manually-entered host has none, and
   * everything downstream falls back to `user@host:port`.
   */
  hostAlias?: string;
  /** Absolute path to a private key file. */
  privateKeyPath?: string;
  /** Inline private key PEM/OpenSSH-v1 text (wins over privateKeyPath). */
  privateKey?: string;
  passphrase?: string;
  timeoutMs?: number;
  keepAliveIntervalSec?: number;
  /** When set, host keys are verified; unknown -> TOFU result. */
  knownHosts?: KnownHosts | null;
  /** TOFU decision: 'accept-always' appends to known_hosts; 'accept-once' proceeds without saving. */
  tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
}

export interface ExecOptions {
  /** Optional PTY (forces merge of stderr into stdout). */
  pty?: boolean;
  /** Env to set on the channel. */
  env?: Record<string, string>;
  /**
   * Write this text to the command's stdin, then close it.
   *
   * This exists for one caller, `pocketshell env set` (FEATURES.md F16): the
   * helper reads a secret's VALUE from stdin deliberately, so it never lands
   * in the command line — argv is readable by any process on the host via
   * `ps`, and a value in argv would also land in this app's own exec log in
   * plaintext. The transport already is the trust boundary; the value crosses
   * it either way, but only stdin keeps it out of every process list.
   */
  stdin?: string;
  /**
   * Cap on the whole exec — from the channel-open request to close — in
   * milliseconds. A channel that never closes would otherwise never settle
   * the promise, and the single-flight guards upstream (the auto-forward
   * scan latch, the per-connection attach queue) close for good the first
   * time that happens. Defaults to {@link EXEC_DEFAULT_TIMEOUT_MS}; `0` opts
   * out for legitimately unbounded commands (`repos clone`).
   */
  timeoutMs?: number;
}

/** Why a connection closed: an explicit disconnect, or the transport dropping. */
export type CloseReason = 'user' | 'lost';

export class SshService {
  private readonly shells: ShellTracker;
  /**
   * Listeners fired (best-effort) when a connection is closed. `reason`
   * distinguishes a user-initiated disconnect from the transport dropping
   * underneath us, so the UI can say which one happened.
   */
  private readonly closeListeners = new Set<
    (connectionId: string, reason: CloseReason) => void
  >();
  constructor(
    private readonly registry: ConnectionRegistry = new ConnectionRegistry(),
    shells?: ShellTracker,
  ) {
    this.shells = shells ?? new ShellTracker();
  }

  /** Expose the shell tracker so the IPC layer can route input/resize/close. */
  get shellTracker(): ShellTracker {
    return this.shells;
  }

  /** Subscribe to connection-close events (for evicting cached per-conn state). */
  onCloseConnection(listener: (connectionId: string, reason: CloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Attempt a connection. Resolves a {@link ConnectResult}; never rejects. */
  connect(opts: ConnectOptions): Promise<ConnectResult> {
    return new Promise((resolve) => {
      const client = newClient();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const fail = (error: string) => {
        try {
          client.end();
        } catch {
          // ignore
        }
        resolve({ ok: false, error });
      };

      const timer = setTimeout(() => {
        fail(`SSH connect timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      client.once('ready', () => {
        clearTimeout(timer);
        const id = this.registry.register({
          client,
          label: `${opts.user}@${opts.host}:${opts.port ?? 22}`,
          host: opts.host,
          port: opts.port ?? 22,
          user: opts.user,
          ...(opts.hostAlias?.trim() ? { hostAlias: opts.hostAlias.trim() } : {}),
          knownHosts: opts.knownHosts ?? null,
          connectedAt: Date.now(),
        });

        // Post-ready transport lifecycle. Without this the registry keeps
        // reporting `connected` after the link has gone away: the renderer
        // never learns the session died, and a send silently goes nowhere.
        // `close()` is idempotent, so a drop that emits both 'error' and
        // 'close' still notifies exactly once.
        client.on('error', () => this.close(id, 'lost'));
        client.on('close', () => this.close(id, 'lost'));

        resolve({ ok: true, connectionId: id });
      });

      client.once('error', (err: NodeJS.ErrnoException & { code?: string }) => {
        clearTimeout(timer);
        fail(translateError(err));
      });

      try {
        const privateKey = loadKey(opts);
        client.connect({
          host: opts.host,
          port: opts.port ?? 22,
          username: opts.user,
          privateKey,
          passphrase: opts.passphrase,
          readyTimeout: timeoutMs,
          keepaliveInterval: (opts.keepAliveIntervalSec ?? DEFAULT_KEEPALIVE_INTERVAL_SEC) * 1000,
          // Host-key verification via the callback ssh2 invokes during the
          // handshake. Returning true accepts the key (and proceeds to auth);
          // returning false aborts. We consult ~/.ssh/known_hosts here and
          // honour the caller's TOFU decision for unknown hosts.
          hostVerifier: (key: Buffer) => {
            if (!opts.knownHosts) return true; // caller opted out of verification
            const { type, b64 } = decodePublicKeyBlob(key);
            const verdict = opts.knownHosts.verify(opts.host, type, b64, opts.port ?? 22);
            if (verdict.trusted) return true;
            if (verdict.mismatch) {
              fail('Host key mismatch — connection refused (known_hosts).');
              return false;
            }
            // unknown
            if (opts.tofuDecision === 'reject') {
              fail('Host key rejected by user.');
              return false;
            }
            if (opts.tofuDecision === 'accept-always') {
              opts.knownHosts.add(opts.host, type, b64, opts.port ?? 22);
            }
            return true; // accept-once proceeds without saving
          },
        });
      } catch (e) {
        clearTimeout(timer);
        fail(`Failed to load key: ${(e as Error).message}`);
      }
    });
  }

  /**
   * Execute a command; resolve on completion. No throw on non-zero exit.
   *
   * Every call is timed into the log. This is the app's unit of remote work —
   * a user-visible action costs however many of these it makes, times whatever
   * one costs on that host — and until now nothing recorded either number, so
   * "it takes too long" had no way to become a fact. One line per exec gives
   * both: count them between two timestamps to see the round trips an action
   * spends, and read `ms` to see what the host charges for one.
   *
   * The command is logged truncated rather than in full. Nothing here is
   * secret today, but exec carries arbitrary shell and this file is what users
   * are asked to paste, so the prefix — enough to tell `sessions list` from
   * `sessions create` — is all it takes to read a trace.
   */
  async exec(connectionId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const rec = this.registry.require(connectionId);
    const startedAt = Date.now();
    const res = await execOnClient(rec, command, opts);
    log('exec', 'ran', {
      connectionId,
      ms: Date.now() - startedAt,
      exitCode: res.exitCode,
      command: execLogPreview(command),
    });
    return res;
  }

  /**
   * Fire-and-forget a background command (e.g. starting a remote listener).
   * Unlike {@link exec}, this does NOT wait for the exec channel to close —
   * a backgrounded process (`setsid ... &`) holds the channel's fds open, so
   * awaiting `close` would hang forever. Returns once the command is sent.
   */
  execBackground(connectionId: string, command: string): void {
    const rec = this.registry.require(connectionId);
    rec.client.exec(command, () => {
      /* intentionally ignored — the bg job owns its own lifetime */
    });
  }

  /**
   * Open a tracked PTY shell and return its id. Output bytes are delivered via
   * `onData`; exit via `onExit`. This is the form the IPC layer uses so the
   * renderer can address the shell across separate calls (input/resize/close)
   * by id alone.
   *
   * @param command Optional command to run inside the PTY (e.g. `tmux attach -t main`).
   *                When omitted, an interactive shell is opened.
   * @param commandMode How [command] reaches the far end. `'typed'` (the
   *                default) opens an interactive login shell and writes the
   *                command to its stdin as if the user had typed it, so a
   *                command that ends leaves a live prompt — the cost is that
   *                nothing runs until the user's profile has finished.
   *                `'exec'` runs the command DIRECTLY under the PTY
   *                (`exec` request with a pty): no login shell, no dotfiles —
   *                the first byte of the command is the first byte after the
   *                channel opens, and the channel closes when the command
   *                exits. Session joins use `'exec'`; the join latency is
   *                dominated by profile startup otherwise.
   */
  async openTrackedShell(
    connectionId: string,
    opts: {
      cols?: number;
      rows?: number;
      term?: string;
      command?: string;
      commandMode?: 'typed' | 'exec';
      onData: (data: Buffer) => void;
      onExit?: (exitCode: number) => void;
    },
  ): Promise<ShellId> {
    const rec = this.registry.require(connectionId);
    const pty = {
      term: opts.term ?? PTY_TERM,
      cols: opts.cols ?? PTY_DEFAULT_COLS,
      rows: opts.rows ?? PTY_DEFAULT_ROWS,
    };
    const channel =
      opts.commandMode === 'exec' && opts.command
        ? await openExecWithPty(rec, opts.command, pty)
        : await openShell(rec, pty);
    const id = this.shells.register({ channel, connectionId });
    channel.on('data', (chunk: Buffer) => opts.onData(chunk));
    channel.on('close', () => {
      opts.onExit?.(0);
      this.shells.remove(id);
    });
    // In the default mode the PTY runs an interactive login shell and the
    // command is sent as if the user typed it; in `'exec'` mode the command is
    // the channel and there is nothing to type it into.
    if (opts.command && opts.commandMode !== 'exec') {
      channel.write(opts.command + '\n');
    }
    return id;
  }

  /**
   * Write input bytes to a tracked shell's stdin (xterm.js -> remote).
   *
   * Returns whether the bytes reached the channel. This used to be `void`,
   * which let the composer's send path report success for a write that never
   * happened. Note `channel.write()` returning false means backpressure, not
   * failure — the data is still queued — so only an unknown shell or a throw
   * counts as a genuine failure.
   */
  shellInput(shellId: ShellId, data: string | Buffer): boolean {
    const rec = this.shells.get(shellId);
    if (!rec) return false;
    // Diagnostic for double-delivery. A paste that arrives twice is either
    // the renderer SENDING it twice (two live onData bindings) or the
    // terminal ECHOING it twice (two live output subscriptions), and those
    // need opposite fixes — this line tells the two apart. Only sizeable
    // payloads are logged: a per-keystroke entry would drown the file and
    // slow typing, and a paste is the reported symptom.
    if (data.length >= 8) {
      log('shell', 'input', {
        shellId,
        bytes: data.length,
        preview: data.toString().slice(0, 60),
      });
    }
    try {
      rec.channel.write(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Resize a tracked shell's PTY. Returns false if the shell is unknown. */
  shellResize(shellId: ShellId, cols: number, rows: number): boolean {
    const rec = this.shells.get(shellId);
    if (!rec) return false;
    try {
      rec.channel.setWindow(rows, cols, rows, cols);
      return true;
    } catch {
      return false;
    }
  }

  /** Close a tracked shell. */
  shellClose(shellId: ShellId): void {
    const rec = this.shells.remove(shellId);
    if (rec) {
      try {
        rec.channel.end();
        rec.channel.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Close a connection idempotently (also tears down its shells).
   *
   * `reason` is 'user' for an explicit disconnect and 'lost' when the
   * transport dropped underneath us. Listeners only fire on the transition,
   * so a repeat call for an already-removed connection is silent — which is
   * what makes the paired 'error'/'close' events safe to wire.
   */
  close(connectionId: string, reason: CloseReason = 'user'): void {
    this.shells.closeAllForConnection(connectionId);
    const rec = this.registry.remove(connectionId);
    if (!rec) return;
    for (const listener of this.closeListeners) {
      try {
        listener(connectionId, reason);
      } catch {
        // a listener failure must not break teardown
      }
    }
    try {
      rec.client.end();
    } catch {
      // ignore
    }
  }

  get registry_(): ConnectionRegistry {
    return this.registry;
  }
}

function loadKey(opts: ConnectOptions): Buffer {
  if (opts.privateKey) return Buffer.from(opts.privateKey, 'utf8');
  if (opts.privateKeyPath) return readFileSync(opts.privateKeyPath);
  throw new Error('No private key provided (pass privateKey or privateKeyPath).');
}

/**
 * The part of a command worth logging.
 *
 * `pathAwareCommand` wraps everything in `/bin/sh -lc 'export PATH=...; <real>'`,
 * so a raw prefix would be the same 60 characters of wrapper for every line and
 * identify nothing. The wrapper is stripped first, then what the user actually
 * asked for is truncated.
 */
export function execLogPreview(command: string, limit = 120): string {
  const unwrapped = /^\/bin\/sh -lc 'export PATH="[^"]*:\$PATH"; (.*)'$/s.exec(command);
  const meat = (unwrapped?.[1] ?? command).replace(/\s+/g, ' ').trim();
  return meat.length <= limit ? meat : `${meat.slice(0, limit)}…`;
}

/**
 * Default cap on one exec, generous because a `repos clone` is a legitimate
 * minutes-long round trip — but finite, because the failure it bounds is not
 * a slow command, it is a WEDGED CHANNEL: no data, no close, no transport
 * error, forever. Exported for the timeout tests.
 */
export const EXEC_DEFAULT_TIMEOUT_MS = 300_000;

export function execOnClient(
  rec: ConnectionRecord,
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    // Exactly one resolution, whichever of close / error / timeout lands
    // first; the rest become no-ops.
    let settled = false;
    let channel: ClientChannel | null = null;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    // Started at ISSUE, not at channel-open: a wedged transport can leave the
    // open request itself unanswered, in which case the callback below never
    // fires at all.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const note = `exec timed out after ${Math.round(timeoutMs / 1000)}s`;
        // Killing the channel is what frees its slot on the host. On a wedged
        // transport even this may be a no-op, but the RESULT is what unblocks
        // the callers — the scan latch and the attach queue run again.
        try {
          channel?.close();
        } catch {
          // nothing to save from a transport in this state
        }
        finish({ stdout, stderr: stderr ? `${stderr}\n${note}` : note, exitCode: -1 });
      }, timeoutMs);
    }
    rec.client.exec(command, (err, stream) => {
      if (err || !stream) {
        // Translate transport errors into an ExecResult; never reject.
        finish({ stdout: '', stderr: err?.message ?? 'exec failed', exitCode: -1 });
        return;
      }
      channel = stream;
      if (opts.stdin !== undefined) {
        // `.end(data)` writes and signals EOF in one call — the reader on the
        // far side is often a plain `read`, which terminates on the close.
        // A throw here means the channel died mid-handshake; say so rather
        // than resolving a result that looks like the command's own output.
        try {
          stream.stdin.end(opts.stdin);
        } catch (e) {
          finish({ stdout: '', stderr: (e as Error).message, exitCode: -1 });
          return;
        }
      }
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      // A channel error mid-run (reset, transport wedge tearing the channel
      // down) is otherwise an uncaught 'error' event — process-level in the
      // main process. Settle with whatever output had already arrived.
      stream.on('error', (streamErr: Error) => {
        finish({
          stdout,
          stderr: stderr ? `${stderr}\n${streamErr.message}` : streamErr.message,
          exitCode: -1,
        });
      });
      stream.on('close', (code: number | null) => {
        finish({ stdout, stderr, exitCode: code ?? -1 });
      });
    });
  });
}

/** The dial cap, reused for PTY opens: both are "the host answers or it won't". */
const OPEN_SHELL_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

function openShell(
  rec: ConnectionRecord,
  pty: { term: string; cols: number; rows: number },
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    // The PTY open is answered by the same transport that answered (or didn't)
    // the connect, but a dial cap alone does not cover it: connects are
    // one-per-dial, while opens are queued per connection behind
    // `TmuxClientPool`'s single-flight — so one hung open used to stall every
    // future tab open on that host, not just this one.
    const timer = setTimeout(() => {
      reject(new Error(`Opening a shell timed out after ${OPEN_SHELL_TIMEOUT_MS / 1000}s`));
    }, OPEN_SHELL_TIMEOUT_MS);
    // ssh2 `shell(window, callback)`: the first arg is the PTY options
    // (term/cols/rows). We request a real PTY so tmux/agent CLIs render.
    const window: PseudoTtyOptions = {
      term: pty.term,
      cols: pty.cols,
      rows: pty.rows,
    };
    rec.client.shell(window, (err, stream) => {
      clearTimeout(timer);
      if (err || !stream) {
        reject(err ?? new Error('shell failed'));
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Run [command] as the PTY itself: an `exec` request carrying a pty.
 *
 * The same timeout discipline as {@link openShell} — opens are queued per
 * connection, so one hung open must not stall the others. The command runs
 * under `sh -c` with sshd's plain environment; anything that needed the
 * user's interactive PATH must widen it itself, the way the session join
 * commands already do (`USER_BIN_PATH`).
 */
function openExecWithPty(
  rec: ConnectionRecord,
  command: string,
  pty: { term: string; cols: number; rows: number },
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Opening a shell timed out after ${OPEN_SHELL_TIMEOUT_MS / 1000}s`));
    }, OPEN_SHELL_TIMEOUT_MS);
    rec.client.exec(
      command,
      { pty: { term: pty.term, cols: pty.cols, rows: pty.rows } },
      (err, stream) => {
        clearTimeout(timer);
        if (err || !stream) {
          reject(err ?? new Error('exec with pty failed'));
          return;
        }
        resolve(stream);
      },
    );
  });
}

function translateError(err: NodeJS.ErrnoException & { code?: string }): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return `Host not found: ${err.message}`;
    case 'ECONNREFUSED':
      return `Connection refused: ${err.message}`;
    case 'ECONNRESET':
      return `Connection reset: ${err.message}`;
    case 'ETIMEDOUT':
      return `Connection timed out`;
    default:
      return err.message;
  }
}

/**
 * Decode an SSH public key blob (the raw bytes ssh2 hands to hostVerifier)
 * into the key-type label + the base64 that known_hosts stores.
 *
 * The blob format is RFC 4251 string-list: `<uint32 len><type><key-data...>`.
 * The base64 known_hosts line is the base64 of exactly this blob, so the b64
 * here is directly comparable to a known_hosts entry.
 */
function decodePublicKeyBlob(blob: Buffer): { type: string; b64: string } {
  // First 4 bytes = big-endian uint32 length of the key-type string.
  if (blob.length < 4) return { type: 'unknown', b64: blob.toString('base64') };
  const len = blob.readUInt32BE(0);
  const type =
    len > 0 && blob.length >= 4 + len
      ? blob.subarray(4, 4 + len).toString('utf8')
      : 'unknown';
  return { type, b64: blob.toString('base64') };
}
