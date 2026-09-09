<script setup lang="ts">
/**
 * DoodleCanvas: draw a quick illustration, or annotate an image, and attach
 * the result to the prompt as a PNG.
 *
 * Why this exists at all: the agent on the other end reads images off disk
 * (AttachmentStager uploads bytes and folds the remote path into the prompt),
 * so "circle the broken button and send it" was already possible — but only
 * by leaving the app, opening an editor, saving, and dragging the file back.
 * This closes that loop without adding a single main-process code path: the
 * canvas produces PNG bytes, and `{kind:'bytes'}` staging already accepts
 * exactly that.
 *
 * ## The item list is the document, not the pixels
 *
 * Strokes and text are kept as geometry and the canvas is repainted from them
 * on every change. The obvious alternative — draw straight to the context and
 * snapshot with getImageData for undo — costs a full-frame copy per stroke and
 * cannot survive a resize or a late-loading backdrop, both of which happen
 * here. The repaint is bounded by the item count, which for a doodle is tens.
 *
 * That is also why the export is trustworthy. There is ONE canvas and ONE
 * painter: `repaint()` draws the backdrop and then every item, and `commit()`
 * encodes that same canvas. Nothing is composited into a preview layer that
 * the exporter would then have to reproduce — the text tool's `<textarea>` is
 * an EDITING affordance that exists only while a caret is in it, and committing
 * it turns it into an item that `repaint()` paints like everything else. There
 * is no second rendering path that could drift.
 *
 * ## Colour, family and leading come from the DOM, not from this file
 *
 * A canvas context needs a resolved colour string and a resolved font string;
 * `var(--accent)` means nothing to it. Rather than hard-code the palette (which
 * the design gate in tests/unit/designGates.test.ts rightly forbids in a .vue
 * file, and which would silently drift from ), the pens name tokens
 * and resolve them from computed style at paint time. Change the token, the pen
 * follows. Text does the same for `--font-ui`, `--fw-semibold` and `--lh-300`.
 *
 * The one number NOT taken from a token is the text SIZE, and the reasoning is
 * in `TEXT.sizeRatio` in src/shared/doodleGeometry.ts: the `--fs-*` ladder is a
 * chrome density system that stops at 20px, while this canvas is a bitmap up to
 * 2048px wide displayed inside a ~700px panel. Size follows the stroke width
 * the user already picked instead, so a caption and the arrow pointing at it
 * read as one hand.
 *
 * ## Undo covers everything, including edits and Clear
 *
 * `history` holds previous versions of the item ARRAY — a list of references,
 * tens of them, which is a different proposition from the frame-sized pixel
 * snapshots the original design rejected. It is what lets undo cover the three
 * things a pop-the-last-item stack cannot: retyping an existing annotation,
 * emptying one (which deletes it), and Clear. An annotation tool whose Clear is
 * irreversible is one misclick from losing the whole markup.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { AppIconName } from './AppIcon.vue';
import { useSettingsStore } from '../stores/settings';
import { isShortcut } from '../../shared/shortcuts';
import { doodleAttachmentName } from '../../shared/composerAttachments';
import {
  arrowHead,
  constrainToAngle,
  hitTestText,
  isBlankText,
  isDegenerateDrag,
  layoutText,
  textFontSize,
  textHalfLeading,
  TEXT,
  type Point,
  type TextLayout,
} from '../../shared/doodleGeometry';

const props = withDefaults(
  defineProps<{
    /**
     * The image to annotate, as a URL an `<img>` can load, or null for a blank
     * canvas.
     *
     * Normally a `data:` URL: routing the clipboard, a local file and a remote
     * file through one form means the backdrop path does not care where the
     * image came from. The one exception is an image ALREADY STAGED as an
     * attachment, whose tile thumbnail is an object URL minted from the very
     * `File` the user dropped — re-encoding those bytes to base64 to satisfy a
     * self-imposed rule would buy nothing, and `fetch`ing a `blob:` URL to do
     * it is blocked by the renderer's `connect-src 'self'` anyway.
     *
     * Both forms are permitted by `img-src 'self' data: blob:` (see
     * src/renderer/index.html) and — this is the part that matters — both are
     * SAME-ORIGIN, so neither taints the canvas and `toBlob` still works. A
     * cross-origin `http:` backdrop would load and then fail at export, which
     * is why nothing here ever constructs one.
     */
    backdrop?: string | null;
    /** Original filename of the backdrop, used to name the attachment. */
    backdropName?: string | null;
    /**
     * The host is uploading the committed drawing right now.
     *
     * Owned by the parent because the upload is: this component's job ends at
     * PNG bytes. It exists so the sheet can stay OPEN across the round trip
     * when replacing an attachment, rather than closing optimistically and
     * having nowhere to put the drawing if the upload fails — the same rule
     * the composer's own send path follows (#745).
     */
    saving?: boolean;
  }>(),
  { backdrop: null, backdropName: null, saving: false },
);

const emit = defineEmits<{
  commit: [{ data: Uint8Array; dataUrl: string; name: string }];
  close: [];
}>();

// The chord table, not any user preference: undo reads the registry so a
// rebinding in Settings moves this key too.
const settings = useSettingsStore();

// ---------------------------------------------------------------------------
// Tools and pens
// ---------------------------------------------------------------------------

/** Everything that is defined by a pointer drag. */
type ShapeTool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse';
type Tool = ShapeTool | 'text';

