/**
 * Every keyboard chord this app claims, as DATA.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The user asked, in as many words: "i also want to see the shortcuts and make
 * them configurable because I asked you about them but I don't know what we
 * have". That is not a feature request so much as a bug report about the
 * repository. Chords accumulated one commit at a time — the clipboard pair,
 * then the typing intercept, then the composer's toggle and its size ladder,
 * then Ctrl+S/L/F in Files, then the zoom fix, then tab cycling — and each one
 * was justified in a comment beside the `if` that implemented it. Several were
 * chosen by asking "what is already taken?", and the answer to that question
 * lived in a conversation rather than anywhere a later reader could check it.
 * FilesView's own comment is the proof: it states that the composer's chords
 * "are not live on this tab, which hides the composer entirely", and that is
 * false — the composer registers its handler on `window` with `capture: true`
 * in `onMounted`, and the workspace keeps it MOUNTED behind a `v-show` while a
 * Files tab is showing, precisely so a tab switch cannot cost a draft. The
 * chord is live; only the panel it toggles is invisible. A mental map cannot
 * catch that. A table can.
 *
 * So: one module, one list, and every call site consults it. That is what makes
 * the Settings screen truthful rather than a second copy of the truth, and it
 * is what stops the NEXT chord being picked against a stale memory of this one.
 *
 * ---------------------------------------------------------------------------
 * WHAT A "CHORD" IS HERE
 * ---------------------------------------------------------------------------
 * `Ctrl` in this file always means Ctrl-OR-Command. Every existing call site
 * spells the test `e.ctrlKey || e.metaKey`, so there has never been a chord in
 * this app that distinguished them, and inventing the distinction now would
 * make the registry disagree with the code it is supposed to describe.
 * {@link formatChordParts} renders it as `Cmd` on macOS purely for display.
 *
 * Matching is on `KeyboardEvent.key`, not on `code`, for the reason spelled out
 * at length in `src/shared/zoomKeys.ts`: `key` is the character the user's
 * LAYOUT actually produced, and matching physical positions turns an unrelated
 * character into a shortcut the moment somebody uses a non-US keyboard. The one
 * documented exception in this app — the numeric keypad's `+`/`-`/`0` — belongs
 * to the zoom matcher, which is a main-process concern and stays there; this
 * registry names those chords for the LIST without claiming to be their
 * implementation. See {@link ShortcutSpec.owner}. The one CHARACTER alias —
 * Russian Ё folding to `` ` `` — works in mirror image and is
 * {@link LAYOUT_ALIASES}'s to explain.
 *
 * ---------------------------------------------------------------------------
 * THE SHIFTED-PUNCTUATION CAVEAT, STATED RATHER THAN HIDDEN
 * ---------------------------------------------------------------------------
 * Because matching is on `key`, Shift changes the key of a punctuation chord:
 * Ctrl+Shift+` arrives as `{ key: '~', shift: true }`, not as
 * `{ key: '`', shift: true }`. A chord captured from a real keypress therefore
 * round-trips exactly — capture and match read the same field — but a chord
 * TYPED into a config file as `Ctrl+Shift+\`` would never fire. That is why the
 * rebinding UI captures a keypress instead of accepting typed text, and why
 * {@link parseChord} is tolerant rather than clever: it is a loader for values
 * this app produced, not a parser for a keybinding language.
 */

/**
 * The screens a chord can belong to.
 *
 * These are not "components". They are the answer to one question — while the
 * user is looking at X, which chords are live? — because that is the question
 * conflict detection has to answer, and a component tree does not answer it
 * (see {@link surfacesCollide}).
 */
export type ShortcutSurface = 'global' | 'workspace' | 'terminal' | 'composer' | 'files' | 'doodle';

/** Display order and prose for each surface, for the Settings list. */
export interface SurfaceSpec {
  id: ShortcutSurface;
  label: string;
  /** One sentence saying WHEN these chords are live. */
  blurb: string;
}

