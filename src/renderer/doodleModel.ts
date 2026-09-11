import type { Point } from '../shared/doodleGeometry';

/** Everything that is defined by a pointer drag. */
export type ShapeTool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse';
export type Tool = ShapeTool | 'text';

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
export const PENS = ['--error', '--warning', '--success', '--accent', '--agent', '--fg'] as const;
export type Pen = (typeof PENS)[number];

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
export const WIDTHS = [6, 12, 24] as const;

export interface Stroke {
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
export interface TextItem {
  kind: 'text';
  pen: Pen;
  width: number;
  origin: Point;
  text: string;
}

export type Item = Stroke | TextItem;
