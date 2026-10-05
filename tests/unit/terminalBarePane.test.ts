// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * A bare pane — a PTY of our own running a command, with no session behind
 * it. The maintenance workspace's `htop` pane is the user this serves.
 *
 * Two rules are pinned here, both about what a bare pane is NOT:
 *
 *  - It never joins. The `sessionName ?? sessionKey` fallback exists so a
 *    session-shaped pane can be keyed by identity alone; a bare pane carries
 *    the same sessionKey and MUST NOT have it read as a session to attach —
 *    main would go looking for a tmux session that does not exist.
 *  - It registers under its sessionKey, not under the bare-shell '' —
 *    `targetSession` is deliberately '' in bare mode (that is what keeps
 *    `requestShell` on the plain-shell branch), and a registry key derived
 *    from it would point every bare pane in the app at one slot.
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

vi.mock('@ui/app/ipc', () => ({
  api: {
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(async () => ({ shellId: 'joined', switched: false })),
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

/** jsdom has no ResizeObserver; the pane's wiring asserts on one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const TerminalView = (await import('@ui/app/components/TerminalView.vue')).default;
const { api } = (await import('@ui/app/ipc')) as unknown as {
  api: { shell: Record<string, ReturnType<typeof vi.fn>> };
};
const { useShellsStore } = await import('@ui/app/stores/shells');

function mountBare() {
  return mount(TerminalView, {
    props: {
      connectionId: 'conn-1',
      sessionKey: 'tool:htop',
      command: 'htop',
      bare: true,
      interceptTyping: false,
    },
    attachTo: document.body,
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

describe('a bare pane', () => {
  it('opens a plain shell carrying its command, and never joins', async () => {
    const wrapper = mountBare();
    await flushPromises();

    expect(api.shell.attachSession).not.toHaveBeenCalled();
    expect(api.shell.open).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      command: 'htop',
      cols: 80,
      rows: 24,
    });
    wrapper.unmount();
  });

  it('registers under its own identity, not the bare-shell slot', async () => {
    const wrapper = mountBare();
    await flushPromises();

    const shells = useShellsStore();
    expect(shells.shellIdFor('tool:htop')).toBe('shell-1');
    wrapper.unmount();
  });
});