export const SURFACES: readonly SurfaceSpec[] = [
  {
    id: 'global',
    label: 'Everywhere',
    blurb:
      'Live on every screen, including the host list before anything is connected. Recognised in the main process, before the page sees the key.',
  },
  {
    id: 'workspace',
    label: 'Tabs',
    blurb:
      'The tab bar of a folder or host workspace. Caught by one window-level handler in capture, so the chord works with focus in the terminal, the file tree or the composer alike.',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    blurb:
      'A session pane with focus. Everything not listed here reaches the shell untouched — that is the default, and it is the point.',
  },
  {
    id: 'composer',
    label: 'Prompt composer',
    blurb:
      'The composer panel. Its toggles listen on the window rather than on the panel, so they stay live while the panel is closed — that is how you open it.',
  },
  {
    id: 'files',
    label: 'Files',
    blurb: 'The Files tab: the tree, the path bar and the open file.',
  },
  {
    id: 'doodle',
    label: 'Annotate',
    blurb: 'The drawing surface that opens over the composer.',
  },
] as const;

/**
 * Which surfaces are live AT THE SAME TIME.
 *
 * "Two commands on one chord in the same surface must be refused" is only a
 * usable rule once "same surface" is defined, and in this app the surfaces
 * genuinely overlap:
 *
 *   - The composer FLOATS OVER the terminal. Both are live together; that is
 *     the entire design of the panel.
 *   - The composer is also live on the FILES TAB, which is the finding that
 *     started this module. `FolderWorkspaceView` mounts it once, outside the
 *     tab body, behind a `v-show` — so its window-level capture handler keeps
 *     running while Files is showing. FilesView's comment says otherwise; the
 *     comment is wrong and the call-site diff corrects it.
 *   - The Files tab has NO terminal — the panes are hidden, and nothing routes
 *     a key to xterm — so `Ctrl+S` can save a file there while staying XOFF at
 *     a shell. That asymmetry is the reason this is a graph and not a flat
 *     "everything collides with everything".
 *   - Tab chords are handled by ONE window listener in capture, not by the
 *     terminal's custom key handler — that is the only way a single
 *     implementation serves the terminal, the Files tree and the composer
 *     alike, and it is why they work on a Files tab at all. They still
 *     collide with terminal chords, because a tab chord fires while a
 *     terminal is showing and both would claim the keystroke.
 *   - The annotate surface opens over the composer and covers it, but the
 *     composer's window handler is still attached underneath.
 *
 * The relation is symmetric and reflexive; `tests/unit/shortcuts.test.ts`
 * proves both, because an asymmetric collision table would refuse a binding in
 * one direction and allow it in the other, which is worse than no check at all.
 */
const SURFACE_COLLISIONS: Record<ShortcutSurface, readonly ShortcutSurface[]> = {
  global: ['global', 'workspace', 'terminal', 'composer', 'files', 'doodle'],
  workspace: ['global', 'workspace', 'terminal', 'composer', 'files'],
  terminal: ['global', 'workspace', 'terminal', 'composer'],
  composer: ['global', 'workspace', 'terminal', 'composer', 'files', 'doodle'],
  files: ['global', 'workspace', 'composer', 'files'],
  doodle: ['global', 'composer', 'doodle'],
};

/** Whether two surfaces can be live at the same moment. @see SURFACE_COLLISIONS */
export function surfacesCollide(a: ShortcutSurface, b: ShortcutSurface): boolean {
  return SURFACE_COLLISIONS[a].includes(b);
}

/**
 * Surfaces where a keystroke can end up in front of a shell.
 *
 * Everything that collides with `terminal` qualifies, which is exactly the set
 * that must not be allowed to swallow SIGINT — see {@link RESERVED_CHORDS}.
 */
function reachesAShell(surface: ShortcutSurface): boolean {
  return surfacesCollide(surface, 'terminal');
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

/**
 * One chord. `ctrl` is Ctrl-or-Command; see the file header.
 *
 * Frozen at construction so a chord handed out of the registry cannot be
 * mutated by a consumer into something the registry never validated.
 */
export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The canonical key token. @see canonicalKey */
  key: string;
}

/**
 * The subset of `KeyboardEvent` a chord is read from. Structural so the rules
 * can be tested without a DOM, exactly as `ZoomKeyInput` is.
 */
