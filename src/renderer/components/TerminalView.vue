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
// The MECHANICS of all of that — asking main for the PTY, adopting or
// switching it, binding the byte/exit streams, keeping the far end's geometry
// true, the parse-stall and drift repairs, the reconcile probe loop — live in
// src/renderer/terminalPane.ts, the pane's controller. This component owns
// what a view owns: the xterm instance and its addons, the DOM events,
// clipboard and drop gestures, the input policy, and the DECISIONS about when
// the PTY opens and closes (mount, unmount, session or connection change).
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
// The ask-then-adopt order in showTarget stays too. It costs nothing, and it
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
import AppIcon from './AppIcon.vue';
import { useShellsStore } from '../stores/shells';
import { createPathLinkProvider, createUrlLinkProvider } from '../terminalLinks';
import { PathHighlighter } from '../terminalPathHighlights';
import { decodeOsc52SetClipboard } from '../osc52';
import { forceLocalMouseSelection } from '../terminalMouseSelection';
import { useSettingsStore } from '../stores/settings';
import { resolveMonoStack } from '../fonts';
import { resolveTheme, terminalLinkTint } from '../themes';
import { isTypingKey } from '../../shared/composerText';
import { isShortcut } from '../../shared/shortcuts';
import { sessionIdentityKey } from '../sessionIdentity';
import { recordDiagDetail } from '../diag';
import { TerminalPane } from '../terminalPane';
import type { ConnectionId } from '../../shared/types';
import '@xterm/xterm/css/xterm.css';

// The PTY this component owns is published to the shells store so other
// surfaces — the prompt composer, first of all — can write to the same pane.
// The open/close DECISIONS deliberately stay with this component (the
// controller only executes them); see the header comment of stores/shells.ts
// for why.
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
   * The tmux session to display. Falls back to {@link sessionKey}. The
   * separate prop exists for the caller whose key is not a session name — the
   * folder workspace keys its panes by the workspace-qualified identity, so
   * main must not be asked to `switch-client` to something that is not a
   * session.
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
 * user pressed Ctrl+V at the terminal and meant it for the composer; what is
 * on the clipboard, whether it is stageable, and whether it is worth opening
 * the panel for are all questions the COMPOSER answers, because the composer
 * is where the answer is acted on. Reading the clipboard here and shipping
 * files or text across would put a second clipboard-to-attachment path in
 * this component, which is exactly what this feature was asked not to grow —
 * the composer's `onPaste` already owns that path. So this stays the same
 * shape as `typed`: a statement that a keystroke was withheld, not an
 * instruction about what to do with it.
 */
const emit = defineEmits<{
  (e: 'typed', text: string): void;
  (e: 'paste-into-composer'): void;
  (e: 'drop-into-composer', files: File[]): void;
}>();

/** The tmux session this pane should be showing, or '' for a bare shell. */
const targetSession = computed(() => props.sessionName ?? props.sessionKey ?? '');

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

const containerEl = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
/** View-side xterm disposables: link provider, highlighter, OSC 52 handler. */
let termDisposables: IDisposable[] = [];
/**
 * Set once the component is being torn down. The mount hook's continuation
 * after the join (`await pane.open()`) reads this: the join is seconds long —
 * an SSH channel, a login shell, an attach — and the workspace can tear the
 * pane down inside it, which releases the template refs and has already run
 * {@link onBeforeUnmount}. Resuming into `pane.observeContainer(null)` then
 * throws (`ResizeObserver: parameter 1 is not of type 'Element'`), leaks the
 * window resize listener, and re-arms a pane that no longer exists.
 */
let unmounted = false;

/** True between mousedown inside the terminal and the mouse-up that ends it. */
let selecting = false;

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

