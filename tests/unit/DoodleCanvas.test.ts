// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { textFontSize, textHalfLeading } from '../../src/shared/doodleGeometry';

/**
 * The doodle surface's two new tools, driven the way a user drives them.
 *
 * The property worth spending a whole spec on is the LAST one in this file:
 * what the user sees on the sheet is what lands in the exported PNG. It is not
 * self-evident. The text tool's caret is an HTML `<textarea>` floating over the
 * canvas, and `toBlob` has never heard of it — so "attach while still typing"
 * is a real way to ship a screenshot with the caption missing, and the only
 * way to know it does not happen is to record what the 2D context was told and
 * check the recording at the moment the encoder was called.
 *
 * Everything is stubbed at the canvas boundary rather than mocked at the
 * component's: jsdom implements no 2D context at all, so a recording fake IS
 * the canvas here. The fake's font metrics are deliberately trivial (ten pixels
 * a character) — line breaking is pinned properly in doodleGeometry.test.ts
 * against the same shape of fake, and what is under test here is the wiring.
 */

const SHEET = { w: 1024, h: 640 };

/**
 * The canvas's DISPLAYED box, in CSS pixels — the sheet's zoom, in other words.
 *
 * Mutable, and that is the point. A sheet shown at 1:1 is the one case that
 * cannot tell a correct coordinate conversion from a missing one: every scale
 * term is 1, so dividing by it, multiplying by it and forgetting it entirely
 * all agree. The real sheet is never at 1:1 — a 2048px backdrop inside a 720px
 * overlay is at about a third — so the placement specs set this to something
 * other than SHEET, and one of them changes it AFTER mount, which is what the
 * overlay's entrance transform does in the app.
 */
let displayed = { ...SHEET };

/** Everything the component was told to draw, in order. */
interface Op {
  op: string;
  args: number[];
  text?: string;
  fill?: string;
  stroke?: string;
  font?: string;
}

let ops: Op[] = [];

/** A 2D context that records instead of rasterising. */
function makeContext(): CanvasRenderingContext2D {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    textBaseline: '',
    measureText: (s: string) => ({ width: s.length * 10 }),
  } as unknown as CanvasRenderingContext2D & Record<string, unknown>;

  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      const entry: Op = { op, args: args.filter((a) => typeof a === 'number') };
      if (op === 'fillText') {
        entry.text = String(args[0]);
        // The component only ever assigns strings; the DOM type also admits a
        // gradient or a pattern, which is why the cast rather than String().
        entry.fill = ctx.fillStyle as string;
        entry.font = ctx.font;
      }
      if (op === 'stroke') entry.stroke = ctx.strokeStyle as string;
      if (op === 'fill') entry.fill = ctx.fillStyle as string;
      ops.push(entry);
    };

  for (const name of [
    'clearRect',
    'fillRect',
    'drawImage',
    'beginPath',
    'moveTo',
    'lineTo',
    'quadraticCurveTo',
    'closePath',
    'rect',
    'ellipse',
    'stroke',
    'fill',
    'fillText',
  ]) {
    ctx[name] = record(name);
  }
  return ctx;
}

/**
 * The design tokens the canvas resolves at paint time.
 *
 * Stubbed wholesale rather than injected as a stylesheet: jsdom's
 * `getComputedStyle` does not resolve custom properties through inheritance, so
 * a `<style>` block would silently hand back empty strings and every assertion
 * about colour would pass against the "stylesheet is missing" fallback.
 */
const TOKENS: Record<string, string> = {
  '--error': 'rgb(255, 0, 0)',
  '--warning': 'rgb(255, 200, 0)',
  '--success': 'rgb(0, 200, 0)',
  '--accent': 'rgb(0, 120, 255)',
  '--agent': 'rgb(200, 0, 200)',
  '--fg': 'rgb(255, 255, 255)',
  '--surface-2': 'rgb(20, 20, 20)',
  '--font-ui': 'Inter Variable, sans-serif',
  '--fw-semibold': '600',
  '--lh-300': '1.3846',
};

/** Ops captured at the instant `toBlob` was called — i.e. what got encoded. */
let encoded: Op[] = [];

