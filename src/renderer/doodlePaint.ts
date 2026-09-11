import {
  layoutText,
  textFontSize,
  TEXT,
  arrowHead,
  type TextLayout,
  type Point,
} from '../shared/doodleGeometry';
import type { Item, Pen, Stroke, TextItem } from './doodleModel';

/**
 * Painting a doodle: resolving the app's design tokens into canvas colours
 * and fonts, laying text out with the canvas's own metrics, and drawing the
 * items. Pure functions over an explicit host element or context — the
 * component keeps the refs and passes them in, so this module has no state
 * and the sheet's painter stays one painter.
 */

/** Read a custom property off the live element tree. */
export function readToken(host: HTMLElement | null, name: string): string {
  const el = host ?? document.documentElement;
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Resolve a token to the concrete colour the canvas context needs. */
export function resolveToken(host: HTMLElement | null, token: Pen): string {
  const value = readToken(host, token);
  // A token that fails to resolve means the stylesheet is not attached — draw
  // something visible rather than throwing away the stroke.
  return value === '' ? 'white' : value;
}

/** The blank-sheet ground, taken from the same token the app paints panels with. */
export function surfaceColor(host: HTMLElement | null): string {
  const value = readToken(host, '--surface-2');
  return value === '' ? 'black' : value;
}

/** `--lh-300` as a number. The body ratio: this is body copy, on a picture. */
export function lineHeightRatioFor(host: HTMLElement | null): number {
  const parsed = Number.parseFloat(readToken(host, '--lh-300'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TEXT.lineHeightRatio;
}

/** The canvas `font` shorthand for a mark of the given width. */
export function fontShorthand(host: HTMLElement | null, markWidth: number): string {
  const family = readToken(host, '--font-ui') || 'sans-serif';
  const weight = readToken(host, '--fw-semibold') || '600';
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
export function fontContentHeight(
  canvas: HTMLCanvasElement | null,
  markWidth: number,
): number | null {
  const ctx = canvas?.getContext('2d');
  if (!ctx) return null;
  ctx.font = fontShorthand(canvas, markWidth);
  const metrics = ctx.measureText('Hg');
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  return Number.isFinite(height) && height > 0 ? height : null;
}

/** What the paint functions need from the sheet they paint on. */
export interface PaintEnv {
  /** The canvas element — the host the design tokens are resolved against. */
  host: HTMLElement | null;
  /** The logical sheet width text wraps to. */
  sheetWidth: number;
  /** Token → colour, so every painter agrees on one resolution. */
  resolve: (token: Pen) => string;
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
export function layoutFor(
  ctx: CanvasRenderingContext2D,
  item: TextItem,
  env: PaintEnv,
): TextLayout {
  ctx.font = fontShorthand(env.host, item.width);
  return layoutText({
    text: item.text,
    origin: item.origin,
    fontSize: textFontSize(item.width),
    lineHeightRatio: lineHeightRatioFor(env.host),
    sheetWidth: env.sheetWidth,
    measure: (s) => ctx.measureText(s).width,
  });
}

export function strokePath(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  env: PaintEnv,
): void {
  const { points } = stroke;
  if (points.length === 0) return;

  ctx.strokeStyle = env.resolve(stroke.pen);
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  const first: Point = points[0];
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
 * the editor's style computation, and it is on that side ON PURPOSE. Only one
 * of these two renderers can be the reference, and it has to be this one: this
 * is what the PNG will contain, and the textarea is an affordance that exists
 * for a few seconds. Correcting the paint instead would land every caption
 * half a leading below the click forever, to spare a transient box from being
 * moved.
 */
export function paintText(
  ctx: CanvasRenderingContext2D,
  item: TextItem,
  env: PaintEnv,
): void {
  const layout = layoutFor(ctx, item, env);
  ctx.fillStyle = env.resolve(item.pen);
  ctx.textBaseline = 'top';
  for (let i = 0; i < layout.lines.length; i++) {
    ctx.fillText(layout.lines[i], layout.x, layout.y + i * layout.lineHeight);
  }
}

export function paintItem(
  ctx: CanvasRenderingContext2D,
  item: Item,
  env: PaintEnv,
): void {
  if (item.kind === 'text') paintText(ctx, item, env);
  else strokePath(ctx, item, env);
}
