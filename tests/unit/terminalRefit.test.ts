// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The re-fit, which is the part of a size change that reaches the far end.
 *
 * Two bugs already fixed in this app came from a grid computed against a cell
 * that had since changed: the sliced tmux status line (7d7cdad) and the
 * font-size wiring (4c0f555). The failure is nasty because it is silent on
 * this side — xterm keeps painting a perfectly nice terminal, at the wrong
 * size — while the PTY on the far end is never told, so tmux goes on drawing
 * to the old geometry and the row the user reads to know which session they
 * are in is the one that gets clipped.
 *
 * Zoom is the third route into the same failure and the reason this file
 * exists: it does not change the cell in CSS px at all, it changes how many
 * cells the window holds. Same wrong grid, same untold PTY.
 *
 * These tests assert the SCHEDULING rather than the resulting cols/rows,
 * because jsdom lays nothing out — there is no cell to measure. That the
 * measurement itself follows from the option assignment was verified against
 * the real xterm 6.0.0 in Electron: 16px -> 24px takes an 800x600 pane from
 * 87x30 to 58x20 and the row box from 19px to 28px, and only after `fit()`.
 * What can regress here, and what these pin, is whether `fit()` is asked for
 * at all.
 */

/** Every `fit()` the component asks for, in order. */
let fits = 0;
/** Every `focus()` the component asks xterm for. */
let focuses = 0;
/** The live `unicode` object of the mounted terminal, so widths can be read. */
let termUnicode: { activeVersion: string } | undefined;
/** The live options object of the mounted terminal, so writes can be read. */
let termOptions: Record<string, unknown> = {};
/** Pending animation-frame callbacks, run by hand so timing is deterministic. */
let frames: FrameRequestCallback[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) {
      // xterm merges constructor options into its options object, and the
      // component reads the settings store for the initial font — so this is
      // also where "the first render already honours the setting" is visible.
      this.options = { ...opts };
      termOptions = this.options;
      termUnicode = this.unicode;
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {
      focuses++;
    }
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
    attachCustomKeyEventHandler(): void {}
    unicode = {
      activeVersion: '6',
      register: (): void => {},
    };
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      fits++;
    }
    // A PLAUSIBLE grid, not `undefined`.
    //
    // It used to answer undefined, which was fine while nothing read it and
    // wrong the moment something did: the component now asks what a fit WOULD
    // produce and declines to perform one that is degenerate, because a fit to
    // a transient four-column box reflows xterm's buffer and the far end's with
    // it (see MIN_REMOTE_COLS in TerminalView.vue). Undefined is the real
    // addon's "I cannot measure" answer — the zero case by another name — so a
    // double that returns it is asserting the hidden-pane path in every test in
    // this file, none of which is about that.
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 };
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
      redraw: vi.fn(async () => true),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;
const { useSettingsStore } = await import('../../src/renderer/stores/settings');

/**
 * Give the pane a size. jsdom lays nothing out, so `clientWidth/clientHeight`
 * are 0 on every element — which is exactly the "hidden pane" geometry the
 * component refuses to fit against, so without this every test would pass
 * vacuously by never fitting at all.
 */
function setPaneSize(wrapper: VueWrapper, width: number, height: number): void {
  for (const [prop, value] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ] as const) {
    Object.defineProperty(wrapper.element, prop, { value, configurable: true });
  }
}

/** Run whatever is queued for the next frame, the way the browser would. */
function runFrames(): void {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(performance.now());
}

/** Settle the watcher and then let its scheduled fit actually happen. */
async function settle(): Promise<void> {
  await nextTick();
  runFrames();
}

async function mountTerminal(): Promise<VueWrapper> {
  const wrapper = mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main' },
    attachTo: document.body,
  });
  setPaneSize(wrapper, 800, 600);
  // onMounted awaits showTarget(); let its microtasks drain. Ten ticks rather
  // than two because the join is three async frames deep — and because
  // `showTarget` now measures again on the far side of it, so a count taken
  // too early leaves that fit to land in the middle of the test it precedes.
  for (let i = 0; i < 10; i++) await nextTick();
  fits = 0;
  frames = [];
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  fits = 0;
  focuses = 0;
  termOptions = {};
  termUnicode = undefined;
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