beforeEach(() => {
  // The canvas reads the shortcut registry for its undo chord, and the
  // registry's bindings live in the settings store — which wants a Pinia.
  setActivePinia(createPinia());
  ops = [];
  encoded = [];
  displayed = { ...SHEET };

  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (name: string) => TOKENS[name] ?? '',
  } as unknown as CSSStyleDeclaration);

  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = (): CanvasRenderingContext2D => context;
  proto.getBoundingClientRect = (): DOMRect =>
    ({
      left: 0,
      top: 0,
      width: displayed.w,
      height: displayed.h,
      right: displayed.w,
      bottom: displayed.h,
    }) as DOMRect;
  proto.toBlob = (cb: (b: Blob | null) => void): void => {
    encoded = [...ops];
    cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  };
  proto.toDataURL = (): string => 'data:image/png;base64,AAAA';
  // Pointer capture is a real API the drag path depends on and jsdom has none.
  const el = Element.prototype as unknown as Record<string, unknown>;
  el.setPointerCapture = (): void => undefined;
  el.releasePointerCapture = (): void => undefined;
});

afterEach(() => vi.restoreAllMocks());

let context = makeContext();

const DoodleCanvas = (await import('../../src/renderer/components/DoodleCanvas.vue')).default;

async function open(): Promise<VueWrapper> {
  context = makeContext();
  const wrapper = mount(DoodleCanvas, { attachTo: document.body });
  await flush();
  return wrapper;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Pick a toolbar tool by its accessible label. */
async function pickTool(wrapper: VueWrapper, label: string): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.attributes('aria-label') === label);
  if (!button) throw new Error(`no tool button labelled ${label}`);
  await button.trigger('click');
  await flush();
}

function sheet(wrapper: VueWrapper): HTMLCanvasElement {
  return wrapper.get('canvas').element;
}

/**
 * Pointer events, built by hand rather than through `trigger`.
 *
 * `clientX`, `button` and friends are getters on jsdom's MouseEvent, so the
 * test-utils helper — which assigns them after construction — throws. A bare
 * Event has no such getters, and the component only ever reads the properties,
 * so an object with them stuck on behaves identically at the handler.
 */
function pointer(kind: string, init: Record<string, unknown>): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, pointerId: 1, shiftKey: false }, init);
  return event;
}

async function key(
  target: Element,
  name: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  await flush();
}

/** Drag from one point to another with the current tool. */
async function drag(
  wrapper: VueWrapper,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: Record<string, unknown> = {},
): Promise<void> {
  const canvas = sheet(wrapper);
  canvas.dispatchEvent(pointer('pointerdown', { clientX: from.x, clientY: from.y }));
  canvas.dispatchEvent(pointer('pointermove', { clientX: to.x, clientY: to.y, ...modifiers }));
  canvas.dispatchEvent(pointer('pointerup', { clientX: to.x, clientY: to.y, ...modifiers }));
  await flush();
}

async function click(wrapper: VueWrapper, at: { x: number; y: number }): Promise<void> {
  sheet(wrapper).dispatchEvent(pointer('pointerdown', { clientX: at.x, clientY: at.y }));
  await flush();
}

/** Type into the open annotation editor. */
async function type(wrapper: VueWrapper, text: string): Promise<void> {
  const el = editor(wrapper);
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

/** The open annotation editor. */
function editor(wrapper: VueWrapper): HTMLTextAreaElement {
  return wrapper.get('textarea').element;
}

function undoButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('button').find((b) => b.attributes('title') === 'Undo');
  if (!button) throw new Error('no undo button');
  return button;
}

/**
 * The ops of the LAST repaint in a recording.
 *
 * The sheet is repainted on every pointer event, so a raw recording holds one
 * frame per move. Every repaint starts by clearing, which makes the final
 * `clearRect` the start of the frame that is actually on screen — the only one
 * an assertion about "what the user sees" should look at.
 */
function frame(from: Op[] = ops): Op[] {
  const start = from.map((o) => o.op).lastIndexOf('clearRect');
  return start < 0 ? from : from.slice(start);
}