const TOOLS: { id: Tool; icon: AppIconName; label: string }[] = [
  { id: 'pen', icon: 'edit-2', label: 'Draw' },
  { id: 'line', icon: 'minus', label: 'Line' },
  { id: 'arrow', icon: 'arrow-right', label: 'Arrow' },
  { id: 'rect', icon: 'square', label: 'Rectangle' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse' },
  { id: 'text', icon: 'type', label: 'Text' },
];

/**
 * The pen palette, as token NAMES.
 *
 * These six are the status/accent tokens that already carry meaning in this
 * UI, so an annotation drawn in `--error` reads the same way an error does
 * everywhere else. No new token is introduced for drawing.
 *
 * Text shares this row rather than growing its own. A second colour control
 * that happened to apply only to text would double the toolbar to express a
 * distinction nobody drawing on a screenshot has ever wanted: the arrow and the
 * label at the end of it are one annotation and should be one colour.
 */
const PENS = ['--error', '--warning', '--success', '--accent', '--agent', '--fg'] as const;
type Pen = (typeof PENS)[number];

/**
 * Logical stroke widths. Scaled with the canvas, so they hold at any zoom.
 *
 * Text size is derived from this too (see `TEXT.sizeRatio` and `TEXT.minSize`,
 * which make these three 48 / 96 / 192px of type), which is why the control's
 * label is deliberately generic: it is the weight of the mark, not the
 * thickness of a line. The two ladders are not the same shape — the floor is a
 * guard for callers below the toolbar's lightest weight — and that is fine,
 * because what the control promises is an ORDERING, not a ratio.
 *
 * The lightest rung used to be 3 and was dropped when every weight but the
 * heaviest was reported as too small: at the ~0.34 display scale of the sheet,
 * a width-3 stroke is about one CSS pixel of ink. The ladder shifted up a rung
 * rather than growing a fourth button — three choices is already two more
 * decisions than annotating a screenshot wants — and the middle one is the
 * default, so the complaint is answered by what opens, not by what must be
 * hunted for.
 */
const WIDTHS = [6, 12, 24] as const;

const tool = ref<Tool>('pen');
const pen = ref<Pen>('--error');
const width = ref<number>(WIDTHS[1]);

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

interface Stroke {
  kind: 'stroke';
  tool: ShapeTool;
  pen: Pen;
  width: number;
  points: Point[];
}

/**
 * A committed text annotation.
 *
 * `origin` is the TOP OF THE GLYPHS of the first line, not a baseline and not
 * the top of the first line BOX — it is the pixel the user clicked, and what
 * they clicked is where the writing starts. The editing `<textarea>` is offset
 * upwards by `textHalfLeading` to put its own first line here too (see
 * `editorStyle`); without that the caret sits half a leading low and the
 * caption visibly hops up at the moment it is committed.
 *
 * The raw text is stored, never the wrapped lines: wrapping depends on the
 * measured font, and the font depends on tokens that can change under a theme
 * switch. Storing lines would freeze a layout computed against a font that is
 * no longer the one being painted with.
 */
interface TextItem {
  kind: 'text';
  pen: Pen;
  width: number;
  origin: Point;
  text: string;
}

type Item = Stroke | TextItem;

/**
 * shallowRef: strokes accumulate hundreds of points while the pointer is down.
 * Deep reactivity would make Vue walk every point on every move event to no
 * purpose — the canvas is repainted explicitly, not by a template binding.
 */
const items = shallowRef<Item[]>([]);
const drawing = ref<Stroke | null>(null);

/**
 * Previous versions of the item list, oldest first. See the header comment:
 * this is a stack of ARRAYS OF REFERENCES, not of pixels, so an entry costs one
 * pointer per item on the sheet.
 */
const history = shallowRef<Item[][]>([]);

const canvasEl = ref<HTMLCanvasElement | null>(null);
const frameEl = ref<HTMLDivElement | null>(null);
const backdropImage = shallowRef<HTMLImageElement | null>(null);
const loadError = ref<string | null>(null);
const busy = ref(false);

/** Logical canvas size. A blank sheet gets a 16:10 field; an image gets its own. */
const size = ref({ w: 1024, h: 640 });

/**
 * Replace the document, keeping the old version for undo.
 *
 * Every mutation goes through here, which is the only way "does undo cover the
 * new tool?" stays answerable: a tool that forgets to call it is a tool that
 * cannot be taken back, and there is exactly one place to check.
 */
function mutate(next: Item[]): void {
  history.value = [...history.value, items.value];
  items.value = next;
}

// ---------------------------------------------------------------------------
// Text editing state
// ---------------------------------------------------------------------------

/**
 * The open text editor, if any.
 *
 * `index` is null for a brand-new annotation and the position in `items` when
 * an existing one is being retyped. Committed text STAYS EDITABLE — click it
 * again with the text tool and the caret comes back. The alternative (text is
 * frozen once committed) means the only cure for a typo is undo-and-retype the
 * whole line, and annotations are typed fast, on top of a screenshot, by
 * someone who is looking at the screenshot rather than at what they typed.
 *
 * `pen` and `width` are copied onto the editor rather than read live from the
 * toolbar, so that re-opening an old red annotation while the toolbar happens
 * to be on green does not silently recolour it. Touching the toolbar WHILE the
 * editor is open does retarget it — that is the user asking.
 */
interface Editing {
  index: number | null;
  origin: Point;
  pen: Pen;
  width: number;
  text: string;
}

const editing = ref<Editing | null>(null);
const editorEl = ref<HTMLTextAreaElement | null>(null);

/**
 * Displayed pixels per logical canvas pixel.
 *
 * The sheet is CSS-scaled to fit the frame (a 2048px screenshot inside a 720px
 * panel), so the editor overlay has to be placed and SIZED in display pixels
 * while the item it edits lives in logical ones. Tracked rather than measured
 * on demand because it only changes on a resize or a backdrop swap, and reading
 * `getBoundingClientRect` from a paint that runs on every pointermove would put
 * a forced layout in the drag loop.
 *
 * The ResizeObserver alone is NOT enough to keep it true, which is why
 * `onPointerDown` re-measures. A ResizeObserver reports the border box, and a
 * border box does not change under a CSS TRANSFORM — but `getBoundingClientRect`
 * does. OverlayPanel's entrance animates the whole sheet through
 * `translateY(8px) scale(0.985)` over `--dur-slow`, so a canvas that mounts with
 * the panel (the blank-sheet route does) measures itself 1.5% small and is
 * never told when the transform settles. 1.5% is nothing at the origin and 10
 * display pixels at the far corner of a 700px sheet: a caret that lands further
 * and further from the click the further across the image you click.
 */
const displayScale = ref(1);
let frameObserver: ResizeObserver | null = null;

function measureScale(): void {
  const canvas = canvasEl.value;
  if (!canvas || canvas.width === 0) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0) displayScale.value = rect.width / canvas.width;
}

