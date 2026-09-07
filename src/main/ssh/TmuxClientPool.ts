import { randomBytes } from 'node:crypto';
import type { GeometryProbe, ShellId } from '../../shared/types.js';
import { clientTtyVar, sessionAttachCommand } from '../../shared/attachCommand.js';
import { aplexerAttachCommand, type SessionBackend } from '../../shared/aplexer.js';
import { tmuxServerArg } from '../projects/commands.js';
import type { PocketshellClient } from '../helper/PocketshellClient.js';
import type { SshService } from './SshService.js';
import { pathAwareCommand } from '../helper/bootstrap.js';
import { log } from '../log.js';

/**
 * One attached tmux client PER SESSION TAB, kept alive for as long as the tab
 * is open, so that returning to a tab costs nothing at all.
 *
 * ## The problem, and why the previous answer was the wrong shape
 *
 * Selecting a session originally meant: open a second SSH channel, request a
 * PTY, wait for a login shell, and run `tmuxctl <name>` in it. Every part of
 * that is per-switch cost. The first fix (commit 516b488) held ONE client per
 * connection and moved it with `tmux switch-client`, which replaced ~250 ms of
 * host time with ~10 ms of exec — measured on a loopback Docker fixture.
 *
 * Measured on a REAL host, over a real link, out of the user's own log, that
 * trade did not survive contact:
 *
 *     switch that succeeded      p50 210 ms, max 425 ms   (8 of 41 attempts)
 *     switch that failed         140 ms - 4.4 s, THEN a full re-join
 *
 * Two costs the loopback benchmark could not show. First, a switch is an SSH
 * exec channel, and a channel is round trips: measured under netem the switch
 * tracks the link almost exactly — 15 ms at 0 RTT, 43 ms at 30 ms, 111 ms at
 * 100 ms. Second, `switch-client` makes tmux repaint every cell of the new
 * session down the PTY: 10.7 KB for one dense 200x50 screen, which is another
 * ~8 ms at 30 ms RTT and a visible wipe-and-redraw at any latency.
 *
 * Neither cost is a defect in the switch. They are what a switch IS. No amount
 * of tuning makes a remote repaint feel like changing tabs in an editor,
 * because the editor is not asking another machine for the tab's contents.
 *
 * ## The shape now
 *
 * A tab that has been opened keeps its own PTY, its own tmux client and its own
 * xterm, all mounted, for as long as the workspace is open. Switching tabs is
 * therefore a renderer visibility change and NOTHING ELSE: no SSH, no exec, no
 * redraw, no bytes. That is the property the user asked for by name — "the same
 * as VS Code when I switch between files" — and it is not reachable by making
 * the switch faster, only by not switching.
 *
 * tmux is built for this. Many clients may attach to one server, each on its
 * own session, and a session's window is sized from its own attached clients
 * (`window-size latest` by default in tmux 3.x), so one tab's geometry cannot
 * disturb another's.
 *
 * ## What it costs: SSH channels, and the ceiling is real
 *
 * Every live tab holds one channel. `sshd`'s `MaxSessions` defaults to 10, and
 * it is a HARD ceiling — measured against the fixture, channel 11 fails with
 * `Channel open failure: open failed`, and it fails for everything else the app
 * needs a channel for too (every `exec`, every SFTP operation, every tail).
 *
 * So the pool keeps at most {@link MAX_LIVE_CLIENTS} clients per connection and
 * evicts the least recently used one beyond that. The budget is per CONNECTION
 * but the demand is per FOLDER WORKSPACE — only the open workspace's tabs are
 * mounted — and the measured layout puts a real folder at
 * one to four sessions, so eviction is a bound rather than a routine event.
 *
 * Eviction closes the PTY and nothing else. A tmux SESSION lives in the tmux
 * server, not in our client, so an evicted tab loses no state whatsoever: the
 * next visit re-joins and gets the session exactly as it was. The renderer
 * learns through the ordinary `shell:exited` it already handles.
 *
 * ## What it costs: the first open of each tab
 *
 * A tab that has never been opened still pays the full join — a PTY, a login
 * shell and `tmuxctl`, which is Python and is ~150 ms on the fixture and 1.5-2 s
 * on the user's host. That cost is unchanged, but it is now paid ONCE PER TAB
 * instead of once per switch, so it amortises to nothing over a working
 * session. It is also the largest thing left; see the note on
 * {@link sessionAttachCommand} about what a raw `tmux attach-session` would
 * save, which is a separate decision from this one.
 *
 * ## What it costs on the host
 *
 * One tmux global-environment variable per (connection, session), left behind
 * on the tmux server when the app goes away — the same leak the shared client
 * had, bounded by distinct sessions opened rather than by joins, because the
 * token is stable per session so a re-join overwrites its own entry. The
 * variable carries the client's TTY, which {@link redraw} and
 * {@link windowSize} read back so their commands are about OUR client and
 * never about whoever else is attached; the SERVER those commands are aimed
 * at comes from the locator recorded alongside it.
 */