/** Every string the sheet was asked to paint, in paint order. */
function painted(from: Op[] = ops): string[] {
  return frame(from)
    .filter((o) => o.op === 'fillText')
    .map((o) => o.text ?? '');
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

describe('the arrow tool', () => {
  it('draws a shaft and a filled head from tail to head', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    ops = [];
    await drag(wrapper, { x: 100, y: 100 }, { x: 400, y: 100 });

    // The shaft starts at the tail…
    const moveTo = frame().find((o) => o.op === 'moveTo');
    expect(moveTo?.args).toEqual([100, 100]);
    // …and stops SHORT of the tip, so a round cap cannot poke out of the point.
    const lineTo = frame().find((o) => o.op === 'lineTo');
    expect(lineTo?.args[0]).toBeLessThan(400);
    expect(lineTo?.args[1]).toBeCloseTo(100, 6);
    // The head is filled, in the pen's colour, not stroked.
    const filled = frame().filter((o) => o.op === 'fill');
    expect(filled).toHaveLength(1);
    expect(filled[0]?.fill).toBe(TOKENS['--error']);
  });

  it('scales the head with the mark weight', async () => {
    const headSpread = async (weight: string): Promise<number> => {
      const wrapper = await open();
      await pickTool(wrapper, 'Arrow');
      await pickTool(wrapper, weight);
      ops = [];
      await drag(wrapper, { x: 100, y: 100 }, { x: 600, y: 100 });
      const barbs = frame()
        .filter((o) => o.op === 'lineTo')
        .slice(1)
        .map((o) => o.args[1] ?? 0);
      expect(barbs).toHaveLength(2);
      return Math.abs((barbs[0] ?? 0) - (barbs[1] ?? 0));
    };
    expect(await headSpread('Mark weight 24')).toBeGreaterThan(await headSpread('Mark weight 6'));
  });

  /**
   * The answer to "what does a click without a drag do?" — nothing, and
   * measurably nothing: no item, and therefore no Undo that appears to do
   * nothing when pressed.
   */
  it('ignores a click with no drag rather than leaving a zero-length arrow', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    expect(undoButton(wrapper).attributes('disabled')).toBeDefined();
    await drag(wrapper, { x: 100, y: 100 }, { x: 101, y: 100 });
    expect(undoButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('snaps to 45-degree steps while Shift is held', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    ops = [];
    // Eight pixels off horizontal over a 300px drag: a hand-held "horizontal".
    await drag(wrapper, { x: 100, y: 100 }, { x: 400, y: 108 }, { shiftKey: true });
    const tip = frame().filter((o) => o.op === 'moveTo').pop();
    expect(tip?.args[1]).toBeCloseTo(100, 6);
  });

  it('leaves the drag alone without Shift', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    ops = [];
    await drag(wrapper, { x: 100, y: 100 }, { x: 400, y: 108 });
    const tip = frame().filter((o) => o.op === 'moveTo').pop();
    expect(tip?.args[1]).toBeCloseTo(108, 6);
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe('the text tool', () => {
  it('places a caret on click and paints the text on commit', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 200, y: 150 });
    expect(wrapper.find('textarea').exists()).toBe(true);

    await type(wrapper, 'broken button');
    // While the caret is open the canvas does NOT paint it — the textarea is
    // the preview, and painting both would ghost.
    expect(painted()).not.toContain('broken button');

    ops = [];
    await key(editor(wrapper), 'Escape');
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(painted()).toContain('broken button');
  });

  it('paints in the shared pen colour and a token-derived font', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await pickTool(wrapper, 'success');
    await click(wrapper, { x: 10, y: 10 });
    await type(wrapper, 'ok');
    ops = [];
    await key(editor(wrapper), 'Escape');

    const drawn = frame().find((o) => o.op === 'fillText');
    expect(drawn?.fill).toBe(TOKENS['--success']);
    // Weight and family from tokens; the size follows the mark weight. 96px at
    // the new default weight of 12, not the 24px this used to assert: at the
    // ~0.34 zoom a capped backdrop is shown at, 24px reached the eye as 8 CSS
    // pixels — below `--fs-100`, the smallest type the app sets anywhere. The
    // mark ladder has since shifted up a rung (WIDTHS is 6 / 12 / 24), so the
    // default moved too. See TEXT.sizeRatio.
    expect(drawn?.font).toBe('600 96px Inter Variable, sans-serif');
  });

  /**
   * The weight control's tooltip promises a size, and it used to promise it by
   * multiplying by a copy of `TEXT.sizeRatio` written out in the template. A
   * copy of a constant is a constant that will be wrong exactly once.
   */
  it('labels the weight control with the size the text will really be', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    const button = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'Mark weight 6');
    expect(button?.attributes('title')).toBe(`Text ${textFontSize(6)}px`);
  });

  /**
   * Enter is a newline, not a commit. An annotation on a screenshot is
   * routinely two lines, so binding Enter to commit would make the multi-line
   * case unreachable — and the composer's own Enter-sends rule is about a
   * message being finished, which a caption is not.
   */
  it('keeps the editor open on Enter, and paints the newline', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 10, y: 10 });
    await key(editor(wrapper), 'Enter');
    expect(wrapper.find('textarea').exists()).toBe(true);

    await type(wrapper, 'first\nsecond');
    ops = [];
    await key(editor(wrapper), 'Escape');
    expect(painted()).toEqual(['first', 'second']);
  });

  it('commits on Ctrl+Enter, for the fingers that try it first', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 10, y: 10 });
    await type(wrapper, 'done');
    await key(editor(wrapper), 'Enter', { ctrlKey: true });
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(painted()).toContain('done');
  });

  /**
   * The collision this tool could most easily cause. The canvas is inside an
   * OverlayPanel (Escape closes the overlay) inside `.composer-root` (Escape
   * runs the close ladder and hides the composer), and both listen for a
   * bubbling Escape. One keypress while typing a caption must not throw away
   * the caption, the drawing AND the composer.
   */
  it('does not let its Escape reach the overlay or the composer', async () => {
    const wrapper = await open();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      await pickTool(wrapper, 'Text');
      await click(wrapper, { x: 10, y: 10 });
      await type(wrapper, 'caption');
      await key(editor(wrapper), 'Escape');
      expect(outer).not.toHaveBeenCalled();
      // …and the same key with no editor open is left for the overlay.
      await key(sheet(wrapper), 'Escape');
      expect(outer).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('leaves nothing behind when a caret is placed and abandoned', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 10, y: 10 });
    await type(wrapper, '   ');
    await key(editor(wrapper), 'Escape');
    expect(undoButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('re-opens a committed annotation for editing when it is clicked', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 100, y: 100 });
    await type(wrapper, 'teh button');
    await key(editor(wrapper), 'Escape');

    // Click inside the block that was just painted.
    await click(wrapper, { x: 120, y: 105 });
    expect(editor(wrapper).value).toBe('teh button');

    await type(wrapper, 'the button');
    ops = [];
    await key(editor(wrapper), 'Escape');
    // Replaced in place, not duplicated.
    expect(painted()).toEqual(['the button']);
  });

  /**
   * Reaching for a swatch with a caret open means "make THIS one that colour" —
   * there is nothing else it could mean, since every other tool applies its
   * colour at the moment of drawing.
   */
  it('recolours the annotation being typed, and keeps the change on commit', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 100, y: 100 });
    await type(wrapper, 'look here');
    await key(editor(wrapper), 'Escape');

    await click(wrapper, { x: 110, y: 105 });
    await pickTool(wrapper, 'accent');
    ops = [];
    await key(editor(wrapper), 'Escape');
    expect(frame().find((o) => o.op === 'fillText')?.fill).toBe(TOKENS['--accent']);

    // …and it is one Undo away, like every other change to the document.
    ops = [];
    await undoButton(wrapper).trigger('click');
    await flush();
    expect(frame().find((o) => o.op === 'fillText')?.fill).toBe(TOKENS['--error']);
  });

  it('deletes an annotation that is emptied', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 100, y: 100 });
    await type(wrapper, 'oops');
    await key(editor(wrapper), 'Escape');

    await click(wrapper, { x: 110, y: 105 });
    await type(wrapper, '');
    ops = [];
    await key(editor(wrapper), 'Escape');
    expect(painted()).toEqual([]);
  });

  it('starts a second annotation when the click misses the first', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 10, y: 10 });
    await type(wrapper, 'one');
    await click(wrapper, { x: 500, y: 400 });
    await type(wrapper, 'two');
    ops = [];
    await key(editor(wrapper), 'Escape');
    expect(painted()).toEqual(['one', 'two']);
  });
});

