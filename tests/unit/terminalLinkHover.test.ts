// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { LinkHoverPainter, type LinkHoverSegment } from '@ui/app/terminalLinkHover';

/**
 * The painter that underlines a hovered link's OTHER rows (terminalLinkHover.ts).
 *
 * The geometry contract is what the screenshots judge: one bar per plain
 * stretch, sitting just under the glyph baseline of its row, scaled with the
 * cell, gone the moment its stretch scrolls out — and never drawn over a row
 * the viewport no longer shows. The colour contract is the native underline's:
 * the bar inherits the cell's own foreground, read off the buffer. The token
 * contract is the event-order guard: a stale `hide` cannot erase a newer show.
 *
 * The terminal is a fake over a real DOM element — jsdom gives `document`, the
 * fake's screen element gives the rect, and everything the painter reads off
 * the buffer is stubbed per test. jsdom serializes a `background` of `#rrggbb`
 * as `rgb(...)`, so the assertions speak rgb.
 */

const COLS = 80;
const ROWS = 24;
const WIDTH = 400;
const HEIGHT = 480;
// WIDTH / COLS x HEIGHT / ROWS.
const CELL_W = 5;
const CELL_H = 20;

interface FakeCell {
  chars?: string;
  fg?: { mode: 'rgb' | 'palette'; value: number };
}

function fakeTerm(options: {
  viewportY?: number;
  theme?: Record<string, string>;
  cells?: Map<number, FakeCell>;
} = {}): Terminal & { fireRender: () => void } {
  const cells = options.cells ?? new Map<number, FakeCell>();
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  screen.getBoundingClientRect = () =>
    ({ width: WIDTH, height: HEIGHT, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON: () => ({}) });
  element.appendChild(screen);
  // The painter reuses its layer only while it is CONNECTED (a detached
  // screen would have it rebuild every repaint), so mount the fake element
  // the way an opened terminal's element is mounted.
  document.body.appendChild(element);
  const renderSubscribers: (() => void)[] = [];
  const term = {
    cols: COLS,
    rows: ROWS,
    element,
    options: { theme: options.theme },
    buffer: {
      active: {
        viewportY: options.viewportY ?? 0,
        getLine: (y: number) => ({
          getCell: (x: number) => {
            const cell = cells.get(y * COLS + x);
            if (cell === undefined) {
              return { getChars: () => '', getWidth: () => 1 };
            }
            return {
              getChars: () => cell.chars ?? ' ',
              getWidth: () => 1,
              isFgRGB: () => (cell.fg?.mode === 'rgb' ? 1 : 0),
              isFgPalette: () => (cell.fg?.mode === 'palette' ? 1 : 0),
              getFgColor: () => cell.fg?.value ?? 0,
            };
          },
        }),
      },
    },
    onRender(cb: () => void) {
      renderSubscribers.push(cb);
      return {
        dispose: () => {
          const i = renderSubscribers.indexOf(cb);
          if (i >= 0) renderSubscribers.splice(i, 1);
        },
      };
    },
    // The way a real terminal tells its render subscribers a frame happened.
    fireRender: () => {
      for (const cb of [...renderSubscribers]) cb();
    },
  };
  return term as unknown as Terminal & { fireRender: () => void };
}

afterEach(() => {
  document.body.replaceChildren();
});

/** The painter's layer INSIDE [term] — never a leftover of an earlier test. */
function barsOf(term: Terminal): HTMLElement[] {
  const layer = term.element?.querySelector('.terminal-link-hover-underlines');
  expect(layer).not.toBeNull();
  return Array.from((layer as HTMLElement).children) as HTMLElement[];
}

const SEG = (x: number, width: number, line: number): LinkHoverSegment => ({ x, width, line });

// cellHeight 20 → baseline round(16), thickness max(1, round(20/12)) = 2, so
// every bar tops out 14px into its row.
const TOP_IN_ROW = 14;
const WHITE = 'rgb(255, 255, 255)';