describe('the terminal re-fits when the cell or the viewport changes', () => {
  it('opens at the stored terminal font size, not at the shipped default', async () => {
    useSettingsStore().set('terminalFontSize', 22);
    await mountTerminal();
    expect(termOptions['fontSize']).toBe(22);
  });

  it('parses every pane under the Unicode 11 width tables', async () => {
    // terminalUnicode.ts: under xterm's default (Unicode 6) provider emoji
    // measure one column, and the font draws two — the next cell paints over
    // the overflow. The switch must happen at construction, before the first
    // output byte is parsed; cells keep the width they were parsed with.
    await mountTerminal();
    expect(termUnicode?.activeVersion).toBe('11');
  });

  it('applies a font-size change AND asks for a fit', async () => {
    const settings = useSettingsStore();
    await mountTerminal();

    settings.set('terminalFontSize', 24);
    await settle();

    expect(termOptions['fontSize']).toBe(24);
    // Without this the grid stays as it was measured against the 16px cell,
    // and the PTY is never told the row count moved.
    expect(fits).toBe(1);
  });

  it('asks for a fit when ZOOM changes, though the cell is untouched', async () => {
    // Zoom does not move `fontSize` — a CSS pixel is zoom-invariant. What it
    // moves is how many of them the window holds, which is the same wrong
    // grid arriving by a different road.
    const settings = useSettingsStore();
    await mountTerminal();
    const sizeBefore = termOptions['fontSize'];

    settings.zoomIn();
    await settle();

    expect(termOptions['fontSize']).toBe(sizeBefore);
    expect(fits).toBe(1);
  });

  it('re-fits on every zoom step, including the reset', async () => {
    const settings = useSettingsStore();
    await mountTerminal();

    settings.zoomIn();
    await settle();
    settings.zoomOut();
    await settle();
    settings.zoomIn();
    await settle();
    settings.resetZoom();
    await settle();

    expect(fits).toBe(4);
  });

  it('does not fit when zoom is written but does not change', async () => {
    const settings = useSettingsStore();
    await mountTerminal();

    // Already at 100%: reset is a no-op, and a no-op must not churn the PTY.
    settings.resetZoom();
    await settle();
    expect(fits).toBe(0);

    // Same at the ceiling, where zoomIn can no longer move.
    settings.set('zoomPercent', 200);
    await settle();
    fits = 0;
    settings.zoomIn();
    await settle();
    expect(fits).toBe(0);
  });

  it('applies a family change and re-fits — a new face is a new cell width', async () => {
    const settings = useSettingsStore();
    await mountTerminal();

    settings.set('monospaceFontFamily', 'JetBrains Mono');
    await settle();

    expect(termOptions['fontFamily']).toBe(
      `"JetBrains Mono", Consolas, 'Cascadia Mono', ui-monospace, monospace`,
    );
    expect(fits).toBe(1);
  });

  it('coalesces a burst into ONE fit per frame', async () => {
    // `fit()` writes xterm's dimensions, which the ResizeObserver can observe
    // again; without coalescing a size change and a zoom change in the same
    // tick would each cost a fit, and a drag-resize would cost dozens.
    const settings = useSettingsStore();
    await mountTerminal();

    settings.set('terminalFontSize', 20);
    settings.zoomIn();
    settings.set('monospaceFontFamily', 'Hack');
    await settle();

    expect(fits).toBe(1);
  });

  it('skips the fit for a pane with no geometry, rather than pushing a 1x1 PTY', async () => {
    // A pane behind another tab measures 0x0. Fitting against that proposes a
    // one-cell terminal and sends it to the remote, where tmux reflows every
    // window to match. It needs no retry latch: coming back into view is
    // itself a size change, so the ResizeObserver fits with whatever the
    // settings became while it was hidden.
    const settings = useSettingsStore();
    const wrapper = await mountTerminal();
    setPaneSize(wrapper, 0, 0);

    settings.set('terminalFontSize', 24);
    await settle();

    expect(fits).toBe(0);
    // The option is still applied, so the fit that follows on re-show measures
    // the right cell.
    expect(termOptions['fontSize']).toBe(24);
  });

  it('does not steal focus from another input when reconnect reattaches the pane', async () => {
    const wrapper = await mountTerminal();
    const composerInput = document.createElement('textarea');
    document.body.appendChild(composerInput);
    composerInput.focus();
    const focusesBeforeReconnect = focuses;

    await wrapper.setProps({ connectionId: 'conn-2' });
    for (let i = 0; i < 10; i++) await nextTick();

    expect(focuses).toBe(focusesBeforeReconnect);
    expect(document.activeElement).toBe(composerInput);
    composerInput.remove();
    wrapper.unmount();
  });
});