// ---------------------------------------------------------------------------
// Where the text lands
// ---------------------------------------------------------------------------

/**
 * "When I click with the I icon on the image it doesn't land where I clicked."
 *
 * Two separate ways that happened, and they are tested separately because
 * either one alone reproduces the report:
 *
 *  1. The caret was placed through a CACHED zoom while the click was decoded
 *     through a LIVE one. They agree until something changes the canvas's
 *     rendered size without changing its border box — which is precisely what
 *     OverlayPanel's entrance does, animating `scale(0.985)` over `--dur-slow`
 *     while a ResizeObserver, which reports border boxes, says nothing. The
 *     error is then proportional to the distance from the top-left corner.
 *  2. The canvas anchors a line's GLYPH TOP at the origin and CSS anchors its
 *     LINE BOX top there, so the editing overlay wrote half a leading below the
 *     click and the caption hopped up when it was committed.
 *
 * Every case here is driven at a zoom that is not 1. At 1:1 a missing scale
 * divide is indistinguishable from a correct one, so a spec written at 1:1
 * would pass against both versions of the bug.
 */
describe('placing text where the pointer is', () => {
  /** `--lh-300`, as the component resolves it. */
  const LEADING = Number(TOKENS['--lh-300']);

  it('maps a click to bitmap pixels through the sheet zoom', async () => {
    // The sheet is drawn at half size, as a large backdrop in a small panel is.
    displayed = { w: SHEET.w / 2, h: SHEET.h / 2 };
    const wrapper = await open();
    await pickTool(wrapper, 'Text');

    await click(wrapper, { x: 150, y: 90 });
    await type(wrapper, 'here');
    ops = [];
    await key(editor(wrapper), 'Escape');

    // Half size, so 150 CSS pixels across the sheet is 300 pixels into the
    // bitmap — and the bitmap is what the attachment will contain.
    const drawn = frame().find((o) => o.op === 'fillText');
    expect(drawn?.args).toEqual([300, 180]);
  });

  /**
   * The stale-zoom half. Nothing here tells the component the sheet resized —
   * that is the point, because in the app nothing tells it either.
   */
  it('places the caret through the zoom the click was read at, not a stale one', async () => {
    const wrapper = await open(); // measured while the sheet was still 1:1
    await pickTool(wrapper, 'Text');
    displayed = { w: SHEET.w / 2, h: SHEET.h / 2 };

    await click(wrapper, { x: 150, y: 90 });

    // The caret belongs under the pointer, in display pixels: the same 150 the
    // click came in at. Read through the stale 1:1 zoom it would sit at 300 —
    // off by the distance from the corner, which is the shape of the report.
    const style = editor(wrapper).style;
    expect(Number.parseFloat(style.left)).toBeCloseTo(150, 6);
    // Vertically the same, less the lift that makes the glyphs — not the box —
    // start at the click. Width 12 is the toolbar's default; none was picked.
    const lift = textHalfLeading(textFontSize(12), LEADING);
    expect(Number.parseFloat(style.top)).toBeCloseTo((180 - lift) / 2, 6);
  });

  /**
   * The half-leading half. The overlay is a WYSIWYG preview, so the glyphs the
   * user types and the glyphs that get painted have to occupy the same pixels —
   * and both have to start at the click, not below it.
   */
  it('starts the writing at the click, in the editor and in the paint alike', async () => {
    displayed = { w: SHEET.w / 2, h: SHEET.h / 2 };
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 100, y: 75 }); // bitmap (200, 150)

    // A textarea centres its glyphs in a line box of `line-height`, so its BOX
    // has to begin above the click by exactly that half-leading for the glyphs
    // inside it to begin at the click. Width 12 is the toolbar's default.
    const lift = textHalfLeading(textFontSize(12), LEADING);
    expect(lift).toBeGreaterThan(0);
    expect(Number.parseFloat(editor(wrapper).style.top)).toBeCloseTo((150 - lift) / 2, 6);

    await type(wrapper, 'wysiwyg');
    ops = [];
    await key(editor(wrapper), 'Escape');
    // The canvas needs no such correction — `textBaseline = 'top'` already
    // anchors the glyph top — so the paint lands on the click itself.
    expect(frame().find((o) => o.op === 'fillText')?.args).toEqual([200, 150]);
  });

  /**
   * The correction has to be derived, not tuned. A constant that cancelled at
   * the default weight would be wrong at the other two, and the enlarged font
   * makes the error twice the size it used to be.
   */
  it('keeps the caret on the click at every mark weight', async () => {
    displayed = { w: SHEET.w / 2, h: SHEET.h / 2 };
    for (const weight of [6, 12, 24]) {
      const wrapper = await open();
      await pickTool(wrapper, 'Text');
      await pickTool(wrapper, `Mark weight ${weight}`);
      await click(wrapper, { x: 100, y: 75 });

      const lift = textHalfLeading(textFontSize(weight), LEADING);
      expect(Number.parseFloat(editor(wrapper).style.left)).toBeCloseTo(100, 6);
      expect(Number.parseFloat(editor(wrapper).style.top)).toBeCloseTo((150 - lift) / 2, 6);
      wrapper.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe('undo', () => {
  it('takes back an arrow', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 100, y: 100 }, { x: 400, y: 100 });
    expect(undoButton(wrapper).attributes('disabled')).toBeUndefined();
    ops = [];
    await undoButton(wrapper).trigger('click');
    await flush();
    expect(frame().filter((o) => o.op === 'fill')).toEqual([]);
  });

  it('takes back a text annotation', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 10, y: 10 });
    await type(wrapper, 'gone');
    await key(editor(wrapper), 'Escape');
    ops = [];
    await undoButton(wrapper).trigger('click');
    await flush();
    expect(painted()).toEqual([]);
  });

  /**
   * The case a pop-the-last-item stack cannot serve, and the reason `history`
   * holds whole versions of the list: retyping an existing annotation is a
   * mutation in the middle of the document, not an append.
   */
  it('takes back an EDIT to an existing annotation', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 100, y: 100 });
    await type(wrapper, 'before');
    await key(editor(wrapper), 'Escape');

    await click(wrapper, { x: 110, y: 105 });
    await type(wrapper, 'after');
    await key(editor(wrapper), 'Escape');

    ops = [];
    await undoButton(wrapper).trigger('click');
    await flush();
    expect(painted()).toEqual(['before']);
  });

  it('takes back Clear, which is one misclick from losing the whole markup', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 100, y: 100 }, { x: 400, y: 100 });
    const clear = wrapper.findAll('button').find((b) => b.attributes('title') === 'Clear');
    await clear?.trigger('click');
    await flush();
    ops = [];
    await undoButton(wrapper).trigger('click');
    await flush();
    expect(frame().filter((o) => o.op === 'fill')).toHaveLength(1);
  });

  it('does not offer an undo for a re-open that changed nothing', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 100, y: 100 });
    await type(wrapper, 'unchanged');
    await key(editor(wrapper), 'Escape');

    await click(wrapper, { x: 110, y: 105 });
    await key(editor(wrapper), 'Escape');

    ops = [];
    await undoButton(wrapper).trigger('click');
    await flush();
    // One undo, and the annotation is gone — the no-op re-open did not consume
    // a press of its own.
    expect(painted()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

describe('what actually reaches the attachment', () => {
  /**
   * The whole point of the spec. `AttachmentStager` uploads the bytes this
   * canvas encodes, so a mark that lives only in a preview layer would look
   * right on screen and be missing from the file the agent reads.
   */
  it('encodes the arrows and the text, not just the backdrop', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 100, y: 100 }, { x: 400, y: 100 });
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 420, y: 90 });
    await type(wrapper, 'this one');
    await key(editor(wrapper), 'Escape');

    const attach = wrapper.findAll('button').find((b) => b.text() === 'Attach');
    await attach?.trigger('click');
    await flush();

    expect(wrapper.emitted('commit')).toHaveLength(1);
    expect(painted(encoded)).toContain('this one');
    expect(frame(encoded).filter((o) => o.op === 'fill')).toHaveLength(1);
  });

  /**
   * Attaching WHILE a caret is still open. The textarea is a DOM element over
   * the canvas and `toBlob` cannot see it, so the commit path has to flush the
   * editor into the document before it encodes — or the user attaches a picture
   * with the caption they are looking at missing from it.
   */
  it('flushes a caption that is still being typed into the bitmap', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 40, y: 40 });
    await type(wrapper, 'still typing');
    expect(wrapper.find('textarea').exists()).toBe(true);

    const attach = wrapper.findAll('button').find((b) => b.text() === 'Attach');
    await attach?.trigger('click');
    await flush();

    expect(painted(encoded)).toContain('still typing');
    expect(wrapper.emitted('commit')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Cancelling must not destroy a drawing without asking.
 *
 * Every route out of this sheet except Attach used to discard silently:
 * Cancel, and — through the parent — the overlay's `✕`, a backdrop click and
 * Escape. Backdrop clicks are the easiest mouse error there is against a
 * modal, and the undo stack that would otherwise be the recovery lives inside
 * the component the close unmounts. So the guard is tested from both sides:
 * that it fires when there is work, and that it stays out of the way when
 * there is not.
 */
function footerButton(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('button').find((b) => b.text() === label);
}

describe('closing the sheet', () => {
  it('closes immediately when the sheet is empty', async () => {
    const wrapper = await open();
    await footerButton(wrapper, 'Cancel')?.trigger('click');
    await flush();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('asks before throwing a drawing away', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 10, y: 10 }, { x: 200, y: 200 });

    await footerButton(wrapper, 'Cancel')?.trigger('click');
    await flush();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.text()).toContain('Discard this drawing?');
  });

  it('keeps the drawing when the question is answered "keep editing"', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 10, y: 10 }, { x: 200, y: 200 });
    await footerButton(wrapper, 'Cancel')?.trigger('click');
    await flush();

    await footerButton(wrapper, 'Keep editing')?.trigger('click');
    await flush();

    expect(wrapper.emitted('close')).toBeUndefined();
    // The sheet is still live and still holds the arrow: Attach encodes it.
    await footerButton(wrapper, 'Attach')?.trigger('click');
    await flush();
    expect(frame(encoded).filter((o) => o.op === 'fill')).toHaveLength(1);
  });

  it('closes on a deliberate Discard', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 10, y: 10 }, { x: 200, y: 200 });
    await footerButton(wrapper, 'Cancel')?.trigger('click');
    await flush();

    await footerButton(wrapper, 'Discard')?.trigger('click');
    await flush();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  /**
   * A caption still being typed is part of the drawing. Without the flush, a
   * sheet whose only content was an open editor would report itself empty and
   * close without asking — the same class of bug as attaching mid-sentence.
   */
  it('counts an open caption as work worth confirming', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Text');
    await click(wrapper, { x: 40, y: 40 });
    await type(wrapper, 'nearly done');

    await footerButton(wrapper, 'Cancel')?.trigger('click');
    await flush();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.text()).toContain('Discard this drawing?');
  });

  /**
   * The parent routes the overlay's `✕`, its backdrop click and Escape through
   * the same door, so the guard covers them all without OverlayPanel knowing
   * this tool exists.
   */
  it('exposes the same guard to the overlay chrome', async () => {
    const wrapper = await open();
    await pickTool(wrapper, 'Arrow');
    await drag(wrapper, { x: 10, y: 10 }, { x: 200, y: 200 });

    (wrapper.vm as unknown as { requestClose: () => void }).requestClose();
    await flush();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.text()).toContain('Discard this drawing?');

    // A SECOND Escape answers "keep editing", not "discard". Escape is the key
    // people press without reading, so it must fall on the safe side.
    (wrapper.vm as unknown as { requestClose: () => void }).requestClose();
    await flush();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.text()).not.toContain('Discard this drawing?');
  });

  it('refuses to close while the annotated image is uploading', async () => {
    const wrapper = await open();
    await wrapper.setProps({ saving: true });
    (wrapper.vm as unknown as { requestClose: () => void }).requestClose();
    await flush();
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe('the attachment name', () => {
  it('names the annotation after the image it was drawn on', async () => {
    context = makeContext();
    const wrapper = mount(DoodleCanvas, {
      attachTo: document.body,
      props: { backdropName: '20260825-101500-01-shot.png' },
    });
    await flush();
    await footerButton(wrapper, 'Attach')?.trigger('click');
    await flush();

    const committed = wrapper.emitted('commit')?.[0]?.[0] as { name: string };
    // The stager's own prefix is stripped; see composerAttachments.test.ts for
    // the full rule and the repeated-annotation case.
    expect(committed.name).toMatch(/^annotated-shot-\d{8}-\d{6}\.png$/);
  });
});
