// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The shared TerminalView's `terminal.inputAdapter` slot (@ui/app/extensions):
 * a platform's input filter is attached to every terminal's helper textarea
 * once it opens, detached on unmount, and its bytes go through `term.input`
 * — the same route a keystroke takes. With nothing contributed, nothing is
 * attached, which is the desktop's own configuration.
 */

const textarea = document.createElement('textarea');
const inputCalls: Array<[string, boolean | undefined]> = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    textarea: HTMLTextAreaElement | undefined = undefined;
    loadAddon(): void {}
    open(): void {
      this.textarea = textarea;
    }
    focus(): void {}
    reset(): void {}
    write(): void {}
    paste(): void {}
    dispose(): void {}
    input(data: string, wasUserInput?: boolean): void {
      inputCalls.push([data, wasUserInput]);
    }
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
      attachSession: vi.fn(async () => ({ ok: true, shellId: 'shell-1' })),
      input: vi.fn(async () => true),
      resize: vi.fn(async () => true),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

const TerminalView = (await import('@ui/app/components/TerminalView.vue')).default;
const { provideExtensions } = await import('@ui/app/extensions');
type Target = import('@ui/app/extensions').TerminalInputTarget;

beforeEach(() => {
  setActivePinia(createPinia());
  inputCalls.length = 0;
});

afterEach(() => {
  provideExtensions({});
});

describe('TerminalView terminal.inputAdapter slot', () => {
  it('attaches each adapter to the xterm textarea, with a sendInput that types', () => {
    const detach = vi.fn();
    const attach = vi.fn((_target: Target) => detach);
    provideExtensions({ 'terminal.inputAdapter': [{ id: 'ime', attach }] });

    const wrapper = mount(TerminalView, { props: { connectionId: 'conn-1', sessionKey: 'main' } });
    expect(attach).toHaveBeenCalledOnce();
    const target = attach.mock.calls[0]![0];
    expect(target.textarea).toBe(textarea);
    expect(target.element).toBe(wrapper.element);
    expect(target.sessionKey).toBe('main');

    target.sendInput('ls\r');
    expect(inputCalls).toEqual([['ls\r', true]]);

    expect(detach).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('attaches nothing when no adapter is contributed', () => {
    const wrapper = mount(TerminalView, { props: { connectionId: 'conn-1', sessionKey: 'main' } });
    // The exposed sendInput still types through the same route.
    (wrapper.vm as unknown as { sendInput: (d: string) => void }).sendInput('x');
    expect(inputCalls).toEqual([['x', true]]);
    wrapper.unmount();
  });
});
