// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The typing intercept's DELIVERY, as opposed to its predicate.
 *
 * `isTypingKey` decides which keys are typing; composerText.test.ts pins that.
 * This file pins what happens to a key once the answer is yes, because that is
 * where the doubled-first-letter bug lived and no test of the predicate could
 * ever have caught it.
 *
 * ## Why the assertion is `defaultPrevented`
 *
 * The bug: `attachCustomKeyEventHandler` returning false stops XTERM, but
 * xterm's `_keyDown` bails at the custom handler and never calls its own
 * `cancel()` (its `_keyPress` does — that arm was not the one being taken). So
 * the DOM event survived un-cancelled, the browser performed the default
 * action, and by then the composer we had just opened owned the focus — so the
 * character was typed into the draft a second time, natively, on top of the
 * copy `typeInto` had planted.
 *
 * jsdom implements no default action for text input, so it cannot reproduce
 * that second copy and no jsdom test can assert "the draft is 'a' not 'aa'"
 * against the real mechanism. What it CAN assert is the thing that makes the
 * second copy impossible: the handler cancels the event. That is the contract,
 * it is exactly what regressed, and it fails if `preventDefault()` is removed.
 * The end-to-end proof over a real browser lives in tests/e2e/composer.spec.ts.
 */

/** Captures the handler TerminalView hands to xterm, so a test can drive it. */
let customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
    paste(): void {}
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
    unicode = { activeVersion: '6', register: (): void => {} };
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
      attachSession: vi.fn(async () => ({ ok: true, shellId: 'shell-1' })),
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

function mountTerminal(interceptTyping: boolean) {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  customKeyHandler = null;
});

describe('typing intercept — delivery', () => {
  it('CANCELS the key event, so the browser cannot type it a second time', () => {
    const wrapper = mountTerminal(true);
    const e = keydown('a');

    expect(customKeyHandler).not.toBeNull();
    expect(customKeyHandler!(e)).toBe(false);

    // The whole regression, in one line: an un-cancelled event is one the
    // browser goes on to deliver natively into whatever now has focus.
    expect(e.defaultPrevented).toBe(true);
    expect(wrapper.emitted('typed')).toEqual([['a']]);
  });

  it('emits the character exactly ONCE per keystroke', () => {
    const wrapper = mountTerminal(true);
    customKeyHandler!(keydown('a'));
    expect(wrapper.emitted('typed')).toHaveLength(1);
  });

  it('carries a capital through Shift without dropping or doubling it', () => {
    // Shift is deliberately not a "modifier" for this purpose: Shift-A is a
    // letter, and it takes the same path as any other letter.
    const wrapper = mountTerminal(true);
    const e = keydown('A', { shiftKey: true });
    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(wrapper.emitted('typed')).toEqual([['A']]);
  });

  it('leaves control keys to the shell, uncancelled and unannounced', () => {
    const wrapper = mountTerminal(true);
    for (const e of [
      keydown('c', { ctrlKey: true }),
      keydown('Enter'),
      keydown('Escape'),
      keydown('ArrowUp'),
      keydown('Tab'),
      keydown(' '),
    ]) {
      expect(customKeyHandler!(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(wrapper.emitted('typed')).toBeUndefined();
  });

  it('does nothing at all when the intercept is off', () => {
    const wrapper = mountTerminal(false);
    const e = keydown('a');
    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(wrapper.emitted('typed')).toBeUndefined();
  });

  it('ignores keyup and keypress, so one keystroke cannot emit twice', () => {
    // xterm consults this handler for more than keydown. Only keydown decides.
    const wrapper = mountTerminal(true);
    customKeyHandler!(keydown('a'));
    customKeyHandler!(new KeyboardEvent('keypress', { key: 'a', cancelable: true }));
    customKeyHandler!(new KeyboardEvent('keyup', { key: 'a', cancelable: true }));
    expect(wrapper.emitted('typed')).toHaveLength(1);
  });
});