/**
 * A shell snippet reading one variable out of the tmux server's GLOBAL
 * environment, empty when it was never published. The join publishes the
 * client's tty before attaching (see {@link sessionAttachCommand}); a bare
 * `tmux` reaches the default socket from the exec channel, which is exactly
 * where that publish lands.
 */
function readTmuxGlobalVar(v: string): string {
  return `$(tmux show-environment -g ${v} 2>/dev/null | sed -n 's/^${v}=//p')`;
}

/**
 * A `tmux` invocation aimed at the server [socketPath] names, or the bare
 * default-socket spelling when it is null. The aiming convention lives in
 * `tmuxServerArg` (../projects/commands.ts); this is the pool's free-form-args
 * entry to it.
 */
function aimedTmux(socketPath: string | null, args: string): string {
  return `tmux ${tmuxServerArg(socketPath)}${args}`;
}

/** Callbacks for a shell this pool opens. Both carry the id they belong to. */
export interface AttachSessionOptions {
  cols?: number;
  rows?: number;
  /**
   * Bytes from the PTY. The {@link ShellId} is passed rather than closed over
   * by the caller because a fresh attach only learns its id when
   * `openTrackedShell` resolves, and the first bytes can beat that resolution.
   */
  onData: (shellId: ShellId, data: Buffer) => void;
  onExit: (shellId: ShellId, exitCode: number) => void;
  /**
   * Which runtime owns the session. Absent means `'tmux'`.
   *
   * An aplexer attach joins by UUID when [aplexerId] is known, else by
   * workspace+tag — never by bare tag, which is unique only within its
   * workspace. The pool keys the client the same way, so two folders holding
   * same-named tags hold two clients, not one aliasing the other.
   */
  backend?: SessionBackend;
  /** Aplexer workspace. Required for an aplexer attach without [aplexerId]. */
  workspace?: string;
  /** Aplexer tag. Defaults to the session name, which carries the tag. */
  tag?: string;
  /** Aplexer UUID. Preferred join selector; survives renames. */
  aplexerId?: string;
}

export interface AttachSessionResult {
  shellId: ShellId;
  /**
   * True when the pool already held a live client for this session, so the
   * renderer is being handed back the PTY it is already bound to and must NOT
   * reset its terminal — the screen it is showing is still the right screen.
   *
   * False when a new PTY was opened: rebind the streams, reset the terminal,
   * adopt the new id.
   *
   * In the per-tab design this is true only for a REPEAT ask about a tab that
   * is already live — a remount behind a `v-show`, a second window on the same
   * workspace, a retry after a transient error. The common case, a user
   * clicking between tabs, never reaches this class at all, because each tab
   * keeps the shell it was given.
   */
  switched: boolean;
}

/**
 * One attach, resolved to the identity the pool keys on.
 *
 * `name` is the display name — the tmux session name, or the aplexer tag the
 * row carries as its name. `key` is the pool key: tmux names are host-global
 * so the name alone keys them, while aplexer tags repeat across workspaces
 * and key on workspace+tag. Two folders holding same-named tags therefore
 * hold two clients rather than aliasing one.
 */
interface AttachTarget {
  name: string;
  key: string;
  backend: SessionBackend;
  workspace: string | null;
  tag: string;
  aplexerId?: string;
}

/** The pool key for (backend, name, workspace, tag). See {@link AttachTarget}. */
function clientKey(
  backend: SessionBackend,
  name: string,
  workspace?: string | null,
  tag?: string | null,
): string {
  if (backend === 'aplexer') return `aplexer:${workspace ?? ''}:${tag ?? name}`;
  return `tmux:${name}`;
}

/** Resolve an attach call's (name, options) into the pooled identity. */
function resolveTarget(sessionName: string, opts: AttachSessionOptions): AttachTarget {
  const backend = opts.backend ?? 'tmux';
  const tag = opts.tag ?? sessionName;
  const workspace = opts.workspace ?? null;
  return {
    name: sessionName,
    key: clientKey(backend, sessionName, workspace, tag),
    backend,
    workspace,
    tag,
    ...(opts.aplexerId ? { aplexerId: opts.aplexerId } : {}),
  };
}

/**
 * How many tmux clients one connection may hold at once.
 *
 * Six, against an `sshd` `MaxSessions` of 10. The four channels of headroom are
 * not slack: `SshService.exec` opens a channel per call and the app execs
 * constantly (the session list refresh, every projects command, every rename),
 * SFTP holds one for the Files tabs, and `tail` holds one per follow. Sizing
 * this at 9 would make an ordinary folder with nine sessions break file
 * browsing, and the failure — `Channel open failure` on an unrelated feature —
 * would point nowhere near the cause.
 *
 * Six is also comfortably above what a folder holds: the measurement
 * found 11 folders holding 11 sessions on this user's host, and the busiest
 * folder in the log has three.
 */
export const MAX_LIVE_CLIENTS = 6;

