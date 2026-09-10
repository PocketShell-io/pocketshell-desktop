/**
 * The shortcut registry as DATA: one row per binding, with its id, surface,
 * owner, user-facing label, and default chords.
 *
 * The id doubles as the localStorage override key, so ids may not be renamed.
 * Everything that READS or VALIDATES this table — overrides, collision
 * checks, the reservation lists — lives in shortcuts.ts, which imports it
 * from here; the data and the engine are separate because the table is read
 * top to bottom when the settings screen is built and the engine is not.
 */

import type { ShortcutSurface } from './shortcuts';

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Who actually implements a binding. This is the honest half of "configurable":
 * a chord recognised in the main process cannot read the renderer's
 * localStorage, and a chord owned by a third-party keymap is not ours to move.
 */
type ShortcutOwner =
  /** A renderer handler that reads this registry. Rebindable. */
  | 'app'
  /** `before-input-event` in the main process. Listed, not rebindable. */
  | 'main'
  /** Electron's default application menu. Listed so the collision is visible. */
  | 'menu'
  /** CodeMirror's own keymap, or xterm's. Listed, not ours. */
  | 'library';

/** One binding, as data. */
export interface ShortcutSpec {
  /** Stable id. Used as the override key on disk, so it may not be renamed. */
  id: string;
  surface: ShortcutSurface;
  /** What it DOES, in the user's words, not the function's name. */
  label: string;
  /**
   * Default chords, in the stored spelling. More than one only where a single
   * intent genuinely has several spellings (zoom in) or where the app has long
   * offered two ways to say the same thing (the composer's toggle).
   */
  defaults: readonly string[];
  owner: ShortcutOwner;
  /** True only for `owner: 'app'` bindings the user may move. */
  rebindable: boolean;
  /**
   * Why this chord and not another, where the answer is not obvious. Shown in
   * the Settings list, because "it is subtle" is exactly the information that
   * was previously only in a code comment.
   */
  note?: string;
  /**
   * The LADDERS this binding is a rung of, if any.
   *
   * The one case where two commands on one chord in overlapping surfaces is
   * correct rather than a bug. Escape is the app's clearest example: the
   * doodle's caption editor, the composer and the overlay chrome all handle it,
   * each calling `stopPropagation` before it reaches the next one out, so one
   * keypress closes the innermost thing that is open. Enter is the second: the
   * slash-command dropdown takes it while open, and the send handler takes it
   * otherwise.
   *
   * A LIST rather than one id, because a binding can be a rung of two ladders
   * at once and one of them is — the doodle's caption editor finishes on Escape
   * AND on Ctrl+Enter, so it stands in the Escape ladder above the composer's
   * dismiss and in the Enter ladder above the composer's send. The conflict
   * check found that pair on its first run and reported it as a duplicate,
   * which is precisely the shape of question this field exists to answer.
   *
   * Rungs share a chord BY DESIGN, so conflict detection must not report them
   * — and every rung is `rebindable: false`, because what makes a ladder work is
   * the ORDER the handlers run in, which is not something a chord picker can
   * express. Naming the ladder here is what stops the next reader "fixing" the
   * duplicate.
   */
  ladders?: readonly ('escape' | 'enter' | 'listStep')[];
}

