// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * Does the FAR END know how big we are?
 *
 * `terminalRefit.test.ts` next door pins the other half of this: whether a
 * `fit()` is asked for at all when the cell or the viewport changes. It cannot
 * see this half, because its fake `fit()` only counts calls — xterm's
 * dimensions never move in it, so `onResize` never fires and the question of
 * what reached the PTY never arises.
 *
 * It arises constantly in the real app, and it is the bug the user reported
 * twice: a tmux status line sitting eighteen rows above the bottom of the pane
 * with the same stale line repeated underneath. That picture means xterm has
 * more rows than the PTY was ever told about — tmux drew its status line where
 * it believed the screen ended and never touched anything below, so those rows
 * still hold whatever the renderer last put there.
 *
 * The two ways geometry failed to arrive, both pinned below:
 *
 *   1. A resize that fires with NO SHELL TO SEND IT TO. A tab joins by opening
 *      an SSH channel, a login shell and `tmuxctl` — 1.5-2 s on the user's
 *      host — and the pane is laid out during that window. The old handler
 *      read `if (shellId)` and dropped it, and `showTarget` then sent the
 *      cols/rows it had captured BEFORE the await. The far end was told a size
 *      the pane no longer had, permanently, because from xterm's side nothing
 *      was going to change again.
 *
 *   2. A size that is right here and stale there. A tab that comes back into
 *      view at the size it was hidden at produces no `onResize` at all, so
 *      nothing was sent — even though its tmux client may have been resized by
 *      something else entirely in the meantime.
 *
 * So these tests drive the geometry rather than counting fits: the fake
 * FitAddon writes a controllable size onto the fake Terminal and fires its
 * `onResize` listeners exactly as xterm does, and the assertions are about the
 * `api.shell.resize` / `api.shell.redraw` calls that came out of the far side.
 */

/** What `fit()` will write onto the terminal next time it runs. */
let paneGrid = { cols: 80, rows: 24 };
/** Pending animation-frame callbacks, run by hand so timing is deterministic. */
let frames: FrameRequestCallback[] = [];
/** Resolves the pending `attachSession`, so the join can be held open. */
let releaseJoin: (() => void) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    resizeListeners: ((size: { cols: number; rows: number }) => void)[] = [];
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
    }
    // Real xterm hands each addon the terminal through `activate`, and the
    // fake FitAddon below needs that handle to resize anything. Doing it the
    // way xterm does keeps the fake honest and saves a module-level alias.
    loadAddon(addon: { activate?: (term: unknown) => void }): void {
      addon.activate?.(this);
    }
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
    onResize(cb: (size: { cols: number; rows: number }) => void): { dispose: () => void } {
      this.resizeListeners.push(cb);
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
    // xterm's real FitAddon resizes the terminal only when the proposal
    // differs, and `Terminal.resize` is what fires `onResize`. Both halves
    // matter here: the first is why a tab returning at its old size sends
    // nothing on its own, and the second is the path the old code relied on
    // exclusively.
    private term: { cols: number; rows: number; resizeListeners: unknown[] } | null = null;
    activate(term: unknown): void {
      this.term = term as { cols: number; rows: number; resizeListeners: unknown[] };
    }
    fit(): void {
      const term = this.term;
      if (!term) return;
      if (term.cols === paneGrid.cols && term.rows === paneGrid.rows) return;
      term.cols = paneGrid.cols;
      term.rows = paneGrid.rows;
      for (const cb of term.resizeListeners as ((s: {
        cols: number;
        rows: number;
      }) => void)[]) {
        cb({ cols: term.cols, rows: term.rows });
      }
    }
    proposeDimensions(): { cols: number; rows: number } {
      return paneGrid;
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// Typed argument lists, not `vi.fn(async () => true)`: an inferred zero-arg
// spy makes `mock.calls` a tuple of length 0, and the assertions below are
// entirely about WHICH cols and rows were sent.
const resize = vi.fn(async (_shellId: string, _cols: number, _rows: number) => true);
const redraw = vi.fn(async (_shellId: string) => true);

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(
        async () =>
          new Promise<{ shellId: string; switched: boolean }>((resolveJoin) => {
            const settle = (): void => resolveJoin({ shellId: 'shell-1', switched: false });
            if (releaseJoin === null) settle();
            else releaseJoin = settle;
          }),
      ),
      input: vi.fn(async () => true),
      resize: (...args: [string, number, number]) => resize(...args),
      redraw: (...args: [string]) => redraw(...args),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

const TerminalView = (await import('../../src/renderer/components/TerminalView.vue')).default;

/** jsdom lays nothing out, so the pane's measured size has to be asserted. */
function setPaneSize(wrapper: VueWrapper, width: number, height: number): void {
  for (const [prop, value] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ] as const) {
    Object.defineProperty(wrapper.element, prop, { value, configurable: true });
  }
}

function runFrames(): void {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(performance.now());
}

/**
 * Drive the component's own resize path.
 *
 * jsdom has no ResizeObserver, so the container observer the app relies on
 * never exists here; the window listener the component also binds is the same
 * `scheduleFit` entry point and is reachable. `runFrames` then performs the
 * coalesced fit it queued.
 */
async function paneResized(): Promise<void> {
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  runFrames();
}

/**
 * Drain the microtask queue.
 *
 * A join is `showTarget` -> `requestShell` -> `attachSession`, three async
 * frames deep, and the geometry push that matters here happens on the far side
 * of all of them. Counting ticks by hand is how a test ends up asserting
 * against a component that has not finished mounting; this just runs the queue
 * dry.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick();
}

/** Every geometry the far end was told, in order. */
function sentSizes(): [number, number][] {
  return resize.mock.calls.map((c) => [c[1], c[2]]);
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  frames = [];
  paneGrid = { cols: 80, rows: 24 };
  releaseJoin = null;
  resize.mockClear();
  redraw.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

async function mountTerminal(): Promise<VueWrapper> {
  const wrapper = mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', sessionName: 'main' },
    attachTo: document.body,
  });
  setPaneSize(wrapper, 800, 600);
  await flush();
  return wrapper;
}