describe('the bar geometry follows the cells, not the mouse', () => {
  it('draws one bar per segment, just under the baseline of its row', () => {
    const term = fakeTerm();
    const painter = new LinkHoverPainter(term);
    painter.show([SEG(4, 14, 1), SEG(0, 26, 2)]);

    expect(
      barsOf(term).map((bar) => ({
        left: bar.style.left,
        width: bar.style.width,
        top: bar.style.top,
        height: bar.style.height,
        color: bar.style.backgroundColor,
      })),
    ).toEqual([
      { left: `${4 * CELL_W}px`, width: `${14 * CELL_W}px`, top: `${TOP_IN_ROW}px`, height: '2px', color: WHITE },
      { left: '0px', width: `${26 * CELL_W}px`, top: `${CELL_H + TOP_IN_ROW}px`, height: '2px', color: WHITE },
    ]);
    painter.dispose();
  });

  it('re-derives the bars on render: a scroll moves them, off-screen drops them', () => {
    const term = fakeTerm();
    const painter = new LinkHoverPainter(term);
    painter.show([SEG(0, 10, 1), SEG(0, 10, 3)]);
    expect(barsOf(term)).toHaveLength(2);

    // A scroll moves the viewport under the stationary mouse; xterm answers
    // with a render, and the painter re-derives every bar from the buffer:
    // line 1 leaves the viewport, line 3 lands on its first row.
    (term.buffer.active as { viewportY: number }).viewportY = 2;
    term.fireRender();
    expect(barsOf(term).map((bar) => bar.style.top)).toEqual([`${TOP_IN_ROW}px`]);
    painter.dispose();
  });

  it('draws nothing for an empty show, and no second show stacks a second layer', () => {
    const term = fakeTerm();
    const painter = new LinkHoverPainter(term);
    painter.show([]);
    expect(term.element?.querySelector('.terminal-link-hover-underlines')).toBeNull();
    painter.show([SEG(0, 10, 1)]);
    expect(term.element?.querySelectorAll('.terminal-link-hover-underlines')).toHaveLength(1);
    expect(barsOf(term)).toHaveLength(1);
    painter.dispose();
  });
});

describe('the token guards the hide against the next show', () => {
  it('hide with the live token clears the bars and unsubscribes the render', () => {
    const term = fakeTerm();
    const painter = new LinkHoverPainter(term);
    const token = painter.show([SEG(0, 10, 1)]);
    painter.hide(token);
    expect(barsOf(term)).toHaveLength(0);
    // After the hide the render subscription is gone: a frame changes nothing.
    term.fireRender();
    expect(barsOf(term)).toHaveLength(0);
    painter.dispose();
  });

  it('a stale hide — a leave arriving after the next fragment hover — is a no-op', () => {
    const term = fakeTerm();
    const painter = new LinkHoverPainter(term);
    // Fragment A hovers, then the pointer crosses onto fragment B before A's
    // leave is dispatched (the event order across a fragment boundary is
    // xterm's own). A's stale hide must not erase B's bars.
    const tokenA = painter.show([SEG(0, 10, 1)]);
    const tokenB = painter.show([SEG(0, 10, 2)]);
    expect(tokenA).not.toBe(tokenB);
    painter.hide(tokenA);
    expect(barsOf(term)).toHaveLength(1);
    painter.hide(tokenB);
    expect(barsOf(term)).toHaveLength(0);
    painter.dispose();
  });
});

describe("the bar inherits the cell's own foreground", () => {
  it("reads an RGB foreground off the segment's first cell", () => {
    const cells = new Map([[0, { chars: 'h', fg: { mode: 'rgb' as const, value: 0x1a2b3c } }]]);
    const term = fakeTerm({ cells });
    const painter = new LinkHoverPainter(term);
    painter.show([SEG(0, 3, 1)]);
    expect(barsOf(term)[0]?.style.backgroundColor).toBe('rgb(26, 43, 60)');
    painter.dispose();
  });

  it('reads a palette foreground through the theme', () => {
    const cells = new Map([[0, { chars: 'h', fg: { mode: 'palette' as const, value: 4 } }]]);
    const term = fakeTerm({ cells, theme: { blue: '#0037da' } });
    const painter = new LinkHoverPainter(term);
    painter.show([SEG(0, 3, 1)]);
    expect(barsOf(term)[0]?.style.backgroundColor).toBe('rgb(0, 55, 218)');
    painter.dispose();
  });

  it('answers a cell without colour methods with the theme foreground', () => {
    // The link-test fakes build cells by hand; the painter must not throw on
    // them, and must fall through to the theme's default foreground.
    const term = fakeTerm({ theme: { foreground: '#cccccc' } });
    const painter = new LinkHoverPainter(term);
    painter.show([SEG(0, 3, 1)]);
    expect(barsOf(term)[0]?.style.backgroundColor).toBe('rgb(204, 204, 204)');
    painter.dispose();
  });
});

describe('dispose', () => {
  it('removes the layer from the screen', () => {
    const term = fakeTerm();
    const painter = new LinkHoverPainter(term);
    painter.show([SEG(0, 10, 1)]);
    painter.dispose();
    expect(term.element?.querySelector('.terminal-link-hover-underlines')).toBeNull();
  });
});
