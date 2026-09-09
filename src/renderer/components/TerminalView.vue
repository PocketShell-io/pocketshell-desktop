<script setup lang="ts">
// TerminalView: an xterm.js terminal attached to an SSH shell channel.
//
// On mount it asks main for the PTY that should be on screen and wires
// xterm <-> the shell:
//   - shell stdout bytes -> xterm.write
//   - xterm user input   -> shell.input
//   - xterm resize       -> shell.resize
// On unmount it closes the shell.
//
// ONE OF THESE PER SESSION TAB, and staying mounted is the whole point. For a
// tmux session it calls `shell.attachSession`, and main answers with a PTY that
// belongs to that session for as long as the tab lives
// (src/main/ssh/TmuxClientPool.ts). Anything else (a bare shell) still goes
// through `shell.open`.
//
// The workspace keeps a TerminalView mounted for every session tab the user has
// visited and merely HIDES the inactive ones, so switching tabs moves no bytes
// and asks the host nothing: each xterm already holds its own session's screen.
// What this replaced was one TerminalView re-pointed by `session-key`, which
// cost a `tmux switch-client` exec plus a full-screen repaint over SSH on every
// click — p50 210 ms on the user's own host, and most attempts failed outright
// and paid a full re-join instead.
//
// `session-key` therefore no longer changes underneath a folder-workspace pane,
// but the watcher on it stays: nothing here assumes it is fixed, and a caller
// with a genuinely re-pointable pane still needs it.
//
// The ask-then-adopt order in `showTarget` stays too. It costs nothing, and it
// is what stops a re-attach closing a PTY main was about to hand back.
//
// Clipboard: a drag always selects IN THIS PANE — plain or Shift+drag alike
// (terminalMouseSelection.ts forces that even while the remote owns the
// mouse) — and copies on mouse-up (see onDocumentMouseUp). ALT+drag — and a
// tmux keyboard yank — select in tmux instead, and the yank comes back as
// OSC 52 (see the handler in onMounted and osc52.ts). RIGHT-CLICK pastes into the shell. Neither paste
// CHORD does — Ctrl/Cmd-V and Ctrl/Cmd-Shift-V are both claimed for the
// prompt composer and leave as `paste-into-composer` (see onCustomKey). The
// MIDDLE click does nothing at all (see onTerminalAuxClick): xterm's own
// middle-click paste would feed the clipboard to the shell silently.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal, type IDisposable, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { applyUnicode11Widths } from '../terminalUnicode';
import { api } from '../ipc';
import AppIcon from './AppIcon.vue';
import { useShellsStore } from '../stores/shells';
import { createPathLinkProvider } from '../terminalLinks';
import { PathHighlighter } from '../terminalPathHighlights';
import { decodeOsc52SetClipboard } from '../osc52';
import { forceLocalMouseSelection } from '../terminalMouseSelection';
import { useSettingsStore } from '../stores/settings';
import { resolveMonoStack } from '../fonts';
import { resolveTheme, terminalLinkTint } from '../themes';
import { isTypingKey } from '../../shared/composerText';
import { isShortcut } from '../../shared/shortcuts';
import { ParseStallMonitor, type ParseStallReport } from '../parseStall';
import { sessionIdentityKey } from '../sessionIdentity';
import { recordDiagDetail, msSinceLastUnhandledError } from '../diag';
import {
  repairIncompleteViewport,
  resumeWriteBufferAfterError,
} from '../xtermWriteBuffer';
import type { ConnectionId, GeometryProbe, ShellId } from '../../shared/types';
import '@xterm/xterm/css/xterm.css';

// The PTY this component owns is published to the shells store so other
// surfaces — the prompt composer, first of all — can write to the same pane.
// Ownership of the open/close lifecycle deliberately stays here; see the header
// comment of stores/shells.ts for why.
const shells = useShellsStore();
// Typography is a user setting; the two values in TERMINAL_OPTIONS are only
// its defaults. See src/renderer/fonts.ts.
const settings = useSettingsStore();

const props = defineProps<{
  connectionId: ConnectionId;
  /**
   * Command to run inside the PTY. Only used for a pane that is NOT a tmux
   * session — a session goes through `shell.attachSession`, which builds its
   * own join command in main so the same code path can also decide to switch
   * instead of joining.
   */
  command?: string;
  /** A key that, when changed, re-points the pane (used to switch sessions). */
  sessionKey?: string;
  /**
   * When true, a printable keystroke is NOT sent to the shell: it is emitted as
   * `typed` instead, for the prompt composer to open with. The caller decides
   * when that applies (the setting, and only while the composer is closed) —
   * this component just obeys a boolean, so it needs to know nothing about
   * either the composer or the settings store.
   */
  interceptTyping?: boolean;
  /**
   * The tmux session to display. Falls back to {@link sessionKey}, which is
   * the session name at every current call site; the separate prop exists so a
   * caller whose key is not a session name can say so rather than having main
   * try to `switch-client` to something that is not a session.
   */
  sessionName?: string;
  /**
   * Which runtime owns the session. Absent means tmux. An aplexer session
   * joins by UUID ([aplexerId]) or workspace+tag — never by bare tag, which
   * is unique only within its workspace — so the workspace must ride along.
   */
  backend?: 'tmux' | 'aplexer';
  /** Aplexer workspace. Required for an aplexer session without [aplexerId]. */
  workspace?: string | null;
  /** Aplexer UUID. Preferred join selector; survives renames. */
  aplexerId?: string | null;
}>();

/**
 * `typed` carries the character that was withheld from the shell, so whoever
 * opens the composer can plant it in the draft. Losing it would mean retyping
 * the first letter of every prompt, which is the whole point of the feature.
 *
 * `paste-into-composer` carries NOTHING, and that emptiness is the design. The
 * user pressed Ctrl+V at the terminal and meant it for the composer; what is on
 * the clipboard, whether it is stageable, and whether it is worth opening the
 * panel for are all questions the COMPOSER answers, because the composer is
 * where the answer is acted on. Reading the clipboard here and shipping files
 * or text across would put a second clipboard-to-attachment path in this
 * component, which is exactly what this feature was asked not to grow — the
 * composer's `onPaste` already owns that path. So this stays the same shape as
 * `typed`: a statement that a keystroke was withheld, not an instruction about
 * what to do with it.
 */
const emit = defineEmits<{
  (e: 'typed', text: string): void;
  (e: 'paste-into-composer'): void;
  (e: 'drop-into-composer', files: File[]): void;
}>();

/** The tmux session this pane should be showing, or '' for a bare shell. */
const targetSession = computed(() => props.sessionName ?? props.sessionKey ?? '');

// ---------------------------------------------------------------------------
// The join veil
// ---------------------------------------------------------------------------
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
const joinPending = ref(false);
let joinPendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long a join may be silent before the veil appears.
 *
 * Short enough that the user never has time to conclude "broken" — that
 * verdict forms in well under a second — and long enough that the common
 * fast join (a pooled client, a warm connection) never flashes the veil at
 * all, which would read as noise rather than as state.
 */
const JOIN_VEIL_DELAY_MS = 250;

function beginJoinPending(): void {
  if (joinPendingTimer !== null) clearTimeout(joinPendingTimer);
  joinPendingTimer = setTimeout(() => {
    joinPendingTimer = null;
    joinPending.value = true;
  }, JOIN_VEIL_DELAY_MS);
}

function endJoinPending(): void {
  if (joinPendingTimer !== null) {
    clearTimeout(joinPendingTimer);
    joinPendingTimer = null;
  }
  joinPending.value = false;
}

onBeforeUnmount(endJoinPending);