describe('the far end is told the geometry the pane actually has', () => {
  it('sends the size the pane grew to DURING the join, not the one captured before it', async () => {
    // The failing shape, exactly. The pane is 80x24 when `showTarget` captures
    // its cols/rows, the join takes seconds, and the layout settles to 200x50
    // while it is in flight. Sending the capture told tmux 24 rows for a pane
    // showing 50 — twenty-six dead rows below the status line, forever.
    releaseJoin = (): void => {};
    const wrapper = mount(TerminalView, {
      props: { connectionId: 'conn-1', sessionKey: 'main', sessionName: 'main' },
      attachTo: document.body,
    });
    setPaneSize(wrapper, 800, 600);
    await flush();

    // The pane is laid out while the join is still open. Nothing can send
    // this: the window listener and the container observer are only bound
    // AFTER the join resolves, and `shellId` is still null anyway. The only
    // thing that can rescue it is `showTarget` measuring again on the far side
    // of the await instead of trusting the numbers it captured.
    paneGrid = { cols: 200, rows: 50 };

    // Now let the join finish.
    const settle = releaseJoin;
    releaseJoin = null;
    settle();
    await flush();

    expect(sentSizes()).toContainEqual([200, 50]);
    // And never the stale pre-await capture.
    expect(sentSizes()).not.toContainEqual([80, 24]);
    wrapper.unmount();
  });

  it('does not re-send a size the far end already has', async () => {
    // Geometry is compared against what the REMOTE was told, not against
    // xterm's previous dimensions, so a route that fires twice costs one send
    // — and an idle tab costs none.
    const wrapper = await mountTerminal();
    resize.mockClear();

    await paneResized();
    await paneResized();

    expect(resize).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('re-sends a size the far end already has when asked to RESYNC', async () => {
    // The deliberate exception to the test above, and the reason the manual
    // lever exists at all.
    //
    // Reported picture: tmux's status line drawn in the middle of the pane with
    // stale rows beneath it — the far end working to a smaller screen than we
    // have. That state is unreachable from this side: a tmux session can hold
    // several clients (this app's tab, the phone, the user's own terminal) and
    // `window-size latest` sizes the window to the most recently used one, so
    // another client can shrink the window while NOTHING here moves. `sent`
    // still matches xterm's grid, the guard correctly sends nothing, and the
    // disagreement is stable.
    //
    // `resyncDisplay` forgets what the remote was told, so the same size goes
    // out again, and asks for the repaint — a `refresh-client` alone would
    // redraw at the size tmux currently believes in, which is the wrong one.
    const wrapper = await mountTerminal();
    resize.mockClear();
    redraw.mockClear();

    (wrapper.vm as unknown as { resyncDisplay: () => void }).resyncDisplay();
    await nextTick();

    expect(resize).toHaveBeenCalledWith('shell-1', 80, 24);
    expect(redraw).toHaveBeenCalledWith('shell-1');
    wrapper.unmount();
  });

  it('paints only after the resize it belongs to has landed', async () => {
    // `refresh-client` redraws the window as tmux CURRENTLY believes it is.
    // The two pushes used to fire as unordered fire-and-forget IPCs, and an
    // exec channel can outrun the client's own WINCH processing — so the
    // repaint could land first and redraw the OLD size into a grid that
    // `fit()` had already reflowed to the new one. Chaining the repaint behind
    // the resize's own resolution orders them for free: the resize IPC does
    // not resolve until `setWindow` ran.
    const wrapper = await mountTerminal();
    resize.mockClear();
    redraw.mockClear();

    let releaseResize!: (value: boolean) => void;
    resize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseResize = resolve;
        }),
    );

    (wrapper.vm as unknown as { resyncDisplay: () => void }).resyncDisplay();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(resize).toHaveBeenCalledWith('shell-1', 80, 24);
    expect(redraw).not.toHaveBeenCalled();

    releaseResize(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(redraw).toHaveBeenCalledWith('shell-1');
    wrapper.unmount();
  });

  it('re-asserts geometry AND asks for a repaint when a hidden tab comes back', async () => {
    // The second half of the report: a tab that returns at the size it was
    // hidden at changes nothing on our side, so the old wiring — which only
    // reacted to xterm's own dimensions moving — sent nothing at all. tmux
    // will not repaint a screen it considers unchanged either, which is why
    // the stale band survived a tab switch.
    const wrapper = await mountTerminal();
    resize.mockClear();
    redraw.mockClear();

    // Hidden: a v-show'd pane measures 0 and must not be fitted or pushed.
    setPaneSize(wrapper, 0, 0);
    await paneResized();
    expect(resize).not.toHaveBeenCalled();
    expect(redraw).not.toHaveBeenCalled();

    // Back into view at exactly the same size.
    setPaneSize(wrapper, 800, 600);
    await paneResized();

    expect(redraw).toHaveBeenCalledWith('shell-1');
    wrapper.unmount();
  });

  it('never pushes the degenerate size of a pane that is off screen', async () => {
    // A pane behind another tab measures 0x0. Telling tmux that reflows every
    // window in the session to one cell — for a tab the user cannot even see.
    const wrapper = await mountTerminal();
    resize.mockClear();

    setPaneSize(wrapper, 0, 0);
    paneGrid = { cols: 1, rows: 1 };
    await paneResized();

    expect(resize).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('never pushes a box that is SMALL but not zero — the four-column wrap', async () => {
    // THE REPORTED PICTURE, and the case the zero-check above could not see.
    //
    // "output in terminal broke again": a band of scrollback wrapped at about
    // four columns (`I'd` / `just` / `poi` / `nt` / `out`, one fragment a row)
    // with correct full-width text above and below it, and the agent TUI still
    // drawing its input box that narrow long after the pane was wide again.
    //
    // Only the remote can produce that. tmux and the TUI wrap to the width they
    // were told and their scrollback keeps the wrap it was written with, so a
    // four-column resize reached the far end — and the correct size that
    // followed repaired only what was drawn after it. There is no undo, which
    // is why the push has to be refused rather than corrected.
    //
    // 30px is the shape of the bug: a container mid-transition is not zero, so
    // it walked straight through a guard that only knew about zero.
    const wrapper = await mountTerminal();
    resize.mockClear();

    setPaneSize(wrapper, 30, 40);
    paneGrid = { cols: 4, rows: 2 };
    await paneResized();

    expect(resize).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('re-asserts the real size, with a repaint, once the layout settles', async () => {
    // The other half of refusing: a transient box must not leave the far end on
    // a stale size with nothing scheduled to correct it. The skip arms the same
    // hidden -> visible edge a backgrounded tab uses, so the pane pushes AND
    // asks for a redraw when it comes back — tmux repaints nothing for a resize
    // it considers a no-op, and "the size it was already on" is exactly that.
    const wrapper = await mountTerminal();
    resize.mockClear();
    redraw.mockClear();

    setPaneSize(wrapper, 30, 40);
    paneGrid = { cols: 4, rows: 2 };
    await paneResized();
    expect(resize).not.toHaveBeenCalled();

    setPaneSize(wrapper, 800, 600);
    paneGrid = { cols: 120, rows: 40 };
    await paneResized();

    expect(resize).toHaveBeenCalledWith('shell-1', 120, 40);
    expect(redraw).toHaveBeenCalledWith('shell-1');
    wrapper.unmount();
  });

  it('still pushes an ordinarily small pane, so the floor cannot become a bug of its own', async () => {
    // The floor is set to be unreachable by a real layout, not to second-guess
    // one. A genuinely narrow pane — a small window, a wide session panel —
    // must still tell the far end the truth, or the fix for a reflow becomes a
    // fix that leaves tmux drawing a screen larger than the viewport.
    const wrapper = await mountTerminal();
    resize.mockClear();

    setPaneSize(wrapper, 320, 240);
    paneGrid = { cols: 24, rows: 12 };
    await paneResized();

    expect(resize).toHaveBeenCalledWith('shell-1', 24, 12);
    wrapper.unmount();
  });
});
