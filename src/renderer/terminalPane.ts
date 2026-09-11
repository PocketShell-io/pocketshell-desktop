import { ref, type Ref } from 'vue';
import type { Terminal, IDisposable } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { api } from './ipc';
import type { useShellsStore } from './stores/shells';
import { ParseStallMonitor, type ParseStallReport } from './parseStall';
import { recordDiagDetail, msSinceLastUnhandledError } from './diag';
import {
  repairIncompleteViewport,
  resumeWriteBufferAfterError,
} from './xtermWriteBuffer';
import type { ConnectionId, GeometryProbe, ShellId } from '../shared/types';

/** What the pane needs from its mounting component, read at call time. */
export interface TerminalPaneDeps {
  /** The shells registry — this pane publishes its PTY under its session key. */
  shells: Pick<ReturnType<typeof useShellsStore>, 'register' | 'unregister'>;
  getConnectionId: () => ConnectionId;
  /** Command for a bare-shell pane; undefined for a tmux/aplexer session. */
  getCommand: () => string | undefined;
  /** The tmux session this pane should be showing, or '' for a bare shell. */
  getTargetSession: () => string;
  /** The workspace-qualified key the PTY is published under. */
  getRegistryKey: () => string;
  getBackend: () => 'tmux' | 'aplexer' | undefined;
  getWorkspace: () => string | null | undefined;
  getAplexerId: () => string | null | undefined;
  /** Whether the container measures non-zero — one definition of "visible". */
  isVisible: () => boolean;
  /** Whether re-attaching may take focus (see the focus note in TerminalView). */
  mayRestoreFocus: () => boolean;
}

/**
 * The PTY lifecycle of one terminal pane, extracted from TerminalView.vue.
 *
 * The component owns what a VIEW owns — the xterm instance, its addons, the
 * DOM events, the input policy — and hands the terminal to {@link attach};
 * this class owns what a CONTROLLER owns: asking main for the PTY, adopting
 * or switching it, binding the byte/exit streams, keeping the far end's
 * geometry true, watching for drift and death, and the bounded repairs. The
 * decision of WHEN a PTY opens or closes stays with the component (mount,
 * unmount, session change, the hidden→visible edge) — see the header of
 * stores/shells.ts for why that ownership is deliberate.
 *
 * Everything below behaves exactly as its in-component original did; the
 * comments are the decision records and travel with the code.
 */
export class TerminalPane {
  // -------------------------------------------------------------------------
  // The join veil
  // -------------------------------------------------------------------------
  //
  // Between asking main for this pane's PTY and the far end's first byte, the
  // pane is a black rectangle — and a black rectangle after a click reads as
  // "broken", which is exactly the report it produced ("is something happening?
  // or it's not working?"). The join takes a channel, a PTY and an attach —
  // subjectively seconds on a real link — and nothing else in the pane says
  // any of that is under way. So while the wait lasts, the pane says so.
  //
  // The veil clears on the FIRST byte that reaches xterm through {@link
  // paneWrite}, whichever it is: a byte means the far end is producing output,
  // which is the thing "is it working?" is actually asking. It re-arms on every
  // re-join (the repair paths all funnel through {@link showTarget}), so a pane
  // that goes silent again says so again. The error paths write their message
  // through paneWrite too, so a failed join clears its own veil by becoming
  // readable.
  readonly joinPending: Ref<boolean> = ref(false);

  private joinPendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * How long a join may be silent before the veil appears.
   *
   * Short enough that the user never has time to conclude "broken" — that
   * verdict forms in well under a second — and long enough that the common
   * fast join (a pooled client, a warm connection) never flashes the veil at
   * all, which would read as noise rather than as state.
   */
  private static readonly JOIN_VEIL_DELAY_MS = 250;

  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private container: HTMLElement | null = null;
  private shellId: ShellId | null = null;

  /** Watches every byte fed xterm, so a parser death is a REPORT. */
  private stallMonitor: ParseStallMonitor | null = null;
  /** The key `shellId` is currently published under, so a re-open can retract it. */
  private registeredKey: string | null = null;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeExit: (() => void) | null = null;
  /**
   * True once main has said this PTY is gone.
   *
   * A tab's shell can die without the tab going anywhere. The pool evicts the
   * least recently used client when a connection runs out of SSH channels —
   * sshd's `MaxSessions` is 10 by default and is a hard ceiling — and the tmux
   * SESSION survives that untouched on the host, because it lives in the tmux
   * server rather than in our client. So a dead shell in a tab the user has not
   * closed is a recoverable state, and {@link scheduleFit} is where it recovers.
   */
  private shellGone = false;
  /**
   * Whether the pane measured zero the last time it was looked at, i.e. it is
   * behind a `v-show`.
   *
   * Only the hidden -> visible EDGE may re-attach. Re-attaching on any resize of
   * a visible pane would silently rejoin a session the user had deliberately
   * exited, which is the one case where a dead pane is the correct outcome.
   */
  private paneHidden = false;
  /**
   * xterm-side handlers for the byte and resize routes, bound ONCE against the
   * stable `term` (in {@link attach}) and reading the current `shellId` from
   * the closure. Binding them per-shell (as an earlier version did) stacked a
   * new onData/onResize on every session switch, so each keystroke — and each
   * reply to tmux's `ESC[>c` device-attributes probe — was sent to the PTY N
   * times, which is what leaked `0;276;0c` into the output.
   */
  private streamDisposables: IDisposable[] = [];
  /**
   * Refits when the CONTAINER changes size, not only when the window does. The
   * prompt composer docks below this pane and grows/shrinks/hides underneath it,
   * which resizes the terminal without any window resize event — without this the
   * xterm canvas keeps its old row count and either clips the tmux status bar or
   * leaves dead black space below it.
   */
  private resizeObserver: ResizeObserver | null = null;
  /** Coalesces a burst of resize callbacks into one fit per frame. */
  private fitFrame = 0;
  /**
   * The geometry the far end was last TOLD, or null when it has been told
   * nothing — a PTY we have just adopted knows only the size it was opened with,
   * and a PTY we do not hold knows nothing at all.
   *
   * This exists because "has the far end been told our size" is a fact about the
   * REMOTE, and until now nothing in this pane held it. Every route into a
   * size change had to remember, on its own, to send one: the font watcher,
   * `showTarget` after a switch, the container observer. Three of
   * today's bugs are one of those routes forgetting, and the fourth is the far
   * end being told correctly and simply not repainting. So the fact is stored
   * once, {@link pushGeometry} is the only thing that writes it, and every route
   * calls that instead of reasoning about whether a send is needed.
   */
  private sent: { cols: number; rows: number } | null = null;