/**
 * The shells-registry key for this pane.
 *
 * Same workspace rule as the join: a bare tag repeats across workspaces, so
 * the registration carries the workspace for aplexer panes and two folders
 * holding same-named tags resolve to their own PTYs. tmux names are
 * host-global and stay bare. See `renderer/sessionIdentity.ts`.
 */
const registryKey = computed(() =>
  sessionIdentityKey(targetSession.value, {
    backend: props.backend,
    workspace: props.workspace ?? undefined,
  }),
);

/**
 * Terminal look & feel, transcribed from the user's Windows Terminal config.
 * Kept as a standalone object so the font/theme can be swapped wholesale
 * without touching the wiring below. 
 *
 * Source: %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\
 *         LocalState\settings.json  (font face/size, bellStyle)
 *   plus  Windows Terminal 1.24 defaults.json  (everything the user's file
 *         leaves unset: the Campbell scheme, bar cursor, 8px padding,
 *         9001-line scrollback, grayscale AA, word delimiters).
 * The user's settings.json has "schemes": [] and no `colorScheme` key, so the
 * built-in default scheme — Campbell — is what they actually see.
 */
const TERMINAL_OPTIONS: ITerminalOptions = {
  // profiles.defaults.font.face = "Consolas"
  fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  // profiles.defaults.font.size = 16. Windows Terminal reads that as points
  // (16pt = 21.33px at 96 DPI), but the user chose to take the number
  // literally as pixels here, so 16 it is. Mirrored by --term-font-size.
  fontSize: 16,
  fontWeight: 400,
  fontWeightBold: 700,
  // No `font.cellHeight` override, so Consolas' natural cell (~1.0em).
  lineHeight: 1.0,
  letterSpacing: 0,

  // defaults.json: cursorShape "bar". Windows Terminal blinks by default.
  cursorStyle: 'bar',
  cursorBlink: true,
  cursorInactiveStyle: 'outline',

  // defaults.json: historySize 9001, snapOnInput true.
  scrollback: 9001,
  scrollOnUserInput: true,

  // defaults.json: wordDelimiters — makes double-click word selection split
  // paths and punctuation exactly as it does in Windows Terminal.
  wordSeparator: ' /\\()"\'-.,:;<>~!@#$%^&*|+=[]{}~?│',

  drawBoldTextInBrightColors: true,
  // Campbell's dim blue (2.38:1) and magenta (2.44:1) are unreadable on its
  // own background; this lifts only those and leaves the rest untouched.
  minimumContrastRatio: 3,

  // No `theme` here: the palette belongs to the APPLIED THEME, looked up from
  // src/renderer/themes.ts at construction and re-assigned by the watcher
  // below. The dark record carries Campbell verbatim, provenance intact.
};

const containerEl = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let shellId: ShellId | null = null;

/**
 * Re-attaching a PTY must not redirect a keystroke from another surface.
 *
 * A reconnect can finish after the prompt composer has taken focus, and the
 * old unconditional `term.focus()` then made the next character land in the
 * terminal. Only restore focus for a visible pane when it already owns focus,
 * or when the document has no meaningful focused control (the initial mount).
 */
function mayRestoreTerminalFocus(): boolean {
  const container = containerEl.value;
  if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) {
    return false;
  }
  const active = document.activeElement;
  if (active && container.contains(active)) return true;
  return active === null || active === document.body || active === document.documentElement;
}

/**
 * Watches every byte this component feeds xterm, so a parser death is a
 * REPORT (which pane, which bytes, what buffer state) instead of a pane that
 * quietly stops updating. See {@link paneWrite} and src/renderer/parseStall.ts.
 */
let stallMonitor: ParseStallMonitor | null = null;
/** The key `shellId` is currently published under, so a re-open can retract it. */
let registeredKey: string | null = null;
let unsubscribeData: (() => void) | null = null;
let unsubscribeExit: (() => void) | null = null;
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
let shellGone = false;
/**
 * Whether the pane measured zero the last time it was looked at, i.e. it is
 * behind a `v-show`.
 *
 * Only the hidden -> visible EDGE may re-attach. Re-attaching on any resize of
 * a visible pane would silently rejoin a session the user had deliberately
 * exited, which is the one case where a dead pane is the correct outcome.
 */
let paneHidden = false;
/**
 * xterm-side handlers. These are bound ONCE against the stable `term` and read
 * the current `shellId` from the closure. Binding them per-shell (as an earlier
 * version did) stacked a new onData/onResize on every session switch, so each
 * keystroke — and each reply to tmux's `ESC[>c` device-attributes probe — was
 * sent to the PTY N times, which is what leaked `0;276;0c` into the output.
 */
let termDisposables: IDisposable[] = [];
/**
 * Refits when the CONTAINER changes size, not only when the window does. The
 * prompt composer docks below this pane and grows/shrinks/hides underneath it,
 * which resizes the terminal without any window resize event — without this the
 * xterm canvas keeps its old row count and either clips the tmux status bar or
 * leaves dead black space below it.
 */
let resizeObserver: ResizeObserver | null = null;
/** Coalesces a burst of resize callbacks into one fit per frame. */
let fitFrame = 0;
/**
 * The geometry the far end was last TOLD, or null when it has been told
 * nothing — a PTY we have just adopted knows only the size it was opened with,
 * and a PTY we do not hold knows nothing at all.
 *
 * This exists because "has the far end been told our size" is a fact about the
 * REMOTE, and until now nothing in this component held it. Every route into a
 * size change had to remember, on its own, to send one: the font watcher
 * (4c0f555), `showTarget` after a switch, the container observer. Three of
 * today's bugs are one of those routes forgetting, and the fourth is the far
 * end being told correctly and simply not repainting. So the fact is stored
 * once, {@link pushGeometry} is the only thing that writes it, and every route
 * calls that instead of reasoning about whether a send is needed.
 */
let sent: { cols: number; rows: number } | null = null;

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
const MIN_REMOTE_COLS = 20;
const MIN_REMOTE_ROWS = 5;

