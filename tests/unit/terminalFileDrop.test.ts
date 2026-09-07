// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Dropping a file on the terminal pane, ROUTED.
 *
 * The user's request: "when I drag+drop a file to the terminal session I want
 * to attach it". Attach means the composer's staging path — the same one the
 * card's own drop zone, the draft paste and the clipboard paste share — so
 * TerminalView's whole job is to recognise the gesture, cancel it and hand the
 * bare File objects up. Everything after that is pinned by
 * composerTerminalDrop.test.ts on the other side of the join.
 *
 * ## What only this side can assert
 *
 * The `preventDefault`s. Before this feature a drag carrying files over the
 * pane was claimed by nobody, and Chromium's default drop action in Electron
 * is to NAVIGATE the window to the dropped file — the whole session UI
 * replaced by a local file:// page. `dragover` must be cancelled for `drop` to
 * be allowed at all (the browser contract), and `drop` must be cancelled so
 * the navigation never happens. jsdom cannot perform the default action, so —
 * as in terminalPasteChord.test.ts — the assertions are `defaultPrevented`
 * plus the emit, which are the things that make the default impossible.
 *
 * ## Only a drag advertising Files is claimed
 *
 * Tab drags cross this pane on their way up and down the strip (the composer
 * learned this in its `onDragOver`); they advertise the strip's own mime type
 * and must keep falling through. A file drag advertises `Files`, which
 * `dataTransfer.types` exposes during `dragover` — unlike `files` itself,
 * which the browser deliberately keeps empty until the drop.
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

/**
 * A drag event the way the browser makes one. jsdom's DragEvent carries no
 * usable `dataTransfer`, so one is bolted on — with `types`, the only thing
 * the dragover handler may look at, and `files`, which only drop sees.
 */
function dragEvent(
  type: 'dragover' | 'dragleave' | 'drop',
  opts: { types?: string[]; files?: File[]; relatedTarget?: Node | null } = {},
): DragEvent {
  const e = new Event(type, { cancelable: true, bubbles: true }) as DragEvent;
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: opts.types ?? [],
      files: opts.files ?? [],
      dropEffect: 'none',
    },
  });
  Object.defineProperty(e, 'relatedTarget', { value: opts.relatedTarget ?? null });
  return e;
}

function file(name: string, type = 'application/pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function mountTerminal() {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping: false },
    attachTo: document.body,
  });
}

const filesType = ['Files'];
const tabType = ['application/x-pocketshell-tab'];

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('dragover — the promise that a drop will be accepted', () => {
  it('cancels a Files drag and arms the affordance', async () => {
    const wrapper = mountTerminal();
    const e = dragEvent('dragover', { types: filesType });

    (wrapper.element as HTMLElement).dispatchEvent(e);
    await wrapper.vm.$nextTick();

    expect(e.defaultPrevented).toBe(true);
    expect(wrapper.classes()).toContain('drop-target');
    wrapper.unmount();
  });

  it('offers to copy, not to move or link', async () => {
    // A file drag's default dropEffect is platform-chosen (often 'move' on
    // Windows). This feature uploads; the original never has to survive it.
    const wrapper = mountTerminal();
    const e = dragEvent('dragover', { types: filesType });

    (wrapper.element as HTMLElement).dispatchEvent(e);

    expect((e.dataTransfer as unknown as { dropEffect: string }).dropEffect).toBe('copy');
    wrapper.unmount();
  });

  it('leaves a tab drag alone — it belongs to the strip', async () => {
    const wrapper = mountTerminal();
    const e = dragEvent('dragover', { types: tabType });

    (wrapper.element as HTMLElement).dispatchEvent(e);
    await wrapper.vm.$nextTick();

    expect(e.defaultPrevented).toBe(false);
    expect(wrapper.classes()).not.toContain('drop-target');
    wrapper.unmount();
  });
});

describe('dragleave — the affordance ends only when the pane is left', () => {
  it('survives crossing the children of the pane on the way to the drop', async () => {
    // dragleave fires for every child the drag crosses; clearing on each one
    // would strobe the outline while the drag is still over the pane. A child
    // is planted in the container because the mocked xterm paints none.
    const wrapper = mountTerminal();
    const child = document.createElement('div');
    (wrapper.element as HTMLElement).appendChild(child);
    (wrapper.element as HTMLElement).dispatchEvent(dragEvent('dragover', { types: filesType }));
    await wrapper.vm.$nextTick();

    (wrapper.element as HTMLElement).dispatchEvent(
      dragEvent('dragleave', { types: filesType, relatedTarget: child }),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.classes()).toContain('drop-target');
    wrapper.unmount();
  });

  it('clears when the drag leaves the pane', async () => {
    const wrapper = mountTerminal();
    (wrapper.element as HTMLElement).dispatchEvent(dragEvent('dragover', { types: filesType }));
    await wrapper.vm.$nextTick();

    (wrapper.element as HTMLElement).dispatchEvent(dragEvent('dragleave', { relatedTarget: null }));
    await wrapper.vm.$nextTick();

    expect(wrapper.classes()).not.toContain('drop-target');
    wrapper.unmount();
  });
});

describe('drop — the gesture, handed to the composer', () => {
  it('cancels the default and emits the File objects', async () => {
    // Cancelling is not bookkeeping: uncancelled, Chromium navigates the
    // window to the first dropped file. The payload is bare Files because a
    // DataTransfer dies with the event — the composer cannot re-read it later
    // the way it re-reads a clipboard.
    const wrapper = mountTerminal();
    const a = file('notes.txt', 'text/plain');
    const b = file('shot.png', 'image/png');
    const e = dragEvent('drop', { types: filesType, files: [a, b] });

    (wrapper.element as HTMLElement).dispatchEvent(e);
    await wrapper.vm.$nextTick();

    expect(e.defaultPrevented).toBe(true);
    const emissions = wrapper.emitted('drop-into-composer');
    expect(emissions).toHaveLength(1);
    expect(emissions![0]).toEqual([[a, b]]);
    wrapper.unmount();
  });

  it('clears the affordance once the drop lands', async () => {
    const wrapper = mountTerminal();
    (wrapper.element as HTMLElement).dispatchEvent(dragEvent('dragover', { types: filesType }));
    await wrapper.vm.$nextTick();

    (wrapper.element as HTMLElement).dispatchEvent(
      dragEvent('drop', { types: filesType, files: [file('a.bin')] }),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.classes()).not.toContain('drop-target');
    wrapper.unmount();
  });

  it('stays out of drags that carry no files', async () => {
    // A text drag (say, a selection off a web page) has its own platform
    // meaning. This pane claims files and only files.
    const wrapper = mountTerminal();
    const e = dragEvent('drop', { types: ['text/plain'] });

    (wrapper.element as HTMLElement).dispatchEvent(e);
    await wrapper.vm.$nextTick();

    expect(e.defaultPrevented).toBe(false);
    expect(wrapper.emitted('drop-into-composer')).toBeUndefined();
    wrapper.unmount();
  });
});
