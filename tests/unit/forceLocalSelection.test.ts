// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Plain drag must select in the pane even while the remote owns the mouse.
 *
 * The report this pins: "I still can't select code in the terminal — I have a
 * use case where I want to copy-paste something and the highlight
 * disappears". The highlight belonged to TMUX: with mouse reporting on, xterm
 * handed button events to the remote, tmux ran its copy-mode selection, and
 * its drag-end (`copy-pipe; cancel`) dismissed the highlight the instant the
 * button went up. Commit e0e0a68 made that yank reach the clipboard through
 * OSC 52, but nothing on screen ever said so — from the user's seat selection
 * was still broken.
 *
 * The fix replaces xterm's `SelectionService.shouldForceSelection` predicate
 * — the one hook its own code consults before reporting a mousedown — so a
 * button-1 press forces the LOCAL selection service (which then drags and
 * persists normally) with or without Shift, and ALT keeps a hand-off to the
 * remote: the gesture goes to tmux, whose yank arrives as OSC 52.
 * terminalMouseSelection.ts documents the mechanism and the shape-checked
 * private-API access.
 *
 * The wiring test below pins that TerminalView actually applies the patch at
 * mount, because the failure shape of this fix is silence: a future xterm
 * upgrade that renames `_core._selectionService` would quietly hand the
 * vanishing gesture back, exactly the class of dead-by-upgrade failure the
 * diag record in the component exists to catch.
 */

import { forceLocalMouseSelection } from '../../src/renderer/terminalMouseSelection';

/** A predicate with xterm's real off-macOS semantics, as shipped in 6.0.0. */
const stockShouldForce = (event: MouseEvent): boolean => event.shiftKey;

function fakeTerm(shouldForce: unknown): unknown {
  return { _core: { _selectionService: { shouldForceSelection: shouldForce } } };
}

function mouse(shift: boolean, alt = false): MouseEvent {
  return new MouseEvent('mousedown', { shiftKey: shift, altKey: alt, bubbles: true });
}

describe('forceLocalMouseSelection — the predicate', () => {
  it('makes a PLAIN button-1 press force local selection', () => {
    const term = fakeTerm(stockShouldForce);
    expect(forceLocalMouseSelection(term)).toBe(true);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(false))).toBe(true);
  });

  it('makes a SHIFT drag force local selection too — the muscle-memory grip', () => {
    // Shift+drag is the older convention xterm's stock bypass was built on.
    // An earlier revision of the patch handed Shift to tmux instead, which
    // brought the vanishing highlight back under that grip — this pins the
    // reversal.
    const term = fakeTerm(stockShouldForce);
    forceLocalMouseSelection(term);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(true))).toBe(true);
  });

  it('keeps ALT as the hand-off to the remote', () => {
    // Alt is the deliberate escape hatch back to tmux's own mouse gestures
    // (copy-mode drag with its OSC 52 yank, pane focus in splits). Alt wins
    // regardless of Shift, so the remote path is unambiguous.
    const term = fakeTerm(stockShouldForce);
    forceLocalMouseSelection(term);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(false, true))).toBe(false);
    expect(svc.shouldForceSelection(mouse(true, true))).toBe(false);
  });

  it('replaces the stock predicate rather than wrapping it', () => {
    // The stock answer (shiftKey) must not survive anywhere in the decision:
    // a wrapper that consulted it first would let Shift's old remote meaning
    // leak back into the muscle-memory grip.
    const term = fakeTerm(stockShouldForce);
    forceLocalMouseSelection(term);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: unknown } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection).not.toBe(stockShouldForce);
  });

  it('answers false and throws nothing on every mismatched shape', () => {
    const shapes: unknown[] = [
      undefined,
      null,
      42,
      {},
      { _core: null },
      { _core: {} },
      { _core: { _selectionService: null } },
      { _core: { _selectionService: undefined } },
      { _core: { _selectionService: 'not an object' } },
      { _core: { _selectionService: {} } },
      { _core: { _selectionService: { shouldForceSelection: 42 } } },
      { _core: { _selectionService: { shouldForceSelection: null } } },
    ];
    for (const shape of shapes) {
      expect(forceLocalMouseSelection(shape)).toBe(false);
    }
  });

  it('is safe to call twice — the patch re-applies and keeps working', () => {
    const term = fakeTerm(stockShouldForce);
    expect(forceLocalMouseSelection(term)).toBe(true);
    expect(forceLocalMouseSelection(term)).toBe(true);
    const svc = (term as { _core: { _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } } })
      ._core._selectionService;
    expect(svc.shouldForceSelection(mouse(false))).toBe(true);
    expect(svc.shouldForceSelection(mouse(true))).toBe(true);
    expect(svc.shouldForceSelection(mouse(false, true))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The wiring: TerminalView applies the patch at mount
// ---------------------------------------------------------------------------

/** Set by the fake terminal; holds the service the component must have patched. */
let selectionService: { shouldForceSelection: (e: MouseEvent) => boolean } | null = null;
/** What the fake terminal answers about its selection — driven per test. */
let fakeSelection = { has: false, text: '' };
/** Every fake terminal instance the component mounted. */
const terminals: unknown[] = [];
/** The clipboard writer the component is handed; asserted per test. */
const writeText = vi.fn(async () => {});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
    dispose(): void {}
    hasSelection(): boolean {
      return fakeSelection.has;
    }
    getSelection(): string {
      return fakeSelection.text;
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
    attachCustomKeyEventHandler(): void {}
    constructor() {
      selectionService = { shouldForceSelection: stockShouldForce };
      (this as { _core?: unknown })._core = { _selectionService: selectionService };
      terminals.push(this);
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
    diag: {
      log: vi.fn(),
    },
  },
}));

