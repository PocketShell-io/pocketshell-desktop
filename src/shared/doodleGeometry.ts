/**
 * The arithmetic behind the doodle surface's arrow and text tools.
 *
 * Pure by construction: no DOM, no canvas context, no design tokens. The
 * component measures the world — pointer positions, resolved token values, the
 * width of a string in the font the canvas actually has — and feeds numbers in.
 * That split is the whole point. Arrowhead barbs and greedy line breaking are
 * exactly the kind of code that is subtly wrong for months (a head that grows
 * past its own shaft, a word that never breaks and runs off the bitmap) and
 * exactly the kind that a unit test pins in ten lines, but only if it is not
 * tangled up with `getComputedStyle` and `CanvasRenderingContext2D`.
 *
 * The one thing this module deliberately does NOT know is how to measure text.
 * Text width depends on the font the canvas resolved, which depends on tokens,
 * which depends on the DOM. So `wrapLines` takes a `measure` callback: the
 * caller passes `ctx.measureText`, a test passes a fake with known widths, and
 * the wrapping algorithm — the part with the off-by-one in it — is testable
 * without a canvas at all.
 */

export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

export const ARROW = {
  /**
   * Head length as a multiple of the stroke width.
   *
   * The head scales with the stroke, and that is a decision rather than an
   * accident. The alternative — a head of fixed pixel size — makes the width
   * control a lie: at width 3 a fixed 24px head is a spearhead on a thread, and
   * at width 12 the shaft is thicker than the barbs and the arrow reads as a
   * line with a lump on it. Everything else on this surface scales with the
   * width the user picked, so the arrow does too, and one control keeps meaning
   * one thing.
   */
  headRatio: 4,

  /**
   * The head may never eat more than this fraction of the arrow.
   *
   * Without the cap, a short drag at width 12 is `min(48, length)` of head and
   * therefore all head and no shaft — a triangle where the user drew an arrow.
   * Leaving 40% of the drag as visible shaft keeps a stubby arrow reading as an
   * arrow, and for any arrow longer than ~10x the stroke width the cap never
   * binds at all, so normal arrows are unaffected.
   */
  maxHeadFraction: 0.6,

  /** Half-angle between the shaft and each barb. ~25.7deg: Feather's own arrow. */
  spread: Math.PI / 7,

  /**
   * Shorter than this, in logical canvas pixels, is a click and not a drag.
   *
   * A click with a shape tool would otherwise commit a zero-length item: an
   * invisible entry that still consumes an Undo, so the user presses Ctrl+Z,
   * sees nothing change, and concludes undo is broken. Two pixels is below the
   * jitter of a trackpad tap and far below any deliberate mark.
   */
  minLength: 2,
} as const;

/** The snap increment for a constrained drag: 45 degrees. */
export const SNAP_RADIANS = Math.PI / 4;

/** Straight-line distance between two points. */
export function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * True when a two-point drag never really left where it started.
 *
 * Shared by every two-point tool, not just the arrow: a click with the
 * rectangle tool is as meaningless as a click with the arrow tool. The pen is
 * the sole exception and it is the caller's job to know that — a tap with the
 * pen is a dot, which is a mark a user means.
 */
export function isDegenerateDrag(from: Point, to: Point): boolean {
  return distance(from, to) < ARROW.minLength;
}

/**
 * Snap `to` onto the nearest ray from `from` at a multiple of `step`.
 *
 * Projected onto the snapped ray rather than kept at its original distance.
 * The difference matters at the moment of snapping: hold Shift halfway through
 * a drag and the length-preserving version swings the head out to the side,
 * away from the pointer, so the arrow appears to lunge. Projection moves the
 * head to the foot of the perpendicular — the nearest point on the ray — which
 * from the user's side looks like the head sliding onto the guide rail it was
 * already close to.
 *
 * The projection can be negative when the pointer is more than 90deg off the
 * chosen ray; it cannot be, because the ray chosen is always the nearest one
 * and the nearest of eight rays is at most 22.5deg away. The clamp is there for
 * a caller that passes a coarser `step`.
 */
