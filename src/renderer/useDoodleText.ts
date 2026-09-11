import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  hitTestText,
  isBlankText,
  textFontSize,
  textHalfLeading,
  TEXT,
  type Point,
  type TextLayout,
} from '../shared/doodleGeometry';
import type { Item, Pen, TextItem } from './doodleModel';

export interface DoodleTextDeps {
  items: Ref<Item[]>;
  /** The one mutation path — see the component's `mutate`. */
  mutate: (next: Item[]) => void;
  repaint: () => void;
  canvasEl: Ref<HTMLCanvasElement | null>;
  /** Displayed pixels per logical canvas pixel — see the component. */
  displayScale: Ref<number>;
  size: Ref<{ w: number; h: number }>;
  pen: Ref<Pen>;
  width: Ref<number>;
  tool: Ref<'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text'>;
  layoutFor: (ctx: CanvasRenderingContext2D, item: TextItem) => TextLayout;
  lineHeightRatio: () => number;
  fontContentHeight: (markWidth: number) => number | null;
}

/**
 * The text tool: placing a caption where the user clicks, editing it in a
 * textarea overlay, and folding it back into the document.
 *
 * Committed text STAYS EDITABLE — click it again with the text tool and the
 * caret comes back. Extracted from DoodleCanvas.vue; every decision record
 * below travelled with its code.
 */
export function useDoodleText(deps: DoodleTextDeps): {
  editing: Ref<{ index: number | null; origin: Point; pen: Pen; width: number; text: string } | null>;
  editorEl: Ref<HTMLTextAreaElement | null>;
  editorStyle: ComputedRef<Record<string, string>>;
  textAt: (point: Point) => number | null;
  onTextPointerDown: (point: Point) => void;
  commitText: () => void;
  onEditorInput: (e: Event) => void;
  onEditorKeydown: (e: KeyboardEvent) => void;
} {
  const { items } = deps;

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

  /** Index of the topmost committed text annotation under `point`, or null. */
  function textAt(point: Point): number | null {
    const ctx = deps.canvasEl.value?.getContext('2d');
    if (!ctx) return null;
    // Back to front: later items are painted on top, so they are hit first.
    for (let i = items.value.length - 1; i >= 0; i--) {
      const item = items.value[i];
      if (item.kind !== 'text') continue;
      if (hitTestText(deps.layoutFor(ctx, item), point)) return i;
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
    openEditor({ index: null, origin: point, pen: deps.pen.value, width: deps.width.value, text: '' });
  }

  function openEditor(next: Editing): void {
    editing.value = next;
    deps.repaint();
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
        deps.mutate([
          ...items.value,
          { kind: 'text', pen: open.pen, width: open.width, origin: open.origin, text: open.text },
        ]);
      }
      deps.repaint();
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
      deps.repaint();
      return;
    }

    const next = [...items.value];
    // Emptying an annotation is how you delete one. There is no separate delete
    // control, and inventing one would mean a selection model this surface does
    // not otherwise have.
    if (isBlankText(open.text)) next.splice(open.index, 1);
    else next[open.index] = { ...existing, text: open.text, pen: open.pen, width: open.width };
    deps.mutate(next);
    deps.repaint();
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
   * Escape never destroys work — the draft's own rule says so in as many words —
   * and Discard is the only control that throws anything away. The way to take
   * back an annotation you did not want is Ctrl+Z, which covers it — see the
   * component's `mutate`.
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
  watch([deps.pen, deps.width], ([nextPen, nextWidth]) => {
    const open = editing.value;
    if (!open) return;
    open.pen = nextPen;
    open.width = nextWidth;
    void nextTick(autoSizeEditor);
  });

  /** No editor open: no style. Typed so the union cannot grow `undefined` members. */
  const EDITOR_STYLE_NONE: Record<string, string> = {};

  /** Leaving the text tool commits; a caret with no text tool has no meaning. */
  watch(deps.tool, () => commitText());

  /** Live editor geometry, in DISPLAYED pixels over the scaled sheet. */
  const editorStyle = computed<Record<string, string>>(() => {
    const open = editing.value;
    if (!open) return EDITOR_STYLE_NONE;
    const scale = deps.displayScale.value;
    const fontSize = textFontSize(open.width);
    // The same available width `layoutText` wraps to, so the textarea breaks its
    // lines at (very nearly) the same places the painted result will. It cannot
    // be exact — the browser's inline layout and `measureText` are two different
    // line breakers — but the box, the family, the size and the leading are the
    // same, so a caption that fits while typing fits when painted.
    const available = deps.size.value.w - open.origin.x - fontSize * TEXT.edgePadding;
    // Lift the box by half a leading. `origin` is where the GLYPHS start — the
    // pixel the user clicked — and the canvas paints them there directly, because
    // `textBaseline = 'top'` anchors the glyph top. CSS does not: a textarea
    // centres each line's glyph box inside a line box of `line-height`, so a box
    // whose top is at `origin` would start writing half a leading lower, and the
    // caption would jump up by that much the instant it was committed. The
    // correction is computed from the font's own metrics, so it holds at every
    // mark weight rather than at the one it was tuned against; `* scale` because
    // everything else in this style block is in display pixels too.
    const lift = textHalfLeading(fontSize, deps.lineHeightRatio(), deps.fontContentHeight(open.width));
    return {
      left: `${open.origin.x * scale}px`,
      top: `${(open.origin.y - lift) * scale}px`,
      width: `${Math.max(fontSize, available) * scale}px`,
      fontSize: `${fontSize * scale}px`,
      lineHeight: String(deps.lineHeightRatio()),
      color: `var(${open.pen})`,
    };
  });

  return {
    editing,
    editorEl,
    editorStyle,
    textAt,
    onTextPointerDown,
    commitText,
    onEditorInput,
    onEditorKeydown,
  };
}