/** Is this grid one a person could actually be looking at? */
function plausibleGrid(size: { cols: number; rows: number } | undefined): boolean {
  if (!size) return false;
  return size.cols >= MIN_REMOTE_COLS && size.rows >= MIN_REMOTE_ROWS;
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
function fitTerminal(): void {
  if (!term || !fitAddon) return;
  const proposed = fitAddon.proposeDimensions();
  if (!plausibleGrid(proposed)) return;
  fitAddon.fit();
  repairTerminalBufferIfNeeded();
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
function repairTerminalBufferIfNeeded(): void {
  if (!term) return;
  repairIncompleteViewport(term);
}

/** True between mousedown inside the terminal and the mouse-up that ends it. */
let selecting = false;

/**
 * Ask main for the PTY that should be on screen, without touching anything.
 *
 * A tmux session goes through `attachSession` so main can move the client it
 * already holds; anything else opens a plain shell, which is always new.
 */
async function requestShell(
  cols: number,
  rows: number,
): Promise<{ shellId: ShellId; switched: boolean }> {
  const session = targetSession.value;
  if (session) {
    const aplexer = props.backend === 'aplexer';
    return api.shell.attachSession({
      connectionId: props.connectionId,
      sessionName: session,
      cols,
      rows,
      // The pool keys (and joins) aplexer sessions by workspace+tag or UUID;
      // the session name alone carries the tag but not the workspace.
      ...(aplexer ? { backend: 'aplexer' as const, tag: session } : {}),
      ...(aplexer && props.workspace ? { workspace: props.workspace } : {}),
      ...(aplexer && props.aplexerId ? { aplexerId: props.aplexerId } : {}),
    });
  }
  const id = await api.shell.open({
    connectionId: props.connectionId,
    command: props.command,
    cols,
    rows,
  });
  return { shellId: id, switched: false };
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
function pushGeometry(opts: { redraw?: boolean } = {}): void {
  if (!term || !shellId) return;
  const { cols, rows } = term;
  // A pane behind a `v-show` measures 0 and xterm keeps whatever grid it last
  // had; pushing that would tell tmux the tab is its old size while it is not
  // on screen at all. The hidden -> visible edge in `scheduleFit` is what
  // brings it back.
  if (!containerEl.value?.clientHeight || !containerEl.value.clientWidth) return;
  // The floor, applied HERE because this is the one place that speaks to the
  // far end (see {@link MIN_REMOTE_COLS}). `scheduleFit` refuses to fit to a
  // degenerate size in the first place, but it is not the only route in: the
  // mount, `showTarget` after a join, and the font and zoom watchers all fit
  // and then push. Guarding the owner covers every one of them, and leaves
  // `sent` untouched — so the size the remote is still on remains the size we
  // believe it is on, and the next plausible fit is compared against the truth.
  if (!plausibleGrid({ cols, rows })) return;
  const id = shellId;
  if (!sent || sent.cols !== cols || sent.rows !== rows) {
    sent = { cols, rows };
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

/** Bind the main->renderer byte and exit streams for the current `shellId`. */
function bindShellStream(): void {
  unsubscribeData = api.shell.onData(({ shellId: id, data }) => {
    if (id === shellId && term) {
      paneWrite(data);
    }
  });
  unsubscribeExit = api.shell.onExited(({ shellId: id }) => {
    if (id === shellId && term) {
      shellGone = true;
      paneWrite('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    }
  });
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
function paneWrite(data: string | Uint8Array): void {
  if (!term) return;
  // The far end produced output: whatever the pane was waiting for, it is no
  // longer the thing the veil was saying. See the join-veil note above.
  endJoinPending();
  repairTerminalBufferIfNeeded();
  stallMonitor?.write(term, data);
}

/** Live facts a stall report needs, read at stall time, not at bind time. */
function describePaneForDiag(): Record<string, unknown> {
  // Every field is best-effort: this runs on a failing path, and tests drive
  // this component with stub terminals that implement only what they exercise.
  const buffer = term?.buffer?.active;
  return {
    session: targetSession.value || '(shell)',
    connection: props.connectionId,
    shellId: shellId ?? '(none)',
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
function handleParseStall(report: ParseStallReport): void {
  const parserThrew = msSinceLastUnhandledError() <= PARSER_DEATH_WINDOW_MS;
  const id = shellId;
  const resumed = parserThrew ? resumeWriteBufferAfterError(term) : false;
  const recovering = parserThrew && resumed && id !== null && !shellGone;
  recordDiagDetail(
    'terminal-stall',
    `terminal output parsing stalled (${report.chunkLength} chars queued, session ${targetSession.value || 'shell'})`,
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
  term?.write('\r\n\x1b[90m[PocketShell] output parsing stalled — see desktop log\x1b[0m\r\n');
  if (recovering && id !== null) rejoinAfterParseDeath(id);
}

/** A throw within this window before a stall counts as the parser's death. */
const PARSER_DEATH_WINDOW_MS = 10_000;

/**
 * The bounded re-join after a parser death. The dead-probe path
 * ({@link scheduleRejoin}) waits for two bad probe answers before trusting
 * that the client is gone; a parser death needs no second opinion — the
 * throw IS the evidence — but it shares the anti-hammer bounds, so every
 * repair path in this component spends re-joins out of the same budget.
 */
function rejoinAfterParseDeath(id: ShellId): void {
  if (Date.now() - lastRejoinAt < REJOIN_MIN_INTERVAL_MS) return;
  if (rejoinStreak >= MAX_CONSECUTIVE_REJOINS) return;
  lastRejoinAt = Date.now();
  rejoinStreak += 1;
  lastRepairAt = Date.now();
  driftRepaintDone = false;
  paneWrite('\r\n\x1b[90m[PocketShell] parser crashed — rejoining for a clean slate…\x1b[0m\r\n');
  forget(
    api.shell.close(id).then(() => {
      if (id !== shellId || !term) return; // the pane moved on meanwhile
      return queueShowTarget();
    }),
  );
}

function unbindShellStream(): void {
  if (unsubscribeData) {
    unsubscribeData();
    unsubscribeData = null;
  }
  if (unsubscribeExit) {
    unsubscribeExit();
    unsubscribeExit = null;
  }
}

/**
 * Fire-and-forget IPC on paths that tolerate the shell dying underneath them:
 * the rejection IS the race the caller already expects (an evicted channel, a
 * pane unmounted mid-write), not news — and an uncaught one would only page
 * the diag banner for a shell this component has already given up on.
 */
function forget(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

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
let showTargetChain: Promise<void> = Promise.resolve();

function queueShowTarget(): Promise<void> {
  const run = showTargetChain.then(showTarget);
  // showTarget writes its own failures into the pane; this catch only keeps
  // the chain alive for the next rider.
  showTargetChain = run.catch(() => undefined);
  return run;
}

/**
 * Put the current target on screen, whether that means a first join, a switch
 * of the shared tmux client, or a fresh PTY because the switch could not be
 * had. Used for the initial mount and for every later session change, because
 * main — not this component — is what decides which of the three it is.
 */
async function showTarget(): Promise<void> {
  if (!term || !containerEl.value) return;
  // From here until the far end's first byte, the pane says what it is doing
  // instead of being a black rectangle. See the join-veil note above.
  beginJoinPending();
  fitTerminal();
  const cols = term.cols;
  const rows = term.rows;

  const previousId = shellId;
  // Retract the OLD key's registration BEFORE asking for the new target.
  // With one PTY shared across sessions, the shells store stops being a map of
  // independent per-session channels and becomes the answer to "which session
  // is this pane showing right now". Leaving the old key registered would let a
  // composer still bound to it write a prompt into whatever session the pane
  // switched to. Unregistered, that composer finds no shell and refuses to
  // send, which is the failure mode to want.
  if (registeredKey !== null) {
    shells.unregister(registeredKey, previousId ?? undefined);
    registeredKey = null;
  }

  let result: { shellId: ShellId; switched: boolean };
  try {
    result = await requestShell(cols, rows);
  } catch (e) {
    // A rejection here used to escape into `onMounted`'s promise, where
    // nothing was waiting for it: the pane stayed blank and the user was told
    // nothing at all — indistinguishable from a session that opened and simply
    // had no output yet. The PTY is the only surface this component owns, so
    // the failure is written INTO it. Nothing is torn down beyond the streams:
    // main disposes of any shell it failed to replace, and a further session
    // change still re-arms the whole path.
    unbindShellStream();
    shellId = null;
    sent = null;
    paneWrite(`\r\n\u001b[31mCould not open a shell: ${describe(e)}\u001b[0m\r\n`);
    return;
  }

  // A join is seconds long on a real host, and the tab can be closed inside
  // that window — the workspace unmounts the pane, `onBeforeUnmount` disposes
  // the terminal, and everything below would then be operating on a corpse.
  // Handing the shell straight back to main is the honest exit: we asked for
  // it, we are not going to use it, and leaving it open would leak an SSH
  // channel against a `MaxSessions` budget of ten.
  if (!term) {
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
    // component opens, where nothing is consuming mouse reports — so the wheel
    // and click-drag get encoded as `\x1b[<0;2;1M` and typed at the prompt, which
    // the shell echoes as literal `0;2;1M`, and drag-select stops working because
    // xterm is claiming the drag for reporting. reset() clears modes with it.
    unbindShellStream();
    if (previousId) term.reset();
    shellId = result.shellId;
    shellGone = false;
    // A PTY we have just been handed knows only the size it was OPENED with,
    // which is the pre-await capture above. Forgetting what we told the old
    // one is what makes the unconditional push below actually send.
    sent = null;
    bindShellStream();
  } else {
    // The same PTY came back — a re-point over a client the pool still holds,
    // a rename's re-key being the case that matters. Nothing was torn down and
    // nothing is being waited for, so the veil's claim ("a join is under way")
    // is already false; leaving it armed would hang the shroud over a live
    // pane until the next byte, which on an idle session is never.
    endJoinPending();
    // Deliberately NO reset here: the tmux client never detached, so it still
    // owns the modes it set and will not be told to set them again — tmux
    // redrew every row of the PTY itself.
  }

  // Publish it before the first byte can be typed at it. Under the
  // workspace-qualified registry key, so same-named aplexer tags in different
  // folders never share a registration.
  registeredKey = registryKey.value;
  shells.register(registeredKey, result.shellId);
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
  fitTerminal();
  pushGeometry({ redraw: true });
  if (mayRestoreTerminalFocus()) term.focus();
}

/** Message text for a thrown value, however it was thrown. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Give up the PTY for good. Only unmount calls this now — a session change
 * goes through {@link showTarget}, which must NOT close first: the shell it
 * would close is the shared tmux client main is about to reuse.
 */
function closeShell(): void {
  unbindShellStream();
  if (registeredKey !== null) {
    shells.unregister(registeredKey, shellId ?? undefined);
    registeredKey = null;
  }
  if (shellId) {
    forget(api.shell.close(shellId));
    shellId = null;
  }
  sent = null;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** Copy `text` to the system clipboard. Silent on failure — never throws. */
async function copyToClipboard(text: string): Promise<void> {
  if (!text) return; // a bare click clears the selection; don't blank the clipboard
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission denied / API unavailable. Nothing useful to do
    // from the renderer; the selection is still there for a manual Ctrl-C.
  }
}

/**
 * Read the system clipboard and feed it to the shell as pasted input.
 *
 * One caller left: the right-click (`onTerminalContextMenu`). Both paste CHORDS
 * go to the composer now, so this is the whole of the shell's paste — see the
 * chord branch in `onCustomKey` for why that is the split.
 */
async function pasteFromClipboard(): Promise<void> {
  if (!term) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // Same as above: degrade quietly. Ctrl-V still works via xterm's own
    // handling of the browser `paste` event.
  }
}

/**
 * Arms the mouse-up copy. Bound in the CAPTURE phase (see the addEventListener
 * in onMounted): xterm's own mousedown handling on a forced-local selection —
 * the plain-drag path terminalMouseSelection.ts installs — calls
 * `stopPropagation()`, which would swallow a bubble-phase listener on this
 * container and leave `selecting` unarmed, so a completed drag would select on
 * screen and never reach the clipboard.
 */
function onTerminalMouseDown(e: MouseEvent): void {
  if (e.button === 0) selecting = true;
  // The middle button's own default — autoscroll, and on some platforms the
  // paste itself — is cancelled here; see onTerminalAuxClick for the other
  // half of the gesture.
  else if (e.button === 1) e.preventDefault();
}

/**
 * The middle click does NOTHING in the pane — deliberately, and the user asked
 * for it that way. Left to itself, xterm answers a middle-button `auxclick` by
 * moving its hidden helper textarea under the cursor (CoreBrowserTerminal,
 * gated on Linux), which is exactly what lets the BROWSER'S middle-click paste
 * fire: whatever the clipboard holds lands in the shell as typed input, with
 * no chord and no confirmation. This swallows the event in the capture phase —
 * stopPropagation keeps it from xterm's own listener on the terminal element,
 * and preventDefault keeps it from the browser — so the gesture is inert. The
 * `mousedown` half above cancels the same press's default.
 *
 * Mouse REPORTING is untouched: xterm forwards press and release through
 * `mousedown`/`mouseup`, neither of which this stops or cancels, so a program
 * inside tmux still sees the middle button. Only the LOCAL paste is gone.
 */
function onTerminalAuxClick(e: MouseEvent): void {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Copy on selection *settle*. Listening on the document (gated by `selecting`)
 * means a drag that ends outside the terminal still copies, while unrelated
 * clicks elsewhere in the app do not re-copy a stale selection. Using mouse-up
 * rather than xterm's onSelectionChange avoids hammering the clipboard on every
 * tick of the drag.
 */
function onDocumentMouseUp(): void {
  if (!selecting) return;
  selecting = false;
  if (!term || !term.hasSelection()) return;
  void copyToClipboard(term.getSelection());
}

function onTerminalContextMenu(e: MouseEvent): void {
  e.preventDefault();
  void pasteFromClipboard();
}

// ---------------------------------------------------------------------------
// Drop a file on the pane -> the prompt composer, the same routing the paste
// chords take. TerminalView cancels the gesture and announces it; everything
// from there is the composer's.
//
// Unlike `paste-into-composer` this event CARRIES the payload, and the
// asymmetry is forced: a DataTransfer's `files` exist only inside the event
// that delivered them, so the composer cannot re-read them the way it re-reads
// a clipboard. What crosses is the bare `File` objects — nothing is opened,
// decoded or staged here. All of that stays in PromptComposer's `stageFiles`,
// the one path the card's own drop, the draft paste and the clipboard paste
// already share.
//
// Only a drag advertising `Files` is claimed. A tab drag carries the strip's
// own mime type (FolderWorkspaceView's TAB_DRAG_TYPE) and must keep falling
// through — the composer learned the same lesson in its `onDragOver`.
// ---------------------------------------------------------------------------

/** True while a file-carrying drag hovers the pane; drives the dashed outline. */
const dropActive = ref(false);

function onTerminalDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return;
  if (!Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropActive.value = true;
}

function onTerminalDragLeave(e: DragEvent): void {
  // dragleave fires for every xterm child the drag crosses; only leaving the
  // container itself — or the window — ends the affordance. Same latch the
  // composer's onDragLeave uses.
  if (containerEl.value?.contains(e.relatedTarget as Node | null)) return;
  dropActive.value = false;
}

function onTerminalDrop(e: DragEvent): void {
  dropActive.value = false;
  if (!e.dataTransfer) return;
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;
  e.preventDefault();
  emit('drop-into-composer', files);
}

/**
 * Intercept the clipboard chords, and (when asked) plain typing, before xterm
 * turns them into input bytes. Returning false tells xterm to leave the event
 * alone.
 */
function onCustomKey(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;

  // THE WORKSPACE'S TAB CHORDS. `Ctrl+[` / `Ctrl+]` step one tab left or right
  //. They are handled by a window-level capture
  // listener in FolderWorkspaceView, which stops the event before it can
  // descend this far — so in the folder workspace this branch never runs.
  //
  // It is here anyway, and it is NOT belt-and-braces: it is the answer to what
  // xterm would do with these keys, which is not nothing. Measured against
  // @xterm/xterm 6's `evaluateKeyboardEvent`, the function this handler is
  // consulted from:
  //
  //   Ctrl+[          -> C0.ESC (0x1B) — THE physical escape of older
  //                      keyboards, and readline's meta-prefix. vim users in
  //                      tmux feel this one.
  //   Ctrl+]          -> C0.GS (0x1D).
  //
  // So a pane mounted outside a folder workspace — a future caller, a test —
  // would otherwise turn a tab chord into shell input. Declining it here means
  // the chord's meaning does not depend on who mounted the terminal.
  //
  // ## What is NOT in this list any more
  //
  // `Ctrl+1`..`Ctrl+9` used to be declined here, for the jump-to-Nth-tab
  // family; the user asked for it to go ("remove ctrl 1 2 3 hotkey"). Then the
  // CYCLE went — `Ctrl+Tab` / `Ctrl+Shift+Tab` ("remove these hotkeys let's
  // keep only ctrl left and ctrl right") — and finally the arrows themselves,
  // when the pair moved onto brackets because they collided with word-jump in
  // text fields. Every removal HANDS KEYS BACK to the shell rather than merely
  // tidying up:
  //
  //   Ctrl+3..Ctrl+8  -> `ESC`, `FS`, `GS`, `RS`, `US`, `DEL` (`Ctrl+3` is a
  //                      common stand-in for Escape).
  //   Ctrl+Tab        -> C0.HT (`\t`). `case 9` ignores Ctrl entirely, so at a
  //                      shell prompt this is completion again.
  //   Ctrl+Shift+Tab  -> ESC [ Z (back-tab).
  //   Ctrl+←/Ctrl+→   -> ESC [ 1 ; 5 D / C, readline's backward/forward-word.
  //
  // A chord this app no longer claims must reach the program the user is
  // actually talking to. `Ctrl+Shift+PageUp`/`PageDown` were never declined
  // here in the first place: xterm's own scrollback is what they do.
  //
  // `preventDefault()` AND `return false`, both, for the third time in this
  // function and for the reason the two branches below spell out: returning
  // false stops xterm (`_keyDown` bails at the custom handler and never calls
  // its own `cancel()`) but leaves the DOM event LIVE. One keystroke, two
  // paths, is bc86cf7 and 3628090.
  //
  // `!e.altKey`: Ctrl+Alt is AltGr on European layouts. AltGr+[ and AltGr+] are
  // real characters on several of them and none of it is ours.
  //
  // The chord is DATA (src/shared/shortcuts.ts) and this branch only DECLINES
  // it. Reading the registry rather than restating it here is the point:
  // this copy and FolderWorkspaceView's are the two that would otherwise drift,
  // and a chord chosen against a drifted copy is exactly what produced a
  // keyboard nobody could look up. Shifted ghosts (`Ctrl+{` / `Ctrl+}`) match
  // nothing in the table and fall through here, as the shifted arrows did.
  if (!e.altKey && isShortcut(settings.shortcutBindings, 'tabs.stepLeftRight', e)) {
    e.preventDefault();
    return false;
  }

  // Typing opens the composer instead of reaching the shell. Everything
  // `isTypingKey` rejects — every chord, every named key, a bare space —
  // falls through to xterm untouched; see its contract for where that line is.
  if (props.interceptTyping === true && isTypingKey(e)) {
    // preventDefault IS THE FEATURE, not a precaution. Returning false only
    // tells xterm to stop processing (`_keyDown` bails at the custom handler
    // and, unlike `_keyPress`, never calls its own `cancel()`), so without this
    // line the DOM event is left un-cancelled and the browser still performs
    // the default action. By the time it does, `typed` has already opened the
    // composer and focused its textarea — so the browser typed the character
    // into it a SECOND time, on top of the copy `typeInto` planted. That is the
    // doubled first letter: one keystroke, two paths. Cancelling here closes
    // the native path, and suppresses the keypress event with it, which is why
    // there is no longer a latch spanning keydown and keypress.
    e.preventDefault();
    emit('typed', e.key);
    return false;
  }

  // BOTH paste chords go to the PROMPT COMPOSER, Shift or no Shift — which is
  // why this is one binding with two defaults (`terminal.pasteIntoComposer`)
  // rather than two branches.
  //
  // Ctrl+V was claimed first, and it was affordable only because it was
  // measured: on this exact xterm (3628090) plain Ctrl+V produces a single
  // `\x16` through xterm's own ctrl-letter mapping and pastes NOTHING. What it
  // costs is readline's literal-next (`quoted-insert`, bound to `\x16`), which
  // some people do use at a bash prompt; `Ctrl+Q` is bound to the same command
  // in vi mode and nothing here claims it.
  //
  // Ctrl+SHIFT+V now joins it, and that was the user's report: "when I paste
  // using ctrl+shift+v it goes directly to terminal but should go to prompt
  // composer". It is the chord every terminal emulator trains into people's
  // hands, so it is the one they reach for FIRST — and a pane where one paste
  // chord opens the composer and its twin dumps the clipboard into the shell
  // does not have two features, it has a coin toss. Which of the two fires is
  // not something a user can feel before the paste has already landed
  // somewhere, and one of those landings runs whatever was on the clipboard as
  // shell input.
  //
  // The shell keeps its paste: RIGHT-CLICK (`onTerminalContextMenu`), which is
  // still a chord-free, one-gesture route to the same place and is documented
  // as such. That is deliberate — pasting a command to run at a prompt is a
  // real thing to want, it just no longer sits on the key most likely to be
  // pressed by reflex.
  //
  // `!e.altKey` stays OUTSIDE the chord test, because it is not part of the
  // chord: Ctrl+Alt is how AltGr arrives on European layouts, and AltGr+V is a
  // printable character on several of them. A user typing `@` or `~` must not
  // have it swallowed by the composer, and no chord table can express "and
  // definitely not AltGr".
  //
  // preventDefault IS THE FEATURE here for the third time in this function, and
  // for the third identical reason — returning false stops xterm (`_keyDown`
  // bails at the custom handler and never calls its own `cancel()`) but leaves
  // the DOM event LIVE, so Chromium performs its own default action on top of
  // ours. It has been measured doing exactly that twice: Ctrl+Shift+V is
  // `pasteAndMatchStyle`, which fires a `paste` on xterm's textarea that xterm
  // turns into a second write (3628090), and Ctrl+V is an ordinary paste into
  // whatever holds focus — about to be the composer's draft, which would then
  // receive the clipboard twice. One keystroke, two paths, is bc86cf7 and
  // 3628090; this line is what closes the native one.
  if (!e.altKey && isShortcut(settings.shortcutBindings, 'terminal.pasteIntoComposer', e)) {
    e.preventDefault();
    emit('paste-into-composer');
    return false;
  }
  // TWO chords answer here, and both mean copy-the-selection:
  // `terminal.copySelection` (Ctrl+Shift+C, rebindable) and
  // `terminal.ctrlCCopiesSelection` (bare Ctrl+C, fixed). The second is the
  // Windows-console contract, on the user's request: the pane is "in copying
  // mode" exactly while it holds a selection — the highlight xterm keeps after
  // the drag ends — and while it does, Ctrl+C must copy rather than
  // interrupt. The guard below is the whole safety of that: with nothing
  // selected the branch stands down and the key falls through to xterm,
  // which sends `\x03` — SIGINT, the chord's day job. A fixed binding is
  // what keeps that arrangement out of the rebinding pool: if Ctrl+C could be
  // moved onto, some other command could take it and its no-selection case
  // would stop being an interrupt at all.
  if (
    isShortcut(settings.shortcutBindings, 'terminal.copySelection', e) ||
    isShortcut(settings.shortcutBindings, 'terminal.ctrlCCopiesSelection', e)
  ) {
    // `preventDefault()` sits here and not only at the return, because
    // returning false stops xterm — `_keyDown` bails at the custom handler and
    // never calls its own `cancel()` — but leaves the DOM event LIVE for
    // Chromium to act on (Ctrl+C is the menu's `copy` role, Ctrl+Shift+C is
    // nothing). Both, always: it is the same defect bc86cf7 and 3628090 fixed
    // twice before, in the very function that documents it.
    if (term?.hasSelection()) {
      e.preventDefault();
      void copyToClipboard(term.getSelection());
      return false;
    }
  }
  return true;
}

onMounted(async () => {
  term = new Terminal({
    ...TERMINAL_OPTIONS,
    fontFamily: resolveMonoStack(settings.monospaceFontFamily),
    fontSize: settings.terminalFontSize,
    theme: resolveTheme(settings.theme).terminal,
    // `registerDecoration` — the at-rest path tint, terminalPathHighlights.ts —
    // is proposed-API and THROWS without this flag. `term.unicode` (the
    // Unicode 11 width provider, terminalUnicode.ts) sits behind the same
    // gate; `term.buffer` is public API despite the repair comment below once
    // claiming otherwise.
    allowProposedApi: true,
    // OSC 8 hyperlinks — links a remote program embeds with escape sequences,
    // rather than text the linkifier guessed at — are NOT handled by
    // WebLinksAddon below; xterm core activates them itself, and its default
    // is unusable in Electron twice over: it asks `confirm()` first (the
    // "This link could potentially be dangerous" dialog), then `window.open()`
    // with NO url — which main's window-open handler refuses as `about:blank`,
    // so confirming the dialog still opened nothing. The handler replaces that
    // default with what the addon's callback below does: `window.open` the URI
    // and let main allow-list http(s) into the system browser. The scheme test
    // here mirrors both the addon's and main's; xterm independently drops
    // non-http(s) OSC 8 URIs before a link is even offered, unless
    // `allowNonHttpProtocols` is set (it is not).
    linkHandler: {
      activate: (_event, uri) => {
        if (/^https?:\/\//i.test(uri)) {
          window.open(uri, '_blank', 'noopener,noreferrer');
        }
      },
    },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Emoji measure two columns — in the buffer as well as in the font — before
  // the first output byte is parsed (terminalUnicode.ts).
  applyUnicode11Widths(term);
  // An explicit activation handler, not the addon default.
  //
  // WebLinksAddon defaults to `window.open(uri)`, which in Electron reaches
  // the main process window-open handler — and when the addon has nothing
  // usable to open, that arrives as `about:blank` and gets dispatched to the
  // OS, which is the "we can't open this 'about' link" dialog. Main now
  // allow-lists the scheme, but filtering here as well means a bad match
  // never leaves the renderer at all, and the check sits next to the thing
  // that produced the URL. Terminal output is remote bytes; a link in it is
  // a suggestion from another machine, not an instruction.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    }),
  );
  term.open(containerEl.value!);
  fitTerminal();

  // Output bytes are observed from here on: one monitor per terminal, for the
  // terminal's whole life, across session re-points (it watches `term`, which
  // survives a switch).
  stallMonitor = new ParseStallMonitor({
    describe: describePaneForDiag,
    onStall: handleParseStall,
  });

  // xterm -> shell. Bound once, against the terminal's whole lifetime.
  termDisposables = [
    term.onData((data) => {
      if (shellId) forget(api.shell.input(shellId, data));
    }),
    // Through `pushGeometry` rather than straight to `api.shell.resize`, so a
    // resize that fires before a PTY exists is not simply LOST: it records
    // nothing, and the unconditional push at the end of `showTarget` then
    // sends whatever the pane has become. That is the hole a tab fell into
    // while its join was in flight — seconds, on this user's host.
    term.onResize(() => {
      pushGeometry();
    }),
    // Path links, registered AFTER WebLinksAddon above, deliberately: xterm
    // gives an EARLIER provider priority over a later one for the same cells
    // and drops intersecting lower-priority links, so a URL stays a web link
    // even if the path detector were fooled by one. It is not — terminalPaths
    // rejects any http(s) token before it peels anything, and a `file://`
    // token is a path for the Files tab, not a web link — but two
    // independent guarantees are worth having for a thing this easy to get
    // subtly wrong.
    //
    // Bound once, like everything else in this array and for the same reason:
    // the session the pane shows is read through a getter at CLICK time, so a
    // switch that reuses this terminal needs no re-registration and cannot
    // stack a second provider.
    term.registerLinkProvider(
      createPathLinkProvider(term, () => ({ sessionName: targetSession.value })),
    ),
    // At-rest highlight for those same links, and the reason the hover layer
    // alone was not enough: the remote CLI colours and underlines its file
    // references itself, but only the FIRST row of a path its own wrapper
    // broke across rows — so the view at rest kept showing a path highlighted
    // halfway no matter what the hover reconstructs. This re-derives the
    // whole link on every row the renderer touches and blocks it in the
    // theme's own selection tint (terminalPathHighlights.ts).
    new PathHighlighter(
      term,
      () => ({ sessionName: targetSession.value }),
      () => terminalLinkTint(resolveTheme(settings.theme).terminal),
    ),
    // OSC 52 -> clipboard. The receiving half of the tmux gesture: an
    // ALT+drag (plain and Shift+drag select in THIS pane now —
    // terminalMouseSelection.ts) selects in tmux copy-mode, and releasing
    // yanks and dismisses the highlight, offering the text to this terminal
    // as `ESC ] 52 ; Pc ; Pt BEL`. A tmux keyboard yank (prefix+[ … y) arrives
    // the same way. Answering it is what turns either into a real copy; see
    // osc52.ts for what is refused. Bound once against the terminal's
    // lifetime, like everything else in this array — the handler reads no
    // per-session state.
    term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52SetClipboard(data);
      if (text) void copyToClipboard(text);
      return true;
    }),
  ];
  term.attachCustomKeyEventHandler(onCustomKey);
  // A plain drag must select in this pane even while the remote owns the
  // mouse — that ownership is exactly what made a selection's highlight
  // vanish under the hand (tmux dismissed it on drag-end), which the user
  // read as "I can't select code". Shift+drag selects here too — the older
  // muscle memory, and the grip that got the vanished highlight back when
  // the first fix handed Shift to tmux. terminalMouseSelection.ts documents
  // the private-API lever and the Alt hand-off to the remote. A patch that
  // could not apply is REPORTED rather than silent, because the failure shape
  // is an xterm upgrade silently handing the old vanishing gesture back.
  if (!forceLocalMouseSelection(term)) {
    recordDiagDetail(
      'terminal-selection',
      'could not force local mouse selection — xterm internals changed',
      { expected: '_core._selectionService.shouldForceSelection' },
    );
  }
  containerEl.value?.addEventListener('mousedown', onTerminalMouseDown, true);
  containerEl.value?.addEventListener('auxclick', onTerminalAuxClick, true);
  containerEl.value?.addEventListener('contextmenu', onTerminalContextMenu);
  document.addEventListener('mouseup', onDocumentMouseUp);

  await queueShowTarget();

  // Re-fit on window resize.
  window.addEventListener('resize', onWindowResize);
  if (typeof ResizeObserver !== 'undefined' && containerEl.value) {
    resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(containerEl.value);
  }
  // And watch for the far end moving the geometry under us. Every tick
  // re-checks visibility and liveness, so a hidden or closed pane costs
  // nothing but the timer's own tick.
  startProbing();
});

function onWindowResize(): void {
  scheduleFit();
}

/**
 * Fit once per animation frame. `fit()` writes to xterm's dimensions, which the
 * ResizeObserver can observe again — coalescing keeps that from looping and
 * keeps a drag-resize of the composer cheap.
 */
function scheduleFit(): void {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    // Skip degenerate geometry: a v-show'd pane measures 0 and fit() would
    // then push a 1x1 PTY at the remote.
    //
    // This guard carries far more weight now that INACTIVE session tabs stay
    // mounted behind a `v-show` instead of there being one pane. It is what
    // keeps a hidden tab from telling its tmux session it is two columns wide —
    // and a hidden tab is now the normal state of most of them.
    if (!containerEl.value?.clientHeight || !containerEl.value.clientWidth) {
      paneHidden = true;
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
    if (!plausibleGrid(fitAddon?.proposeDimensions())) {
      paneHidden = true;
      return;
    }
    const wasHidden = paneHidden;
    paneHidden = false;
    fitTerminal();
    // Coming back to a tab whose PTY the pool evicted to stay under the channel
    // budget. Re-joining on this EDGE rather than on the exit itself is what
    // keeps it from fighting the user: a session they exited on purpose stays
    // exited, because that pane never became hidden.
    if (wasHidden && shellGone) {
      shellGone = false;
      void queueShowTarget();
      return;
    }
    // Everything else routes through the one place that knows what the far end
    // has been told. `fit()` above may have changed nothing — a tab that comes
    // back at the size it was hidden at is the normal case — and that is
    // precisely when the old wiring sent nothing, because it only ever reacted
    // to xterm's own dimensions moving. On the hidden -> visible edge the
    // redraw is asked for too: tmux will not repaint a screen it thinks is
    // unchanged, and the stale band the user reported is exactly that.
    pushGeometry(wasHidden ? { redraw: true } : {});
  });
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  document.removeEventListener('mouseup', onDocumentMouseUp);
  containerEl.value?.removeEventListener('mousedown', onTerminalMouseDown, true);
  containerEl.value?.removeEventListener('auxclick', onTerminalAuxClick, true);
  containerEl.value?.removeEventListener('contextmenu', onTerminalContextMenu);
  stopProbing();
  stallMonitor?.dispose();
  stallMonitor = null;
  for (const d of termDisposables) d.dispose();
  termDisposables = [];
  closeShell();
  term?.dispose();
  term = null;
});

// Re-point the pane when the session key changes. Note this no longer says
// "re-open": main answers most of these by switching the tmux client that is
// already attached, and the PTY behind this terminal survives untouched.
/**
 * Font AND zoom settings are live: no restart, and no remount of this
 * component.
 *
 * THE REFIT IS NOT OPTIONAL. Changing the family or the size changes xterm's
 * cell size, so the grid it computed from the old cell is now wrong — rows get
 * clipped or a dead band opens under tmux's status line — and, worse, the PTY
 * on the far end is never told, so tmux keeps drawing to the old geometry.
 * That is the same class of failure as the sliced status line fixed in
 * 7d7cdad, arriving by a different route. Measured on this exact xterm
 * (6.0.0) rather than assumed: 16px -> 24px takes an 800x600 pane from 87x30
 * to 58x20 and the row box from 19px to 28px, and only after the fit.
 *
 * ZOOM gets there differently and still ends up here. A CSS pixel is
 * zoom-invariant, so the cell does NOT change size in CSS px — what changes is
 * how many of them fit, because the window's viewport in CSS px shrinks or
 * grows. The container's ResizeObserver does see that and would usually fit on
 * its own; zoom is watched anyway so the refit is a stated consequence of the
 * setting rather than a side effect of an observer two layers away. It costs
 * one coalesced fit.
 *
 * Reassigning the font options on a zoom-only change is free: xterm's
 * OptionsService compares before it fires, so an identical value is a no-op
 * and does not trigger a re-measure.
 *
 * `scheduleFit()` rather than a bare `fitAddon.fit()`: it coalesces to one fit
 * per frame, which also gives xterm a frame to re-measure the new cell, and it
 * skips the degenerate 0x0 measurement of a hidden pane that a bare fit would
 * push at the remote as a 1x1 terminal. (A pane hidden behind another tab is
 * exactly that case, and it needs no retry latch: `v-show` toggling back on is
 * itself a size change, so the ResizeObserver fires and fits with whatever the
 * settings became while it was hidden.) The resize reaches the shell through
 * the already-bound `term.onResize` handler — there is nothing extra to send.
 */
watch(
  () => [settings.monospaceFontFamily, settings.terminalFontSize, settings.zoomPercent] as const,
  ([family, size]) => {
    if (!term) return;
    term.options.fontFamily = resolveMonoStack(family);
    term.options.fontSize = size;
    scheduleFit();
  },
);

/**
 * Theme is live like the font settings above, and deliberately a SEPARATE
 * watcher: a palette changes no cell metrics, so this must not drag a refit
 * along with it. Folding it into the font watch would push a pointless resize
 * at the remote on every theme change.
 *
 * `resolveTheme` is reactive on the stored choice and, for `system`, on the OS
 * preference — so flipping Windows between light and dark retints the terminal
 * too. xterm repaints on the options assignment.
 */
watch(
  () => resolveTheme(settings.theme),
  (theme) => {
    if (!term) return;
    term.options.theme = theme.terminal;
  },
);
watch(
  () => props.sessionKey,
  () => {
    void queueShowTarget();
  },
);

/**
 * Re-attach when the CONNECTION changes underneath the pane, not only the
 * session. A reconnect after a dropped link mints a brand-new connectionId —
 * the store deliberately keeps the dead id alive through 'lost' so the `v-if`
 * gates hold these panes mounted and the scrollback survives — and the
 * workspace then passes the new id down as this prop. Without this watcher the
 * pane never noticed: `requestShell` reads `props.connectionId` only inside
 * `showTarget`, so the component sat on a shellId minted against the dead
 * connection forever, and the tab stayed frozen even though the link was back.
 *
 * `showTarget` is genuinely the whole fix, because it already handles every
 * shape this can take: main answers with a PTY on the NEW connection, which
 * can never equal the old `shellId`, so the "different PTY came back" branch
 * runs — unbind the dead streams, `reset()` the grid (the dead tmux client
 * never sent its mode-teardown, same reasoning as the reset in that branch),
 * adopt, rebind, re-register with the shells store, and push fresh geometry.
 * Nothing here needs to close the old shell first: it belonged to a connection
 * main has already torn down, and `showTarget` never closes before asking for
 * the same reason a session switch must not.
 */
watch(
  () => props.connectionId,
  () => {
    void queueShowTarget();
  },
);

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
function resyncDisplay(): void {
  fitTerminal();
  sent = null;
  pushGeometry({ redraw: true });
}

/**
 * How often a VISIBLE pane asks tmux what it believes about our geometry.
 * See {@link reconcileTick} for why this exists at all and what bounds its
 * cost.
 */
const GEOMETRY_PROBE_INTERVAL_MS = 5000;
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
 * pane per {@link HEALTHY_REPAIR_INTERVAL_MS}, which is the user's workaround,
 * automated, at a rate nobody pays for.
 */
const HEALTHY_REPAIR_INTERVAL_MS = 30_000;
/**
 * Consecutive `dead` probe answers required before the pane re-joins on its
 * own. Two: one bad answer is a network blip, and a re-join is seconds of
 * join not to be spent on one; two in a row means the tmux client is really
 * unreachable.
 */
const DEAD_TICKS_BEFORE_REJOIN = 2;
/** Minimum spacing between self-re-joins, so a dead host cannot get hammered. */
const REJOIN_MIN_INTERVAL_MS = 60_000;
/**
 * Re-join episodes allowed in a row without a single healthy probe answer in
 * between. A tmux server that is genuinely gone fails every re-join; without
 * this cap the pane would print its failure line and re-join every minute
 * forever.
 */
const MAX_CONSECUTIVE_REJOINS = 3;

/** The pending reconcile timer, when this pane is mounted. */
let probeTimer: ReturnType<typeof setInterval> | null = null;
/** True while a probe's round trip is in flight, so ticks cannot stack. */
let probeInFlight = false;
/** Consecutive `dead` answers on the current pane. */
let deadTicks = 0;
/** Epoch ms of the last repaint the loop decided to ask for. */
let lastRepairAt = 0;
/** True once an episode of another client driving the window has been repainted. */
let driftRepaintDone = false;
/** Re-join episodes since the last healthy probe answer. */
let rejoinStreak = 0;
/** Epoch ms of the last self-re-join, for {@link REJOIN_MIN_INTERVAL_MS}. */
let lastRejoinAt = 0;

/**
 * Watch the far end, repair what is ours, repaint what is not, and re-join
 * what is gone.
 *
 * ## Why this has to exist after all the wiring above
 *
 * Every route above reads true from the same assumption: before sending a
 * size we compare against {@link sent}, what the far end was last TOLD. Two
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
 * {@link REJOIN_MIN_INTERVAL_MS} and {@link MAX_CONSECUTIVE_REJOINS} so a
 * genuinely gone session cannot be hammered; a pane the user exited on purpose
 * never reaches here at all, because its channel is dead and `shellGone`
 * gates the tick.
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
async function reconcileTick(): Promise<void> {
  if (!term || !shellId || !fitAddon || shellGone) return;
  if (document.hidden) return;
  // A v-show'd pane measures 0. Same question scheduleFit asks, deliberately:
  // one definition of visible, wherever it is needed.
  if (!containerEl.value?.clientHeight || !containerEl.value.clientWidth) return;
  const id = shellId;
  if (probeInFlight) return;
  probeInFlight = true;
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
    probeInFlight = false;
  }
  // The round trip took real time; the tab may have switched targets, been
  // closed, or exited underneath the await. Any of those means the answer no
  // longer describes the pane on screen.
  if (!term || id !== shellId || shellGone) return;
  if (far.kind === 'bare') return; // not a tmux client of ours; nothing to check, ever
  if (far.kind === 'dead') {
    scheduleRejoin(id);
    return;
  }
  // An answer at all means the repair path is alive: any streak that led
  // here is over.
  deadTicks = 0;
  rejoinStreak = 0;
  const grid = { cols: term.cols, rows: term.rows };
  if (far.client.cols !== grid.cols || far.client.rows !== grid.rows) {
    // OUR side is wrong: the tty is not the grid we pushed. Re-push and
    // repaint — the repair that is unambiguously ours to make.
    resyncDisplay();
    lastRepairAt = Date.now();
    driftRepaintDone = false;
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
    if (!driftRepaintDone) {
      driftRepaintDone = true;
      lastRepairAt = Date.now();
      forget(api.shell.redraw(id));
    }
    return;
  }
  driftRepaintDone = false;
  // Healthy, and ours. Repaint on the clock: the garble no comparison catches.
  if (Date.now() - lastRepairAt >= HEALTHY_REPAIR_INTERVAL_MS) {
    lastRepairAt = Date.now();
    forget(api.shell.redraw(id));
  }
}

/**
 * The bounded automatic re-join: what the user did by hand ("connect to
 * another session then go back and connect again to the current one"), because
 * a fresh join is the only repair that re-initialises both ends of the stream.
 */
function scheduleRejoin(id: ShellId): void {
  deadTicks += 1;
  if (deadTicks < DEAD_TICKS_BEFORE_REJOIN) return;
  if (Date.now() - lastRejoinAt < REJOIN_MIN_INTERVAL_MS) return;
  if (rejoinStreak >= MAX_CONSECUTIVE_REJOINS) return;
  deadTicks = 0;
  lastRejoinAt = Date.now();
  rejoinStreak += 1;
  // The join's own attach repaints everything; do not double-repair behind it.
  lastRepairAt = Date.now();
  driftRepaintDone = false;
  paneWrite('\r\n\x1b[90m[PocketShell] lost the tmux client — rejoining…\x1b[0m\r\n');
  // Closing is what makes the next attach a FRESH JOIN: main drops the
  // pool record when the channel dies, so `attachSession` cannot answer
  // with the very client that just proved unreachable.
  forget(
    api.shell.close(id).then(() => {
      if (id !== shellId || !term) return; // the pane moved on meanwhile
      return queueShowTarget();
    }),
  );
}

function startProbing(): void {
  if (probeTimer !== null) return;
  // The clocked repaint counts from here, not from epoch zero: a pane that
  // mounts already owns a fresh attach's full repaint, and its first owed
  // one is a full interval away, not overdue.
  lastRepairAt = Date.now();
  probeTimer = setInterval(() => {
    void reconcileTick();
  }, GEOMETRY_PROBE_INTERVAL_MS);
}

function stopProbing(): void {
  if (probeTimer !== null) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

defineExpose({ focus: (): void => term?.focus(), resyncDisplay });
</script>

<template>
  <div
    ref="containerEl"
    class="terminal"
    :class="{ 'drop-target': dropActive }"
    @dragover="onTerminalDragOver"
    @dragleave="onTerminalDragLeave"
    @drop="onTerminalDrop"
  >
    <!-- The join veil. A child of the container rather than a sibling under a
         new wrapper so FitAddon's measurement of this box is untouched (its
         arithmetic reads the box the xterm element lands in). Absolutely
         positioned and pointer-transparent: it overlays the pane, passes
         clicks and keystrokes through to xterm, and disappears on the first
         remote byte. -->
    <div v-if="joinPending" class="join-veil" aria-live="polite">
      <AppIcon name="refresh" :size="16" class="spin" />
      <span>{{ targetSession ? `Joining ${targetSession}…` : 'Connecting…' }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * The padding lives on `.xterm`, NOT here, and that is load-bearing rather
 * than cosmetic.
 *
 * `App.vue` sets `* { box-sizing: border-box }`, so Chromium returns the
 * BORDER-box height from `getComputedStyle(el).height`. FitAddon then does,
 * in `proposeDimensions()`:
 *
 *     const h = parseInt(getComputedStyle(term.element.parentElement).height)
 *     const avail = h - (padding of term.element)
 *     rows = Math.floor(avail / cellHeight)
 *
 * It subtracts the padding of the element it OWNS, never the padding of the
 * parent it MEASURES. Under `content-box` those are the same number; under
 * `border-box` they are not. With the padding here, it read this box as 684px
 * while the content box was 668px, asked for 36 rows x 19px = 684px, and
 * overflowed by exactly the 16px of `--term-padding` — which `overflow:
 * hidden` then sliced off the bottom row, leaving 3px of tmux's status line.
 * That is the line the user reads constantly to know which session they are
 * in, so the failure was both invisible in code and loud on screen.
 *
 * Moving the padding onto the element FitAddon subtracts from makes its
 * arithmetic true again: 35 rows, 665px, status line whole, and the 8px inset
 * looks identical. The background stays HERE so the black still reaches the
 * container edges rather than leaving an unpainted frame.
 *
 * This is the classic FitAddon slicing defect ("confirm FitAddon runs after
 * final layout so the last row lands whole") and it long predates the
 * floating composer; the composer only moved the sliced row up off the window
 * edge, where it finally became obvious.
 */
.terminal {
  width: 100%;
  height: 100%;
  background: var(--term-bg);
  overflow: hidden;
  /* The veil's positioning context. Layout-inert — no size, padding or border
     changes — so the FitAddon arithmetic documented above still holds. */
  position: relative;
  /* Windows Terminal defaults.json: antialiasingMode "grayscale" */
  -webkit-font-smoothing: antialiased;
}
/* Says what the pane is doing while it waits for the far end's first byte:
   the join is a channel, a PTY and an attach, subjectively seconds on a real
   link, and a black rectangle reads as broken rather than as busy. One row,
   centred, muted — state, not an alarm. Pointer-transparent, so keystrokes
   aimed at the pane during the join are queued, not eaten. */
.join-veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  color: var(--fg-muted);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  pointer-events: none;
  background: var(--term-bg);
}
.join-veil .app-icon {
  color: var(--fg-secondary);
}
/* The file-drop affordance. An outline paints OUTSIDE layout, which matters
   here more than usual: FitAddon measures this box with getComputedStyle on
   every refit, and any border/padding borrowed to draw a frame would cost the
   pane a row. Same dashed treatment the composer's card lights up with. */
.terminal.drop-target {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
.terminal :deep(.xterm) {
  height: 100%;
  /* Windows Terminal defaults.json: padding "8, 8, 8, 8" */
  padding: var(--term-padding);
}
</style>