export function constrainToAngle(from: Point, to: Point, step: number = SNAP_RADIANS): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const raw = Math.atan2(dy, dx);
  const snapped = Math.round(raw / step) * step;
  const projected = Math.max(0, dx * Math.cos(snapped) + dy * Math.sin(snapped));
  return {
    x: from.x + projected * Math.cos(snapped),
    y: from.y + projected * Math.sin(snapped),
  };
}

/** The three corners of the filled head, plus where the shaft should stop. */
export interface ArrowHead {
  /** The head end of the drag — the point the arrow points AT. */
  tip: Point;
  /** The barbs, in the order a path should visit them from the tip. */
  barbA: Point;
  barbB: Point;
  /**
   * Where to end the shaft.
   *
   * The shaft stops at the barb baseline rather than running all the way to
   * the tip. Both look identical for a thin stroke, but a round line cap of
   * radius w/2 drawn AT the tip pokes w/2 past it — at width 12 that is a
   * 6px blob sticking out of the point of the arrow, which is precisely where
   * the eye is looking. Ending at the baseline puts the cap under the filled
   * triangle, where nobody can see it.
   */
  shaftEnd: Point;
}

/**
 * Geometry for an arrowhead drawn at `to`, pointing away from `from`.
 *
 * Returns null for a drag too short to have a direction: `atan2(0, 0)` is 0,
 * so a degenerate drag would otherwise produce a confident east-pointing head
 * out of no information at all.
 */