export interface ChordKeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Characters that canonicalise to another key's token, because the layout
 * prints a different character on the same keycap.
 *
 * One entry, and the reason it is not the position-matching mistake the file
 * header warns about: on the Russian ЙЦУКЕН layout the backquote key prints
 * Ё — the keycap is engraved ё — so a Russian user pressing the VS Code panel
 * chord produces `Ctrl+Ё`, and no other key on that layout produces
 * `` Ctrl+` ``. Matching the character as reported would leave the app's most
 * pressed chord dead there; folding the character into the token of the keycap
 * it belongs to keeps matching, capture and parse on one vocabulary. It also
 * means the rebinding field — which captures through the same function —
 * stores `Ctrl+\`` for a Ё keypress: one spelling per chord, not one per
 * layout.
 *
 * The list stops there on purpose. Aliasing Cyrillic LETTERS to the Latin
 * letters printed at the same positions (а→F, …) WOULD be position matching
 * wearing a disguise: it turns unrelated typing into shortcuts, which is the
 * exact failure `key`-matching exists to avoid. Ё qualifies because its US
 * counterpart is a punctuation key with no letter of its own, so the alias
 * takes nothing away — no binding holds Ё, and nothing else changes meaning.
 */
const LAYOUT_ALIASES: Readonly<Record<string, string>> = {
  Ё: '`',
};

/**
 * The canonical spelling of a key token.
 *
 * Letters are upper-cased because a browser reports `v` or `V` for the same
 * physical key depending on Shift and Caps Lock, and the existing call sites
 * already test both spellings by hand (`e.key === 'V' || e.key === 'v'`). A bare
 * space becomes `Space` so a chord string can use `+` as its separator without a
 * token that is invisible in a config file. Named keys keep the DOM's own
 * spelling — `Escape`, `ArrowUp`, `Backspace` — so there is one vocabulary
 * rather than a translation layer nobody can remember the direction of.
 * Layout-printed stand-ins fold last, after the upper-case has had its turn —
 * {@link LAYOUT_ALIASES}.
 */
export function canonicalKey(key: string): string {
  if (key === ' ' || key === 'Space' || key === 'Spacebar') return 'Space';
  // `Array.from` rather than `.length`, so an astral character counts as one
  // and is not truncated into half a surrogate pair.
  const chars = Array.from(key);
  if (chars.length === 1) {
    const upper = key.toUpperCase();
    return LAYOUT_ALIASES[upper] ?? upper;
  }
  return key;
}

/** A chord from a real key event. Ctrl and Cmd are the same modifier here. */
export function chordFromEvent(e: ChordKeyInput): Chord {
  return Object.freeze({
    ctrl: e.ctrlKey === true || e.metaKey === true,
    alt: e.altKey === true,
    shift: e.shiftKey === true,
    key: canonicalKey(e.key),
  });
}

/**
 * A chord's stored spelling: modifiers in a fixed order, then the key.
 *
 * Fixed order is what makes the string a KEY rather than a rendering —
 * `Ctrl+Shift+V` and `Shift+Ctrl+V` are one chord, and two spellings of it
 * would be two entries in an override map and a conflict check that missed
 * them.
 */
export function chordToString(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(chord.key);
  return parts.join('+');
}

/**
 * Read a stored chord back, or `null` for anything this build cannot trust.
 *
 * Deliberately narrow. This parses values THIS APP WROTE — the defaults below
 * and whatever the capture field produced — out of user-writable JSON on disk.
 * It is not a keybinding language, so an unknown modifier name, a missing key
 * or a duplicate modifier is simply rejected rather than guessed at. A rejected
 * override costs that one binding its custom chord and nothing else; see the
 * settings store's per-entry degradation.
 */
export function parseChord(raw: string): Chord | null {
  if (typeof raw !== 'string') return null;
  // A lone `+` is a legal key token, so the split cannot be naive: peel the
  // modifiers off the front and treat the whole remainder as the key.
  let rest = raw.trim();
  if (rest === '') return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (;;) {
    const plus = rest.indexOf('+');
    // No separator left, or the separator IS the key (`Ctrl++`): stop peeling.
    if (plus <= 0) break;
    const head = rest.slice(0, plus);
    const lower = head.toLowerCase();
    if (lower === 'ctrl' || lower === 'cmd' || lower === 'control' || lower === 'command') {
      if (ctrl) return null;
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option') {
      if (alt) return null;
      alt = true;
    } else if (lower === 'shift') {
      if (shift) return null;
      shift = true;
    } else {
      // Not a modifier, so this is the key and it contained a `+`. That is not
      // a spelling this app produces.
      return null;
    }
    rest = rest.slice(plus + 1);
  }
  if (rest === '') return null;
  return Object.freeze({ ctrl, alt, shift, key: canonicalKey(rest) });
}