  constructor(private readonly deps: TerminalPaneDeps) {}

  /**
   * Hand the pane its terminal. Binds the byte/resize routes and starts the
   * stall monitor — once, against the terminal's whole lifetime.
   */
  attach(term: Terminal, fitAddon: FitAddon, container: HTMLElement): void {
    this.term = term;
    this.fitAddon = fitAddon;
    this.container = container;

    // Output bytes are observed from here on: one monitor per terminal, for the
    // terminal's whole life, across session re-points (it watches `term`, which
    // survives a switch).
    this.stallMonitor = new ParseStallMonitor({
      describe: () => this.describePaneForDiag(),
      onStall: (report) => this.handleParseStall(report),
    });

    // xterm -> shell, and xterm's own dimensions -> the geometry push. Bound
    // once, against the terminal's lifetime. The resize route goes through
    // `pushGeometry` rather than straight to `api.shell.resize`, so a resize
    // that fires before a PTY exists is not simply LOST: it records nothing,
    // and the unconditional push at the end of `showTarget` then sends
    // whatever the pane has become. That is the hole a tab fell into while
    // its join was in flight — seconds, on this user's host.
    this.streamDisposables = [
      term.onData((data) => {
        if (this.shellId) forget(api.shell.input(this.shellId, data));
      }),
      term.onResize(() => {
        this.pushGeometry();
      }),
    ];
  }

  /** Give up the PTY and every watcher. Only unmount calls this. */
  detach(): void {
    this.stopProbing();
    this.stopObservingContainer();
    this.stallMonitor?.dispose();
    this.stallMonitor = null;
    for (const d of this.streamDisposables) d.dispose();
    this.streamDisposables = [];
    this.endJoinPending();
    this.closeShell();
    this.term = null;
    this.fitAddon = null;
    this.container = null;
  }

  // -------------------------------------------------------------------------
  // Session target: ask, adopt, switch
  // -------------------------------------------------------------------------

  /**
   * `showTarget` has five independent triggers — the mount, the two watchers,
   * the hidden-to-visible re-join and the two repair rejoins — and a join is
   * seconds long, so two invocations can overlap and adopt their targets in
   * RESOLUTION order rather than trigger order, with the loser's PTY handed
   * back (or leaked against the MaxSessions budget) on the way out. Calls are
   * SERIALIZED instead: each runs to completion before the next starts, and
   * since every trigger reads the props that are current when its turn comes,
   * the last one queued wins with the state that is actually current.
   */
  private showTargetChain: Promise<void> = Promise.resolve();

