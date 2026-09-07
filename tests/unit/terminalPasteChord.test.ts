// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Pasting into the terminal, and why one keystroke used to paste twice.
 *
 * ## What was measured
 *
 * Driven in the real Electron runtime this app ships, against a real xterm.js
 * terminal, counting what `term.onData` handed the shell for one keypress:
 *
 *     Ctrl+V         -> onData x1, [""]        (SYN — xterm's own
 *                                                     ctrl-letter mapping; this
 *                                                     chord does not paste)
 *     Ctrl+Shift+V   -> onData x2, ["TEXT", "TEXT"]  <-- the bug
 *     right-click    -> onData x1, ["TEXT"]
 *
 * So the renderer SENDS the bytes twice; nothing is echoing them. And it is
 * Ctrl+Shift+V specifically, which is the only chord that pastes at all — the
 * one the component's own header documents, and therefore the one the user was
 * using.
 *
 * ## Why twice
 *
 * `onCustomKey` handles the chord itself (`pasteFromClipboard()` ->
 * `term.paste()`) and returns false. Returning false stops XTERM — its
 * `_keyDown` bails at the custom handler — but it does NOT cancel the DOM
 * event, and xterm's `_keyDown` has no `cancel()` on that path. Chromium then
 * performs its own default action for Ctrl+Shift+V (paste as plain text),
 * which fires a `paste` event on xterm's textarea, which xterm's own paste
 * listener turns into a second `onData`. One keystroke, two paths, two writes.
 *
 * This is the identical defect the typing intercept had two branches earlier in
 * the same function, fixed in 1dffa87 and pinned by terminalTypingIntercept.test.ts —
 * "one keystroke, two paths", where the second path was the browser typing the
 * character into the composer it had just opened. The comment there explains
 * the mechanism; this is the same mechanism, on the clipboard chord.
 *
 * The fix is the same one line: `e.preventDefault()` before handling. Verified
 * in Electron — with it, Ctrl+Shift+V is onData x1 and right-click stays x1.
 *
 * ## Why one test here is skipped
 *
 * `onCustomKey` lives in TerminalView.vue, which was being edited concurrently
 * by another change when this was written, so the one-line fix is delivered as
 * a diff rather than applied here. The skipped case below IS that fix's
 * assertion; un-skip it when the diff lands. The rest of this file passes
 * either way and pins the parts that are already right, so a future edit cannot
 * quietly take them away.
 *
 * As with the typing intercept, the assertion is `defaultPrevented` rather than
 * a byte count: jsdom performs no default action, so it cannot produce the
 * second paste at all. What it can assert is the thing that makes the second
 * paste impossible.
 *
 * ## Both chords now go to the composer, and the shell keeps the right-click
 *
 * Plain Ctrl+V was claimed for the PROMPT COMPOSER first: the user asked that
 * pasting at the terminal put the clipboard in the composer — an image as a
 * staged attachment, text as draft content — rather than into the shell. The
 * measurement above is what made that affordable: Ctrl+V never pasted anything
 * here, it only produced `\x16`, so nothing the user could previously do with
 * it was taken away except readline's literal-next (`quoted-insert`).
 *
 * Ctrl+SHIFT+V has now followed it, on a second report: "when I paste using
 * ctrl+shift+v it goes directly to terminal but should go to prompt composer".
 * That is the chord every terminal emulator trains into the hand, so it is the
 * one reached for FIRST — and a pane where one paste chord opens the composer
 * while its twin feeds the shell is not two features, it is a coin toss the
 * user cannot call until the clipboard has already landed somewhere. One of
 * those landings hands whatever was on the clipboard to a shell.
 *
 * So the split is no longer chord-vs-chord, it is KEYBOARD-vs-MOUSE: both
 * chords announce `paste-into-composer`, and the right-click is the whole of
 * the shell's paste. The tests below are written the other way up from how they
 * started — what they now guard is that NEITHER chord reaches `term.paste`,
 * and that the right-click still does.
 *
 * The `preventDefault` assertions are unchanged and matter more than before.
 * Ctrl+Shift+V is `pasteAndMatchStyle` in Chromium's default menu; leaving the
 * event live would let the browser paste into whatever holds focus, which a
 * moment later is the composer's draft — the doubled paste of 3628090 arriving
 * at a new destination.
 */