/** Whether a key event is this chord. */
export function chordMatches(chord: Chord, e: ChordKeyInput): boolean {
  const pressed = chordFromEvent(e);
  return (
    pressed.ctrl === chord.ctrl &&
    pressed.alt === chord.alt &&
    pressed.shift === chord.shift &&
    pressed.key === chord.key
  );
}

/**
 * How a key token is SHOWN, which is not how it is stored.
 *
 * Arrow keys are spelled out as words rather than drawn as `↑`/`↓`, and that is
 * a rule with a test behind it: `tests/unit/designGates.test.ts` bans glyphs
 * doing an icon's job in renderer templates, with a single grandfathered
 * exemption for the composer's `Ctrl+Shift+↑` tooltip copy. A shortcut list is
 * the exact place that exemption would be quietly widened into a habit, so this
 * one says "Up". It also reads better in a `<kbd>` chip, which is what the
 * Settings list renders each part as.
 */
const KEY_LABELS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Del',
  Tab: 'Tab',
  Space: 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/**
 * The chord as a list of parts, one per `<kbd>` chip.
 *
 * A list rather than a string because the Settings screen styles each key
 * separately; joining here and splitting there would put the separator in two
 * places. `mac` renders the Ctrl-or-Command modifier as `Cmd`, which is display
 * only — the stored spelling stays `Ctrl` on every platform, so a settings file
 * copied between machines keeps working.
 */
