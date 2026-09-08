import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { applyUnicode11Widths } from '../../src/renderer/terminalUnicode';

/**
 * The width contract behind every emoji a pane draws.
 *
 * xterm's default provider measures emoji under Unicode 6: one column each.
 * The fonts that draw them render two, and the next cell paints over the
 * overflow — half an emoji on any row that carries a background. The pane
 * therefore runs Unicode 11, and because nothing else can observe which
 * provider a terminal is on, this pins the two halves of the contract against
 * the real emulator: the default is as narrow as the bug requires, and
 * `applyUnicode11Widths` turns these codepoints wide before any output would
 * be parsed.
 *
 * Runs against `@xterm/headless` — the same UnicodeService the DOM terminal
 * uses, no mocks.
 */

/**
 * Write `s` into a fresh terminal (Unicode 11 applied first when `wide`), let
 * the parser finish, and return each cell of row 0 as `chars:width`.
 */
async function cellWidths(s: string, wide: boolean): Promise<string[]> {
  const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
  if (wide) applyUnicode11Widths(term);
  await new Promise<void>((resolve) => term.write(s, resolve));
  const line = term.buffer.active.getLine(0)!;
  const cells: string[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)!;
    cells.push(`${cell.getChars()}:${cell.getWidth()}`);
  }
  return cells;
}

describe('terminal Unicode widths', () => {
  // U+1F389 🎉 is the emoji the bug was reported with; U+2705 ✅ and the
  // U+1F331 🌱 + VS16 sequence cover the plain-wide and text-style cases.
  const EMOJI = 'A\u{1F389}B\u{1F331}\uFE0FC\u2705D';

  it('measures emoji one column wide under the default (Unicode 6) tables', async () => {
    const cells = await cellWidths(EMOJI, false);
    expect(cells[0]).toBe('A:1');
    expect(cells[1]).toBe('\u{1F389}:1');
    expect(cells[2]).toBe('B:1');
  });

  it('switches the provider to Unicode 11', () => {
    // `unicode` is proposed API in xterm, like `buffer` below; the pane
    // constructs with allowProposedApi already on (terminalPathHighlights).
    const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    applyUnicode11Widths(term);
    expect(term.unicode.activeVersion).toBe('11');
  });

  it('measures emoji two columns wide once applied', async () => {
    const cells = await cellWidths(EMOJI, true);
    // Each emoji takes two columns, the second being the wide-character
    // continuation cell — the column the DOM renderer must not paint over.
    expect(cells[0]).toBe('A:1');
    expect(cells[1]).toBe('\u{1F389}:2');
    expect(cells[2]).toBe(':0');
    expect(cells[3]).toBe('B:1');
    // The seedling carries an explicit emoji-presentation selector (U+FE0F);
    // under Unicode 11 the whole sequence lives in one wide cell.
    expect(cells[4]).toBe('\u{1F331}\uFE0F:2');
    expect(cells[5]).toBe(':0');
    expect(cells[6]).toBe('C:1');
    expect(cells[7]).toBe('\u{2705}:2');
    expect(cells[8]).toBe(':0');
    expect(cells[9]).toBe('D:1');
  });
});