describe('TerminalView applies the patch at mount', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    selectionService = null;
    fakeSelection = { has: false, text: '' };
    terminals.length = 0;
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn(async () => ''), writeText },
    });
  });

  it('replaces the selection predicate on the terminal it mounts', async () => {
    const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;
    const wrapper = mount(TerminalView, {
      props: { connectionId: 'conn-1', sessionKey: 'main' },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(selectionService).not.toBeNull();
    expect(selectionService!.shouldForceSelection).not.toBe(stockShouldForce);
    expect(selectionService!.shouldForceSelection(mouse(false))).toBe(true);
    expect(selectionService!.shouldForceSelection(mouse(true))).toBe(true);
    expect(selectionService!.shouldForceSelection(mouse(false, true))).toBe(false);
    wrapper.unmount();
  });

  it('copies a forced-path drag on mouse-up, even though xterm stopped the mousedown', async () => {
    // The forced-local mousedown is answered by xterm's SelectionService with
    // `stopPropagation()` — verified against xterm 6.0.0's handleMouseDown. A
    // bubble-phase listener on this component's container therefore never ran,
    // `selecting` stayed unarmed, and a completed drag selected on screen
    // without ever reaching the clipboard — the copy-paste use case this pane
    // exists for. The listener must be CAPTURE-phase to survive that.
    const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;
    const wrapper = mount(TerminalView, {
      props: { connectionId: 'conn-1', sessionKey: 'main' },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 0));

    // Stand in for xterm's selection layer: a child whose mousedown handler
    // stops propagation, exactly as SelectionService.handleMouseDown does on
    // the forced path.
    const child = document.createElement('div');
    child.addEventListener('mousedown', (e) => e.stopPropagation());
    (wrapper.element as HTMLElement).appendChild(child);

    const mousedown = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    child.dispatchEvent(mousedown);
    // xterm holds the selection the drag produced by the time the button
    // comes up.
    fakeSelection = { has: true, text: 'DRAGGED CODE' };
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(writeText).toHaveBeenCalledWith('DRAGGED CODE');
    wrapper.unmount();
  });

  it('does not copy on a mouse-up with no armed drag', async () => {
    // The gate that keeps an unrelated click elsewhere from re-copying a
    // stale selection — pinned here so the capture-phase change above cannot
    // quietly become "copy on every mouse-up".
    const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;
    const wrapper = mount(TerminalView, {
      props: { connectionId: 'conn-1', sessionKey: 'main' },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 0));

    fakeSelection = { has: true, text: 'STALE' };
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(writeText).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