export function formatChordParts(chord: Chord, mac = false): string[] {
  const parts: string[] = [];
  if (chord.ctrl) parts.push(mac ? 'Cmd' : 'Ctrl');
  if (chord.alt) parts.push(mac ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(KEY_LABELS[chord.key] ?? chord.key);
  return parts;
}

/** One-line spelling, for prose, titles and test failure messages. */
export function formatChord(chord: Chord, mac = false): string {
  return formatChordParts(chord, mac).join('+');
}

// The registry data lives in shortcutTable.ts; these re-exports keep the
// one-import surface every chord handler already reads (the same move
// sessionName.ts made when its parts split).
export { SHORTCUTS, shortcutById, shortcutIds, shortcutsForSurface, type ShortcutSpec } from './shortcutTable';
import { SHORTCUTS, shortcutById } from './shortcutTable';

// ---------------------------------------------------------------------------
// What may not be bound, and why
// ---------------------------------------------------------------------------

/**
 * Chords a user must never be able to take away from their own shell.
 *
 * These are refused on every surface a terminal can be behind
 * ({@link reachesAShell}) and permitted elsewhere — `Ctrl+S` is the case that
 * proves the rule, since it is XOFF at a shell and Save on the Files tab, which
 * has no shell.
 *
 * All of them are BARE Ctrl chords, and that is not an oversight: a terminal
 * encodes Ctrl+letter as a single control byte and has no way to express
 * Ctrl+SHIFT+letter at all, which is why every app chord in this repo that sits
 * next to a terminal wears Shift. Ctrl+Shift+C is therefore fine while Ctrl+C
 * is not, and the two are genuinely different keys as far as the shell is
 * concerned.
 *
 * The list is deliberately short. It covers being unable to STOP, EXIT, SUSPEND
 * or UNFREEZE a program, and being unable to reach tmux at all — the four ways
 * a user gets locked out of their own session with no keyboard route back.
 * Keys that merely annoy (Ctrl+R’s reverse search, Ctrl+U’s kill-line)
 * are not here: refusing those would be this app deciding how somebody edits
 * their command line.
 */
export const RESERVED_CHORDS: readonly { chord: string; why: string }[] = [
  {
    chord: 'Ctrl+C',
    why: 'SIGINT when nothing is selected — the only way to stop a running program. With a selection the pane copies instead, which is fixed (terminal.ctrlCCopiesSelection), and no rebindable command may take the chord either way.',
  },
  { chord: 'Ctrl+D', why: 'End of input — the only way to exit a shell or a REPL.' },
  { chord: 'Ctrl+Z', why: 'SIGTSTP — suspends the foreground job.' },
  { chord: 'Ctrl+B', why: 'tmux’s default prefix. Without it there is no tmux.' },
  {
    chord: 'Ctrl+A',
    why: 'The other tmux prefix in common use, and readline’s beginning-of-line.',
  },
  { chord: 'Ctrl+\\', why: 'SIGQUIT — the stop that works when SIGINT does not.' },
  {
    chord: 'Ctrl+S',
    why: 'XOFF. Freezes the terminal, and Ctrl+Q is the only way back.',
  },
  { chord: 'Ctrl+Q', why: 'XON — the way back out of a frozen terminal.' },
] as const;

/**
 * Accelerators Electron's DEFAULT application menu binds, split by whether the
 * renderer can take them back.
 *
 * This app builds no menu, so every one of these is live and none of them was
 * declared here. Read out of the shipped binary rather than remembered
 * (`electron 33.3.1`, `node_modules/electron/dist/electron.exe`).
 *
 * The split is the useful part, and it is the difference between two bug
 * classes this repo has already paid for:
 *
 *   - EDITING roles (`undo`, `redo`, `cut`, `copy`, `paste`,
 *     `pasteAndMatchStyle`, `selectAll`) act on whatever holds focus, and a
 *     cancelled keydown suppresses them. That is measured, not assumed: it is
 *     exactly what `preventDefault()` fixed in the doubled-paste bug. So these
 *     are BINDABLE, with the standing requirement that the handler cancels the
 *     event.
 *   - WINDOW and APP roles (`close`, `quit`, `minimize`, `reload`,
 *     `forceReload`, `toggleDevTools`, `togglefullscreen`) are handled by the
 *     menu itself, and `preventDefault()` in the renderer does not reach it.
 *     Binding an app command to one of these gets you the command AND the role
 *     — the window closes, the page reloads — so they are refused.
 *   - ZOOM roles are a third case: the app already disarmed them from the main
 *     process, and the chords now belong to `zoom.in`/`zoom.out`/`zoom.reset`.
 *     Refused because they are taken, not because they cannot work.
 */
export const MENU_CLAIMED_UNSUPPRESSIBLE: readonly { chord: string; role: string }[] = [
  { chord: 'Ctrl+W', role: 'close — shuts the window. readline wants it for delete-word.' },
  { chord: 'Ctrl+Q', role: 'quit — exits the app.' },
  { chord: 'Ctrl+M', role: 'minimize.' },
  { chord: 'Ctrl+R', role: 'reload — throws away the whole renderer, terminals included.' },
  { chord: 'Ctrl+Shift+R', role: 'forceReload.' },
  { chord: 'Ctrl+Shift+I', role: 'toggleDevTools.' },
  { chord: 'F12', role: 'toggleDevTools.' },
  { chord: 'F11', role: 'togglefullscreen.' },
] as const;

/** Menu roles a cancelled keydown DOES suppress. Bindable; see the note. */
export const MENU_CLAIMED_SUPPRESSIBLE: readonly { chord: string; role: string }[] = [
  { chord: 'Ctrl+Z', role: 'undo' },
  { chord: 'Ctrl+Y', role: 'redo' },
  { chord: 'Ctrl+X', role: 'cut' },
  { chord: 'Ctrl+C', role: 'copy' },
  { chord: 'Ctrl+V', role: 'paste' },
  { chord: 'Ctrl+Shift+V', role: 'pasteAndMatchStyle' },
  { chord: 'Ctrl+A', role: 'selectAll' },
] as const;

/**
 * Chords the zoom commands already own.
 *
 * Both spellings of the shifted `=` are here — `Ctrl+Shift+=` as a config file
 * would write it, `Ctrl+Shift++` as a real keypress reports it — because Shift
 * changes `key` for punctuation and the capture field produces the second one.
 * Missing that is how a user would be allowed to bind something to a chord that
 * then silently lost to zoom.
 */
const ZOOM_OWNED = new Set([
  'Ctrl+=',
  'Ctrl++',
  'Ctrl+Shift+=',
  'Ctrl+Shift++',
  'Ctrl+-',
  'Ctrl+0',
]);

/**
 * Keys whose modifiers xterm folds into a CSI parameter rather than dropping.
 *
 * This is the set that makes `Ctrl+Shift+<arrow>` a REAL key at a terminal:
 * `evaluateKeyboardEvent` reaches `case 38` long before any ctrl branch and
 * emits `ESC [ 1 ; <mods+1> A`, so Ctrl+Shift+Up is `ESC [ 1 ; 6 A`, which vim
 * and tmux both read.
 */
const CSI_MODIFIED_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
  'Insert',
]);

