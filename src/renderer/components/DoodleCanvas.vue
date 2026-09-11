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
  constrainToAngle,
  isDegenerateDrag,
  textFontSize,
  type Point,
  type TextLayout,
} from '../../shared/doodleGeometry';
import { useDoodleText } from '../useDoodleText';
import {
  PENS,
  WIDTHS,
  type Item,
  type Pen,
  type Stroke,
  type TextItem,
  type Tool,
} from '../doodleModel';
import {
  fontContentHeight as fontContentHeightOn,
  lineHeightRatioFor,
  paintItem as paintItemOn,
  resolveToken,
  surfaceColor,
  strokePath as strokePathOn,
  layoutFor as layoutForOn,
  type PaintEnv,
} from '../doodlePaint';

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
//
// The pen palette and the width ladder — with the reasoning for each — are
// data in doodleModel.ts. TOOLS stays here because its icons are AppIcon
// names, a type only a .vue module can import; the toolbar's live state is
// here too.

const TOOLS: { id: Tool; icon: AppIconName; label: string }[] = [
  { id: 'pen', icon: 'edit-2', label: 'Draw' },
  { id: 'line', icon: 'minus', label: 'Line' },
  { id: 'arrow', icon: 'arrow-right', label: 'Arrow' },
  { id: 'rect', icon: 'square', label: 'Rectangle' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse' },
  { id: 'text', icon: 'type', label: 'Text' },
];

const tool = ref<Tool>('pen');
const pen = ref<Pen>('--error');
const width = ref<number>(WIDTHS[1]);

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

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
//
// The open-editor state and its machinery live in useDoodleText.ts, called
// below once the painters it closes over exist.

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
// Token resolution and painting
// ---------------------------------------------------------------------------
//
// The painters are pure functions in doodlePaint.ts — tokens into colours and
// fonts, text laid out with the canvas's own metrics, strokes and captions
// drawn — and every decision record travelled with them. These closures bind
// them to THIS sheet's canvas and width, so the component's callers read
// exactly as before.

const resolve = (token: Pen): string => resolveToken(canvasEl.value, token);
const getSurface = (): string => surfaceColor(canvasEl.value);
const lineHeightRatio = (): number => lineHeightRatioFor(canvasEl.value);
const fontContentHeight = (markWidth: number): number | null =>
  fontContentHeightOn(canvasEl.value, markWidth);

const paintEnv = (): PaintEnv => ({
  host: canvasEl.value,
  sheetWidth: size.value.w,
  resolve,
});

const layoutFor = (ctx: CanvasRenderingContext2D, item: TextItem): TextLayout =>
  layoutForOn(ctx, item, paintEnv());

const strokePath = (ctx: CanvasRenderingContext2D, stroke: Stroke): void =>
  strokePathOn(ctx, stroke, paintEnv());

const paintItem = (ctx: CanvasRenderingContext2D, item: Item): void =>
  paintItemOn(ctx, item, paintEnv());

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
//
// The whole text tool — the open-editor state, placement, the commit
// vocabulary (Escape, Ctrl/Cmd+Enter, a click elsewhere, Attach; never blur),
// the key handling, and the overlay's geometry — is useDoodleText.ts, with
// its decision records. It closes over the painters and the toolbar state.

const {
  editing,
  editorEl,
  editorStyle,
  onTextPointerDown,
  commitText,
  onEditorInput,
  onEditorKeydown,
} = useDoodleText({
  items,
  mutate,
  repaint,
  canvasEl,
  displayScale,
  size,
  pen,
  width,
  tool,
  layoutFor,
  lineHeightRatio,
  fontContentHeight,
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