/** What the pool remembers about one live client. */
interface SessionClient {
  shellId: ShellId;
  /** The session this client is attached to. Fixed for its whole life. */
  session: string;
  /**
   * The pool key — `tmux:<name>` or `aplexer:<workspace>:<tag>`. Stored
   * because eviction finds the record without knowing which runtime it is.
   */
  key: string;
  /** Which runtime owns the session behind this client. */
  backend: SessionBackend;
  /** Aplexer workspace, or null for a tmux client. Fixed for its whole life. */
  workspace: string | null;
  /**
   * tmux global-environment variable holding this client's tty. Empty for an
   * aplexer client, which needs no handshake — `a attach` is one spelling
   * that reaches every session the snapshot lists.
   */
  ttyVar: string;
  /**
   * The tmux server this session lives on, discovered at join time via the
   * same enrichment probe that aims Stop and rename — or null when it could
   * not be learned (probe failed, tmux predates the `socket_path` column, no
   * helper injected). Null degrades {@link redraw}/{@link windowSize} to the
   * legacy bare-`tmux` spelling, which is the only aiming available and is
   * correct for sessions on the default socket.
   *
   * A rename does not touch this: `tmuxctl` renames within the session's own
   * server, so the socket outlives every name the session carries.
   */
  socketPath: string | null;
  /**
   * Eviction order: a monotonic counter, NOT a timestamp.
   *
   * `Date.now()` has millisecond resolution and a user clicking through tabs
   * produces several attaches inside one millisecond, which makes every
   * `lastUsed` equal and collapses "least recently used" into "first in the
   * map" — i.e. it would evict the tab the user is actively working in. A
   * counter cannot tie.
   */
  useOrder: number;
  /** When it was last used, for the eviction log only. */
  lastUsedAt: number;
}

