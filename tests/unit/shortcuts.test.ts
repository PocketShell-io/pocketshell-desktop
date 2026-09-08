import { describe, expect, it } from 'vitest';
import {
  type Chord,
  chordFromEvent,
  chordMatches,
  chordsFor,
  chordToString,
  conflictingBinding,
  defaultBindings,
  formatChord,
  formatChordParts,
  isShortcut,
  MENU_CLAIMED_UNSUPPRESSIBLE,
  parseChord,
  RESERVED_CHORDS,
  resolveBindings,
  shortcutById,
  shortcutIds,
  SHORTCUTS,
  SURFACES,
  surfacesCollide,
  terminalCanEncode,
  validateBinding,
} from '../../src/shared/shortcuts';

/**
 * The registry as a THING THAT CAN BE WRONG.
 *
 * A list of chords in a file is only trustworthy if something checks it, and
 * the specific failure this whole feature exists to prevent is a chord chosen
 * against a stale idea of what was already taken. That check is
 * `the shipped defaults do not collide` below: it runs every pair of bindings
 * whose surfaces can be live together, including the ones no UI can change, and
 * it is the assertion that would have caught a duplicate the moment it was
 * added rather than the first time a user pressed it.
 *
 * The rest pins the two rules that keep a user out of trouble — chords that
 * belong to the shell, and chords Electron's menu owns and the page cannot take
 * back — and the parse/format round trip that makes a stored override readable
 * a build later.
 */

function chord(raw: string): Chord {
  const parsed = parseChord(raw);
  if (!parsed) throw new Error(`not a chord: ${raw}`);
  return parsed;
}

