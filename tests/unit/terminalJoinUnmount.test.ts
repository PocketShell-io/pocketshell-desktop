// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * An unmount that lands inside the join.
 *
 * Reported live on 2026-09-12 as the app-wide diag banner `Failed to execute
 * 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'`,
 * thrown from `TerminalPane.observeContainer` out of the tail of
 * TerminalView's `onMounted`: the hook `await`s `pane.open()` — seconds on a
 * real host — and the workspace tore the pane down inside that await. The
 * unmount had already run the teardown hook (refs released, pane detached),
 * so the resumed continuation observed `null` and re-armed a corpse: the
 * banner, a leaked window resize listener, a live probe timer on a dead pane.
 *
 * The contract pinned here: a join that outlives its pane adds NOTHING —
 * no resize listener, no ResizeObserver, no probing. A join its pane
 * survives still wires all three.
 */

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
    attachCustomKeyEventHandler(): void {}
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

/**
 * The join, held in the test's hands. `pane.open()` reaches the shell only
 * through this promise, so the test decides whether the join outlives the
 * pane — the race the component must survive.
 */
let join: { resolve: (result: { shellId: string; switched: boolean }) => void } | null = null;

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(
        () =>
          new Promise<{ shellId: string; switched: boolean }>((resolve) => {
            join = { resolve };
          }),
      ),
      input: vi.fn(async () => true),
      resize: vi.fn(async () => true),
      redraw: vi.fn(async () => true),
      close: vi.fn(async () => true),
      windowSize: vi.fn(async () => ({ kind: 'bare' as const })),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

/** jsdom has no ResizeObserver; a recording stub is the whole point here. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  observed: unknown[] = [];
  constructor(_callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;

function mountTerminal() {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping: false },
    attachTo: document.body,
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  ResizeObserverStub.instances = [];
  join = null;
});

describe('the join outlived its pane', () => {
  it('wires nothing on a pane torn down during the join', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const wrapper = mountTerminal();
    await flushPromises();
    expect(join).not.toBeNull();

    wrapper.unmount();
    join!.resolve({ shellId: 'shell-1', switched: false });
    await flushPromises();

    expect(addSpy).not.toHaveBeenCalledWith('resize', expect.any(Function));
    expect(ResizeObserverStub.instances).toHaveLength(0);
    addSpy.mockRestore();
  });

  it('still wires everything when the pane survives its join', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const wrapper = mountTerminal();
    await flushPromises();

    join!.resolve({ shellId: 'shell-1', switched: false });
    await flushPromises();

    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(ResizeObserverStub.instances).toHaveLength(1);
    expect(ResizeObserverStub.instances[0]!.observed).toEqual([wrapper.element]);
    wrapper.unmount();
    addSpy.mockRestore();
  });
});