export class TmuxClientPool {
  /** connectionId -> pool key -> its live client. */
  private readonly clients = new Map<string, Map<string, SessionClient>>();
  /**
   * connectionId -> pool key -> its stable handshake token.
   *
   * Kept even for sessions whose client has been evicted, so a re-join reuses
   * the same tmux variable instead of leaving another behind (see the class
   * comment). Tokens are strings; the map is bounded by sessions visited.
   * Aplexer clients hold no token — the entry is simply never read for them.
   */
  private readonly tokens = new Map<string, Map<string, string>>();
  /** Ever-increasing stamp handed to a client each time it is used. */
  private useClock = 0;
  /**
   * One attach at a time per connection.
   *
   * A client is not added to {@link clients} until its PTY has opened. Without
   * this queue, several TerminalViews mounting in the same renderer turn all
   * see the same old count, skip eviction, and open their channels together.
   * That makes the channel budget a statement about completed attaches rather
   * than the requests actually in flight.
   */
  private readonly attachQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ssh: SshService,
    /**
     * The helper client, used for one thing: locating the tmux server a
     * session lives on at join time ({@link PocketshellClient.locateSession}
     * — the same probe that aims Stop and rename). Optional only so existing
     * constructions keep compiling; without it every aimed command degrades
     * to the legacy bare-`tmux` spelling, which is precisely the behaviour
     * that made Redraw a silent no-op on per-session-server hosts.
     */
    private readonly helper?: PocketshellClient,
  ) {}

  /**
   * Display [sessionName] on [connectionId].
   *
   * Returns the live client for that session when there is one — which is the
   * whole point, and costs nothing — and otherwise joins, evicting the least
   * recently used client first if the connection is at its channel budget.
   *
   * Never throws for anything the host does; only a failure to open a PTY at
   * all propagates, which is the contract `shell:open` already has.
   */
  async attach(
    connectionId: string,
    sessionName: string,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    // Keep the capacity decision and the subsequent PTY open atomic with
    // respect to other attaches on this connection. A rejected attach must not
    // poison the queue for the request behind it, hence the catch before the
    // next operation starts.
    const previous = this.attachQueues.get(connectionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.attachNow(connectionId, sessionName, opts));
    this.attachQueues.set(connectionId, current);
    try {
      return await current;
    } finally {
      if (this.attachQueues.get(connectionId) === current) this.attachQueues.delete(connectionId);
    }
  }

  /** Perform one attach after this connection's earlier request has finished. */
  private async attachNow(
    connectionId: string,
    sessionName: string,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    const target = resolveTarget(sessionName, opts);
    const held = this.live(connectionId, target.key);
    log('tmux', 'attach requested', {
      connectionId,
      sessionName,
      backend: target.backend,
      held: held != null,
      liveClients: this.liveCount(connectionId),
    });
    if (held) {
      // The tab is already up. This is the case the whole design exists to
      // make free, and it is free: no exec, no redraw, no bytes on the wire.
      held.useOrder = ++this.useClock;
      held.lastUsedAt = Date.now();
      return { shellId: held.shellId, switched: true };
    }

    this.evictDownTo(connectionId, MAX_LIVE_CLIENTS - 1);
    return this.joinWithCapacityRetry(connectionId, target, opts);
  }

  /**
   * Ask the tmux client behind [shellId] to repaint every cell it owns.
   *
   * ## Why a resize is not enough
   *
   * A PTY resize is how the far end learns our geometry, and tmux repaints
   * when that number changes. It does NOT repaint when the number is the same,
   * and it never repaints rows it does not believe exist. Both cases are the
   * user's bug report: tmux had been drawing to a screen shorter than the
   * pane, so the band below its status line held cells nobody had written
   * since — and re-sending the size it already had cleared nothing, because
   * from tmux's side nothing moved.
   *
   * `refresh-client` is the command for exactly that: redraw, without changing
   * anything. It is targeted at OUR client rather than run bare, because a
   * bare `refresh-client` picks whatever client tmux considers current, which
   * on a host where the user also has a terminal attached is somebody else's
   * screen.
   *
   * ## How our client is named
   *
   * By the tty the joining PTY published into the tmux server's global
   * environment (see {@link sessionAttachCommand}). That handshake was built
   * for `switch-client` and kept afterwards purely as a diagnostic.
   *
   * ## Why the command is aimed at a socket, not run bare
   *
   * The tty variable answers WHO to repaint; the enrichment probe
   * ({@link PocketshellClient.locateSession}, run once at join time and kept
   * on the record) answers WHERE. tmuxctl 0.3.5 puts every session it creates
   * on its own server (`tmuxctl-<name>` beside the legacy default socket), so
   * a bare `tmux refresh-client -t $tty` runs against a server that has never
   * heard of our client and answers `can't find client` — which this method
   * swallowed as a silent false. That was the user's bug report: Redraw
   * clicked on a garbled pane changed nothing, for every session the app
   * creates. `-S <socket>` (the same aiming `sessionExistsCommand` introduced
   * for Stop and rename) reaches the server the client actually belongs to;
   * a null socket keeps the bare spelling, which is correct for sessions on
   * the default socket and the only spelling available without the probe.
   *
   * ## Failure is logged, not thrown
   *
   * Every arm degrades to a no-op: no record for the shell, the variable never
   * published (the join raced, or tmux was too old for `set-environment`), the
   * client since detached. A redraw that does not happen costs a stale band on
   * screen until the next one; a redraw that throws would break a tab switch.
   * The failure used to be silent, which is how a systematically broken Redraw
   * shipped; a non-zero exit is now logged with tmux's stderr so the next
   * report of "Redraw does nothing" has a trace to read. Returns whether the
   * refresh was actually issued, for the tests and for the log.
   */
  async redraw(shellId: ShellId): Promise<boolean> {
    const held = this.clientForShell(shellId);
    if (!held) return false;
    // An aplexer client repaints its live screen on every attach and follows
    // the PTY size through SIGWINCH — there is no stale band a refresh could
    // clear, so there is nothing to issue. True, not false: the repaint the
    // caller wanted is already the steady state, and false would read as "no
    // client to refresh".
    if (held.backend === 'aplexer') return true;
    const connectionId = this.connectionForShell(shellId);
    if (!connectionId) return false;
    // One exec, one round trip: read the tty back out of the tmux global
    // environment and refresh that client in the same shell. Splitting it in
    // two would double the latency of every tab switch for no gain.
    const command = `tty=${readTmuxGlobalVar(held.ttyVar)}; ` +
      `[ -n "$tty" ] && ${aimedTmux(held.socketPath, 'refresh-client -t "$tty"')}`;
    try {
      const res = await this.ssh.exec(connectionId, pathAwareCommand(command));
      if (res.exitCode !== 0) {
        log('tmux', 'redraw could not reach our client', {
          shellId,
          session: held.session,
          socketPath: held.socketPath,
          exitCode: res.exitCode,
          stderr: res.stderr.slice(0, 200),
        });
      }
      return res.exitCode === 0;
    } catch (e) {
      log('tmux', 'redraw exec failed', {
        shellId,
        session: held.session,
        error: String(e).slice(0, 200),
      });
      return false;
    }
  }

  /**
   * Ask tmux what geometry IT believes is behind [shellId], and answer
   * honestly about whether it could be asked at all.
   *
   * ## Why two quantities, not one
   *
   * The stale-geometry failure starts on the FAR side: under tmux's
   * `window-size latest`, another client of the same session — the phone, the
   * user's own terminal — can become latest and shrink or grow the window
   * while nothing moves here. From this side nothing changed, so
   * TerminalView's `sent` guard correctly sends nothing, and the disagreement
   * sits on screen until something outside forces a repaint. Correcting what
   * cannot be noticed requires being ABLE to notice it, and this read-only
   * question is that ability.
   *
   * But which number to compare against was measured, not assumed, and the
   * first spelling of this probe got it wrong: it asked for
   * `#{window_width} #{window_height}` and the renderer compared that against
   * the xterm grid. `window_height` is the PANE area — a session running its
   * status line (the default) answers one row SHORT of the PTY's height
   * forever. Compared against the full grid, the probe therefore disagreed on
   * every tick, and every visible pane re-sent its size and repainted every
   * interval while healthy; with the status line OFF it agreed even when
   * genuinely drifted. Both halves of that are fixed by asking for two
   * quantities and letting the renderer compare each against the thing it is
   * actually about: `#{client_width} #{client_height}` is the size of OUR
   * client's tty — exactly what `resize` set — and
   * `#{window_width} #{window_height}` is the window that tty is showing,
   * which is `client` minus the status-line row at most. One `display-message`
   * carries both; the probe still costs one exec and zero bytes into the pane.
   *
   * ## Why `display-message` and not the PTY's own size
   *
   * The kernel pty behind this channel already answers with our size — but it
   * only ever repeats what WE told sshd, so comparing against it checks our
   * bookkeeping against itself. The quantities whose drift breaks rendering
   * live in the tmux SERVER. `-t "$tty"` names OUR client by its tty (the
   * same rendezvous {@link redraw} uses), so the answer is about our view,
   * not somebody else's.
   *
   * ## Why the three kinds, and not a nullable size
   *
   * The probe used to fold every failure — shell not ours, handshake variable
   * never published, client detached, exec failed — into `null`, and the
   * renderer treated null as "nothing to check". On a host where the aiming
   * could not reach the client, the repair loop was then permanently DEAD
   * while looking healthy: no answer, no error, no repair, forever — which is
   * the shape of the garbled-pane report that only a manual re-join cured.
   * `bare` says "never ask again"; `dead` says "ask, and keep failing" so the
   * renderer can re-join; `ok` carries the measured pair. See
   * {@link GeometryProbe} for the contract.
   *
   * ## Cost and failure, both bounded
   *
   * One exec for a shell the pool holds, NOTHING AT ALL for a shell it does
   * not — a bare shell is normal, not an error, and a probe that cannot be
   * answered must cost less than doing without one. Nothing here throws.
   */
  async windowSize(shellId: ShellId): Promise<GeometryProbe> {
    const held = this.clientForShell(shellId);
    if (!held) return { kind: 'bare' };
    // No tmux behind an aplexer shell to ask — and no `window-size latest`
    // second client that can move a window under us either, since concurrent
    // attaches share one live terminal sized by the active device. `bare` is
    // the honest answer: the renderer's reconcile loop stops probing, which
    // is exactly right when there is nothing to drift.
    if (held.backend === 'aplexer') return { kind: 'bare' };
    const connectionId = this.connectionForShell(shellId);
    if (!connectionId) return { kind: 'bare' };
    // Same shape as {@link redraw}: recover our client's tty from the global
    // environment, aim at the session's own tmux server (see the redraw note
    // for why bare `tmux` cannot reach a helper-created client), and name our
    // client by its tty, so the answer is about our view and the command
    // costs one round trip.
    const command = `tty=${readTmuxGlobalVar(held.ttyVar)}; ` +
      `[ -n "$tty" ] && ${aimedTmux(
        held.socketPath,
        `display-message -p -t "$tty" '#{client_width} #{client_height} #{window_width} #{window_height}'`,
      )}`;
    try {
      const res = await this.ssh.exec(connectionId, pathAwareCommand(command));
      // A non-zero exit covers every "could not ask": the variable never
      // published (the join raced, or tmux pre-dates `set-environment`), the
      // client has since detached (`can't find client`), the server is gone.
      // All are `dead`, never an error worth raising — but never a quiet
      // `ok` either.
      if (res.exitCode !== 0) return { kind: 'dead' };
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(res.stdout);
      if (!m) return { kind: 'dead' };
      return {
        kind: 'ok',
        client: { cols: Number(m[1]), rows: Number(m[2]) },
        window: { cols: Number(m[3]), rows: Number(m[4]) },
      };
    } catch {
      return { kind: 'dead' };
    }
  }

  /** Forget a connection's clients. Called when the connection goes away. */
  release(connectionId: string): void {
    this.clients.delete(connectionId);
    this.tokens.delete(connectionId);
  }

  /**
   * A session this pool holds a client for has been renamed on the host.
   *
   * The pool keys clients by NAME, and that name is what {@link isShowing}
   * fences composer sends against and what {@link attach} matches on. A rename
   * behind its back would break two things quietly: the next composer send
   * would be rejected as belonging to a stranger, and re-selecting the renamed
   * session would look like a session we do not hold and cost a full re-join
   * beside the client that is already showing it.
   *
   * Nothing else has to move. The tmux CLIENT is unaffected — clients follow a
   * session by id, so a rename does not detach anything — and the handshake
   * variable is keyed on a random token rather than on the session name. The
   * token map moves with it so a later re-join of the renamed session still
   * overwrites its own tmux variable rather than adding one.
   *
   * An aplexer rename changes the tag, never the id or the workspace, so the
   * client moves from one workspace-qualified key to another; the PTY stays
   * attached throughout, exactly like the tmux case. Pass [opts] with the
   * row's backend and workspace so the right key moves.
   *
   * Returns true when a record was actually updated, which is only a
   * diagnostic: a rename of a session this connection does not hold is a
   * perfectly ordinary no-op.
   */
  renamed(
    connectionId: string,
    from: string,
    to: string,
    opts?: { backend?: SessionBackend; workspace?: string | null },
  ): boolean {
    const backend = opts?.backend ?? 'tmux';
    const fromKey = clientKey(backend, from, opts?.workspace, from);
    const held = this.clients.get(connectionId)?.get(fromKey);
    if (!held) return false;
    const byName = this.clients.get(connectionId)!;
    const toKey = clientKey(backend, to, opts?.workspace ?? held.workspace, to);
    byName.delete(fromKey);
    held.session = to;
    held.key = toKey;
    byName.set(toKey, held);

    const tokens = this.tokens.get(connectionId);
    const token = tokens?.get(fromKey);
    if (tokens && token !== undefined) {
      tokens.delete(fromKey);
      tokens.set(toKey, token);
    }
    log('tmux', 'session renamed under a live client', { connectionId, from, to });
    return true;
  }

  /**
   * A session this pool may hold a client for has been KILLED on the host
   *
   *
   * The mirror image of {@link renamed}, and the reason both exist: this pool
   * keys clients by session key, so anything that changes what that key means
   * — or stops it meaning anything — has to be told, or the map keeps a record
   * of a session that is not there.
   *
   * The PTY is closed here rather than left to expire. It WOULD expire: the
   * tmux client on the far end detaches when its session dies and the login
   * shell exits, so `shell:exited` reaches the renderer on its own within a
   * round trip. But "on its own within a round trip" is not a guarantee — a
   * wedged link leaves the channel open against a `MaxSessions` budget of ten —
   * and, more to the point, the record has to go SYNCHRONOUSLY with the kill.
   * Otherwise {@link attach} can hand a caller a client for a session that no
   * longer exists, and {@link isShowing} keeps fencing composer sends against a
   * name nothing answers to.
   *
   * The handshake token goes too, unlike in a rename where it merely moves. A
   * rename keeps the same session and so wants the same tmux variable; a kill
   * ends the session, and a later session that happens to reuse the name — which
   * `sessions create` produces routinely, since it derives the name from the
   * folder — is a DIFFERENT session that must not inherit the dead one's tty
   * rendezvous.
   *
   * Returns whether a live client was actually closed, which is diagnostic
   * only: killing a session no tab was showing is perfectly ordinary.
   */
  killed(
    connectionId: string,
    session: string,
    opts?: { backend?: SessionBackend; workspace?: string | null },
  ): boolean {
    const backend = opts?.backend ?? 'tmux';
    const key = clientKey(backend, session, opts?.workspace, session);
    const byName = this.clients.get(connectionId);
    const held = byName?.get(key);
    this.tokens.get(connectionId)?.delete(key);
    if (!held || !byName) return false;
    byName.delete(key);
    // The tracker is consulted rather than trusted: the channel may already have
    // gone (an eviction, a drop), and `shellClose` on a stale id is a no-op we
    // would rather not log as a close that happened.
    const live = this.ssh.shellTracker.get(held.shellId) != null;
    if (live) this.ssh.shellClose(held.shellId);
    log('tmux', 'session killed under a live client', {
      connectionId,
      session,
      shellId: held.shellId,
      closed: live,
    });
    return live;
  }

  /**
   * The session a shell is attached to, or null. Test/diagnostic.
   *
   * Keyed on the SHELL rather than on the connection, because a connection no
   * longer has one answer: it has one per live tab.
   */
  sessionForShell(shellId: ShellId): string | null {
    for (const byName of this.clients.values()) {
      for (const held of byName.values()) {
        if (held.shellId === shellId) return held.session;
      }
    }
    return null;
  }

  /** The pool's record for a shell, or undefined. */
  private clientForShell(shellId: ShellId): SessionClient | undefined {
    for (const byName of this.clients.values()) {
      for (const held of byName.values()) {
        if (held.shellId === shellId) return held;
      }
    }
    return undefined;
  }

  /**
   * The connection a shell belongs to.
   *
   * Recovered by walking the map rather than stored on the record, because the
   * record is keyed inside its connection's map already and a second copy of
   * the same fact is a second thing to keep in step across `renamed` and
   * eviction.
   */
  private connectionForShell(shellId: ShellId): string | null {
    for (const [connectionId, byName] of this.clients) {
      for (const held of byName.values()) {
        if (held.shellId === shellId) return connectionId;
      }
    }
    return null;
  }

  /** The sessions a connection currently holds live clients for. Diagnostic. */
  liveSessions(connectionId: string): string[] {
    const byName = this.clients.get(connectionId);
    if (!byName) return [];
    return [...byName.values()]
      .filter((held) => this.ssh.shellTracker.get(held.shellId))
      .map((held) => held.session);
  }

  /**
   * Whether it is safe to write [sessionName]'s input to [shellId].
   *
   * With one client per session this fence is exact rather than temporal, and
   * that is a genuine simplification of the hazard commit 516b488 described. A
   * composer send is not one write — it puts the prompt text in, waits (250 ms
   * or more for Codex's TUI), then sends Enter — and under a SHARED client a
   * user who hit Send and immediately clicked another tab could have the Enter
   * submit a stranger's pane, because the shell's meaning changed underneath
   * the send. A per-tab client cannot change meaning: the shell is bound to its
   * session for its whole life, so a send that started against the right shell
   * finishes against the right session no matter what the user clicks.
   *
   * The check is kept anyway, and is now a real assertion rather than a race
   * guard: it catches a caller holding a stale id for a session whose tab was
   * evicted and re-joined onto a different shell. A caller that names no
   * session is passed through, as before — terminal keystrokes come from the
   * focused pane and always mean whatever it is currently displaying, and a
   * shell this pool never opened cannot be misrouted in the first place.
   *
   * For an aplexer client the name alone is not the identity — two folders can
   * hold same-named tags — so a caller that knows the workspace passes it and
   * both halves must match. A caller that does not (terminal keystrokes never
   * do) falls back to the name, which is the same answer the tmux case gives.
   */
  isShowing(shellId: ShellId, sessionName: string, workspace?: string): boolean {
    const held = this.clientForShell(shellId);
    if (!held) return true;
    if (held.session !== sessionName) return false;
    if (
      held.backend === 'aplexer' &&
      workspace != null &&
      held.workspace != null &&
      held.workspace !== workspace
    ) {
      return false;
    }
    return true;
  }

  /**
   * The remembered client for a pool key, but only if its channel is still
   * tracked.
   *
   * The renderer closes the PTY when a terminal unmounts, and a dropped
   * connection closes every shell on it, neither of which routes through this
   * class. Consulting the tracker rather than trusting the map is what keeps a
   * closed channel from being handed out as a live client.
   */
  private live(connectionId: string, key: string): SessionClient | undefined {
    const byName = this.clients.get(connectionId);
    const held = byName?.get(key);
    if (!held) return undefined;
    if (this.ssh.shellTracker.get(held.shellId)) return held;
    byName!.delete(key);
    return undefined;
  }

  /** How many of a connection's remembered clients still have a live channel. */
  private liveCount(connectionId: string): number {
    const byName = this.clients.get(connectionId);
    if (!byName) return 0;
    let n = 0;
    for (const [name, held] of [...byName]) {
      // Prune as we count: a shell the renderer or a drop closed is not a
      // client, and leaving it in the map would evict a healthy tab to make
      // room that was already there.
      if (this.ssh.shellTracker.get(held.shellId)) n += 1;
      else byName.delete(name);
    }
    return n;
  }

  /**
   * Close least-recently-used clients until at most [limit] remain live.
   *
   * LRU rather than oldest-first because the tabs a user moves between are the
   * ones that must stay instant, and those are exactly the recently used ones.
   * Closing the PTY is the whole of an eviction: the tmux session is
   * server-side and survives untouched, so the tab loses its channel and
   * nothing else, and the renderer finds out through the `shell:exited` it
   * already listens for.
   */
  private evictDownTo(connectionId: string, limit: number): void {
    const byName = this.clients.get(connectionId);
    if (!byName) return;
    while (this.liveCount(connectionId) > Math.max(0, limit)) {
      if (!this.evictOne(connectionId)) return;
    }
  }

  /** Close one live least-recently-used client, if this connection has one. */
  private evictOne(connectionId: string): boolean {
    const byName = this.clients.get(connectionId);
    if (!byName) return false;
    let victim: SessionClient | undefined;
    for (const held of byName.values()) {
      if (!this.ssh.shellTracker.get(held.shellId)) continue;
      if (!victim || held.useOrder < victim.useOrder) victim = held;
    }
    if (!victim) return false;
    log('tmux', 'evicting the least recently used client to stay under the channel budget', {
      connectionId,
      session: victim.session,
      shellId: victim.shellId,
      idleMs: Date.now() - victim.lastUsedAt,
      budget: MAX_LIVE_CLIENTS,
    });
    this.ssh.shellClose(victim.shellId);
    byName.delete(victim.key);
    return true;
  }

  /**
   * Retry one PTY open after freeing a cached client when the SSH server says
   * its channel ceiling was reached. A single retry is deliberate: it covers
   * the common lower-MaxSessions/short-lived-channel cases without discarding
   * every tab when an unrelated server-side policy is refusing PTYs.
   */
  private async joinWithCapacityRetry(
    connectionId: string,
    target: AttachTarget,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    try {
      return await this.join(connectionId, target, opts);
    } catch (error) {
      if (!isChannelOpenFailure(error) || !this.evictOne(connectionId)) throw error;
      log('tmux', 'PTY open hit the SSH channel ceiling; retrying after one eviction', {
        connectionId,
        session: target.name,
        error: String(error).slice(0, 200),
      });
      return this.join(connectionId, target, opts);
    }
  }

  /**
   * Open a PTY and run the documented join in it.
   *
   * There is no longer a `note` parameter. It existed to print, into the
   * terminal, the tmux reason a failed `switch-client` had forced a re-join —
   * a fallback nobody could see. The pool no longer switches, so there is no
   * such fallback and nothing to explain: a join here is either the first time
   * a tab was opened or the return to an evicted one, and both are ordinary.
   *
   * An aplexer target joins with `a attach` by UUID (or workspace+tag) and
   * skips the tmux handshake and socket aim entirely — neither exists outside
   * tmux, and the attach repaints the live screen on its own.
   */
  private async join(
    connectionId: string,
    target: AttachTarget,
    opts: AttachSessionOptions,
  ): Promise<AttachSessionResult> {
    const isAplexer = target.backend === 'aplexer';
    const ttyVar = isAplexer ? '' : clientTtyVar(this.tokenFor(connectionId, target.key));
    const hintedSocketPath = isAplexer
      ? undefined
      : this.cachedSocketPath(connectionId, target.name);
    const command = isAplexer
      ? aplexerAttachCommand({ id: target.aplexerId, workspace: target.workspace, tag: target.tag })
      : sessionAttachCommand(target.name, ttyVar, hintedSocketPath);
    // The session-server locator is advisory: it only aims later redraw and
    // geometry commands. It must not sit in front of the PTY open, because a
    // multi-socket probe is a full SSH exec round trip and the terminal can
    // start joining before that answer exists. Starting it only AFTER the PTY
    // channel has opened also avoids the MaxSessions race that ruled out the
    // old concurrent version.
    // The callbacks need the id of the shell they belong to, and the id only
    // exists once `openTrackedShell` resolves. A `const` captured from the
    // enclosing scope would be in its temporal dead zone for any byte that
    // arrives before that — so the id is handed over through a mutable box the
    // callbacks read at call time instead. The null guards below never fire in
    // practice: `openTrackedShell` binds its channel listeners synchronously
    // and resolves, and the microtask that assigns `id` runs before the event
    // loop can deliver the next I/O callback. They are there so the types say
    // so rather than so bytes get dropped.
    let id: ShellId | null = null;
    const shellId = await this.ssh.openTrackedShell(connectionId, {
      command,
      // The join IS the channel: it runs directly under the PTY (an `exec`
      // request with a pty) instead of being typed into an interactive login
      // shell. The login shell was the join's largest fixed cost — the command
      // could not start until the user's profile had finished, a large part of
      // the 1.5-2 s a join was observed to take on a real host, and the
      // session-create path this app is asked to drive under a second pays it
      // on every new tab. The join commands widen their own PATH
      // (`USER_BIN_PATH`), so they never needed the profile; and the channel
      // closing when the join ends is exactly what each command's trailing
      // `exit` already assumed (see attachCommand.ts).
      commandMode: 'exec',
      cols: opts.cols,
      rows: opts.rows,
      onData: (data) => {
        if (id) opts.onData(id, data);
      },
      onExit: (exitCode) => {
        if (!id) return;
        // The PTY died — the user typed `exit`, the session was killed, the
        // channel dropped, or this pool evicted it. Drop the record so the
        // next attach joins rather than handing back a dead client.
        const byName = this.clients.get(connectionId);
        if (byName?.get(target.key)?.shellId === id) byName.delete(target.key);
        opts.onExit(id, exitCode);
      },
    });
    id = shellId;
    let byName = this.clients.get(connectionId);
    if (!byName) {
      byName = new Map();
      this.clients.set(connectionId, byName);
    }
    byName.set(target.key, {
      shellId,
      session: target.name,
      key: target.key,
      backend: target.backend,
      workspace: target.workspace,
      ttyVar,
      socketPath: hintedSocketPath ?? null,
      useOrder: ++this.useClock,
      lastUsedAt: Date.now(),
    });
    if (hintedSocketPath === undefined && !isAplexer) {
      this.locateSocketPath(connectionId, target.name, shellId);
    }
    return { shellId, switched: false };
  }

  private cachedSocketPath(connectionId: string, sessionName: string): string | null | undefined {
    const helper = this.helper;
    if (!helper || typeof helper.cachedSessionSocketPath !== 'function') return undefined;
    return helper.cachedSessionSocketPath(connectionId, sessionName);
  }

  /** Fill in the optional tmux-server aim without delaying the terminal join. */
  private locateSocketPath(connectionId: string, sessionName: string, shellId: ShellId): void {
    if (!this.helper) return;
    void this.helper
      .locateSession(connectionId, sessionName)
      .then((located) => {
        if (located.status !== 'found') return;
        // A rename or a connection drop may have removed/re-keyed this record
        // while the advisory probe was in flight. Find it by the stable PTY id
        // and only update a client that is still ours.
        const held = this.clientForShell(shellId);
        if (held) held.socketPath = located.socketPath;
      })
      .catch(() => {
        // The locator is an optimisation. The join and its legacy bare-tmux
        // fallback remain useful when the probe cannot answer.
      });
  }

  /**
   * The handshake token for one (connection, pool key).
   *
   * Per session rather than per connection, because there is now a client per
   * session and they must not share a tmux variable — the second join would
   * overwrite the first's tty and a reader could not tell the two clients
   * apart. Stable across re-joins of the same session, so an evicted tab that
   * is revisited overwrites its own entry rather than leaving another behind.
   */
  private tokenFor(connectionId: string, key: string): string {
    let byName = this.tokens.get(connectionId);
    if (!byName) {
      byName = new Map();
      this.tokens.set(connectionId, byName);
    }
    let token = byName.get(key);
    if (!token) {
      token = randomBytes(6).toString('hex');
      byName.set(key, token);
    }
    return token;
  }
}

/** ssh2's error text for a server-side MaxSessions/channel-open refusal. */
function isChannelOpenFailure(error: unknown): boolean {
  return /channel open failure/i.test(error instanceof Error ? error.message : String(error));
}