/** Captures the handler TerminalView hands to xterm, so a test can drive it. */
let customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
/** Everything the component asked xterm to paste. */
let pasted: string[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
    paste(text: string): void {
      pasted.push(text);
    }
    dispose(): void {}
    hasSelection(): boolean {
      return false;
    }
    getSelection(): string {
      return '';
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    parser = {
      registerOscHandler(): { dispose: () => void } {
        return { dispose: () => {} };
      },
    };
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
      customKeyHandler = fn;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): undefined {
      return undefined;
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(async () => ({ shellId: 'shell-1', switched: false })),
      input: vi.fn(async () => true),
      resize: vi.fn(async () => true),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;

/** A keydown the way the browser makes one: cancelable, so it can be cancelled. */
function keydown(key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...mods });
}

function mountTerminal() {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping: false },
    attachTo: document.body,
  });
}

/** Let the handler's `await navigator.clipboard.readText()` settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  customKeyHandler = null;
  pasted = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: vi.fn(async () => 'CLIPBOARD-TEXT'), writeText: vi.fn(async () => {}) },
  });
});

describe('paste chord — delivery', () => {
  it('CANCELS Ctrl+Shift+V, so the browser cannot paste it a second time', async () => {
    // THE ORIGINAL REGRESSION, and it outlived the change of destination. An
    // un-cancelled event is one Chromium goes on to act on itself, and its
    // action for this chord is `pasteAndMatchStyle` — measured in Electron as
    // two onData writes for one keypress, one from each path. Now that the
    // chord opens the composer, the browser's copy would land in the DRAFT
    // instead, on top of the staged one; the same defect with a new victim.
    const wrapper = mountTerminal();
    const e = keydown('V', { ctrlKey: true, shiftKey: true });

    expect(customKeyHandler).not.toBeNull();
    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);

    await settle();
    expect(pasted).toEqual([]);
    wrapper.unmount();
  });

  it('sends Ctrl+Shift+V to the COMPOSER, and nothing to the shell', async () => {
    // The user's report, pinned: "when I paste using ctrl+shift+v it goes
    // directly to terminal but should go to prompt composer". The bytes are
    // withheld from xterm (`false`) and the clipboard is never read here — the
    // composer reads it, because the composer is where the answer is acted on.
    const wrapper = mountTerminal();

    expect(customKeyHandler!(keydown('V', { ctrlKey: true, shiftKey: true }))).toBe(false);
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toHaveLength(1);
    expect(pasted).toEqual([]);
    wrapper.unmount();
  });

  it('announces once per keystroke, never once per key EVENT', async () => {
    // xterm consults this handler for keyup and keypress too. A handler that
    // acted on all three would read the clipboard three times and, for an
    // image, stage three tiles.
    const wrapper = mountTerminal();

    customKeyHandler!(keydown('V', { ctrlKey: true, shiftKey: true }));
    customKeyHandler!(
      new KeyboardEvent('keypress', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    customKeyHandler!(
      new KeyboardEvent('keyup', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toHaveLength(1);
    expect(pasted).toEqual([]);
    wrapper.unmount();
  });

  it('sends NEITHER chord to the shell — the right-click is the only route left', async () => {
    // The split, asserted in one place: keyboard goes to the composer, mouse
    // goes to the shell. If a future edit reintroduces a `e.shiftKey` test in
    // that branch, this is the test that says which half broke — the chords
    // would start pasting into the shell again while the right-click carried
    // on working, which is exactly the state the user reported.
    const wrapper = mountTerminal();

    for (const mods of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
      expect(customKeyHandler!(keydown('V', mods))).toBe(false);
    }
    await settle();
    expect(pasted).toEqual([]);
    expect(wrapper.emitted('paste-into-composer')).toHaveLength(2);

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    (wrapper.element as HTMLElement).dispatchEvent(menu);
    await settle();
    expect(pasted).toEqual(['CLIPBOARD-TEXT']);
    // And the mouse route does NOT double as a composer route.
    expect(wrapper.emitted('paste-into-composer')).toHaveLength(2);
    wrapper.unmount();
  });

  it('cancels the right-click that pastes, so no context menu follows it', async () => {
    // The other paste route, and the one that was already correct: it cancels
    // its own event, so it stays a single write. Measured in Electron as
    // onData x1.
    const wrapper = mountTerminal();
    const target = wrapper.element as HTMLElement;

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(menu);
    await settle();

    expect(menu.defaultPrevented).toBe(true);
    expect(pasted).toEqual(['CLIPBOARD-TEXT']);
    wrapper.unmount();
  });

  it('survives a clipboard the browser refuses to read', async () => {
    // Permission denied / no clipboard API. The pane must not throw into an
    // unhandled rejection; the paste simply does nothing.
    //
    // Driven through the RIGHT-CLICK, because that is now the only thing in
    // this component that reads the clipboard at all — the chords hand the job
    // to the composer without touching it.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    const wrapper = mountTerminal();

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    (wrapper.element as HTMLElement).dispatchEvent(menu);
    await settle();

    expect(pasted).toEqual([]);
    wrapper.unmount();
  });
});

/**
 * The MIDDLE click is inert, on purpose.
 *
 * Left to itself, xterm answers a middle-button `auxclick` by moving its
 * hidden helper textarea under the cursor (CoreBrowserTerminal, gated on
 * Linux) — which is what turns the browser's OWN middle-click paste into a
 * paste into the shell. The user reported exactly that: a stray middle press
 * feeding the clipboard to the shell, with no chord and no confirmation. The
 * fix swallows the event in the capture phase on the container, before xterm's
 * listener on the terminal element runs, and cancels the `mousedown` half of
 * the gesture too.
 *
 * jsdom has no middle-click default action, so — as with the chords in §4 of
 * SHORTCUTS.md — what is asserted is the thing that makes the paste
 * impossible: `defaultPrevented`, and the event never reaching the terminal
 * element at all. Mouse reporting rides `mousedown`/`mouseup`, which these
 * tests also pin as untouched, so a program inside tmux keeps its middle
 * button even though the local paste is gone.
 */
