// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * A shell that exited must stop answering registry lookups.
 *
 * `shellIdFor` is how every surface that aims bytes at a pane by session key
 * finds the channel to write to, and the pane keeps its tab (and therefore its
 * registration) mounted long after the session's worker is gone. An exit that
 * left the entry standing made the next `shellIdFor` answer with a CORPSE —
 * and the agent launch is the caller that hurt: recreating a session under the
 * same workspace and tag resolved `armLaunch`'s watcher on the spot, the
 * `pocketshell agent …` line was written into the closed channel, main dropped
 * it for an id it no longer tracked, and the user was left in a plain shell
 * with no message, because the launch counted as delivered. The exit handler
 * now unregisters, so the watcher waits for the re-join's real id.
 */

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
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
    activate(): void {}
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 };
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

/** The exit events main has broadcast, captured so a test can fire them. */
let exitHandlers: ((e: { shellId: string }) => void)[] = [];

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(async () => ({ shellId: 'shell-1', switched: false })),
      input: vi.fn(async () => true),
      resize: vi.fn(async () => true),
      redraw: vi.fn(async () => true),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn((cb: (e: { shellId: string }) => void) => {
        exitHandlers.push(cb);
        return () => undefined;
      }),
    },
  },
}));

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  exitHandlers = [];
});

async function mountTerminal(): Promise<VueWrapper> {
  const wrapper = mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', sessionName: 'main' },
  });
  await flush();
  return wrapper;
}

describe('a shell exit clears the pane from the shells registry', () => {
  it('unregisters the session key when its shell exits', async () => {
    const { useShellsStore } = await import('../../src/renderer/stores/shells');
    const shells = useShellsStore();
    const wrapper = await mountTerminal();
    expect(shells.shellIdFor('main')).toBe('shell-1');

    exitHandlers.at(-1)?.({ shellId: 'shell-1' });
    await flush();

    expect(shells.shellIdFor('main')).toBeNull();
    wrapper.unmount();
  });

  it('never drops a registration a re-join has already replaced', async () => {
    const { useShellsStore } = await import('../../src/renderer/stores/shells');
    const shells = useShellsStore();
    const wrapper = await mountTerminal();

    // The re-join won the race: a newer id is live under the key when the old
    // shell's exit event finally lands. The store's id guard is what keeps the
    // live registration; the handler must not bypass it.
    shells.register('main', 'shell-2');
    exitHandlers.at(-1)?.({ shellId: 'shell-1' });
    await flush();

    expect(shells.shellIdFor('main')).toBe('shell-2');
    wrapper.unmount();
  });
});