// The pane's PTY lifecycle controller. The getters keep the controller reading
// the props that are CURRENT whenever a join or repair runs, so a watcher
// re-point needs no re-wiring.
const pane = new TerminalPane({
  shells,
  getConnectionId: () => props.connectionId,
  getCommand: () => props.command,
  getTargetSession: () => targetSession.value,
  getRegistryKey: () => registryKey.value,
  getBackend: () => props.backend,
  getWorkspace: () => props.workspace,
  getAplexerId: () => props.aplexerId,
  isVisible: () => !!containerEl.value?.clientHeight && !!containerEl.value?.clientWidth,
  mayRestoreFocus: mayRestoreTerminalFocus,
});
/** Drives the join veil in the template; the controller arms and clears it. */
const joinPending = pane.joinPending;

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
// that delivered them, so the composer cannot re-read them the way it re-read
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
  // The one way any link leaves this pane: the system browser, through main's
  // allow-list, with the scheme checked here so a bad match never leaves the
  // renderer. Shared by the three layers that can carry an http(s) address —
  // the multi-row provider below, WebLinksAddon, and xterm's OSC 8 handler —
  // so all three keep saying the same thing about what a click opens.
  const openExternal = (uri: string): void => {
    if (!/^https?:\/\//i.test(uri)) return;
    window.open(uri, '_blank', 'noopener,noreferrer');
  };
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
      activate: (_event, uri) => openExternal(uri),
    },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Emoji measure two columns — in the buffer as well as in the font — before
  // the first output byte is parsed (terminalUnicode.ts).
  applyUnicode11Widths(term);
  // Web links that span rows, registered BEFORE WebLinksAddon below — the
  // opposite of the path provider's ordering, and for the mirror reason. A
  // URL the remote CLI's wrapper broke across rows reaches WebLinksAddon as
  // only its first-row fragment (`https://…/opik/`, underlined, opening a
  // truncated address); this provider reports the one whole-address link
  // reconstructed from the flattened line, and xterm's priority rule lets it
  // claim the fragment's cells. On single-row URLs it answers nothing, so
  // the addon keeps every line it always handled. (createUrlLinkProvider
  // documents the overlap arithmetic; terminalLinks.ts the joins that make
  // the address whole.)
  termDisposables = [term.registerLinkProvider(createUrlLinkProvider(term, openExternal))];
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
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)));
  term.open(containerEl.value!);
  // Hands the terminal to the controller: the initial fit, the parse-stall
  // monitor, and the byte/resize routes — bound ONCE against the terminal's
  // whole lifetime, across session re-points (terminalPane.ts documents why
  // per-shell binding leaked keystrokes).
  pane.attach(term, fitAddon, containerEl.value!);

  // Path links, registered AFTER WebLinksAddon above, deliberately: xterm
  // gives an EARLIER provider priority over a later one for the same cells
  // and drops intersecting lower-priority links, so a URL stays a web link
  // even if the path detector were fooled by one. It is not — terminalPaths
  // rejects any http(s) token before it peels anything, and a `file://`
  // token is a path for the Files tab, not a web link — but two
  // independent guarantees are worth having for a thing this easy to get
  // subtly wrong.
  //
  // Bound once, like everything else bound against the terminal here and for
  // the same reason: the session the pane shows is read through a getter at
  // CLICK time, so a switch that reuses this terminal needs no re-registration
  // and cannot stack a second provider.
  termDisposables.push(
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
  );
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

  await pane.open();

  // An unmount landed inside the join: the teardown hook below already ran,
  // and nothing here is this pane's business any more. See the `unmounted`
  // note by the declarations.
  if (unmounted) return;

  // Re-fit on window resize.
  window.addEventListener('resize', onWindowResize);
  pane.observeContainer(containerEl.value!);
  // And watch for the far end moving the geometry under us. Every tick
  // re-checks visibility and liveness, so a hidden or closed pane costs
  // nothing but the timer's own tick.
  pane.startProbing();
});

function onWindowResize(): void {
  pane.scheduleFit();
}

onBeforeUnmount(() => {
  unmounted = true;
  window.removeEventListener('resize', onWindowResize);
  document.removeEventListener('mouseup', onDocumentMouseUp);
  containerEl.value?.removeEventListener('mousedown', onTerminalMouseDown, true);
  containerEl.value?.removeEventListener('auxclick', onTerminalAuxClick, true);
  containerEl.value?.removeEventListener('contextmenu', onTerminalContextMenu);
  for (const d of termDisposables) d.dispose();
  termDisposables = [];
  pane.detach();
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
 * the bound `term.onResize` route — there is nothing extra to send.
 */
watch(
  () => [settings.monospaceFontFamily, settings.terminalFontSize, settings.zoomPercent] as const,
  ([family, size]) => {
    if (!term) return;
    term.options.fontFamily = resolveMonoStack(family);
    term.options.fontSize = size;
    pane.scheduleFit();
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
    void pane.open();
  },
);

/**
 * Re-attach when the CONNECTION changes underneath the pane, not only the
 * session. A reconnect after a dropped link mints a brand-new connectionId —
 * the store deliberately keeps the dead id alive through 'lost' so the `v-if`
 * gates hold these panes mounted and the scrollback survives — and the
 * workspace then passes the new id down as this prop. Without this watcher the
 * pane never noticed: the join reads `props.connectionId` only inside
 * showTarget, so the component sat on a shellId minted against the dead
 * connection forever, and the tab stayed frozen even though the link was back.
 *
 * showTarget is genuinely the whole fix, because it already handles every
 * shape this can take: main answers with a PTY on the NEW connection, which
 * can never equal the old `shellId`, so the "different PTY came back" branch
 * runs — unbind the dead streams, `reset()` the grid (the dead tmux client
 * never sent its mode-teardown, same reasoning as the reset in that branch),
 * adopt, rebind, re-register with the shells store, and push fresh geometry.
 * Nothing here needs to close the old shell first: it belonged to a connection
 * main has already torn down, and showTarget never closes before asking for
 * the same reason a session switch must not.
 */
watch(
  () => props.connectionId,
  () => {
    void pane.open();
  },
);

/** The menu's on-demand "put the pane and the far end back in agreement". */
function resyncDisplay(): void {
  pane.resyncDisplay();
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