/**
 * Every chord this app claims — including the ones it does not implement.
 *
 * The ones it does not implement are the reason the list is trustworthy.
 * Electron's DEFAULT MENU binds accelerators this app never declared, and that
 * is not a footnote: `Ctrl+=` silently did nothing for months because the
 * default `zoomin` role carries `CommandOrControl+Plus` and Electron parses
 * `Plus` as SHIFTED `=`, and `Ctrl+W` still closes the window where readline
 * expects delete-word. A list that only showed what this app wrote would have
 * shown neither, and both are things the user experiences as this app's
 * keyboard behaviour.
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  // --- Everywhere ---------------------------------------------------------
  {
    id: 'zoom.in',
    surface: 'global',
    label: 'Zoom the whole window in',
    defaults: ['Ctrl+=', 'Ctrl++'],
    owner: 'main',
    rebindable: false,
    note: 'Four spellings for one intent, matched in the main process: Ctrl+=, Ctrl+Shift+=, a layout with a dedicated + key, and the numeric keypad. Electron’s default menu bound only CommandOrControl+Plus, which is SHIFTED = — so plain Ctrl+= matched nothing for months, which is the bug that started this. The keypad is matched by physical key code, the one place in the app that looks at code rather than key.',
  },
  {
    id: 'zoom.out',
    surface: 'global',
    label: 'Zoom the whole window out',
    defaults: ['Ctrl+-'],
    owner: 'main',
    rebindable: false,
    note: 'Ctrl+Shift+- is deliberately NOT a second spelling: that chord is Ctrl+_, which readline binds to undo, and swallowing it would cost a key inside the terminal to buy a fourth way to press one that already has three.',
  },
  {
    id: 'zoom.reset',
    surface: 'global',
    label: 'Reset zoom to 100%',
    defaults: ['Ctrl+0'],
    owner: 'main',
    rebindable: false,
  },
  {
    id: 'window.close',
    surface: 'global',
    label: 'Close the window',
    defaults: ['Ctrl+Shift+W'],
    owner: 'main',
    rebindable: false,
    note:
      'Relocated from Ctrl+W, which Electron\'s default menu held and which is readline\'s delete-word. That menu is gone on Windows and Linux; Alt+F4 and the title bar still close. Admitted because Ctrl+Shift+W produces nothing at the terminal.',
  },
  {
    id: 'window.devTools',
    surface: 'global',
    label: 'Toggle DevTools',
    defaults: ['Ctrl+Shift+I'],
    owner: 'main',
    rebindable: false,
    note:
      'The chord the removed default menu carried, re-provided in before-input-event. Also dead at the terminal.',
  },
  {
    id: 'overlay.close',
    ladders: ['escape'],
    surface: 'global',
    label: 'Close the panel in front (Settings, Ports, Usage, a dialog)',
    defaults: ['Escape'],
    owner: 'app',
    rebindable: false,
    note: 'Escape is a ladder, not a chord: it closes the innermost thing that is open, and each surface stops it before it reaches the next one out. Rebinding a rung would break the ordering rather than move a key.',
  },
  {
    id: 'text.deleteWordBackward',
    surface: 'global',
    label: 'Delete the word before the caret — inside a text field',
    defaults: ['Ctrl+W'],
    owner: 'app',
    rebindable: false,
    note:
      'Readline’s unix-word-rubout (`\\x17`), made good everywhere EXCEPT the shell: Electron’s default menu held this chord for Close until `169cf60` disarmed that menu, leaving every text field with a dead key the hand still reaches for. The handler only ever fires in an `<input>` or `<textarea>` — it stands down inside `.xterm`, so the terminal keeps sending `\\x17` to the shell, and inside the code editor, whose keymap is CodeMirror’s. On macOS the default menu stays and Cmd+W still means Close there, so this does not install on darwin. Not rebindable because its TRUE reach is “plain text fields”, which no surface models: rebinding it as if it were live over the whole workspace would let conflict detection promise things about a terminal it never touches.',
  },

  // --- Tabs ---------------------------------------------------------------
  {
    id: 'tabs.stepLeftRight',
    surface: 'workspace',
    label: 'The tab to the left, the tab to the right',
    defaults: ['Ctrl+[', 'Ctrl+]'],
    owner: 'app',
    rebindable: false,
    note: 'Moved here from Ctrl+ArrowLeft/ArrowRight, which collided with word-jump in every text field: "ctrl+left and right conflicts with jumping over words". A PAIR of chords, so it is fixed for the same reason a pair always is here: an override replaces a binding’s chords outright and would lose one. It CLAMPS at both ends. What it costs is real and stated rather than assumed: through xterm, Ctrl+[ IS Escape (C0 0x1B — the physical escape of older keyboards and the meta-prefix for readline’s ESC-chords) and Ctrl+] is GS. Esc does not reach the pane from anywhere this chord is live; Alt+B / Alt+F-style meta sequences should use Alt instead. Shifted ghosts (Ctrl+{ and Ctrl+}) match nothing and fall through. It stands down inside a real text field, where prose is being typed — but NOT inside the terminal, whose xterm-helper-textarea would otherwise exempt the one surface this is for.',
  },
  {
    id: 'workspaces.stepUpDown',
    surface: 'global',
    label: 'The workspace above, the workspace below',
    defaults: ['Ctrl+ArrowUp', 'Ctrl+ArrowDown'],
    owner: 'app',
    rebindable: false,
    note: 'The other half of the same gesture: it walks the session panel’s folder rows, flat across roots (a root header is a label, not a stop), and opens each one’s workspace. Owned by HostWorkspaceView, because it changes WHICH workspace is mounted and that view owns the route — surface "global" for the same reason. Clamps at both ends. The cheaper half at the terminal: xterm sends ESC [ 1 ; 5 A / B, which readline leaves unbound by default. Same text-field exemption as the tab arrows, kept in step deliberately.',
  },

  // `tabs.move` (Ctrl+Shift+PageUp/PageDown), `tabs.jumpToIndex`
  // (Ctrl+1..Ctrl+9) and the tab CYCLE (`tabs.next`/`tabs.previous`,
  // Ctrl+Tab / Ctrl+Shift+Tab) USED TO BE HERE and were removed at the user's
  // request — "Move the active tab left or right remove this too", "remove
  // ctrl 1 2 3 hotkey", "remove these hotkeys let's keep only ctrl left and
  // ctrl right" — when the arrow chords arrived to do the navigating.
  //
  // Recorded here because each removal HAND KEYS BACK to the pane, and a
  // future reader wondering why those chords are free needs to know they were
  // deliberately released rather than never claimed: Ctrl+3..Ctrl+8 are the C0
  // controls ESC, FS, GS, RS, US and DEL (Ctrl+3 is a common stand-in for
  // Escape); Ctrl+Shift+PageUp/PageDown reach xterm's own scrollback; and
  // Ctrl+Tab is C0.HT (completion at a shell prompt, since xterm ignores Ctrl
  // on Tab) while Ctrl+Shift+Tab is ESC [ Z, back-tab.
  //
  // Moving a tab from the keyboard went with its chord. The DRAG
  // is untouched and is the way to reorder.

  // --- Session creation ---------------------------------------------------
  {
    id: 'sessions.new',
    surface: 'workspace',
    label: 'New session — open the folder picker',
    defaults: ['Ctrl+Shift+N'],
    owner: 'app',
    rebindable: true,
    note: 'The session panel\'s `+`, on the keyboard: it opens the same picker the + opens, in the panel\'s first root, with the caret already in its filter - a palette in the VS Code shape. The picker half of the Ctrl+N pair; `sessions.newInFolder` is the quick half. The shifted letter encodes nothing at the terminal, so no shell behavior is taken. Stands down inside a text field, and while the picker is already open; live whenever the panel is mounted, collapsed included - the panel is v-show\'d, not unmounted.',
  },
  {
    id: 'sessions.newInFolder',
    surface: 'workspace',
    label: 'New shell session in this folder',
    defaults: ['Ctrl+N'],
    owner: 'app',
    rebindable: true,
    note: 'The quick half of the Ctrl+N pair, on the user\'s request: one press starts a plain shell in the folder workspace in front — the same create the workspace + makes, minus the agent dialog — and puts the keyboard in the new pane. Live only while a folder workspace is mounted. WHAT IT COSTS, stated rather than assumed: bare Ctrl+N is ^N at the shell — readline next-history, next-line in emacs and vi — so a real key is taken from programs that bind it. It is the first bare Ctrl+letter the app claims against a key the shell uses, claimed because the quick create is the whole point of the pair and Shift is what makes the twin a dialog. Stands down inside a text field and while a tab rename is open, and one press per press — key repeat is refused, or a held chord mints sessions.',
  },

  // --- Terminal -----------------------------------------------------------
  {
    id: 'terminal.pasteIntoShell',
    surface: 'terminal',
    label: 'Paste into the shell (right-click)',
    defaults: [],
    owner: 'app',
    rebindable: false,
    note: 'NO CHORD, on purpose — this is the right-click, and it is the only route left to the shell’s own paste. Ctrl+Shift+V used to be here and moved to pasteIntoComposer on a user report: it is the chord every terminal emulator trains into the hand, so it is the one reached for first, and a pane where one paste chord opens the composer while its twin feeds the shell is a coin toss the user cannot call before the clipboard has already landed somewhere. Listed with no default rather than deleted, because the action still exists and a reader of this table needs to find out how to reach it.',
  },
  {
    id: 'terminal.copySelection',
    surface: 'terminal',
    label: 'Copy the selection',
    defaults: ['Ctrl+Shift+C'],
    owner: 'app',
    rebindable: true,
    note: 'Selecting with the mouse already copies on mouse-up, so this chord is the keyboard route to something the mouse does for free. Only fires WITH a selection; bare Ctrl+C is the same command, fixed on its own entry below.',
  },
  {
    id: 'terminal.ctrlCCopiesSelection',
    surface: 'terminal',
    label: 'Ctrl+C copies the selection',
    defaults: ['Ctrl+C'],
    owner: 'app',
    rebindable: false,
    note: 'The Windows-console contract, on the user\'s request: when the pane holds a selection, Ctrl+C copies it instead of interrupting. Without a selection it falls through untouched and stays SIGINT — which is why this entry is fixed and why Ctrl+C stays on the reserved list: a rebindable command holding it would promise the chord while the no-selection case still owes the shell the interrupt.',
  },
  {
    id: 'terminal.pasteIntoComposer',
    surface: 'terminal',
    label: 'Put the clipboard in the prompt composer',
    defaults: ['Ctrl+V', 'Ctrl+Shift+V'],
    owner: 'app',
    rebindable: false,
    note: 'BOTH paste chords, which is the point: a user reported reaching for Ctrl+Shift+V — the chord every terminal emulator trains into the hand — and having the clipboard go to the shell instead. Ctrl+V was affordable only because it was measured: plain Ctrl+V in this pane produced a single SYN byte through xterm’s own ctrl-letter mapping and pasted nothing. What it costs is readline’s literal-next (quoted-insert); Ctrl+Q is bound to the same command in vi mode. Ctrl+Alt+V is left alone — Ctrl+Alt is how AltGr arrives on European layouts, where V sits under a printable character. Both chords are cancelled with preventDefault(), measured: without it Ctrl+Shift+V fires twice (Chromium’s own paste-as-plain-text lands a second copy) and Ctrl+V pastes natively into the draft on top of the staged one.',
  },
  {
    id: 'terminal.scrollback',
    surface: 'terminal',
    label: 'Scroll the pane’s buffer',
    defaults: ['Shift+PageUp', 'Shift+PageDown'],
    owner: 'library',
    rebindable: false,
    note: 'xterm’s own, not this app’s — listed because a user pressing it is using this app’s keyboard, and because it is what the tab-move chord had to stay clear of.',
  },
  {
    id: 'terminal.typingOpensComposer',
    surface: 'terminal',
    label: 'Typing opens the prompt composer',
    defaults: [],
    owner: 'app',
    rebindable: false,
    note: 'Not a chord: ANY printable key, when the setting above is on and the composer is closed. Anything with Ctrl, Alt or Cmd held falls through to the shell untouched, and so does every named key and a bare space — that one rule is what keeps Ctrl+C, tmux’s prefix and the pager’s space out of it.',
  },

  // --- Prompt composer ----------------------------------------------------
  {
    id: 'composer.toggle',
    surface: 'composer',
    label: 'Open or close the composer',
    defaults: ['Ctrl+`'],
    owner: 'app',
    rebindable: true,
    note: 'The VS Code panel chord, deliberately NOT a Shift chord: it is the one users already have in their fingers, and a terminal wants nothing from Ctrl+`. Live on the Files tab too — the composer stays mounted there so a tab switch cannot cost a draft.',
  },
  {
    id: 'composer.toggleAlt',
    surface: 'composer',
    label: 'Open or close the composer (second chord)',
    defaults: ['Ctrl+Shift+K'],
    owner: 'app',
    rebindable: true,
    note: 'Shift is what makes it safe: bare Ctrl+K is a real terminal key (readline kill-line) and must keep reaching the pane.',
  },
  {
    id: 'composer.grow',
    surface: 'composer',
    label: 'Make the composer bigger',
    defaults: ['Ctrl+Shift+ArrowUp'],
    owner: 'app',
    rebindable: true,
    note: 'One of the few Shift chords that is NOT free at a terminal: an arrow carries its modifiers in the escape sequence, so Ctrl+Shift+Up would otherwise reach the shell as ESC [ 1 ; 6 A, which vim and tmux both read.',
  },
  {
    id: 'composer.shrink',
    surface: 'composer',
    label: 'Make the composer smaller, and close it past the bottom',
    defaults: ['Ctrl+Shift+ArrowDown'],
    owner: 'app',
    rebindable: true,
    note: 'Shrinking past docked closes the panel and hands focus back to the terminal, so this is also the way back from a maximized composer.',
  },
  {
    id: 'composer.attach',
    surface: 'composer',
    label: 'Attach a file',
    defaults: ['Ctrl+Shift+A'],
    owner: 'app',
    rebindable: true,
    note: 'Shift again, for the same reason: bare Ctrl+A is beginning-of-line in readline and the other common tmux prefix.',
  },
  {
    id: 'composer.send',
    ladders: ['enter'],
    surface: 'composer',
    label: 'Send the prompt',
    defaults: ['Enter', 'Ctrl+Enter'],
    owner: 'app',
    rebindable: false,
    note: 'Enter is what a text box means, not a chord this app assigned. Shift+Enter is the newline; Ctrl+Enter sends too, for people whose muscle memory came from a chat client. An IME composing text is left alone.',
  },
  {
    id: 'composer.newline',
    surface: 'composer',
    label: 'Newline inside the prompt',
    defaults: ['Shift+Enter'],
    owner: 'app',
    rebindable: false,
  },
  {
    id: 'composer.discard',
    surface: 'composer',
    label: 'Discard the draft',
    defaults: ['Ctrl+Shift+Backspace'],
    owner: 'app',
    rebindable: true,
    note: 'The one control in the composer that throws work away, which is why it is a three-key chord and why Escape is not it.',
  },
  {
    id: 'composer.dismiss',
    ladders: ['escape'],
    surface: 'composer',
    label: 'Close the composer, keeping the draft',
    defaults: ['Escape'],
    owner: 'app',
    rebindable: false,
    note: 'A rung of the Escape ladder: it closes the slash-command dropdown first if one is open, then the panel. It never destroys the draft — Discard is the only control that does.',
  },
  {
    id: 'composer.slashNext',
    surface: 'composer',
    ladders: ['listStep'],
    label: 'Move through the slash-command list',
    defaults: ['ArrowDown', 'ArrowUp'],
    owner: 'app',
    rebindable: false,
    note: 'Bare arrows, live only while the dropdown is open.',
  },
  {
    id: 'composer.slashAccept',
    ladders: ['enter'],
    surface: 'composer',
    label: 'Accept the highlighted slash command',
    defaults: ['Tab', 'Enter'],
    owner: 'app',
    rebindable: false,
  },

  // --- Files --------------------------------------------------------------
  {
    id: 'files.treeStep',
    surface: 'files',
    ladders: ['listStep'],
    label: 'Move through the file list',
    defaults: ['ArrowDown', 'ArrowUp', 'Home', 'End'],
    owner: 'app',
    rebindable: false,
    note: 'Bare keys, live only while a file-list ROW has focus — Tab reaches the list like any other control, arrows walk it with a roving focus, and they must not be intercepted anywhere else. Opening the focused row is Enter or Space, which is the platform activating a focused control, not a chord this app claims — so it is deliberately absent from this registry. A QUAD of defaults, for the same reason the tab arrows are a pair: an override replaces all four chords outright.',
  },
  {
    id: 'files.save',
    surface: 'files',
    label: 'Save the open file',
    defaults: ['Ctrl+S'],
    owner: 'app',
    rebindable: true,
    note: 'Safe HERE and nowhere else. Ctrl+S at a terminal is XOFF and freezes the screen, which is why this binding is refused on any surface a shell can be behind — and why the Files tab, which has no terminal, may have it.',
  },
  {
    id: 'files.gotoPath',
    surface: 'files',
    label: 'Type a path to go to',
    defaults: ['Ctrl+L'],
    owner: 'app',
    rebindable: true,
    note: 'The address-bar chord. The shell’s own Ctrl+L (clear screen) is untouched: this handler only ever sees keys from inside the Files pane.',
  },
  {
    id: 'files.filterTree',
    surface: 'files',
    label: 'Filter this folder',
    defaults: ['Ctrl+F'],
    owner: 'app',
    rebindable: true,
    note: 'Filters the TREE, not the open file — the editor loads no search extension, so nothing else in this pane wants the chord.',
  },
  {
    id: 'files.editorUndo',
    surface: 'files',
    label: 'Undo in the open file',
    defaults: ['Ctrl+Z'],
    owner: 'library',
    rebindable: false,
    note: 'CodeMirror’s own history keymap, listed because a user pressing it is using this app’s keyboard. Moving it means reconfiguring the editor’s extensions, not changing a line here.',
  },
  {
    id: 'files.editorRedo',
    surface: 'files',
    label: 'Redo in the open file',
    defaults: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    owner: 'library',
    rebindable: false,
  },
  {
    id: 'files.editorTabFocus',
    surface: 'files',
    label: 'Let Tab move focus out of the editor again',
    defaults: ['Ctrl+M'],
    owner: 'library',
    rebindable: false,
    note: 'CodeMirror’s accessibility escape hatch, kept intact because Tab indents in this editor. Electron’s default menu also binds Ctrl+M to Minimize, and the menu wins — see the collisions section.',
  },

  // --- Annotate -----------------------------------------------------------
  {
    id: 'doodle.undo',
    surface: 'doodle',
    label: 'Undo the last mark',
    defaults: ['Ctrl+Z'],
    owner: 'app',
    rebindable: true,
    note: 'The way to take back an annotation, since Escape on this surface COMMITS rather than cancels. While a caption caret is open the textarea keeps its own Ctrl+Z — undo there means "undo my typing".',
  },
  {
    id: 'doodle.commitText',
    ladders: ['escape', 'enter'],
    surface: 'doodle',
    label: 'Finish the caption you are typing',
    defaults: ['Escape', 'Ctrl+Enter'],
    owner: 'app',
    rebindable: false,
    note: 'Escape COMMITS here, because nothing in this app’s Escape ladder destroys work. Ctrl+Enter matches the composer’s "modifier plus Enter finishes this".',
  },
] as const;

/** Lookup by id. Built once; the registry is a constant. */
export const BY_ID = new Map(SHORTCUTS.map((spec) => [spec.id, spec]));

export function shortcutById(id: string): ShortcutSpec | undefined {
  return BY_ID.get(id);
}

/** The registry's ids, in declaration order. */
export function shortcutIds(): string[] {
  return SHORTCUTS.map((spec) => spec.id);
}

/** Every spec on one surface, in declaration order. */
export function shortcutsForSurface(surface: ShortcutSurface): ShortcutSpec[] {
  return SHORTCUTS.filter((spec) => spec.surface === surface);
}