export function arrowHead(from: Point, to: Point, strokeWidth: number): ArrowHead | null {
  const length = distance(from, to);
  if (length < ARROW.minLength) return null;

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.min(strokeWidth * ARROW.headRatio, length * ARROW.maxHeadFraction);

  const barb = (offset: number): Point => ({
    x: to.x - head * Math.cos(angle + offset),
    y: to.y - head * Math.sin(angle + offset),
  });

  // The barbs' projection onto the shaft: how far back the baseline sits.
  const baseline = head * Math.cos(ARROW.spread);
  return {
    tip: { x: to.x, y: to.y },
    barbA: barb(-ARROW.spread),
    barbB: barb(ARROW.spread),
    shaftEnd: {
      x: to.x - baseline * Math.cos(angle),
      y: to.y - baseline * Math.sin(angle),
    },
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const TEXT = {
  /**
   * Font size as a multiple of the selected stroke width.
   *
   * This is the one number here that a reader will want to argue with, because
   * the house rule is that type comes from the `--fs-*` tokens. It cannot, and
   * pocketshell-core/packages/ui/src/fonts.ts already says why in as many words: the `--fs-*`
   * ladder "is a density system — 28px rows, 40px bars" for CHROME, and it tops
   * out at 20px. The canvas is not chrome. Its logical pixels are not CSS
   * pixels: a phone screenshot is annotated at up to 2048px wide and then
   * displayed at a few hundred, so `--fs-300` text would be four screen pixels
   * tall on the sheet and 13/2048 of the width of the exported PNG. A ladder
   * built for row heights has no opinion that is useful here.
   *
   * What text on this surface must match is the OTHER MARKS on this surface —
   * a caption and the arrow pointing at it should look like they came from one
   * hand — and the user already chose that weight of mark with the width
   * control. So size follows width. Family, weight and line height still come
   * from tokens (`--font-ui`, `--fw-semibold`, `--lh-300`); only the SCALE is
   * the canvas's own.
   *
   * WAS 4, borrowed unchanged from `ARROW.headRatio`, and that borrowing is
   * exactly what was wrong: an arrowhead is a shape and reads fine when the
   * sheet is shrunk, while type stops being type. The sheet is ALWAYS shrunk.
   * The doodle lives in an `md` OverlayPanel — `min(720px, 92vw)` less the
   * panel border and the frame's `--sp-2` padding, so ~700 CSS px of sheet —
   * and a backdrop is worked at up to 2048px (`MAX` in DoodleCanvas.vue). That
   * is a display scale of 700/2048 = 0.34, and worse for a portrait screenshot,
   * where `max-height: 56vh` on a 900px-tall window gives 504/2048 = 0.25.
   *
   * At 4x the three mark weights were 12 / 24 / 48 logical pixels, which at
   * 0.34 reach the eye as 4 / 8 / 16 CSS pixels. Two of the three settings were
   * below `--fs-100` (11px), the smallest type the app sets anywhere — the
   * default among them. Hence "for annotations font size is too small": it was,
   * measurably, and at every setting but the heaviest.
   *
   * At 8x with the toolbar's current ladder of 6 / 12 / 24 they are 48 / 96 /
   * 192 — the same ratio that fixed the original complaint, applied to a mark
   * ladder that has since shifted up one rung because the strokes themselves
   * were reported too small (see `WIDTHS` in DoodleCanvas.vue). The default 96
   * lands at ~33 CSS px on screen and is 4.7% of the width of a 2048px export:
   * heading-sized, which is what the heaviest caption on a screenshot wants to
   * be when the whole sheet shrinks to a third.
   */
  sizeRatio: 8,

  /**
   * The smallest font an annotation is ever set in, in logical pixels.
   *
   * A GUARD now, not a rung. When it was introduced the toolbar's lightest
   * weight was 3, and 3 * 8 = 24px was the exact size that had just been
   * reported as too small to read — the ratio alone left one setting of the
   * control still producing the complaint. The mark ladder has since shifted up
   * to 6 / 12 / 24, so its lightest weight resolves to 48px and the floor never
   * binds for a toolbar selection.
   *
   * It stays because `textFontSize` is public arithmetic, not a private helper
   * of the toolbar: anything that calls it with a width below 4.5 — a future
   * ladder change, a custom tool, a test — would otherwise get sub-36px type,
   * which is the size class this module has already been told once is
   * unreadable on the shrunken sheet.
   */
  minSize: 36,

  /**
   * Fallback line-height ratio, used only if `--lh-300` fails to resolve —
   * which means the stylesheet is not attached, and a sane number beats
   * stacking every line of the annotation on one baseline.
   */
  lineHeightRatio: 1.3846,

  /**
   * Breathing room, in multiples of the font size, kept between the text block
   * and the right edge of the bitmap. Text that wraps exactly at the edge looks
   * like text that got cut off.
   */
  edgePadding: 0.5,

  /** Slop around a text block when hit-testing a click, in multiples of size. */
  hitPadding: 0.25,

  /**
   * Fallback height of a line's glyph box — ascent plus descent — as a multiple
   * of the font size, used only when the canvas will not report font metrics.
   *
   * NEW, and it exists to place the editing overlay (see `textHalfLeading`).
   * 1.21 is Inter's own: ascent 0.969em + descent 0.242em, the family `--font-ui`
   * resolves to. It is a fallback and not the number normally used — Chromium's
   * `measureText` reports `fontBoundingBoxAscent`/`Descent` and those are the
   * very metrics its CSS line box is built from, so the real ones are exact
   * where this one is merely close. The fallback matters in jsdom, whose
   * `measureText` returns a width and nothing else.
   *
   * NOT 1: the em square is not the glyph box. Assuming 1 would over-correct
   * the overlay by (1.21 - 1) / 2 = 0.105em, which at the new heaviest weight
   * is 10 logical pixels of caption sitting above where it was typed.
   */
  contentBoxRatio: 1.21,
} as const;

/**
 * The font size an annotation is set at, for a given stroke width.
 *
 * `Math.max` before `Math.round`, so the floor is the floor: see `TEXT.minSize`
 * for why the lightest mark weight is not allowed to take the ratio literally.
 */
export function textFontSize(strokeWidth: number): number {
  return Math.round(Math.max(strokeWidth * TEXT.sizeRatio, TEXT.minSize));
}

/**
 * How far below the top of a LINE BOX the glyphs inside it actually begin.
 *
 * This is the number that decides whether a caption lands where it was typed.
 * Two renderers draw the same annotation — the canvas, via `fillText` with
 * `textBaseline = 'top'`, and a `<textarea>` overlaid on the canvas while the
 * caret is in it — and they anchor the first line differently. Canvas `top`
 * puts the glyph top AT the given y. CSS puts it half a leading down, because
 * a line box of `line-height` tall centres its `ascent + descent` glyph box
 * inside itself, above and below alike. So the same origin renders the same
 * string in two places, and the gap is proportional to the font size: it was
 * 2px at the old 24px default and would have been 8px at the new 48px one,
 * growing to 17px at the heaviest weight. Tuning it away with a constant would
 * therefore fix exactly one font size and break the other two.
 *
 * `contentHeight` is `fontBoundingBoxAscent + fontBoundingBoxDescent` from the
 * canvas that will do the painting. Passing the measured value makes the
 * correction exact rather than approximate, because Blink builds both the
 * canvas baseline and the CSS line box from that same metric; null falls back
 * to `TEXT.contentBoxRatio`.
 *
 * Clamped at zero: a line height TIGHTER than the glyph box (a theme could set
 * `--lh-300` below 1) means the glyphs overflow their line box symmetrically,
 * not that the caption should be pushed upwards.
 */
export function textHalfLeading(
  fontSize: number,
  lineHeightRatio: number,
  contentHeight: number | null = null,
): number {
  const content =
    contentHeight !== null && contentHeight > 0 ? contentHeight : fontSize * TEXT.contentBoxRatio;
  return Math.max(0, (fontSize * lineHeightRatio - content) / 2);
}

/** Measures the advance width of a string in whatever font the caller has. */
export type MeasureText = (text: string) => number;

/**
 * Break `text` into rendered lines, at most `maxWidth` wide.
 *
 * Three rules, in order:
 *
 *  1. A newline the user typed is a HARD break and is never merged away. This
 *     is why the paragraphs are split first: greedy wrapping over the whole
 *     string would happily pull the first word of the next paragraph up onto
 *     the previous line whenever it fitted, which silently destroys a
 *     deliberately laid-out list.
 *  2. Within a paragraph, break on spaces, greedily. Greedy is right here and
 *     not merely easy: an annotation is a handful of words and the balanced
 *     (Knuth-Plass) alternative buys nothing at that length.
 *  3. A single word wider than the line is broken between characters. Without
 *     this rule a pasted URL or a long path — the two things most likely to be
 *     typed onto a screenshot — would overflow the bitmap and be cropped by the
 *     PNG's edge, which is invisible in the editor and permanent in the export.
 *
 * A non-positive `maxWidth` disables wrapping rather than looping forever; it
 * means the caller placed the caret at the very edge of the sheet, and text
 * running off the side is a better failure than a hung renderer.
 */
export function wrapLines(text: string, maxWidth: number, measure: MeasureText): string[] {
  const paragraphs = text.split('\n');
  if (!(maxWidth > 0)) return paragraphs;

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      // An empty paragraph is a blank line the user asked for, not nothing.
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line !== '' && measure(`${line} ${word}`) > maxWidth) {
        out.push(line);
        line = '';
      }
      if (line === '' && measure(word) > maxWidth) {
        // Rule 3: the word does not fit on a line of its own either. Every
        // piece but the last is a finished line; the last one keeps going, so
        // a following short word can still join it.
        const pieces = breakWord(word, maxWidth, measure);
        out.push(...pieces.slice(0, -1));
        line = pieces[pieces.length - 1] ?? '';
      } else {
        line = line === '' ? word : `${line} ${word}`;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Split one over-long word into chunks that each fit.
 *
 * Character-by-character accumulation rather than a binary search on length:
 * proportional fonts have kerning pairs, so `measure(a + b)` is not
 * `measure(a) + measure(b)` and a width-based estimate can overshoot. The words
 * this ever runs on are URLs and paths, tens of characters, so the linear scan
 * is free. A single character wider than the whole line still gets its own line
 * rather than looping — nothing else can be done with it.
 */
function breakWord(word: string, maxWidth: number, measure: MeasureText): string[] {
  const pieces: string[] = [];
  let chunk = '';
  for (const ch of word) {
    const candidate = chunk + ch;
    if (chunk !== '' && measure(candidate) > maxWidth) {
      pieces.push(chunk);
      chunk = ch;
    } else {
      chunk = candidate;
    }
  }
  pieces.push(chunk);
  return pieces;
}

/** A laid-out text annotation: what to draw, and the box it occupies. */
export interface TextLayout {
  lines: string[];
  /** Baseline-to-baseline distance, in logical pixels. */
  lineHeight: number;
  fontSize: number;
  /** The block's bounding box, with `x`/`y` at the top-left of the first line. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLayoutInput {
  text: string;
  /** Top-left of the first line — where the user clicked. */
  origin: Point;
  fontSize: number;
  /** Ratio, not pixels: the resolved value of `--lh-300`. */
  lineHeightRatio: number;
  /** Width of the sheet, so text can be wrapped before it leaves the bitmap. */
  sheetWidth: number;
  measure: MeasureText;
}

/**
 * Lay a text annotation out at its origin.
 *
 * `y` is the TOP of the first line, not its baseline, and the caller is
 * expected to paint with `textBaseline = 'top'`. Two reasons: it is the same
 * box a `<textarea>` overlaid on the canvas occupies, so the editing preview
 * and the painted result line up without an ascent fudge factor; and ascent is
 * a font metric this module has no way to know, which would drag the DOM back
 * in through the door it was just shown out of.
 */
export function layoutText(input: TextLayoutInput): TextLayout {
  const { text, origin, fontSize, lineHeightRatio, sheetWidth, measure } = input;
  // Never narrower than one em. The raw figure goes negative for a caret placed
  // within `edgePadding` of the right edge, and a non-positive width switches
  // `wrapLines` off entirely — text that runs off the bitmap and is cropped by
  // the PNG, invisibly, in the export. That was a 12px-wide sliver of the sheet
  // when the font was 24px and is a 192px one at the heaviest weight now, so
  // the fallback moved from "unreachable" to "reachable by clicking near the
  // edge". One character per line is ugly; silently losing the caption is
  // worse. It also matches what the editing overlay already did
  // — `Math.max(fontSize, available)` in DoodleCanvas.vue's `editorStyle` — so
  // the preview and the paint now break their lines by the same rule.
  const maxWidth = Math.max(fontSize, sheetWidth - origin.x - fontSize * TEXT.edgePadding);
  const lines = wrapLines(text, maxWidth, measure);
  const lineHeight = fontSize * lineHeightRatio;
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line));
  return {
    lines,
    lineHeight,
    fontSize,
    x: origin.x,
    y: origin.y,
    width,
    // The last line contributes its full line height, not just its font size:
    // the block's height is what the editor's textarea occupies, and a
    // textarea's last line carries its leading like every other line.
    height: lineHeight * lines.length,
  };
}

/**
 * Is `point` inside (or just outside) a laid-out block?
 *
 * The slop is what makes "click the text to fix the typo" work: a text block's
 * bounding box is only as wide as its longest line, so clicking the ragged
 * right of a short line — visually well inside the annotation — would miss.
 */
export function hitTestText(layout: TextLayout, point: Point): boolean {
  const pad = layout.fontSize * TEXT.hitPadding;
  return (
    point.x >= layout.x - pad &&
    point.x <= layout.x + layout.width + pad &&
    point.y >= layout.y - pad &&
    point.y <= layout.y + layout.height + pad
  );
}

/**
 * Is this text worth keeping?
 *
 * The text equivalent of `isDegenerateDrag`. Clicking with the text tool and
 * then clicking elsewhere must leave nothing behind — an empty annotation is
 * invisible, but it still occupies an Undo and can still be hit-tested, so it
 * would sit there stealing clicks aimed at the drawing underneath.
 */
export function isBlankText(text: string): boolean {
  return text.trim() === '';
}