describe('chords — spelling', () => {
  it('round-trips every spelling the registry ships', () => {
    for (const spec of SHORTCUTS) {
      for (const raw of spec.defaults) {
        const parsed = parseChord(raw);
        expect(parsed, `${spec.id} default ${raw}`).not.toBeNull();
        // Canonical: what goes in comes back out identically, so a default and
        // an override of the same chord are the same map key.
        expect(chordToString(parsed!), `${spec.id} default ${raw}`).toBe(raw);
      }
    }
  });

  it('puts modifiers in one fixed order, so one chord has one spelling', () => {
    expect(chordToString(chord('Shift+Ctrl+V'))).toBe('Ctrl+Shift+V');
    expect(chordToString(chord('shift+CTRL+alt+k'))).toBe('Ctrl+Alt+Shift+K');
  });

  it('treats Cmd as Ctrl, because every call site in the app does', () => {
    expect(chordToString(chord('Cmd+S'))).toBe('Ctrl+S');
    expect(chordMatches(chord('Ctrl+S'), { key: 's', metaKey: true })).toBe(true);
    expect(chordMatches(chord('Ctrl+S'), { key: 's', ctrlKey: true })).toBe(true);
  });

  it('keeps a lone + as a key rather than as a separator', () => {
    // `Ctrl++` is a real zoom spelling on a layout with a dedicated + key.
    expect(chordToString(chord('Ctrl++'))).toBe('Ctrl++');
    expect(chord('Ctrl++').key).toBe('+');
  });

  it('rejects what it cannot trust rather than guessing', () => {
    for (const bad of ['', '   ', 'Ctrl+', 'Hyper+K', 'Ctrl+Ctrl+K', 'Ctrl+A+B']) {
      expect(parseChord(bad), bad).toBeNull();
    }
  });

  it('upper-cases a letter but leaves a named key in the DOM spelling', () => {
    expect(chordFromEvent({ key: 'v', ctrlKey: true }).key).toBe('V');
    expect(chordFromEvent({ key: 'ArrowDown', ctrlKey: true }).key).toBe('ArrowDown');
    expect(chordFromEvent({ key: ' ' }).key).toBe('Space');
  });

  it('folds the Russian Ё into the backquote key it is printed on', () => {
    // On ЙЦУКЕН the backquote keycap is engraved ё, so Ctrl+Ё is what a
    // Russian user presses for the VS Code panel chord — no other key on that
    // layout produces Ctrl+`.
    expect(chordFromEvent({ key: 'ё', ctrlKey: true }).key).toBe('`');
    expect(chordFromEvent({ key: 'Ё', ctrlKey: true }).key).toBe('`');
    expect(chordMatches(chord('Ctrl+`'), { key: 'ё', ctrlKey: true })).toBe(true);
    // The stored spelling stays canonical, so one chord has one map key.
    expect(chordToString(parseChord('Ctrl+Ё')!)).toBe('Ctrl+`');
    // One alias, not a rule about Cyrillic: letters stay themselves.
    expect(chordFromEvent({ key: 'а', ctrlKey: true }).key).toBe('А');
  });

  it('spells arrows as words, never as glyphs', () => {
    // designGates.test.ts bans glyph-as-icon in renderer templates, and a
    // shortcut list is exactly where that rule would be quietly widened.
    expect(formatChordParts(chord('Ctrl+Shift+ArrowUp'))).toEqual(['Ctrl', 'Shift', 'Up']);
    expect(formatChord(chord('Ctrl+Shift+ArrowDown'))).toBe('Ctrl+Shift+Down');
    expect(formatChord(chord('Escape'))).toBe('Esc');
  });

  it('shows Cmd on a Mac without changing what is stored', () => {
    expect(formatChordParts(chord('Ctrl+Shift+V'), true)).toEqual(['Cmd', 'Shift', 'V']);
    expect(chordToString(chord('Ctrl+Shift+V'))).toBe('Ctrl+Shift+V');
  });

  it('matches on the key, and Shift is part of the chord', () => {
    expect(chordMatches(chord('Ctrl+Shift+V'), { key: 'V', ctrlKey: true, shiftKey: true })).toBe(
      true,
    );
    // Shift is part of the chord, which is what lets one command hold Ctrl+V
    // and Ctrl+Shift+V as two entries rather than as one fuzzy match.
    expect(chordMatches(chord('Ctrl+V'), { key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(chordMatches(chord('Ctrl+V'), { key: 'v', ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe('surfaces', () => {
  it('is reflexive and symmetric', () => {
    // An asymmetric table would refuse a binding in one direction and allow it
    // in the other, which is worse than having no check.
    for (const a of SURFACES) {
      expect(surfacesCollide(a.id, a.id), a.id).toBe(true);
      for (const b of SURFACES) {
        expect(surfacesCollide(a.id, b.id), `${a.id}/${b.id}`).toBe(
          surfacesCollide(b.id, a.id),
        );
      }
    }
  });

  it('has the composer live on the Files tab', () => {
    // The finding that started the module. FolderWorkspaceView mounts the
    // composer once, outside the tab body, behind a `v-show` — so its window
    // capture handler keeps running while Files is showing.
    expect(surfacesCollide('composer', 'files')).toBe(true);
  });

  it('has no terminal behind the Files tab', () => {
    // Which is why Ctrl+S may be Save there and may never be anything at a
    // shell, where it is XOFF.
    expect(surfacesCollide('files', 'terminal')).toBe(false);
  });

  it('gives every surface at least one binding to show', () => {
    for (const surface of SURFACES) {
      expect(
        SHORTCUTS.some((spec) => spec.surface === surface.id),
        surface.id,
      ).toBe(true);
    }
  });
});

describe('the registry', () => {
  it('has unique ids', () => {
    const ids = shortcutIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never marks a chord rebindable that this app does not implement', () => {
    // A main-process chord cannot read the renderer's localStorage, and a
    // library's keymap is not ours to move. Offering either would be a control
    // that does nothing.
    for (const spec of SHORTCUTS) {
      if (spec.owner !== 'app') expect(spec.rebindable, spec.id).toBe(false);
    }
  });

  it('keeps every ladder rung fixed', () => {
    // What makes a ladder work is the ORDER the handlers run in, which a chord
    // picker cannot express.
    for (const spec of SHORTCUTS) {
      if (spec.ladders) expect(spec.rebindable, spec.id).toBe(false);
    }
  });

  it('gives every rebindable binding exactly one chord', () => {
    // An override replaces a binding's chords outright, so a rebindable entry
    // with two defaults would lose one the first time it was moved.
    for (const spec of SHORTCUTS) {
      if (spec.rebindable) expect(spec.defaults.length, spec.id).toBe(1);
    }
  });

  it('does not ship a default that collides with another live binding', () => {
    // THE CHECK THIS MODULE EXISTS FOR. Every pair whose surfaces can be live
    // together, including the locked ones no UI can change.
    const bindings = defaultBindings();
    const collisions: string[] = [];
    for (const [id, chords] of bindings) {
      for (const c of chords) {
        const other = conflictingBinding(id, c, bindings);
        if (other) collisions.push(`${id} and ${other} both hold ${formatChord(c)}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('does not ship a default the app itself would refuse', () => {
    // A default that fails validation is a chord the user could never restore
    // after moving it once.
    const bindings = defaultBindings();
    const bad: string[] = [];
    for (const spec of SHORTCUTS) {
      if (!spec.rebindable) continue;
      const c = chordsFor(bindings, spec.id)[0]!;
      const refusal = validateBinding(spec.id, c, bindings);
      if (refusal) bad.push(`${spec.id}: ${refusal.message}`);
    }
    expect(bad).toEqual([]);
  });

  it('names the chords the terminal pane claims, and the action that has none', () => {
    // The audit, pinned. If one of these disappears from the registry the list
    // stops being the truth about the app.
    //
    // BOTH paste chords belong to the composer. Ctrl+Shift+V moved here from
    // pasteIntoShell on a user report — it is the chord every terminal trains
    // into the hand, so it is the one reached for first, and having it feed the
    // shell while its twin fed the composer made the destination a coin toss.
    expect(shortcutById('terminal.pasteIntoComposer')!.defaults).toEqual([
      'Ctrl+V',
      'Ctrl+Shift+V',
    ]);
    expect(shortcutById('terminal.copySelection')!.defaults).toEqual(['Ctrl+Shift+C']);
    // Bare Ctrl+C copies the selection too — the Windows-console contract, on
    // the user's request — but it can never be a REBINDABLE chord: without a
    // selection it is SIGINT, and a movable Ctrl+C would let another command
    // take the interrupt away. Fixed, with the guard living in the handler.
    const ctrlC = shortcutById('terminal.ctrlCCopiesSelection')!;
    expect(ctrlC.defaults).toEqual(['Ctrl+C']);
    expect(ctrlC.rebindable).toBe(false);
    // The shell's paste survives with NO chord: it is the right-click, and it
    // stays in the table because the action still exists and a reader needs to
    // find out how to reach it.
    expect(shortcutById('terminal.pasteIntoShell')!.defaults).toEqual([]);
    expect(shortcutById('terminal.pasteIntoShell')!.rebindable).toBe(false);
  });

  it('lists the chords Electron binds that this app never declared', () => {
    // The zoom asymmetry the user reported, and the Ctrl+W hazard. A list that
    // only showed what this app wrote would have shown neither.
    const menu = MENU_CLAIMED_UNSUPPRESSIBLE.map((entry) => entry.chord);
    expect(menu).toContain('Ctrl+W');
    expect(menu).toContain('Ctrl+R');
  });
});

/**
 * Transcribed from `@xterm/xterm@6`'s own
 * `src/common/input/Keyboard.ts::evaluateKeyboardEvent`, which is the function
 * this app's custom key handler is consulted from — so these are the bytes a
 * chord really would have produced, not a belief about terminals in general.
 *
 * The belief is the thing being corrected. The tab chords were briefed as
 * affordable because "terminals cannot encode most Ctrl+digit or Ctrl+Tab", and
 * that is measurably false for this xterm. What IS true is narrower and more
 * useful: Ctrl+SHIFT+letter is free, which is why every app chord next to a
 * terminal in this repo wears Shift.
 */
describe('what a terminal can encode', () => {
  it('says YES to Ctrl+Tab — `case 9` ignores Ctrl entirely', () => {
    // `\t` at a shell prompt is completion, not nothing. Taking this chord
    // costs something, and the list says so.
    expect(terminalCanEncode(chord('Ctrl+Tab'))).toBe(true);
    expect(terminalCanEncode(chord('Ctrl+Shift+Tab'))).toBe(true);
  });

  it('says yes to Ctrl+3..Ctrl+8, which are C0 controls', () => {
    // keyCodes 51-55 -> ESC FS GS RS US, and 56 -> DEL. Ctrl+3 in particular is
    // a widely used stand-in for Escape.
    for (const digit of ['3', '4', '5', '6', '7', '8']) {
      expect(terminalCanEncode(chord(`Ctrl+${digit}`)), digit).toBe(true);
    }
  });

  it('says no to Ctrl+1, Ctrl+2 and Ctrl+9 — the only free digits', () => {
    for (const digit of ['1', '2', '9']) {
      expect(terminalCanEncode(chord(`Ctrl+${digit}`)), digit).toBe(false);
    }
  });

  it('says yes to the ctrl-letter bytes a shell really receives', () => {
    expect(terminalCanEncode(chord('Ctrl+C'))).toBe(true);
    expect(terminalCanEncode(chord('Ctrl+\\'))).toBe(true);
    expect(terminalCanEncode(chord('Ctrl+Space'))).toBe(true);
  });

  it('says no to Ctrl+Shift+letter — the branch demands Shift be absent', () => {
    // THE RULE THE APP'S CHORDS ACTUALLY RELY ON.
    for (const letter of ['C', 'V', 'K', 'A']) {
      expect(terminalCanEncode(chord(`Ctrl+Shift+${letter}`)), letter).toBe(false);
    }
  });

  it('says yes to Ctrl+Shift+arrow — modifiers ride in the CSI parameter', () => {
    // Ctrl+Shift+Up is `ESC [ 1 ; 6 A`, which vim and tmux read. The composer's
    // size ladder does cost the pane something.
    expect(terminalCanEncode(chord('Ctrl+Shift+ArrowUp'))).toBe(true);
    expect(terminalCanEncode(chord('Ctrl+Shift+PageUp'))).toBe(true);
  });

  it('is not fooled by Shift changing the character', () => {
    // Ctrl+Shift+2 is `@` is NUL and Ctrl+Shift+- is `_` is US, both matched on
    // the character in a branch Shift does not guard. zoomKeys.ts already
    // refuses Ctrl+Shift+- as a zoom spelling for this exact reason.
    expect(terminalCanEncode(chord('Ctrl+Shift+@'))).toBe(true);
    expect(terminalCanEncode(chord('Ctrl+Shift+_'))).toBe(true);
  });

  it('says yes to a bare Alt chord, which is Meta with an ESC prefix', () => {
    expect(terminalCanEncode(chord('Alt+K'))).toBe(true);
  });
});

describe('validateBinding', () => {
  const inForce = defaultBindings();

  it('refuses a chord that belongs to the shell, anywhere a shell can be behind', () => {
    // Ctrl+Q is the one entry that is BOTH: XON at a shell and `quit` in
    // Electron's menu. The menu reason wins because it is the more destructive
    // outcome and it applies on every surface, shell or not — so this asserts
    // the refusal and its reason, not one particular kind for all eight.
    const alsoMenu = new Set(MENU_CLAIMED_UNSUPPRESSIBLE.map((entry) => entry.chord));
    for (const entry of RESERVED_CHORDS) {
      const refusal = validateBinding('terminal.copySelection', chord(entry.chord), inForce);
      if (alsoMenu.has(entry.chord)) {
        expect(refusal?.kind, entry.chord).toBe('menu');
        continue;
      }
      expect(refusal?.kind, entry.chord).toBe('reserved');
      // The reason travels with the refusal: "no" without "because SIGINT" is
      // the app being arbitrary at somebody who has a real reason to ask.
      expect(refusal?.message).toContain(entry.why);
    }
  });

  it('allows Ctrl+S on the Files tab, which has no shell behind it', () => {
    expect(validateBinding('files.save', chord('Ctrl+S'), inForce)).toBeNull();
  });

  it('refuses Ctrl+S for a binding the terminal can be behind', () => {
    expect(validateBinding('composer.toggle', chord('Ctrl+S'), inForce)?.kind).toBe('reserved');
  });

  it('refuses a bare Alt chord near a terminal — Alt is Meta there', () => {
    expect(validateBinding('terminal.copySelection', chord('Alt+K'), inForce)?.kind).toBe(
      'reserved',
    );
    // …and allows it where nothing reads ESC-prefixed keys.
    expect(validateBinding('files.filterTree', chord('Alt+K'), inForce)).toBeNull();
  });

  it('refuses the menu accelerators the page cannot take back', () => {
    // Including the bare function keys. F12 has no modifier and would fail the
    // "needs Ctrl or Alt" rule too, but "the menu owns it" is the answer that
    // stops the user going off to try Ctrl+F12 — which the menu also owns.
    for (const entry of MENU_CLAIMED_UNSUPPRESSIBLE) {
      const parsed = parseChord(entry.chord);
      if (!parsed) throw new Error(`unparseable menu chord: ${entry.chord}`);
      const refusal = validateBinding('files.filterTree', parsed, inForce);
      expect(refusal?.kind, entry.chord).toBe('menu');
    }
  });

  it('refuses the zoom chords, which are already taken', () => {
    for (const raw of ['Ctrl+0', 'Ctrl+-', 'Ctrl+=', 'Ctrl+Shift++']) {
      expect(validateBinding('files.filterTree', chord(raw), inForce)?.kind, raw).toBe('menu');
    }
  });

  it('allows an editing accelerator, because preventDefault suppresses those', () => {
    // Ctrl+Shift+V is `pasteAndMatchStyle` in the default menu AND the chord
    // the terminal pane hands to the composer. Cancelling the keydown is what
    // makes that work — measured, in the double-paste investigation.
    //
    // Asked of the Files filter rather than of a terminal command: the terminal
    // pane's own paste bindings are fixed now (a two-chord binding cannot be
    // rebound without losing one), so asking either of them would test
    // `locked` and never reach the menu rule this is about. Files has no
    // terminal behind it, so the surfaces do not collide.
    expect(validateBinding('files.filterTree', chord('Ctrl+Shift+V'), inForce)).toBeNull();
  });

  it('refuses a chord with no modifier, which would swallow typing', () => {
    expect(validateBinding('files.filterTree', chord('K'), inForce)?.kind).toBe('no-modifier');
  });

  it('refuses a modifier pressed on its own', () => {
    expect(validateBinding('files.filterTree', chord('Ctrl+Shift'), inForce)?.kind).toBe(
      'modifier-only',
    );
  });

  it('names the command it is conflicting with', () => {
    const refusal = validateBinding('files.filterTree', chord('Ctrl+L'), inForce);
    expect(refusal?.kind).toBe('conflict');
    expect(refusal).toMatchObject({ withId: 'files.gotoPath' });
    expect(refusal?.message).toContain('Type a path to go to');
  });

  it('is not fooled by two spellings of one chord', () => {
    const refusal = validateBinding('files.filterTree', chord('Cmd+L'), inForce);
    expect(refusal?.kind).toBe('conflict');
  });

  it('reports a conflict ACROSS surfaces that are live together', () => {
    // The composer floats over the terminal, so the composer's toggle and a
    // terminal chord are two commands one keypress could reach.
    const refusal = validateBinding('composer.toggle', chord('Ctrl+Shift+V'), inForce);
    expect(refusal?.kind).toBe('conflict');
    expect(refusal).toMatchObject({ withId: 'terminal.pasteIntoComposer' });
  });

  it('does NOT report a conflict across surfaces that never coexist', () => {
    // Files has no terminal behind it, so the Files filter may take a chord the
    // terminal pane also uses. Ctrl+Shift+C is copy-selection in the terminal.
    expect(validateBinding('files.filterTree', chord('Ctrl+Shift+C'), inForce)).toBeNull();
  });

  it('refuses to move a fixed binding at all', () => {
    expect(validateBinding('zoom.in', chord('Ctrl+Shift+Z'), inForce)?.kind).toBe('locked');
    expect(validateBinding('files.editorUndo', chord('Ctrl+Shift+Z'), inForce)?.kind).toBe(
      'locked',
    );
    // A PAIR of chords is always fixed here — an override replaces a binding's
    // chords outright, so a rebindable pair loses one the first time it moves.
    // `tabs.jumpToIndex` used to stand in this line and is gone; the arrows
    // that replaced it are fixed for the same rule that fixed the digits.
    expect(validateBinding('tabs.stepLeftRight', chord('Ctrl+Shift+J'), inForce)?.kind).toBe(
      'locked',
    );
    expect(validateBinding('workspaces.stepUpDown', chord('Ctrl+Shift+J'), inForce)?.kind).toBe(
      'locked',
    );
  });

  it('reports a reserved chord as reserved even when it is also taken', () => {
    // Ordered most specific first: the user needs the reason they cannot have
    // it at all, not a hint that freeing the other binding would help.
    const refusal = validateBinding('composer.toggle', chord('Ctrl+Z'), inForce);
    expect(refusal?.kind).toBe('reserved');
  });

  it('refuses an id this build does not have', () => {
    expect(validateBinding('nope.nope', chord('Ctrl+Shift+J'), inForce)?.kind).toBe('unknown');
  });
});

describe('resolveBindings', () => {
  it('is the defaults when nothing has been moved', () => {
    const resolved = resolveBindings({});
    expect(chordToString(chordsFor(resolved, 'files.save')[0]!)).toBe('Ctrl+S');
  });

  it('replaces a binding rather than adding to it', () => {
    const resolved = resolveBindings({ 'files.filterTree': 'Ctrl+Shift+F' });
    expect(chordsFor(resolved, 'files.filterTree').map(chordToString)).toEqual(['Ctrl+Shift+F']);
  });

  it('frees the chord the moved binding used to hold', () => {
    // A conflict against a chord the user already vacated is not a conflict.
    const resolved = resolveBindings({ 'files.gotoPath': 'Ctrl+Shift+L' });
    expect(validateBinding('files.filterTree', chord('Ctrl+L'), resolved)).toBeNull();
  });

  it('degrades per entry, never per blob', () => {
    const resolved = resolveBindings({
      'files.save': 'Ctrl+Shift+S',
      'no.such.id': 'Ctrl+Shift+X',
      'files.gotoPath': 'not a chord at all+',
      // A fixed binding cannot be reached around by hand-editing the file.
      'zoom.in': 'Ctrl+Shift+Y',
      // A chord the app would refuse, written straight into the blob.
      'files.filterTree': 'Ctrl+W',
    });
    expect(chordsFor(resolved, 'files.save').map(chordToString)).toEqual(['Ctrl+Shift+S']);
    expect(chordsFor(resolved, 'files.gotoPath').map(chordToString)).toEqual(['Ctrl+L']);
    expect(chordsFor(resolved, 'zoom.in').map(chordToString)).toEqual(['Ctrl+=', 'Ctrl++']);
    expect(chordsFor(resolved, 'files.filterTree').map(chordToString)).toEqual(['Ctrl+F']);
  });

  it('refuses to let two hand-edited overrides collide', () => {
    const resolved = resolveBindings({
      'files.gotoPath': 'Ctrl+Shift+G',
      'files.filterTree': 'Ctrl+Shift+G',
    });
    const both = [
      ...chordsFor(resolved, 'files.gotoPath'),
      ...chordsFor(resolved, 'files.filterTree'),
    ].map(chordToString);
    expect(new Set(both).size).toBe(2);
  });
});

describe('isShortcut — the shape every call site becomes', () => {
  const bindings = resolveBindings({});

  it('answers for a chord without the call site spelling it', () => {
    // One command, both spellings: Shift makes no difference to where a paste
    // at the terminal goes, which is the whole of the user's report.
    expect(isShortcut(bindings, 'terminal.pasteIntoComposer', { key: 'v', ctrlKey: true })).toBe(
      true,
    );
    expect(
      isShortcut(bindings, 'terminal.pasteIntoComposer', { key: 'V', ctrlKey: true, shiftKey: true }),
    ).toBe(true);
    // AltGr is not a paste: Ctrl+Alt is how it arrives on European layouts,
    // where V sits under a printable character.
    expect(
      isShortcut(bindings, 'terminal.pasteIntoComposer', { key: 'v', ctrlKey: true, altKey: true }),
    ).toBe(false);
    // The shell's paste holds no chord at all now — it is the right-click — so
    // nothing on the keyboard may answer for it.
    expect(
      isShortcut(bindings, 'terminal.pasteIntoShell', { key: 'V', ctrlKey: true, shiftKey: true }),
    ).toBe(false);
  });

  it('follows a rebinding without the call site being rebuilt', () => {
    const moved = resolveBindings({ 'terminal.copySelection': 'Ctrl+Shift+Y' });
    expect(isShortcut(moved, 'terminal.copySelection', { key: 'Y', ctrlKey: true, shiftKey: true })).toBe(
      true,
    );
    expect(isShortcut(moved, 'terminal.copySelection', { key: 'C', ctrlKey: true, shiftKey: true })).toBe(
      false,
    );
  });

  it('opens the composer from the Russian layout backquote key', () => {
    // The user report behind the Ё alias: Ctrl+Ё must fire composer.toggle
    // exactly as Ctrl+` does on a US layout.
    expect(isShortcut(bindings, 'composer.toggle', { key: 'ё', ctrlKey: true })).toBe(true);
    // Shift is still part of the chord, alias or no alias.
    expect(
      isShortcut(bindings, 'composer.toggle', { key: 'Ё', ctrlKey: true, shiftKey: true }),
    ).toBe(false);
  });

  it('falls back to the defaults rather than to no binding at all', () => {
    // A handler that resolved before the store was ready must still work.
    expect(isShortcut(new Map(), 'files.save', { key: 's', ctrlKey: true })).toBe(true);
  });

  it('leaves everything else alone, which is the terminal’s whole contract', () => {
    for (const e of [
      { key: 'd', ctrlKey: true },
      { key: 'b', ctrlKey: true },
      { key: 'a' },
      { key: 'Enter' },
    ]) {
      const claimed = SHORTCUTS.filter(
        (spec) => spec.surface === 'terminal' && isShortcut(bindings, spec.id, e),
      );
      expect(claimed.map((s) => s.id), JSON.stringify(e)).toEqual([]);
    }
  });

  it('answers Ctrl+C only by the fixed copy-when-selected binding', () => {
    // The one deliberate exception to the contract above: with a selection the
    // pane copies, without one the chord falls through and is SIGINT. That
    // guard lives in TerminalView's handler — the registry can only pin that
    // the claim is FIXED and sits on exactly one entry, so no other terminal
    // command can ever be the thing Ctrl+C reaches.
    const claimed = SHORTCUTS.filter(
      (spec) => spec.surface === 'terminal' && isShortcut(bindings, spec.id, { key: 'c', ctrlKey: true }),
    );
    expect(claimed.map((s) => s.id)).toEqual(['terminal.ctrlCCopiesSelection']);
    // And rebinding the rebindable copy chord away does not move this one:
    expect(
      isShortcut(resolveBindings({ 'terminal.copySelection': 'Ctrl+Shift+Y' }), 'terminal.ctrlCCopiesSelection', {
        key: 'c',
        ctrlKey: true,
      }),
    ).toBe(true);
  });
});