/**
 * Whether a terminal could have encoded this chord at all.
 *
 * Not a refusal — an ANNOTATION. A chord a shell can never receive is a chord
 * this app can claim for free, and saying so beside a binding answers the first
 * question a terminal user has when an app takes a Ctrl chord: what did I just
 * lose?
 *
 * ---------------------------------------------------------------------------
 * THE PREMISE THIS FUNCTION WAS ASKED TO ENCODE IS FALSE, AND SAYING SO IS THE
 * POINT OF HAVING IT IN CODE
 * ---------------------------------------------------------------------------
 * The tab chords were briefed as affordable because "terminals cannot encode
 * most Ctrl+digit or Ctrl+Tab". Measured against the xterm this app actually
 * ships — @xterm/xterm 6, `src/common/input/Keyboard.ts::evaluateKeyboardEvent`
 * — that is not true:
 *
 *   - `Ctrl+Tab` is `HT`. `case 9` is reached before the ctrl branch and is
 *     gated only on Shift, so Ctrl is simply ignored: Tab produces `	` and
 *     Ctrl+Shift+Tab produces `ESC [ Z`. At a shell prompt that is completion.
 *   - `Ctrl+3`..`Ctrl+8` are C0 controls — keyCodes 51-55 map to
 *     `ESC`, `FS`, `GS`, `RS`, `US`, and 56 to `DEL`. `Ctrl+3` in particular is
 *     a widely used stand-in for Escape. Only `Ctrl+1`, `Ctrl+2` and `Ctrl+9`
 *     genuinely encode nothing.
 *   - `Ctrl+Shift+<arrow>` is a modified CSI sequence, not nothing.
 *   - `Ctrl+Shift+2` is `@` is `NUL`, and `Ctrl+Shift+-` is `_` is `US` — those
 *     two run in a branch matched on the CHARACTER, after Shift has changed it.
 *     `zoomKeys.ts` already refuses `Ctrl+Shift+-` as a zoom-out spelling for
 *     exactly this reason.
 *
 * What IS free is `Ctrl+Shift+<letter>`: every branch that could encode it
 * demands `!ev.shiftKey`, and the character fallback demands `!ev.ctrlKey`. So
 * the app's Shift-wearing chords cost the shell nothing, and the tab chords do
 * cost it something. Both facts belong in the list rather than in a belief.
 *
 * Answered for the `Ctrl` spelling, which is the conservative one: xterm's ctrl
 * branch tests `ctrlKey` specifically, so the Cmd spelling of the same chord
 * encodes less, never more.
 */
export function terminalCanEncode(chord: Chord): boolean {
  const key = chord.key;

  // Encoded whatever is held: the modifier never reaches the branch.
  if (key === 'Tab' || key === 'Enter' || key === 'Escape' || key === 'Backspace') return true;
  // Modifiers folded into a CSI parameter. @see CSI_MODIFIED_KEYS
  if (CSI_MODIFIED_KEYS.has(key)) return true;
  if (/^F([1-9]|1[0-2])$/.test(key)) return true;

  // Alt is Meta: an ESC prefix in front of whatever the key would have been.
  if (chord.alt) return true;

  if (!chord.ctrl) return false;

  // Matched on the character, so Shift does not save these two.
  if (key === '_' || key === '@') return true;

  // Everything below is the ctrl branch, which is gated on Shift being absent —
  // which is the whole reason every app chord next to a terminal wears Shift.
  if (chord.shift) return false;
  if (key === 'Space') return true;
  if (key.length !== 1) return false;
  // A-Z -> ^A..^Z; 3-8 -> ESC FS GS RS US DEL; [ \ ] -> ESC FS GS.
  return /[A-Z3-8[\\\]]/.test(key);
}