const isEmpty = computed(
  () => items.value.length === 0 && drawing.value === null && editing.value === null,
);
const canUndo = computed(() => history.value.length > 0);

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/** Read a custom property off the live element tree. */
function readToken(name: string): string {
  const host = canvasEl.value ?? document.documentElement;
  return getComputedStyle(host).getPropertyValue(name).trim();
}

/** Resolve a token to the concrete colour the canvas context needs. */
function resolve(token: Pen): string {
  const value = readToken(token);
  // A token that fails to resolve means the stylesheet is not attached — draw
  // something visible rather than throwing away the stroke.
  return value === '' ? 'white' : value;
}

/** The blank-sheet ground, taken from the same token the app paints panels with. */
function getSurface(): string {
  const value = readToken('--surface-2');
  return value === '' ? 'black' : value;
}

/** `--lh-300` as a number. The body ratio: this is body copy, on a picture. */
function lineHeightRatio(): number {
  const parsed = Number.parseFloat(readToken('--lh-300'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TEXT.lineHeightRatio;
}

/** The canvas `font` shorthand for a mark of the given width. */
function fontFor(markWidth: number): string {
  const family = readToken('--font-ui') || 'sans-serif';
  const weight = readToken('--fw-semibold') || '600';
  return `${weight} ${textFontSize(markWidth)}px ${family}`;
}

/**
 * Ascent plus descent of the font a mark of this width paints in, or null.
 *
 * Asked of the canvas rather than of the DOM because the canvas is the only
 * thing here that can answer: `getComputedStyle` reports the font that was
 * REQUESTED, while `measureText` reports metrics of the font that was actually
 * resolved, which is what both the painter and the browser's own line boxes are
 * built from. The string measured is arbitrary — `fontBoundingBox*` describes
 * the font, not the glyphs — but 'Hg' is a cap and a descender, so a renderer
 * that ever regressed to ink-box metrics would be caught rather than flattered.
 *
 * Null when the metrics are missing, which is not hypothetical: jsdom has no
 * text engine and its `measureText` returns a width and nothing else.
 * `textHalfLeading` has a documented fallback for exactly that.
 */
function fontContentHeight(markWidth: number): number | null {
  const ctx = canvasEl.value?.getContext('2d');
  if (!ctx) return null;
  ctx.font = fontFor(markWidth);
  const metrics = ctx.measureText('Hg');
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  return Number.isFinite(height) && height > 0 ? height : null;
}

/**
 * Lay a text item out using the canvas's own text metrics.
 *
 * The context is mutated (`font`) before measuring, because `measureText`
 * answers for whatever font is set — measuring in one font and painting in
 * another is the classic way to get wrapping that is right on screen and wrong
 * in the export. Setting it here means every caller measures in the font the
 * very next `fillText` will use.
 */
function layoutFor(ctx: CanvasRenderingContext2D, item: TextItem): TextLayout {
  ctx.font = fontFor(item.width);
  return layoutText({
    text: item.text,
    origin: item.origin,
    fontSize: textFontSize(item.width),
    lineHeightRatio: lineHeightRatio(),
    sheetWidth: size.value.w,
    measure: (s) => ctx.measureText(s).width,
  });
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const { points } = stroke;
  if (points.length === 0) return;

  ctx.strokeStyle = resolve(stroke.pen);
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  const first = points[0];
  const last = points[points.length - 1];

  if (stroke.tool === 'pen') {
    // Quadratic through the midpoints: joining the raw samples with straight
    // segments makes a slow hand look faceted, because pointer events arrive
    // far apart in screen space when the pointer moves slowly.
    ctx.moveTo(first.x, first.y);
    if (points.length === 1) {
      // A tap is a dot, not nothing.
      ctx.lineTo(first.x + 0.01, first.y);
    }
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const next = points[i + 1];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
    }
    if (points.length > 1) ctx.lineTo(last.x, last.y);
    ctx.stroke();
    return;
  }

  if (stroke.tool === 'line' || stroke.tool === 'arrow') {
    // The head is computed before the shaft is drawn because it decides where
    // the shaft ENDS — see ArrowHead.shaftEnd for why it is not the tip.
    const head = stroke.tool === 'arrow' ? arrowHead(first, last, stroke.width) : null;
    const end = head?.shaftEnd ?? last;
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    if (head) {
      ctx.beginPath();
      ctx.moveTo(head.tip.x, head.tip.y);
      ctx.lineTo(head.barbA.x, head.barbA.y);
      ctx.lineTo(head.barbB.x, head.barbB.y);
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    return;
  }

  const x = Math.min(first.x, last.x);
  const y = Math.min(first.y, last.y);
  const w = Math.abs(last.x - first.x);
  const h = Math.abs(last.y - first.y);

  if (stroke.tool === 'rect') {
    ctx.rect(x, y, w, h);
  } else {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
}

/**
 * Paint one text annotation.
 *
 * `textBaseline = 'top'` rather than the default alphabetic baseline: the
 * layout module works in top-left boxes, and an alphabetic baseline would need
 * an ascent metric that differs per font before a click could be turned into
 * one. With 'top' the glyphs of line 0 begin exactly at `layout.y`, which is
 * exactly where the user clicked — no fudge on this side at all.
 *
 * The half-leading correction that makes the editing overlay agree lives in
 * `editorStyle`, and it is on that side ON PURPOSE. Only one of these two
 * renderers can be the reference, and it has to be this one: this is what the
 * PNG will contain, and the textarea is an affordance that exists for a few
 * seconds. Correcting the paint instead would land every caption half a leading
 * below the click forever, to spare a transient box from being moved.
 */
function paintText(ctx: CanvasRenderingContext2D, item: TextItem): void {
  const layout = layoutFor(ctx, item);
  ctx.fillStyle = resolve(item.pen);
  ctx.textBaseline = 'top';
  for (let i = 0; i < layout.lines.length; i++) {
    ctx.fillText(layout.lines[i], layout.x, layout.y + i * layout.lineHeight);
  }
}

function paintItem(ctx: CanvasRenderingContext2D, item: Item): void {
  if (item.kind === 'text') paintText(ctx, item);
  else strokePath(ctx, item);
}

function repaint(): void {
  const canvas = canvasEl.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const image = backdropImage.value;
  if (image) {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  } else {
    // A blank doodle is exported as a real PNG, so it needs an opaque ground —
    // transparent strokes on transparent would arrive as an invisible image on
    // whatever the agent's viewer happens to composite it against.
    ctx.fillStyle = getSurface();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // The item currently under a caret is skipped: the textarea is drawn over
  // that exact rectangle in the same font and colour, and painting both would
  // show the old text ghosting behind the new. It comes back the instant the
  // edit commits, which is also the instant before any export can happen.
  const held = editing.value?.index ?? null;
  for (let i = 0; i < items.value.length; i++) {
    if (i === held) continue;
    paintItem(ctx, items.value[i]);
  }
  if (drawing.value) strokePath(ctx, drawing.value);
}

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------

/** Map a pointer event to logical canvas coordinates. */
function pointFrom(e: PointerEvent): Point {
  const canvas = canvasEl.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  // The canvas is CSS-scaled to fit the frame, so screen pixels are not
  // logical pixels; divide through by the displayed size, not by DPR.
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

/**
 * The second point of a two-point drag, with Shift applied.
 *
 * Shift constrains to 45deg increments, and only for the two tools where an
 * angle is the thing being drawn. It is NOT wired to the rectangle and the
 * ellipse, where the same key conventionally means "square"/"circle" — that is
 * a different constraint with the same keycap, and implementing one of them
 * while leaving the other to do nothing would be worse than doing neither: a
 * user who learns Shift on the arrow would reasonably expect a square.
 *
 * Why constrain at all: the commonest annotation on a screenshot is a
 * horizontal or vertical arrow pointing at a row or a column, and a
 * hand-dragged "horizontal" arrow is out by a degree or two, which is visible
 * precisely because the thing it points at is aligned.
 */
function dragPoint(e: PointerEvent, stroke: Stroke): Point {
  const point = pointFrom(e);
  const constrainable = stroke.tool === 'line' || stroke.tool === 'arrow';
  if (!e.shiftKey || !constrainable) return point;
  return constrainToAngle(stroke.points[0], point);
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const canvas = canvasEl.value;
  if (!canvas) return;

  // Re-measure BEFORE the click is decoded, so the scale that places the text
  // editor is the same scale the click was read through. `pointFrom` divides a
  // live `getBoundingClientRect`; `editorStyle` multiplies the cached
  // `displayScale`. The two only cancel — which is what "the caret appears
  // exactly where I clicked" means — if they are the same number, and see
  // `displayScale` for how they drift apart on their own. One forced layout per
  // press, on a path that already takes one.
  measureScale();

  if (tool.value === 'text') {
    onTextPointerDown(pointFrom(e));
    return;
  }

  // Capture so a stroke that leaves the canvas keeps tracking, and so the
  // matching up event is delivered here even if it happens over the toolbar.
  canvas.setPointerCapture(e.pointerId);
  drawing.value = {
    kind: 'stroke',
    tool: tool.value,
    pen: pen.value,
    width: width.value,
    points: [pointFrom(e)],
  };
  repaint();
}

function onPointerMove(e: PointerEvent): void {
  const stroke = drawing.value;
  if (!stroke) return;
  if (stroke.tool === 'pen') {
    stroke.points.push(pointFrom(e));
  } else {
    // Every other tool is defined by two corners; dragging moves the second.
    stroke.points = [stroke.points[0], dragPoint(e, stroke)];
  }
  repaint();
}

function onPointerUp(e: PointerEvent): void {
  const stroke = drawing.value;
  if (!stroke) return;
  canvasEl.value?.releasePointerCapture(e.pointerId);
  // Take the release position too, so letting go of Shift on the last frame, or
  // a release that arrives without a preceding move, still lands where the
  // pointer actually is.
  if (stroke.tool !== 'pen' && stroke.points.length === 2) {
    stroke.points = [stroke.points[0], dragPoint(e, stroke)];
  }
  drawing.value = null;
  // A click with no drag leaves a shape of zero extent; only the pen means
  // anything by a single point. For the arrow in particular this is the whole
  // answer to "what does a click do?": nothing, deliberately, because the
  // alternative is an invisible zero-length arrow that still eats an Undo.
  const degenerate =
    stroke.tool !== 'pen' &&
    stroke.points.length === 2 &&
    isDegenerateDrag(stroke.points[0], stroke.points[1]);
  if (!degenerate) mutate([...items.value, stroke]);
  repaint();
}

// ---------------------------------------------------------------------------
// Text tool
// ---------------------------------------------------------------------------

/** Index of the topmost committed text annotation under `point`, or null. */
function textAt(point: Point): number | null {
  const ctx = canvasEl.value?.getContext('2d');
  if (!ctx) return null;
  // Back to front: later items are painted on top, so they are hit first.
  for (let i = items.value.length - 1; i >= 0; i--) {
    const item = items.value[i];
    if (item.kind !== 'text') continue;
    if (hitTestText(layoutFor(ctx, item), point)) return i;
  }
  return null;
}

/**
 * A click with the text tool: commit whatever was open, then edit or place.
 *
 * The order is load-bearing. Committing first can DELETE an item (an annotation
 * emptied to whitespace is a deleted annotation), which shifts every index after
 * it, so the hit test has to run against the settled list or it would hand back
 * a stale index and the click would open the wrong annotation.
 */
function onTextPointerDown(point: Point): void {
  commitText();
  const hit = textAt(point);
  if (hit !== null) {
    const item = items.value[hit];
    if (item.kind === 'text') {
      const { origin, pen: itemPen, width: itemWidth, text } = item;
      openEditor({ index: hit, origin, pen: itemPen, width: itemWidth, text });
      return;
    }
  }
  openEditor({ index: null, origin: point, pen: pen.value, width: width.value, text: '' });
}

function openEditor(next: Editing): void {
  editing.value = next;
  repaint();
  void nextTick(() => {
    const el = editorEl.value;
    if (!el) return;
    autoSizeEditor();
    el.focus();
    // Caret at the END of the existing text, not at the click position.
    // Mapping a click to a character offset is possible but it would be the
    // only place in this app where a click inside a canvas is decoded into a
    // text index, and getting it wrong puts the caret somewhere the user did
    // not point at — worse than a predictable end-of-text.
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

/**
 * Fold the open editor back into the document.
 *
 * Four things reach here, and they are the entire commit vocabulary of the
 * tool: Escape, Ctrl/Cmd+Enter, a click elsewhere on the sheet, and Attach.
 * Blur is deliberately NOT one of them — a blur-commits rule means reaching for
 * the colour swatch ends the annotation you were in the middle of typing, which
 * is exactly when a user reaches for the colour swatch.
 */
function commitText(): void {
  const open = editing.value;
  if (!open) return;
  editing.value = null;

  if (open.index === null) {
    // A caret placed and then abandoned leaves nothing behind, and — the point
    // of checking before `mutate` — costs no Undo either. An Undo that appears
    // to do nothing is how users conclude undo is broken.
    if (!isBlankText(open.text)) {
      mutate([
        ...items.value,
        { kind: 'text', pen: open.pen, width: open.width, origin: open.origin, text: open.text },
      ]);
    }
    repaint();
    return;
  }

  const existing = items.value[open.index];
  // Colour and weight are compared alongside the text, not just the text:
  // reaching for a swatch mid-edit retargets the open annotation (see the
  // toolbar watcher), so "nothing changed" has to mean all three or a
  // recolour-without-retype would be silently thrown away here.
  const unchanged =
    existing?.kind === 'text' &&
    existing.text === open.text &&
    existing.pen === open.pen &&
    existing.width === open.width;
  if (existing?.kind !== 'text' || unchanged) {
    // Re-opened and left alone. No change, so no history entry.
    repaint();
    return;
  }

  const next = [...items.value];
  // Emptying an annotation is how you delete one. There is no separate delete
  // control, and inventing one would mean a selection model this surface does
  // not otherwise have.
  if (isBlankText(open.text)) next.splice(open.index, 1);
  else next[open.index] = { ...existing, text: open.text, pen: open.pen, width: open.width };
  mutate(next);
  repaint();
}

/** Grow the textarea to its content so it never scrolls under the caret. */
function autoSizeEditor(): void {
  const el = editorEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function onEditorInput(e: Event): void {
  const open = editing.value;
  if (!open) return;
  open.text = (e.target as HTMLTextAreaElement).value;
  autoSizeEditor();
}

/**
 * Keys inside the text editor.
 *
 * ENTER INSERTS A NEWLINE. It is the default, and it is left alone on purpose:
 * an annotation on a screenshot wraps and is routinely two or three lines, so
 * binding Enter to commit would make the multi-line case unreachable. Note this
 * is the OPPOSITE of the composer's own draft (bare Enter sends there), and the
 * divergence is fine because they are answering different questions: the draft
 * is a message you are finishing, this is a caption you are laying out.
 *
 * ESCAPE COMMITS AND CLOSES THE EDITOR, and it does not propagate.
 *
 * The propagation half is the important half. This canvas is mounted inside an
 * OverlayPanel (Escape -> close the overlay) which is mounted inside the
 * composer's `.composer-root` (Escape -> the close ladder -> hide the whole
 * composer). Both listen for a bubbling Escape, so without `stopPropagation`
 * one keypress while typing a caption would throw away the caption, the
 * drawing, and the composer, in that order. `stopPropagation` here makes the
 * open editor the innermost rung of that same ladder — Escape closes what you
 * opened last — without either of the outer handlers needing to know this tool
 * exists.
 *
 * COMMITS, rather than cancels, because this app's Escape never destroys work:
 * Escape never destroys work — the draft's own rule says so in as many words — and Discard is the only control
 * that throws anything away. The way to take back an annotation you did not
 * want is Ctrl+Z, which covers it — see `mutate`.
 *
 * Ctrl/Cmd+Enter also commits, matching the composer's "modifier plus Enter
 * finishes this" muscle memory for the many users who will try it first.
 *
 * Ctrl+Z is allowed to reach the textarea's native undo and is stopped from
 * reaching the sheet's: while a caret is in a text box, undo means "undo my
 * typing", not "delete the arrow I drew a minute ago".
 */
function onEditorKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    commitText();
    return;
  }
  if (e.key === 'Enter' && mod && !e.isComposing) {
    e.preventDefault();
    e.stopPropagation();
    commitText();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.stopPropagation();
  }
}

/**
 * Retarget the open editor when the toolbar changes.
 *
 * Picking a colour or a weight with a caret in a text box means "make THIS
 * text that colour" — there is nothing else on the sheet it could plausibly
 * mean, since every other tool applies its colour at the moment of drawing.
 * The textarea is styled from the same values, so the change is visible while
 * typing rather than at commit.
 */
watch([pen, width], ([nextPen, nextWidth]) => {
  const open = editing.value;
  if (!open) return;
  open.pen = nextPen;
  open.width = nextWidth;
  void nextTick(autoSizeEditor);
});

/** Leaving the text tool commits; a caret with no text tool has no meaning. */
watch(tool, () => commitText());

/** Live editor geometry, in DISPLAYED pixels over the scaled sheet. */
const editorStyle = computed(() => {
  const open = editing.value;
  if (!open) return {};
  const scale = displayScale.value;
  const fontSize = textFontSize(open.width);
  // The same available width `layoutText` wraps to, so the textarea breaks its
  // lines at (very nearly) the same places the painted result will. It cannot
  // be exact — the browser's inline layout and `measureText` are two different
  // line breakers — but the box, the family, the size and the leading are the
  // same, so a caption that fits while typing fits when painted.
  const available = size.value.w - open.origin.x - fontSize * TEXT.edgePadding;
  // Lift the box by half a leading. `origin` is where the GLYPHS start — the
  // pixel the user clicked — and the canvas paints them there directly, because
  // `textBaseline = 'top'` anchors the glyph top. CSS does not: a textarea
  // centres each line's glyph box inside a line box of `line-height`, so a box
  // whose top is at `origin` would start writing half a leading lower, and the
  // caption would jump up by that much the instant it was committed. The
  // correction is computed from the font's own metrics, so it holds at every
  // mark weight rather than at the one it was tuned against; `* scale` because
  // everything else in this style block is in display pixels too.
  const lift = textHalfLeading(fontSize, lineHeightRatio(), fontContentHeight(open.width));
  return {
    left: `${open.origin.x * scale}px`,
    top: `${(open.origin.y - lift) * scale}px`,
    width: `${Math.max(fontSize, available) * scale}px`,
    fontSize: `${fontSize * scale}px`,
    lineHeight: String(lineHeightRatio()),
    color: `var(${open.pen})`,
  };
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function undo(): void {
  const past = history.value;
  if (past.length === 0) return;
  // An open editor is abandoned by undo rather than committed: the user asked
  // to go back, and committing on the way out would first ADD the annotation
  // they are undoing past.
  editing.value = null;
  items.value = past[past.length - 1];
  history.value = past.slice(0, -1);
  repaint();
}

function clear(): void {
  editing.value = null;
  drawing.value = null;
  if (items.value.length > 0) mutate([]);
  repaint();
}

// ---------------------------------------------------------------------------
// Closing without losing the drawing
// ---------------------------------------------------------------------------

/**
 * The "really throw this away?" state.
 *
 * Until this existed, every route out of the sheet except Attach destroyed the
 * markup silently: Cancel, the overlay's `✕`, a stray click on the backdrop,
 * and Escape. On a blank sheet that is merely annoying. On a screenshot the
 * user attached, opened, and spent a minute drawing on, a mis-aimed click
 * outside a modal — the single easiest mouse error there is — deleted all of
 * it with no undo, because undo lives INSIDE the component that just
 * unmounted.
 *
 * The guard is deliberately not a `window.confirm`: that blocks the renderer,
 * looks nothing like the rest of the app, and cannot be tested. It is a bar in
 * the sheet's own footer, which also keeps the drawing visible behind the
 * question being asked about it.
 *
 * The rule is the app's usual one: Escape never destroys work. So
 * Escape ARMS the guard, and a second Escape dismisses the guard rather than
 * confirming it — the safe direction on the key people press without reading.
 * Discarding takes a deliberate click on a button that says Discard.
 */
const confirmingClose = ref(false);

/** True once there is anything on the sheet worth a confirmation. */
const isDirty = computed(() => !isEmpty.value);

/**
 * Ask to close. The parent routes EVERY dismissal through here — its own
 * Cancel button, the overlay's `✕`, its backdrop click and its Escape — so
 * there is exactly one place that decides whether work is about to be lost.
 */
function requestClose(): void {
  // A second Escape (or `✕`) while the question is up answers "keep editing".
  if (confirmingClose.value) {
    confirmingClose.value = false;
    return;
  }
  // An upload in flight owns the drawing until it lands; closing over the top
  // of it would leave a committed annotation with nowhere to go.
  if (props.saving) return;
  if (!isDirty.value) {
    emit('close');
    return;
  }
  // A caret still open is part of the drawing: flush it so the confirmation is
  // asked about what the user can actually see.
  commitText();
  confirmingClose.value = true;
}

/** The parent owns the overlay chrome, so it needs the same door. */
defineExpose({ requestClose });

function onKeydown(e: KeyboardEvent): void {
  // Ctrl/Cmd+Z only. Escape is the overlay's to handle, and it already does —
  // except while a text editor is open, where the textarea stops it first.
  if (isShortcut(settings.shortcutBindings, 'doodle.undo', e) && canUndo.value) {
    e.preventDefault();
    undo();
  }
}

function attachmentName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  // The stripping rules live in the pure module: re-annotating an already
  // annotated attachment is a supported second pass, and the name it starts
  // from carries decorations from both this surface and the stager.
  return doodleAttachmentName(props.backdropName ?? null, stamp);
}

async function commit(): Promise<void> {
  const canvas = canvasEl.value;
  if (!canvas || busy.value) return;
  // Flush the caret INTO the document first. Without this, attaching while
  // still typing a caption would export a bitmap with the caption missing —
  // the textarea is a DOM element floating over the canvas and `toBlob` has
  // never heard of it. `commitText` repaints synchronously, so the pixels are
  // right by the time the encoder is asked for them.
  commitText();
  busy.value = true;
  try {
    const blob = await new Promise<Blob | null>((resolve_) =>
      canvas.toBlob(resolve_, 'image/png'),
    );
    if (!blob) {
      loadError.value = 'Could not encode the drawing.';
      return;
    }
    emit('commit', {
      data: new Uint8Array(await blob.arrayBuffer()),
      // The tile preview is a data URL because the CSP allows `data:` for
      // img-src; it is never persisted, exactly like the other tile previews.
      dataUrl: canvas.toDataURL('image/png'),
      name: attachmentName(),
    });
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Backdrop loading
// ---------------------------------------------------------------------------

async function loadBackdrop(source: string | null): Promise<void> {
  backdropImage.value = null;
  loadError.value = null;
  if (!source) {
    size.value = { w: 1024, h: 640 };
    await nextTick();
    measureScale();
    repaint();
    return;
  }

  const image = new Image();
  await new Promise<void>((done) => {
    image.onload = () => done();
    image.onerror = () => {
      loadError.value = 'That image could not be opened.';
      done();
    };
    image.src = source;
  });

  if (loadError.value === null && image.naturalWidth > 0) {
    // Cap the working resolution. A phone screenshot is ~1179x2556 and a
    // desktop capture can be 5K; annotating at full native size costs memory
    // and export bytes for detail no one is going to look at, and the strokes
    // scale with the image anyway.
    const MAX = 2048;
    const scale = Math.min(1, MAX / Math.max(image.naturalWidth, image.naturalHeight));
    size.value = {
      w: Math.round(image.naturalWidth * scale),
      h: Math.round(image.naturalHeight * scale),
    };
    backdropImage.value = image;
  }
  await nextTick();
  measureScale();
  repaint();
}

watch(() => props.backdrop, loadBackdrop);

onMounted(async () => {
  document.addEventListener('keydown', onKeydown);
  if (frameEl.value && typeof ResizeObserver !== 'undefined') {
    frameObserver = new ResizeObserver(measureScale);
    frameObserver.observe(frameEl.value);
  }
  await loadBackdrop(props.backdrop);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  frameObserver?.disconnect();
  frameObserver = null;
});
</script>

<template>
  <div class="doodle">
    <div class="toolbar" role="toolbar" aria-label="Drawing tools">
      <div class="group" role="group" aria-label="Tool">
        <button
          v-for="t in TOOLS"
          :key="t.id"
          class="tool-btn"
          :class="{ active: tool === t.id }"
          :title="t.label"
          :aria-label="t.label"
          :aria-pressed="tool === t.id"
          @click="tool = t.id"
        >
          <AppIcon :name="t.icon" :size="14" />
        </button>
      </div>

      <div class="sep" />

      <div class="group" role="group" aria-label="Colour">
        <button
          v-for="p in PENS"
          :key="p"
          class="pen-btn"
          :class="{ active: pen === p }"
          :style="{ '--pen': `var(${p})` }"
          :title="p.replace('--', '')"
          :aria-label="p.replace('--', '')"
          :aria-pressed="pen === p"
          @click="pen = p"
        >
          <span class="swatch" />
        </button>
      </div>

      <div class="sep" />

      <!-- One control, two meanings: line thickness, and — via
           TEXT.sizeRatio — text size. They are the same idea (how heavy a
           mark), which is why this is not two controls.

           The tooltip asks `textFontSize(w)` rather than writing the ratio out
           a second time. It used to say `w * 4`, which was already a copy of
           `TEXT.sizeRatio` and would now be promising "Text 12px" for a mark
           the canvas sets at 36. One function owns the answer. -->
      <div class="group" role="group" aria-label="Mark weight">
        <button
          v-for="w in WIDTHS"
          :key="w"
          class="width-btn"
          :class="{ active: width === w }"
          :title="tool === 'text' ? `Text ${textFontSize(w)}px` : `${w}px`"
          :aria-label="`Mark weight ${w}`"
          :aria-pressed="width === w"
          @click="width = w"
        >
          <!-- The dot previews the weight, it does not measure it: capped at
               16px because the button is 24px and an 18px dot leaves two
               pixels of air on a side. Ordering survives the cap — 6 / 10 / 16
               is still three visibly different dots. -->
          <span
            class="width-dot"
            :style="{ '--dot': `${Math.min(Math.round(w / 1.5) + 2, 16)}px` }"
          />
        </button>
      </div>

      <div class="spacer" />

      <button class="tool-btn" :disabled="!canUndo" title="Undo" @click="undo">
        <AppIcon name="rotate-ccw" :size="14" />
      </button>
      <button class="tool-btn" :disabled="isEmpty" title="Clear" @click="clear">
        <AppIcon name="trash-2" :size="14" />
      </button>
    </div>

    <div ref="frameEl" class="frame">
      <!-- The stage is exactly the canvas's displayed box, so the text editor
           can be positioned in its coordinate space with nothing but a scale
           factor. It shrink-wraps: the canvas is `object-fit: contain` inside
           the frame, and an editor placed against the FRAME would be offset by
           whatever letterboxing that produced. -->
      <div class="stage">
        <canvas
          ref="canvasEl"
          class="sheet"
          :class="{ texting: tool === 'text' }"
          :width="size.w"
          :height="size.h"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <!-- Sized and coloured from the same numbers `paintText` uses, so this
             is a live preview of the painted result rather than a separate
             styling of the same string. -->
        <textarea
          v-if="editing"
          ref="editorEl"
          class="text-editor"
          :style="editorStyle"
          :value="editing.text"
          rows="1"
          spellcheck="false"
          aria-label="Annotation text"
          @input="onEditorInput"
          @keydown="onEditorKeydown"
        />
      </div>
    </div>

    <!-- The confirmation REPLACES the action row rather than stacking above it,
         so the buttons that answer the question are the only buttons there
         are. Leaving Attach and Cancel live underneath a "discard?" prompt
         would offer three answers to a two-answer question. -->
    <footer v-if="confirmingClose" class="actions confirm">
      <p class="hint warn">Discard this drawing? It cannot be recovered.</p>
      <button class="btn" @click="confirmingClose = false">Keep editing</button>
      <button class="btn danger" @click="emit('close')">Discard</button>
    </footer>
    <footer v-else class="actions">
      <p v-if="loadError" class="error">{{ loadError }}</p>
      <p v-else-if="saving" class="hint">Uploading the annotated image&hellip;</p>
      <p v-else-if="editing" class="hint">Enter for a new line, Esc or Ctrl+Enter to finish</p>
      <p v-else-if="tool === 'text'" class="hint">Click the sheet to write; click text to edit it</p>
      <p v-else-if="tool === 'arrow' || tool === 'line'" class="hint">
        Drag from tail to head; hold Shift for 45&deg; steps
      </p>
      <p v-else class="hint">{{ backdropName || 'Blank sheet' }}</p>
      <button class="btn" :disabled="saving" @click="requestClose">Cancel</button>
      <button class="btn primary" :disabled="busy || saving" @click="commit">
        {{ saving ? 'Saving…' : 'Attach' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.doodle {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

/* ---- Toolbar ------------------------------------------------------------ */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  flex-wrap: wrap;
}
.group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sep {
  width: 1px;
  align-self: stretch;
  margin: 0 var(--sp-1);
  background: var(--border);
}
.spacer {
  flex: 1 1 auto;
}

.tool-btn,
.pen-btn,
.width-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tool-btn:hover:not(:disabled),
.pen-btn:hover,
.width-btn:hover {
  background: var(--state-hover);
  color: var(--fg);
}
.tool-btn.active,
.width-btn.active {
  background: var(--state-selected);
  border-color: var(--accent-dim);
  color: var(--accent);
}
.tool-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.tool-btn:focus-visible,
.pen-btn:focus-visible,
.width-btn:focus-visible,
.btn:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* The swatch IS the affordance, so it carries the selected state as a ring
   rather than a fill — a filled background behind a colour chip reads as a
   second, competing colour. */
.swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--pen);
}
.pen-btn.active {
  border-color: var(--fg);
}

.width-dot {
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  background: currentColor;
}

/* ---- Sheet -------------------------------------------------------------- */
.frame {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: var(--sp-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
/* Shrink-wraps the canvas so `.text-editor`'s containing block IS the sheet.
   `line-height: 0` kills the inline descender gap that would otherwise put a
   few pixels between the two boxes and offset every caption. */
.stage {
  position: relative;
  min-width: 0;
  line-height: 0;
}
/* Fit the sheet inside the overlay without ever scaling it up: an 800px-wide
   screenshot blown up to fill a 960px panel would be annotated against soft
   pixels. */
.sheet {
  display: block;
  max-width: 100%;
  max-height: 56vh;
  object-fit: contain;
  border-radius: var(--r-sm);
  cursor: crosshair;
  touch-action: none;
}
/* The text tool places a caret rather than dragging a shape, and the pointer
   should say which. */
.sheet.texting {
  cursor: text;
}

/* ---- Text editor --------------------------------------------------------
 * A transparent textarea sitting exactly where the painted text will be. No
 * background and no border on purpose: any chrome here would be chrome the
 * export does not have, so the moment of committing would visibly change the
 * annotation. The caret and the selection are the only things that appear and
 * then vanish, which is what a caret is for. */
.text-editor {
  position: absolute;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--font-ui);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  resize: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  caret-color: currentColor;
}
.text-editor:focus {
  /* No focus ring: the caret is the focus indicator, and a ring drawn around
     the block would sit over the picture being annotated. */
  outline: none;
}

/* ---- Footer ------------------------------------------------------------- */
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.hint,
.error {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.error {
  color: var(--error);
}
/* The discard confirmation borrows the composer's "Not sent" banner treatment
   rather than inventing one: same tokens, same meaning — a row that is asking
   about losing something. */
.actions.confirm {
  padding: var(--sp-2);
  background: var(--error-soft);
  border: 1px solid var(--error);
  border-radius: var(--r-md);
}
.hint.warn {
  color: var(--fg);
}
.btn {
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  font-size: var(--fs-200);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: var(--state-hover);
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-semibold);
}
.btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Outlined, not filled: the safe answer (Keep editing) is the plain button, so
   the destructive one must not also be the loudest thing in the row. Same
   treatment as the composer's own `.discard`. */
.btn.danger {
  background: transparent;
  border-color: var(--error);
  color: var(--error);
  font-weight: var(--fw-medium);
}
.btn.danger:hover:not(:disabled) {
  background: var(--error);
  color: var(--on-accent);
}
</style>
