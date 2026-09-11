/**
 * At-rest highlighting for terminal path links — the half the hover link
 * provider cannot give.
 *
 * The user's acceptance test is the view at rest, and at rest the remote CLI
 * wins the styling: it colours its file references blue and underlines them,
 * but when ITS wrapper breaks a path across rows the underline attribute
 * covers only the first row's fragment, and the continuation sits plain. The
 * hover link (terminalLinks.ts) does reconstruct the whole path, but only
 * while the mouse is on it — so every at-rest screenshot kept reading as
 * "still not highlighting". This layer closes that gap: the full joined
 * path carries a block tint whenever it is on screen, mouse or no mouse.
 * The joined WEB urls the same wrapper breaks across rows get the same
 * repair through the same pipeline (lineLinks below): the remote CLI
 * underlines only the first row of those too.
 *
 * ## Why an onRender rescan, given the docs once said this was not viable
 *
 * `Terminal.registerDecoration` anchors to a buffer MARKER, and the old
 * objection was staleness: tmux repaints rows in place, so a cached
 * decoration comes to underline cells whose contents have moved on. The
 * escape is to never let a decoration outlive its render: `term.onRender`
 * reports exactly which viewport rows the renderer touched, and for each one
 * this layer DISPOSES the decorations it held for that row and re-derives
 * them from the buffer as it stands now, through the very same
 * {@link pathLinks} the hover provider uses — one detection pipeline, two
 * presentations. A decoration therefore never describes anything but the
 * frame it was scanned in; the per-frame cost is one rescan of the dirty
 * rows, which is the price the old note already anticipated.
 *
 * Three facts shape the rest:
 *
 *   - a marker is created as an offset from the cursor's absolute line
 *     (`viewportY + cursorY`), so the highlighter re-derives the offset for
 *     every row it refreshes rather than holding markers across scrolls.
 *
 *   - the tint paints on the ACTIVE buffer, whatever it is — and that is
 *     almost always the ALTERNATE one. This pane is always a tmux client,
 *     and the attach client is itself a full-screen program whose first
 *     bytes are `smcup` (`CSI ?1049h`, captured from tmux 3.4), so every
 *     joined session draws on the alternate buffer and the normal buffer
 *     holds only a bare shell. xterm registers markers and decorations on
 *     either buffer, and its DOM renderer paints a decoration's
 *     `backgroundColor` into the active buffer's cell spans (looked up by
 *     absolute line), so no buffer special case is wanted here. Two
 *     unrelated gates do exist but gate other things: `registerDecoration`
 *     is proposed-API (TerminalView constructs the terminal with
 *     `allowProposedApi` for it), and xterm's decoration-ELEMENT renderer
 *     `display:none`s its elements on the alternate buffer — an element this
 *     colour-only decoration never shows through.
 *
 *   - a refresh that would change nothing disposes and registers nothing.
 *     Every decoration registration asks the renderer for a full repaint
 *     (RenderService listens for registration), and a highlighter that
 *     re-registered on every touched row — including the rows its own
 *     repaint touches — would chase its own tail at frame rate. A row is
 *     rewritten only when its anchor line, its segment list or the tint
 *     actually changed.
 *
 * Decorations are keyed by viewport row and the whole viewport is revisited
 * on scroll (a scroll re-renders every row), so nothing survives long enough
 * to point at the wrong text; `onResize` clears outright and the next render
 * repopulates.
 */
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { lastTextColumn, lineLinks, type TerminalPathContext, type UrlOpener } from './terminalLinks';

interface RowSegment {
  x: number;
  width: number;
}

interface RowDecorations {
  marker: IMarker;
  decorations: IDecoration[];
  segments: RowSegment[];
  tint: string;
}

function sameSegments(a: RowSegment[], b: RowSegment[]): boolean {
  return (
    a.length === b.length && a.every((s, i) => s.x === b[i]?.x && s.width === b[i]?.width)
  );
}

export class PathHighlighter {
  private readonly rows = new Map<number, RowDecorations>();
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly context: () => TerminalPathContext,
    private readonly tint: () => string,
  ) {}

  /** Begin highlighting; one subscription to the render stream. */
  attach(): void {
    this.subscriptions.push(
      this.term.onRender(({ start, end }) => {
        const baseY = this.term.buffer.active.viewportY;
        for (let row = start; row <= end; row++) this.refreshRow(row, baseY);
      }),
      this.term.onResize(() => this.clear()),
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.clear();
  }

  private refreshRow(row: number, baseY: number): void {
    const buffer = this.term.buffer.active;
    // `pathLinks` speaks 1-based absolute buffer lines, as xterm's own link
    // provider contract does.
    const line = baseY + row + 1;

    // The segment list THIS row carries: one entry per link that spans it.
    // A row that is neither the link's first nor its last has no endpoint of
    // its own in the range — the range records two cells — so its segment is
    // clamped to the row's own text: a reconstructed row stops short of the
    // pane and the padding after it is not path.
    const segments: RowSegment[] = [];
    // One flattening, both detectors: paths of every span, and the web links
    // that cross rows (a single-row URL gets no tint — it was never
    // half-underlined by the remote CLI, so there is nothing to repair).
    // The opener is never called; decorations do not activate.
    const open: UrlOpener = () => undefined;
    for (const link of lineLinks(this.term, line, this.context, open)) {
      if (line < link.range.start.y || line > link.range.end.y) continue;
      const rowEnd = lastTextColumn(this.term, line);
      const startX = line === link.range.start.y ? link.range.start.x : 1;
      const endX = line === link.range.end.y ? link.range.end.x : rowEnd;
      const width = endX - startX + 1;
      if (width <= 0) continue;
      segments.push({ x: startX, width });
    }

    const tint = this.tint();
    const held = this.rows.get(row);
    if (
      held !== undefined &&
      held.marker.line === line - 1 &&
      held.tint === tint &&
      sameSegments(held.segments, segments)
    ) {
      return;
    }

    if (held !== undefined) {
      for (const decoration of held.decorations) decoration.dispose();
      held.marker.dispose();
      this.rows.delete(row);
    }
    if (segments.length === 0) return;

    // One marker per row; every segment anchors to it. The marker is the
    // buffer line the decorations describe, so it is created relative to the
    // cursor's ABSOLUTE line (viewportY + cursorY).
    const cursorLine = baseY + buffer.cursorY;
    const marker = this.term.registerMarker(line - 1 - cursorLine);
    if (marker === undefined || marker.line < 0) {
      marker?.dispose();
      return;
    }

    const decorations: IDecoration[] = [];
    for (const segment of segments) {
      const decoration = this.term.registerDecoration({
        marker,
        anchor: 'left',
        x: segment.x,
        width: segment.width,
        backgroundColor: tint,
        layer: 'bottom',
      });
      if (decoration !== undefined) decorations.push(decoration);
    }

    if (decorations.length === 0) {
      marker.dispose();
      return;
    }
    this.rows.set(row, { marker, decorations, segments, tint });
  }

  private clear(): void {
    for (const { marker, decorations } of this.rows.values()) {
      for (const decoration of decorations) decoration.dispose();
      marker.dispose();
    }
    this.rows.clear();
  }
}