/** Why a binding was refused. `kind` is what the UI switches on. */
export type BindingRefusal =
  | { kind: 'unknown'; message: string }
  | { kind: 'locked'; message: string }
  | { kind: 'no-modifier'; message: string }
  | { kind: 'modifier-only'; message: string }
  | { kind: 'reserved'; message: string }
  | { kind: 'menu'; message: string }
  | { kind: 'conflict'; message: string; withId: string };

/** Key tokens that are only ever a modifier — not a chord on their own. */
const MODIFIER_KEYS = new Set(['CONTROL', 'SHIFT', 'ALT', 'META', 'OS', 'ALTGRAPH', 'CAPSLOCK']);

/**
 * Whether [chord] may be bound to [id], given every other binding in force.
 *
 * Returns `null` for "yes". The refusals are ordered from the most specific
 * cause to the least, so a chord that is both reserved AND already taken is
 * reported as reserved — the user needs the reason they cannot have it at all,
 * not a suggestion that freeing the other binding would help.
 *
 * [inForce] is the RESOLVED map — defaults with overrides applied — not the
 * defaults, because a conflict against a chord the user already moved away from
 * is not a conflict.
 */
export function validateBinding(
  id: string,
  chord: Chord,
  inForce: ReadonlyMap<string, readonly Chord[]>,
): BindingRefusal | null {
  const spec = shortcutById(id);
  if (!spec) return { kind: 'unknown', message: `No shortcut is called ${id}.` };
  if (!spec.rebindable) {
    return {
      kind: 'locked',
      message:
        spec.owner === 'main'
          ? 'This chord is recognised in the main process, before the page sees the key, so it cannot be changed from here.'
          : spec.owner === 'library'
            ? 'This belongs to the editor’s own keymap, not to PocketShell.'
            : 'This one is fixed. See the note beside it for why.',
    };
  }

  if (MODIFIER_KEYS.has(chord.key.toUpperCase())) {
    return { kind: 'modifier-only', message: 'That is a modifier on its own. Hold it and press a key.' };
  }

  const spelling = chordToString(chord);

  if (ZOOM_OWNED.has(spelling)) {
    return {
      kind: 'menu',
      message: `${formatChord(chord)} is one of the zoom chords, which the main process handles before the page sees the key.`,
    };
  }

  const menu = MENU_CLAIMED_UNSUPPRESSIBLE.find((entry) => entry.chord === spelling);
  if (menu) {
    return {
      kind: 'menu',
      message: `Electron’s built-in menu owns ${formatChord(chord)} (${menu.role}) and the page cannot take it back — you would get both.`,
    };
  }

  // Checked AFTER the menu, so `F12` is reported as "the menu owns it" rather
  // than as "add a modifier" — which would be true, useless, and would send the
  // user off to try Ctrl+F12, which the menu also owns.
  //
  // Every rebindable binding sits on a surface where SOMETHING else wants the
  // keyboard — a shell, a text box, a tree. A chord with no Ctrl and no Alt is
  // therefore not a shortcut, it is a keystroke being stolen from whatever the
  // user is typing into.
  if (!chord.ctrl && !chord.alt) {
    return {
      kind: 'no-modifier',
      message: 'A shortcut needs Ctrl or Alt. Without one it would swallow ordinary typing.',
    };
  }

  if (reachesAShell(spec.surface)) {
    const reserved = RESERVED_CHORDS.find((entry) => entry.chord === spelling);
    if (reserved) {
      return {
        kind: 'reserved',
        message: `${formatChord(chord)} belongs to the shell: ${reserved.why}`,
      };
    }
    // Alt+letter is how a terminal spells Meta — it sends ESC then the letter,
    // which readline and every Emacs-flavoured editor read as a real key.
    if (chord.alt && !chord.ctrl) {
      return {
        kind: 'reserved',
        message: 'A bare Alt chord is Meta at a terminal — it sends ESC and the key, which programs read. Add Ctrl.',
      };
    }
  }

  const clash = conflictingBinding(id, chord, inForce);
  if (clash) {
    const other = shortcutById(clash)!;
    return {
      kind: 'conflict',
      withId: clash,
      message: `${formatChord(chord)} is already ${other.label} (${surfaceLabel(other.surface)}), and both are live at the same time.`,
    };
  }

  return null;
}