describe('middle click — inert', () => {
  /** A child of the container, standing in for the xterm element beneath it. */
  function mountWithTerminalChild() {
    const wrapper = mountTerminal();
    const container = wrapper.element as HTMLElement;
    const xtermEl = document.createElement('div');
    container.appendChild(xtermEl);
    return { wrapper, container, xtermEl };
  }

  function mouse(type: string, button: number): MouseEvent {
    return new MouseEvent(type, { button, bubbles: true, cancelable: true });
  }

  it('cancels a middle auxclick and keeps it from xterm entirely', async () => {
    const { wrapper, xtermEl } = mountWithTerminalChild();
    const seenByXterm = vi.fn();
    xtermEl.addEventListener('auxclick', seenByXterm);

    const e = mouse('auxclick', 1);
    xtermEl.dispatchEvent(e);
    await settle();

    expect(e.defaultPrevented).toBe(true);
    expect(seenByXterm).not.toHaveBeenCalled();
    expect(pasted).toEqual([]);
    wrapper.unmount();
  });

  it('cancels a middle mousedown — the same gesture, other half', async () => {
    // The middle press's own default (autoscroll; on some platforms the paste
    // itself) is cancelled at mousedown as well, so nothing is left for the
    // browser to do with the gesture.
    const { wrapper, xtermEl } = mountWithTerminalChild();

    const e = mouse('mousedown', 1);
    xtermEl.dispatchEvent(e);
    await settle();

    expect(e.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it('leaves mouse reporting alone: press and release pass through untouched', async () => {
    // A program inside tmux sees the middle button through xterm's mousedown/
    // mouseup forwarding. The suppression must never stop or cancel THOSE —
    // only the local paste gesture dies, not the remote one. The auxclick
    // guard stops propagation; mousedown must demonstrably still travel.
    const { wrapper, container, xtermEl } = mountWithTerminalChild();
    const seenByContainer = vi.fn();
    container.addEventListener('mousedown', seenByContainer);

    const press = mouse('mousedown', 1);
    xtermEl.dispatchEvent(press);
    const release = mouse('mouseup', 1);
    xtermEl.dispatchEvent(release);
    await settle();

    expect(seenByContainer).toHaveBeenCalledTimes(1);
    expect(press.defaultPrevented).toBe(true); // cancelled for the BROWSER only
    expect(release.defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it('leaves every other button exactly as it was', async () => {
    // Left still arms the copy-on-select and is not cancelled; right is the
    // paste route and belongs to `contextmenu`, untouched by an auxclick
    // guard that only ever fires for button 1.
    const { wrapper, xtermEl } = mountWithTerminalChild();
    const seenByXterm = vi.fn();
    xtermEl.addEventListener('auxclick', seenByXterm);

    const left = mouse('auxclick', 0);
    xtermEl.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
    expect(seenByXterm).toHaveBeenCalledTimes(1);

    const right = mouse('auxclick', 2);
    xtermEl.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(false);
    expect(seenByXterm).toHaveBeenCalledTimes(2);

    const leftPress = mouse('mousedown', 0);
    xtermEl.dispatchEvent(leftPress);
    expect(leftPress.defaultPrevented).toBe(false);

    wrapper.unmount();
  });
});

/**
 * Plain Ctrl+V is the COMPOSER's.
 *
 * What this file can assert is the interception, and only the interception:
 * this component deliberately knows nothing about what is on the clipboard or
 * what the composer will do with it. It cancels the chord, withholds the bytes
 * and says so. The decision that follows is pinned by clipboardPaste.test.ts
 * and the routing by composerClipboardPaste.test.ts.
 *
 * "No bytes reached the shell" is asserted three ways, because in jsdom no
 * single one of them is the real mechanism: the handler returns false (xterm's
 * `_keyDown` bails before its ctrl-letter mapping can produce `\x16`), the DOM
 * event is cancelled (Chromium never performs its own paste), and nothing was
 * handed to `term.paste`. In the real runtime the first two are what stop the
 * write; here they are simply the things that can be observed.
 */
describe('Ctrl+V — intercepted for the prompt composer', () => {
  it('cancels the chord and announces it, instead of feeding the shell', async () => {
    const wrapper = mountTerminal();
    const e = keydown('v', { ctrlKey: true });

    expect(customKeyHandler).not.toBeNull();
    // Both halves are required, and the second is the one that regressed twice
    // already (3628090, bc86cf7). Returning false stops xterm but leaves the
    // DOM event live, and Chromium's default action for Ctrl+V is a paste into
    // whatever holds focus — which, a moment later, is the composer's draft.
    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);

    await settle();
    expect(wrapper.emitted('paste-into-composer')).toHaveLength(1);
    expect(pasted).toEqual([]);
    wrapper.unmount();
  });

  it('takes the capital and the Cmd spelling too', async () => {
    // Caps Lock spells the key 'V' with no Shift held, and macOS uses Meta.
    // Neither is a different intention.
    const spellings: [string, Partial<KeyboardEventInit>][] = [
      ['V', { ctrlKey: true }],
      ['v', { metaKey: true }],
      ['V', { metaKey: true }],
    ];
    for (const [key, mods] of spellings) {
      const wrapper = mountTerminal();
      const e = keydown(key, mods);
      expect(customKeyHandler!(e)).toBe(false);
      expect(e.defaultPrevented).toBe(true);
      expect(wrapper.emitted('paste-into-composer')).toHaveLength(1);
      wrapper.unmount();
    }
    await settle();
  });

  it('announces once per keystroke, never once per key EVENT', async () => {
    // xterm consults this handler for keyup and keypress as well. Three events
    // would be three clipboard reads and, for an image, three staged tiles.
    const wrapper = mountTerminal();

    customKeyHandler!(keydown('v', { ctrlKey: true }));
    customKeyHandler!(new KeyboardEvent('keypress', { key: 'v', ctrlKey: true, cancelable: true }));
    customKeyHandler!(new KeyboardEvent('keyup', { key: 'v', ctrlKey: true, cancelable: true }));
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toHaveLength(1);
    wrapper.unmount();
  });

  it('leaves AltGr+V alone — it is a printable character, not a chord', async () => {
    // Ctrl+Alt is how AltGr arrives on European layouts, where V sits under a
    // real character on several of them. Swallowing it would make the key
    // untypeable in the terminal.
    const wrapper = mountTerminal();
    const e = keydown('v', { ctrlKey: true, altKey: true });

    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toBeUndefined();
    wrapper.unmount();
  });

  it('takes the Shift spelling as the same intention', async () => {
    // Ctrl+Shift+V used to be excluded here by an `!e.shiftKey` test, and its
    // removal IS the fix for the user's report. Asserted in this describe as
    // well as the one above, because this is the block a reader consults for
    // "what opens the composer", and the answer must not depend on Shift.
    const wrapper = mountTerminal();
    const e = keydown('V', { ctrlKey: true, shiftKey: true });

    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toHaveLength(1);
    wrapper.unmount();
  });

  it('leaves AltGr+Shift+V alone as well', async () => {
    // The AltGr guard has to survive the Shift branch being merged in: on a
    // European layout Ctrl+Alt is AltGr, and swallowing it would make a
    // printable character untypeable whether or not Shift is down.
    const wrapper = mountTerminal();
    const e = keydown('V', { ctrlKey: true, altKey: true, shiftKey: true });

    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toBeUndefined();
    wrapper.unmount();
  });

  it('does not fire on a bare V, with or without Shift', async () => {
    const wrapper = mountTerminal();

    for (const e of [keydown('v'), keydown('V', { shiftKey: true })]) {
      expect(customKeyHandler!(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
    }
    await settle();

    expect(wrapper.emitted('paste-into-composer')).toBeUndefined();
    wrapper.unmount();
  });
});