  open(): Promise<void> {
    const run = this.showTargetChain.then(() => this.showTarget());
    // showTarget writes its own failures into the pane; this catch only keeps
    // the chain alive for the next rider.
    this.showTargetChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Ask main for the PTY that should be on screen, without touching anything.
   *
   * A tmux session goes through `attachSession` so main can move the client it
   * already holds; anything else opens a plain shell, which is always new.
   */
  private async requestShell(
    cols: number,
    rows: number,
  ): Promise<{ shellId: ShellId; switched: boolean }> {
    const session = this.deps.getTargetSession();
    if (session) {
      const aplexer = this.deps.getBackend() === 'aplexer';
      const workspace = this.deps.getWorkspace();
      const aplexerId = this.deps.getAplexerId();
      return api.shell.attachSession({
        connectionId: this.deps.getConnectionId(),
        sessionName: session,
        cols,
        rows,
        // The pool keys (and joins) aplexer sessions by workspace+tag or UUID;
        // the session name alone carries the tag but not the workspace.
        ...(aplexer ? { backend: 'aplexer' as const, tag: session } : {}),
        ...(aplexer && workspace ? { workspace } : {}),
        ...(aplexer && aplexerId ? { aplexerId } : {}),
      });
    }
    const id = await api.shell.open({
      connectionId: this.deps.getConnectionId(),
      command: this.deps.getCommand(),
      cols,
      rows,
    });
    return { shellId: id, switched: false };
  }

  /**
   * Put the current target on screen, whether that means a first join, a switch
   * of the shared tmux client, or a fresh PTY because the switch could not be
   * had. Used for the initial mount and for every later session change, because
   * main — not this pane — is what decides which of the three it is.
   */
  private async showTarget(): Promise<void> {
    const term = this.term;
    if (!term || !this.container) return;
    // From here until the far end's first byte, the pane says what it is doing
    // instead of being a black rectangle. See the join-veil note above.
    this.beginJoinPending();
    this.fitTerminal();
    const cols = term.cols;
    const rows = term.rows;

    const previousId = this.shellId;
    // Retract the OLD key's registration BEFORE asking for the new target.
    // With one PTY shared across sessions, the shells store stops being a map of
    // independent per-session channels and becomes the answer to "which session
    // is this pane showing right now". Leaving the old key registered would let a
    // composer still bound to it write a prompt into whatever session the pane
    // switched to. Unregistered, that composer finds no shell and refuses to
    // send, which is the failure mode to want.
    if (this.registeredKey !== null) {
      this.deps.shells.unregister(this.registeredKey, previousId ?? undefined);
      this.registeredKey = null;
    }

    let result: { shellId: ShellId; switched: boolean };
    try {
      result = await this.requestShell(cols, rows);
    } catch (e) {
      // A rejection here used to escape into `onMounted`'s promise, where
      // nothing was waiting for it: the pane stayed blank and the user was told
      // nothing at all — indistinguishable from a session that opened and simply
      // had no output yet. The PTY is the only surface this pane owns, so
      // the failure is written INTO it. Nothing is torn down beyond the streams:
      // main disposes of any shell it failed to replace, and a further session
      // change still re-arms the whole path.
      this.unbindShellStream();
      this.shellId = null;
      this.sent = null;
      this.paneWrite(`\r\n\u001b[31mCould not open a shell: ${describe(e)}\u001b[0m\r\n`);
      return;
    }

    // A join is seconds long on a real host, and the tab can be closed inside
    // that window — the workspace unmounts the pane, the component disposes
    // the terminal, and everything below would then be operating on a corpse.
    // Handing the shell straight back to main is the honest exit: we asked for
    // it, we are not going to use it, and leaving it open would leak an SSH
    // channel against a `MaxSessions` budget of ten.
    if (!this.term) {
      forget(api.shell.close(result.shellId));
      return;
    }

    if (result.shellId !== previousId) {
      // A different PTY. Main has already closed the one it replaced, so all that
      // is left here is to stop listening for it, wipe the pane, and adopt the
      // new id.
      //
      // `reset()`, not `clear()`. clear() only empties the scrollback — it leaves
      // every DEC private mode set, and mouse tracking (1000/1002/1003 + SGR 1006)
      // is the one that matters. tmux turns mouse reporting ON when it attaches and
      // OFF when it exits cleanly; a session that dies, is killed, or whose attach
      // fails never sends the OFF. The mode then survives into the next shell this
      // pane opens, where nothing is consuming mouse reports — so the wheel
      // and click-drag get encoded as `\x1b[<0;2;1M` and typed at the prompt, which
      // the shell echoes as literal `0;2;1M`, and drag-select stops working because
      // xterm is claiming the drag for reporting. reset() clears modes with it.
      this.unbindShellStream();
      if (previousId) term.reset();
      this.shellId = result.shellId;
      this.shellGone = false;
      // A PTY we have just been handed knows only the size it was OPENED with,
      // which is the pre-await capture above. Forgetting what we told the old
      // one is what makes the unconditional push below actually send.
      this.sent = null;
      this.bindShellStream();
    } else {
      // The same PTY came back — a re-point over a client the pool still holds,
      // a rename's re-key being the case that matters. Nothing was torn down and
      // nothing is being waited for, so the veil's claim ("a join is under way")
      // is already false; leaving it armed would hang the shroud over a live
      // pane until the next byte, which on an idle session is never.
      this.endJoinPending();
      // Deliberately NO reset here: the tmux client never detached, so it still
      // owns the modes it set and will not be told to set them again — tmux
      // redrew every row of the PTY itself.
    }

    // Publish it before the first byte can be typed at it. Under the
    // workspace-qualified registry key, so same-named aplexer tags in different
    // folders never share a registration.
    this.registeredKey = this.deps.getRegistryKey();
    this.deps.shells.register(this.registeredKey, result.shellId);
    // Re-fit and push the geometry the pane has NOW, not the `cols`/`rows`
    // captured before the await. A join is an SSH channel, a login shell and
    // `tmuxctl` — seconds on a real host — and the pane is laid out during it,
    // so the captured pair is routinely stale by the time we get here. Sending
    // it was how a tab ended up permanently taller than the screen tmux was
    // drawing to. `fit()` first, because a layout that settled during the await
    // has not been measured yet.
    //
    // `redraw` because this is an edge where the size may legitimately not have
    // moved — the same PTY handed back for a tab that is already up — and tmux
    // repaints nothing in that case, including any band it had stopped owning.
    this.fitTerminal();
    this.pushGeometry({ redraw: true });
    if (this.deps.mayRestoreFocus()) term.focus();
  }

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  /** Bind the main->renderer byte and exit streams for the current `shellId`. */
  private bindShellStream(): void {
    this.unsubscribeData = api.shell.onData(({ shellId: id, data }) => {
      if (id === this.shellId && this.term) {
        this.paneWrite(data);
      }
    });
    this.unsubscribeExit = api.shell.onExited(({ shellId: id }) => {
      if (id === this.shellId && this.term) {
        this.shellGone = true;
        // A dead PTY must stop answering registry lookups. Everything that aims
        // bytes at this pane by key — the agent launch above all — reads
        // `shellIdFor`, and an entry left pointing at a closed channel makes the
        // next launch for a recreated same-named session fire into the corpse:
        // main drops the write for an id it no longer tracks, and the launch is
        // gone without a trace. Passing the id keeps a newer registration (a
        // re-join that raced this event) untouched — the store no-ops then.
        if (this.registeredKey !== null) this.deps.shells.unregister(this.registeredKey, id);
        this.paneWrite('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
      }
    });
  }

  private unbindShellStream(): void {
    if (this.unsubscribeData) {
      this.unsubscribeData();
      this.unsubscribeData = null;
    }
    if (this.unsubscribeExit) {
      this.unsubscribeExit();
      this.unsubscribeExit = null;
    }
  }

  /**
   * The ONE door bytes take into xterm.
   *
   * Every write goes through the stall monitor with a completion callback,
   * because a parse that dies mid-chunk (the `start argument out of range`
   * family: an xterm handler throws, the write loop never reschedules) has a
   * signature of exactly one thing: SOME chunk's callback never firing, ever.
   * Without the callback there is no signal at all — the pane just stops.
   *
   * Diagnostics bypass this helper deliberately: a report must reach the
   * terminal even while the monitor is declaring a stall, and one more watched
   * write on top of a wedged queue would only be reported as a second stall.
   */
  private paneWrite(data: string | Uint8Array): void {
    const term = this.term;
    if (!term) return;
    // The far end produced output: whatever the pane was waiting for, it is no
    // longer the thing the veil was saying. See the join-veil note above.
    this.endJoinPending();
    this.repairTerminalBufferIfNeeded();
    this.stallMonitor?.write(term, data);
  }

  /** Live facts a stall report needs, read at stall time, not at bind time. */
  private describePaneForDiag(): Record<string, unknown> {
    // Every field is best-effort: this runs on a failing path, and tests drive
    // this pane with stub terminals that implement only what they exercise.
    const term = this.term;
    const buffer = term?.buffer?.active;
    return {
      session: this.deps.getTargetSession() || '(shell)',
      connection: this.deps.getConnectionId(),
      shellId: this.shellId ?? '(none)',
      cols: term?.cols,
      rows: term?.rows,
      bufferLines: buffer?.length,
      baseY: buffer?.baseY,
      viewportY: buffer?.viewportY,
      cursorX: buffer?.cursorX,
      cursorY: buffer?.cursorY,
    };
  }

  /**
   * What happens when the parse loop is declared dead.
   *
   * The thrown error itself already reached the desktop log through the window
   * `error` handler — but anonymous, unattached to this pane, and with no idea
   * what bytes killed it. This writes the other half of the story: the stalled
   * chunk and the buffer state, tagged with the session, so the next incident
   * is reproducible from the log alone. A marker line goes INTO the pane too —
   * a frozen pane must say so, not just silently stop.
   *
   * Then, when a thrown unhandled error arrived just before the stall — the
   * signature of exactly one event, the parser dying mid-chunk — the loop is
   * restarted and the pane re-joins its session. The restart alone is not the
   * repair: the chunk that killed the parser is lost mid-sequence and the
   * buffer's line invariants are whatever the throw left them as, so drawing
   * continues into a suspect emulator. The fresh join is the one repair that
   * re-initialises BOTH ends — the same truth the dead-probe path is built on,
   * under the same bounds, so a parser that dies in a loop cannot hammer the
   * host with joins.
   */
  private handleParseStall(report: ParseStallReport): void {
    const parserThrew = msSinceLastUnhandledError() <= PARSER_DEATH_WINDOW_MS;
    const id = this.shellId;
    const resumed = parserThrew ? resumeWriteBufferAfterError(this.term) : false;
    const recovering = parserThrew && resumed && id !== null && !this.shellGone;
    recordDiagDetail(
      'terminal-stall',
      `terminal output parsing stalled (${report.chunkLength} chars queued, session ${this.deps.getTargetSession() || 'shell'})`,
      {
        ...report.details,
        stalledChunk: report.chunk,
        stalledChunkHex: report.chunkHex,
        pendingBehind: report.pendingBehind,
        ageMs: report.ageMs,
        parserThrew,
        loopResumed: resumed,
        rejoining: recovering,
      },
    );
    this.term?.write('\r\n\x1b[90m[PocketShell] output parsing stalled — see desktop log\x1b[0m\r\n');
    if (recovering && id !== null) this.rejoinAfterParseDeath(id);
  }

  /**
   * The bounded re-join after a parser death. The dead-probe path
   * ({@link scheduleRejoin}) waits for two bad probe answers before trusting
   * that the client is gone; a parser death needs no second opinion — the
   * throw IS the evidence — but it shares the anti-hammer bounds, so every
   * repair path in this pane spends re-joins out of the same budget.
   */
  private rejoinAfterParseDeath(id: ShellId): void {
    if (Date.now() - this.lastRejoinAt < TerminalPane.REJOIN_MIN_INTERVAL_MS) return;
    if (this.rejoinStreak >= TerminalPane.MAX_CONSECUTIVE_REJOINS) return;
    this.lastRejoinAt = Date.now();
    this.rejoinStreak += 1;
    this.lastRepairAt = Date.now();
    this.driftRepaintDone = false;
    this.paneWrite('\r\n\x1b[90m[PocketShell] parser crashed — rejoining for a clean slate…\x1b[0m\r\n');
    forget(
      api.shell.close(id).then(() => {
        if (id !== this.shellId || !this.term) return; // the pane moved on meanwhile
        return this.open();
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Geometry: fit, push, and the far end
  // -------------------------------------------------------------------------

  /**
   * The smallest grid the far end may ever be told about.
   *
   * ## The picture this exists for
   *
   * Reported as "output in terminal broke again": a band of scrollback wrapped at
   * about four columns — `I'd` / `just` / `poi` / `nt` / `out`, one fragment per
   * row — with correctly-wrapped full-width text above and below it, and a live
   * agent TUI still drawing its input box at that width long after the pane was
   * wide again.
   *
   * That picture can only be made by the REMOTE. tmux and the TUI inside it wrap
   * to the width they were told, and their scrollback keeps the wrap it was
   * written with; nothing on this side re-flows text that has already been
   * printed. So something sent a resize of roughly four columns, the agent
   * reflowed its whole view to it, and the correct size that followed repaired
   * only what was redrawn afterwards. The damage is not recoverable — which is
   * what makes a bogus push worth refusing rather than correcting.
   *
   * ## Why the existing guard did not catch it
   *
   * There has been a degenerate-geometry guard here since inactive tabs started
   * staying mounted, and it asks the right question of the wrong quantity: it
   * tests the container for ZERO pixels (`clientWidth`/`clientHeight`), because
   * the case it was written for is a `v-show`'d pane, which measures exactly 0.
   * A container that is 30px wide is not zero, is not a pane anyone is looking
   * at, and produces a four-column fit — every transient layout that has a
   * non-zero width on its way to its real one walks straight through the guard.
   *
   * ## Why these numbers
   *
   * They are chosen to be UNREACHABLE by a real pane rather than to be the
   * smallest usable terminal. The session panel is clamped to 560px
   * (`MAX_PANEL_WIDTH`), the composer is an overlay and takes no rows from the
   * pane, and the window has an OS minimum — so a grid this small is not a
   * cramped layout, it is a measurement taken mid-transition. 20 columns is
   * narrower than any terminal anyone has ever worked in on purpose, and 5 rows
   * is narrower than the tmux status line plus a prompt.
   *
   * A pane that really is smaller than this keeps the last size the far end was
   * told, which is the honest failure: tmux draws a screen bigger than the
   * viewport and the user sees part of it, instead of the agent reflowing its
   * session to a width the user cannot read and cannot undo.
   */
  private static readonly MIN_REMOTE_COLS = 20;
  private static readonly MIN_REMOTE_ROWS = 5;

  /** Is this grid one a person could actually be looking at? */
  private plausibleGrid(size: { cols: number; rows: number } | undefined): boolean {
    if (!size) return false;
    return (
      size.cols >= TerminalPane.MIN_REMOTE_COLS && size.rows >= TerminalPane.MIN_REMOTE_ROWS
    );
  }

  /**
   * Fit only a pane-sized grid, then repair xterm's active buffer if the resize
   * exposed its 6.0.0 missing-line state.
   *
   * `FitAddon.fit()` eventually calls `Terminal.resize()`. In the shipped xterm
   * 6.0.0 a row-growing resize can leave the active buffer's logical line list
   * shorter than `ybase + rows`, which makes a later tmux reverse-index/scroll
   * throw `start argument out of range`. Keep the repair at the app's single fit
   * boundary so every resize route gets the same guard.
   */
  private fitTerminal(): void {
    const term = this.term;
    if (!term || !this.fitAddon) return;
    const proposed = this.fitAddon.proposeDimensions();
    if (!this.plausibleGrid(proposed)) return;
    this.fitAddon.fit();
    this.repairTerminalBufferIfNeeded();
  }

  /**
   * Repair xterm's 6.0.0 missing-viewport state before it can parse more output.
   *
   * The repair reaches xterm's private core buffer because it must PUSH onto the
   * buffer's line list, which no public API exposes (reading the grid through
   * `term.buffer` is public; writing to it is not). It only appends the missing
   * blank lines, preserving parser state and the existing screen; no reset or
   * remote repaint is needed.
   */
  private repairTerminalBufferIfNeeded(): void {
    if (!this.term) return;
    repairIncompleteViewport(this.term);
  }

  /**
   * Make the far end's idea of our geometry true, and repaint if it was not.
   *
   * ## The bug this is the answer to
   *
   * The user saw a tmux status line sitting eighteen rows above the bottom of
   * the pane, with the same stale line repeated underneath it to the edge. That
   * picture has exactly one cause: xterm has more rows than the PTY was told
   * about, so tmux drew its status line at what it believed was the last row and
   * never touched anything below. The rows below are not corrupt — they are
   * cells nobody has written since the pane was last bigger.
   *
   * ## Why the previous wiring let that happen
   *
   * Geometry reached the far end through `term.onResize`, which fires only when
   * xterm's OWN dimensions change. Two holes follow from that, and both are live
   * now that every opened tab stays mounted:
   *
   *  1. **A resize with no shell to send it to.** A tab joins by opening an SSH
   *     channel, a login shell and `tmuxctl` — 1.5-2 s on this user's host. The
   *     pane is laid out during that window (the tab strip settles, the composer
   *     docks), so `fit()` runs and `onResize` fires while `shellId` is still
   *     null, and the handler drops it. `showTarget` then sent the cols/rows it
   *     had captured BEFORE the await, which are the pre-layout numbers. The far
   *     end is told a size the pane no longer has, and nothing ever corrects it,
   *     because from xterm's side the dimensions are not going to change again.
   *
   *  2. **A size that is right on our side and stale on theirs.** A pane that
   *     comes back into view at the size it had when it was hidden produces no
   *     `onResize` at all, so a client that has meanwhile been resized by
   *     anything else — another client on the same session, a re-join — is never
   *     put back.
   *
   * Recording what was sent closes both: the comparison is against the REMOTE's
   * last known state rather than against our own previous dimensions, so a route
   * that changes nothing locally still sends when the remote is behind, and a
   * route that fires twice sends once.
   *
   * ## Why a repaint follows
   *
   * A resize tmux considers a no-op repaints nothing, and the stale band is
   * exactly the region tmux does not think it owns. `refresh-client` targeted at
   * our own client is the clean way to say "draw all of it" without changing
   * anything else; sending `C-l` into the PTY would be interpreted by whatever
   * is running instead. It is asked for only when we actually pushed something,
   * so an idle tab costs no host work.
   */
  private pushGeometry(opts: { redraw?: boolean } = {}): void {
    const term = this.term;
    if (!term || !this.shellId) return;
    const { cols, rows } = term;
    // A pane behind a `v-show` measures 0 and xterm keeps whatever grid it last
    // had; pushing that would tell tmux the tab is its old size while it is not
    // on screen at all. The hidden -> visible edge in `scheduleFit` is what
    // brings it back.
    if (!this.deps.isVisible()) return;
    // The floor, applied HERE because this is the one place that speaks to the
    // far end (see MIN_REMOTE_COLS). `scheduleFit` refuses to fit to a
    // degenerate size in the first place, but it is not the only route in: the
    // mount, `showTarget` after a join, and the font and zoom watchers all fit
    // and then push. Guarding the owner covers every one of them, and leaves
    // `sent` untouched — so the size the remote is still on remains the size we
    // believe it is on, and the next plausible fit is compared against the truth.
    if (!this.plausibleGrid({ cols, rows })) return;
    const id = this.shellId;
    if (!this.sent || this.sent.cols !== cols || this.sent.rows !== rows) {
      this.sent = { cols, rows };
      const pushed = api.shell.resize(id, cols, rows);
      // The repaint must describe the size we JUST pushed, not race it.
      // `refresh-client` draws the window as tmux currently believes it is, and
      // an exec channel can outrun the client's own WINCH processing — a repaint
      // that lands first would redraw the OLD size into a grid already reflowed
      // to the new one. Ordering them costs nothing: the resize IPC resolves
      // only after `setWindow` ran.
      if (opts.redraw === true) forget(pushed.then(() => api.shell.redraw(id)));
      else forget(pushed);
    } else if (opts.redraw === true) {
      // The redraw is NOT conditional on the size having moved, and that is the
      // whole point of asking for one. The case it exists for is precisely the
      // case where nothing moved: a tab coming back into view at the size it was
      // hidden at, whose tmux client may have been resized by something else
      // meanwhile, or which simply stopped owning the rows below its status line.
      // A resize tmux considers a no-op repaints nothing at all.
      //
      // It stays opt-in per call site rather than automatic because an ordinary
      // drag-resize produces a run of pushes and tmux repaints itself on each one;
      // asking again would be an SSH exec per frame for no visible difference. It
      // is the EDGES that need it — hidden to visible, and a freshly adopted PTY.
      forget(api.shell.redraw(id));
    }
  }

  /**
   * Put the pane and the far end back in agreement, on demand.
   *
   * `sent = null` forgets what the far end was TOLD, so the size is sent again
   * even though our side never moved — the half a plain redraw cannot do, since
   * `refresh-client` repaints the window at whatever size tmux currently
   * believes in. Then push, with a repaint, so tmux draws all of it rather than
   * the part it thinks changed. The menu item is the instant, on-demand version;
   * {@link reconcileTick} calls it when a probe says our client's tty has
   * drifted from the grid.
   */
  resyncDisplay(): void {
    this.fitTerminal();
    this.sent = null;
    this.pushGeometry({ redraw: true });
  }

  // -------------------------------------------------------------------------
  // Container-driven fits
  // -------------------------------------------------------------------------

  /**
   * Observe the container for size changes; called once by {@link attach}'s
   * caller so the observer's lifetime matches the component's DOM.
   */
  observeContainer(container: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.stopObservingContainer();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(container);
  }

  private stopObservingContainer(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  /**
   * Fit once per animation frame. `fit()` writes to xterm's dimensions, which the
   * ResizeObserver can observe again — coalescing keeps that from looping and
   * keeps a drag-resize of the composer cheap.
   */
  scheduleFit(): void {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      // Skip degenerate geometry: a v-show'd pane measures 0 and fit() would
      // then push a 1x1 PTY at the remote.
      //
      // This guard carries far more weight now that INACTIVE session tabs stay
      // mounted behind a `v-show` instead of there being one pane. It is what
      // keeps a hidden tab from telling its tmux session it is two columns wide —
      // and a hidden tab is now the normal state of most of them.
      if (!this.deps.isVisible()) {
        this.paneHidden = true;
        return;
      }
      // A box that is small but not zero. `proposeDimensions` answers what a
      // `fit()` WOULD produce, so asking first is what keeps xterm from reflowing
      // its own buffer to four columns on the way past — the guard below in
      // `pushGeometry` would stop the remote hearing about it, but the local
      // reflow would still have happened, and a re-flowed scrollback does not
      // come back.
      //
      // Treated as HIDDEN rather than merely skipped, deliberately: that is what
      // arms the hidden -> visible edge below, so when the layout settles the
      // pane re-asserts its geometry AND asks for a repaint. A plain `return`
      // would leave the far end on a stale size with nothing scheduled to correct
      // it — the exact failure mode this whole function was rewritten to remove.
      //
      // `undefined` from `proposeDimensions` means the addon could not measure at
      // all, which is the zero case by another name.
      if (!this.plausibleGrid(this.fitAddon?.proposeDimensions())) {
        this.paneHidden = true;
        return;
      }
      const wasHidden = this.paneHidden;
      this.paneHidden = false;
      this.fitTerminal();
      // Coming back to a tab whose PTY the pool evicted to stay under the channel
      // budget. Re-joining on this EDGE rather than on the exit itself is what
      // keeps it from fighting the user: a session they exited on purpose stays
      // exited, because that pane never became hidden.
      if (wasHidden && this.shellGone) {
        this.shellGone = false;
        void this.open();
        return;
      }
      // Everything else routes through the one place that knows what the far end
      // has been told. `fit()` above may have changed nothing — a tab that comes
      // back at the size it was hidden at is the normal case — and that is
      // precisely when the old wiring sent nothing, because it only ever reacted
      // to xterm's own dimensions moving. On the hidden -> visible edge the
      // redraw is asked for too: tmux will not repaint a screen it thinks is
      // unchanged, and the stale band the user reported is exactly that.
      this.pushGeometry(wasHidden ? { redraw: true } : {});
    });
  }

  // -------------------------------------------------------------------------
  // Give up the PTY
  // -------------------------------------------------------------------------

  /**
   * Give up the PTY for good. Only unmount calls this now — a session change
   * goes through {@link showTarget}, which must NOT close first: the shell it
   * would close is the shared tmux client main is about to reuse.
   */
  private closeShell(): void {
    this.unbindShellStream();
    if (this.registeredKey !== null) {
      this.deps.shells.unregister(this.registeredKey, this.shellId ?? undefined);
      this.registeredKey = null;
    }
    if (this.shellId) {
      forget(api.shell.close(this.shellId));
      this.shellId = null;
    }
    this.sent = null;
  }

  // -------------------------------------------------------------------------
  // The join veil, mechanics
  // -------------------------------------------------------------------------

  private beginJoinPending(): void {
    if (this.joinPendingTimer !== null) clearTimeout(this.joinPendingTimer);
    this.joinPendingTimer = setTimeout(() => {
      this.joinPendingTimer = null;
      this.joinPending.value = true;
    }, TerminalPane.JOIN_VEIL_DELAY_MS);
  }

  private endJoinPending(): void {
    if (this.joinPendingTimer !== null) {
      clearTimeout(this.joinPendingTimer);
      this.joinPendingTimer = null;
    }
    this.joinPending.value = false;
  }

  // -------------------------------------------------------------------------
  // The reconcile loop: probe, repair, repaint, re-join
  // -------------------------------------------------------------------------

  /**
   * How often a VISIBLE pane asks tmux what it believes about our geometry.
   * See {@link reconcileTick} for why this exists at all and what bounds its
   * cost.
   */
  private static readonly GEOMETRY_PROBE_INTERVAL_MS = 5000;
  /**
   * How often a healthy pane asks tmux for a full repaint anyway.
   *
   * This interval is the answer to the report no geometry check can see: a
   * session garbling under a busy TUI — frames repeated down the pane, stale
   * rows below tmux's status bar — that stayed broken through every resize and
   * every geometry probe, and that the user could only cure by leaving the tab
   * and coming back. Leaving and coming back fires exactly one
   * {@link api.shell.redraw}, and that repaint is what cured it. A desync
   * between xterm's parser state and the client's byte stream is invisible to
   * size comparison by construction — both ends agree on the geometry and
   * disagree about everything drawn in it — so the loop repaints on the clock
   * instead of on detection: one exec and one full-screen repaint per visible
   * pane per HEALTHY_REPAIR_INTERVAL_MS, which is the user's workaround,
   * automated, at a rate nobody pays for.
   */
  private static readonly HEALTHY_REPAIR_INTERVAL_MS = 30_000;
  /**
   * Consecutive `dead` probe answers required before the pane re-joins on its
   * own. Two: one bad answer is a network blip, and a re-join is seconds of
   * join not to be spent on one; two in a row means the tmux client is really
   * unreachable.
   */
  private static readonly DEAD_TICKS_BEFORE_REJOIN = 2;
  /** Minimum spacing between self-re-joins, so a dead host cannot get hammered. */
  private static readonly REJOIN_MIN_INTERVAL_MS = 60_000;
  /**
   * Re-join episodes allowed in a row without a single healthy probe answer in
   * between. A tmux server that is genuinely gone fails every re-join; without
   * this cap the pane would print its failure line and re-join every minute
   * forever.
   */
  private static readonly MAX_CONSECUTIVE_REJOINS = 3;

  /** The pending reconcile timer, while this pane is attached. */
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  /** True while a probe's round trip is in flight, so ticks cannot stack. */
  private probeInFlight = false;
  /** Consecutive `dead` answers on the current pane. */
  private deadTicks = 0;
  /** Epoch ms of the last repaint the loop decided to ask for. */
  private lastRepairAt = 0;
  /** True once an episode of another client driving the window has been repainted. */
  private driftRepaintDone = false;
  /** Re-join episodes since the last healthy probe answer. */
  private rejoinStreak = 0;
  /** Epoch ms of the last self-re-join, for REJOIN_MIN_INTERVAL_MS. */
  private lastRejoinAt = 0;

  /**
   * Watch the far end, repair what is ours, repaint what is not, and re-join
   * what is gone.
   *
   * ## Why this has to exist after all the wiring above
   *
   * Every route above reads true from the same assumption: before sending a
   * size we compare against `sent`, what the far end was last TOLD. Two
   * classes of failure defeat that by construction, and the loop is shaped
   * around them:
   *
   *   1. **The far end moved something we control.** Our client's tty size can
   *      end up other than what we pushed — a resize lost in a transient, a
   *      layout that settled wrong. The probe answers
   *      `#{client_width} #{client_height}` — the size of OUR client's tty, the
   *      quantity {@link pushGeometry} sets — and a mismatch is repaired by
   *      {@link resyncDisplay}: push the true size again, repaint.
   *   2. **The far end moved something we do not control, or control nothing
   *      about.** Under `window-size latest`, another client of the session —
   *      the phone, the user's own terminal — can take the window; and a
   *      desync between xterm's parser state and the client's byte stream can
   *      garble a pane at CONSTANT geometry, which no comparison of sizes can
   *      ever detect. Both are answered the same way the user answered them by
   *      hand: a full repaint, asked on the clock while healthy (item 2's only
   *      cure), and once per episode when the window has been taken (item 1's
   *      honest picture). We never FIGHT for the window: there is no portable
   *      way to reclaim `latest` (measured on tmux 3.4: `resize-window -c`
   *      does not exist, `refresh-client -C` is control-mode-only), and a
   *      resize war between two active clients would garble both.
   *
   * ## The exit that is not an exit: re-joining on `dead`
   *
   * A probe that cannot be answered — the handshake variable never published,
   * the client detached, the tmux server restarted under the session — used to
   * read as `null`, indistinguishable from healthy agreement, and the pane sat
   * frozen or garbled forever behind a repair path that had quietly died. The
   * probe now answers `dead`, and two `dead`s in a row do what the user did by
   * hand: close the shell and join the session fresh. The fresh join is the one
   * repair that re-initialises BOTH ends — a new tmux client sends its complete
   * stream, and the terminal is reset before it binds. Bounded by
   * REJOIN_MIN_INTERVAL_MS and MAX_CONSECUTIVE_REJOINS so a genuinely gone
   * session cannot be hammered; a pane the user exited on purpose never reaches
   * here at all, because its channel is dead and `shellGone` gates the tick.
   *
   * ## The guards, in order
   *
   * A dead or never-opened shell does nothing (`shellGone` is set by exit; an
   * evicted tab recovers through `scheduleFit`, not here). An obscured window
   * (`document.hidden`) and a hidden pane (the zero-measure case behind another
   * tab) skip the round trip entirely, because only the pane someone is LOOKING
   * AT needs to be right promptly — exactly what makes the interval affordable
   * when the channel budget counts. And since the answer takes a network round
   * trip to arrive, everything below the await re-reads the world instead of
   * trusting the world that asked.
   */
  private async reconcileTick(): Promise<void> {
    const term = this.term;
    if (!term || !this.shellId || !this.fitAddon || this.shellGone) return;
    if (document.hidden) return;
    // A v-show'd pane measures 0. Same question scheduleFit asks, deliberately:
    // one definition of visible, wherever it is needed.
    if (!this.deps.isVisible()) return;
    const id = this.shellId;
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    let far: GeometryProbe;
    try {
      far = await api.shell.windowSize(id);
    } catch {
      // A rejected probe is this tick's answer lost — the shell died between the
      // guards and the call, the exact race this loop exists to absorb. Skipping
      // the tick is honest: the next one re-probes, and a genuinely gone shell
      // starts answering `dead`, which is the path to the rejoin.
      return;
    } finally {
      this.probeInFlight = false;
    }
    // The round trip took real time; the tab may have switched targets, been
    // closed, or exited underneath the await. Any of those means the answer no
    // longer describes the pane on screen.
    if (!this.term || id !== this.shellId || this.shellGone) return;
    if (far.kind === 'bare') return; // not a tmux client of ours; nothing to check, ever
    if (far.kind === 'dead') {
      this.scheduleRejoin(id);
      return;
    }
    // An answer at all means the repair path is alive: any streak that led
    // here is over.
    this.deadTicks = 0;
    this.rejoinStreak = 0;
    const grid = { cols: term.cols, rows: term.rows };
    if (far.client.cols !== grid.cols || far.client.rows !== grid.rows) {
      // OUR side is wrong: the tty is not the grid we pushed. Re-push and
      // repaint — the repair that is unambiguously ours to make.
      this.resyncDisplay();
      this.lastRepairAt = Date.now();
      this.driftRepaintDone = false;
      return;
    }
    // The window is at most one row shorter than the client: that row is the
    // status line, when the session runs one (measured both ways on tmux 3.4).
    const windowIsOurs =
      far.window.cols === far.client.cols &&
      (far.window.rows === far.client.rows || far.window.rows === far.client.rows - 1);
    if (!windowIsOurs) {
      // Another client is driving `window-size latest`. Not ours to fight — but
      // the first tick of the episode repaints, so the drift at least shows
      // correctly instead of compounding stale rows under a moving window.
      if (!this.driftRepaintDone) {
        this.driftRepaintDone = true;
        this.lastRepairAt = Date.now();
        forget(api.shell.redraw(id));
      }
      return;
    }
    this.driftRepaintDone = false;
    // Healthy, and ours. Repaint on the clock: the garble no comparison catches.
    if (Date.now() - this.lastRepairAt >= TerminalPane.HEALTHY_REPAIR_INTERVAL_MS) {
      this.lastRepairAt = Date.now();
      forget(api.shell.redraw(id));
    }
  }

  /**
   * The bounded automatic re-join: what the user did by hand ("connect to
   * another session then go back and connect again to the current one"), because
   * a fresh join is the only repair that re-initialises both ends of the stream.
   */
  private scheduleRejoin(id: ShellId): void {
    this.deadTicks += 1;
    if (this.deadTicks < TerminalPane.DEAD_TICKS_BEFORE_REJOIN) return;
    if (Date.now() - this.lastRejoinAt < TerminalPane.REJOIN_MIN_INTERVAL_MS) return;
    if (this.rejoinStreak >= TerminalPane.MAX_CONSECUTIVE_REJOINS) return;
    this.deadTicks = 0;
    this.lastRejoinAt = Date.now();
    this.rejoinStreak += 1;
    // The join's own attach repaints everything; do not double-repair behind it.
    this.lastRepairAt = Date.now();
    this.driftRepaintDone = false;
    this.paneWrite('\r\n\x1b[90m[PocketShell] lost the tmux client — rejoining…\x1b[0m\r\n');
    // Closing is what makes the next attach a FRESH JOIN: main drops the
    // pool record when the channel dies, so `attachSession` cannot answer
    // with the very client that just proved unreachable.
    forget(
      api.shell.close(id).then(() => {
        if (id !== this.shellId || !this.term) return; // the pane moved on meanwhile
        return this.open();
      }),
    );
  }

  startProbing(): void {
    if (this.probeTimer !== null) return;
    // The clocked repaint counts from here, not from epoch zero: a pane that
    // mounts already owns a fresh attach's full repaint, and its first owed
    // one is a full interval away, not overdue.
    this.lastRepairAt = Date.now();
    this.probeTimer = setInterval(() => {
      void this.reconcileTick();
    }, TerminalPane.GEOMETRY_PROBE_INTERVAL_MS);
  }

  private stopProbing(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }
}

/** A throw within this window before a stall counts as the parser's death. */
const PARSER_DEATH_WINDOW_MS = 10_000;

/**
 * Fire-and-forget IPC on paths that tolerate the shell dying underneath them:
 * the rejection IS the race the caller already expects (an evicted channel, a
 * pane unmounted mid-write), not news — and an uncaught one would only page
 * the diag banner for a shell this pane has already given up on.
 */
function forget(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

/** Message text for a thrown value, however it was thrown. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