/**
 * The id of a binding that already holds [chord] somewhere [id] can be pressed,
 * or null.
 *
 * Split out of {@link validateBinding} so the same rule answers two questions.
 * The UI asks "may the user set this?", which stops at the first refusal and
 * never reaches the conflict check for a locked binding. The test suite asks
 * "do the SHIPPED defaults collide?", which has to run over every pair
 * including the locked ones — and that is the check that would have caught a
 * chord being chosen against a stale mental map, which is the whole reason this
 * module exists.
 */
export function conflictingBinding(
  id: string,
  chord: Chord,
  inForce: ReadonlyMap<string, readonly Chord[]>,
): string | null {
  const spec = shortcutById(id);
  if (!spec) return null;
  const spelling = chordToString(chord);
  for (const [otherId, chords] of inForce) {
    if (otherId === id) continue;
    const other = shortcutById(otherId);
    if (!other) continue;
    if (!surfacesCollide(spec.surface, other.surface)) continue;
    // Two rungs of one ladder share a chord on purpose. @see ShortcutSpec.ladders
    if (spec.ladders?.some((rung) => other.ladders?.includes(rung)) === true) continue;
    if (!chords.some((c) => chordToString(c) === spelling)) continue;
    return otherId;
  }
  return null;
}

/** The prose name of a surface, for a message. */
export function surfaceLabel(surface: ShortcutSurface): string {
  return SURFACES.find((s) => s.id === surface)?.label ?? surface;
}

/**
 * The registry's own defaults, parsed.
 *
 * Parsing rather than hand-building the objects means the default strings go
 * through the same loader a stored override does, so a typo in a default is a
 * failing test rather than a chord that silently never fires.
 * `tests/unit/shortcuts.test.ts` asserts every default parses and that the
 * defaults do not conflict with each other.
 */
export function defaultBindings(): Map<string, Chord[]> {
  const out = new Map<string, Chord[]>();
  for (const spec of SHORTCUTS) {
    const chords: Chord[] = [];
    for (const raw of spec.defaults) {
      const chord = parseChord(raw);
      if (chord) chords.push(chord);
    }
    out.set(spec.id, chords);
  }
  return out;
}

/**
 * Defaults with the user's overrides applied, per binding.
 *
 * An override REPLACES a binding's chords rather than adding to them. Every
 * rebindable entry has exactly one default, so there is nothing to merge; and a
 * user who moved a chord means the old one is free, which is the answer conflict
 * detection needs.
 *
 * Degradation is per ENTRY, like every other collection this app stores: an
 * override naming an id this build dropped, or a chord that no longer validates
 * because the registry gained a conflicting binding, falls back to that one
 * default and leaves the rest of the map alone.
 */
export function resolveBindings(overrides: Readonly<Record<string, string>>): Map<string, Chord[]> {
  const resolved = defaultBindings();
  for (const [id, raw] of Object.entries(overrides)) {
    const spec = shortcutById(id);
    if (!spec || !spec.rebindable) continue;
    const chord = parseChord(raw);
    if (!chord) continue;
    // Validated against the map AS IT IS BEING BUILT, so two overrides that
    // collide with each other cannot both land. The first one wins, which is
    // arbitrary but stable — and the UI refuses the second at the moment it is
    // set, so reaching this line at all means the file was hand-edited.
    if (validateBinding(id, chord, resolved)) continue;
    resolved.set(id, [chord]);
  }
  return resolved;
}

/**
 * The chords in force for one binding, for a call site.
 *
 * This is the function every `if (e.ctrlKey && e.key === 'x')` in the app is
 * meant to become. Falls back to the defaults for an id the caller resolved
 * before the store was ready, so a handler can never end up with NO binding and
 * silently stop working.
 */
export function chordsFor(bindings: ReadonlyMap<string, readonly Chord[]>, id: string): readonly Chord[] {
  const found = bindings.get(id);
  if (found && found.length > 0) return found;
  return defaultBindings().get(id) ?? [];
}

/**
 * Whether a key event is the binding [id].
 *
 * The shape every call site wants: one call, no chord spelled inline, and the
 * registry is the only place that knows what the chord is.
 */
export function isShortcut(
  bindings: ReadonlyMap<string, readonly Chord[]>,
  id: string,
  e: ChordKeyInput,
): boolean {
  return chordsFor(bindings, id).some((chord) => chordMatches(chord, e));
}
