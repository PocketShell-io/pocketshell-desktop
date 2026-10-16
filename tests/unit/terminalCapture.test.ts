import { describe, expect, it } from 'vitest';
import type { IBufferLine, Terminal } from '@xterm/xterm';

/**
 * The capture chords' engine: the pane's grid back out as text.
 *
 * The terminal is faked rather than instantiated, as in terminalLinks.test.ts
 * — a real `Terminal` needs a DOM and a renderer to hold buffer contents, and
 * what is under test here is the READING rules: which rows a scope takes, what
 * joins a wrapped row, what a blank or double-width cell contributes, and what
 * gets trimmed. One fake-builder serves both because the arithmetic runs on
 * `IBufferLine`s and nothing else.
 */

/** One row of the fake buffer. `cells` is one entry per CELL, not per char. */
interface FakeRow {
  cells: { chars: string; width: number }[];
  isWrapped: boolean;
}

/**
 * A buffer [rows] wide-[width] cells — every row of a real xterm buffer is the
 * pane's full width whether or not anything was written to it — with [wrapped]
 * naming the rows xterm flagged as continuations of the one above. [rows] and
 * [height] position the viewport: the `screen` scope reads from `viewportY`
 * for [height] rows, exactly as a scrolled pane would show.
 */
function fakeTerminal(
  rows: string[],
  width: number,
  opts: { wrapped?: number[]; viewportY?: number; height?: number } = {},
): Terminal {
  return buildTerminal(
    rows.map((row, i) => ({
      // Padded rows keep genuine trailing blanks as untouched cells: `chars: ''`.
      cells: [...row.padEnd(width)].map((ch) => ({ chars: ch, width: 1 })),
      isWrapped: (opts.wrapped ?? []).includes(i),
    })),
    opts,
  );
}

/** A fake buffer from hand-built rows, for the shapes a string cannot spell. */
function buildTerminal(
  rows: FakeRow[],
  opts: { viewportY?: number; height?: number } = {},
): Terminal {
  const lines: FakeRow[] = rows;
  const buffer = {
    viewportY: opts.viewportY ?? 0,
    length: lines.length,
    getNullCell: () => ({ getChars: () => '', getWidth: () => 1 }),
    getLine: (y: number): IBufferLine | undefined => {
      const line = lines[y];
      if (!line) return undefined;
      return {
        length: line.cells.length,
        isWrapped: line.isWrapped,
        getCell: (x: number) => {
          const cell = line.cells[x];
          if (!cell) return undefined;
          return { getChars: () => cell.chars, getWidth: () => cell.width };
        },
      } as unknown as IBufferLine;
    },
  };
  return { rows: opts.height ?? rows.length, buffer: { active: buffer } } as unknown as Terminal;
}

const { captureTerminalText } = await import('@ui/app/terminalCapture');

describe('captureTerminalText — scopes', () => {
  it('reads the visible screen top to bottom', () => {
    const term = fakeTerminal(['first', 'second', 'third'], 10);
    expect(captureTerminalText(term, 'screen')).toBe('first\nsecond\nthird');
  });

  it('reads only the viewport when the pane is scrolled up', () => {
    const term = fakeTerminal(['old-1', 'old-2', 'new-1', 'new-2', 'new-3'], 10, {
      viewportY: 2,
      height: 3,
    });
    expect(captureTerminalText(term, 'screen')).toBe('new-1\nnew-2\nnew-3');
    // The whole buffer starts at row 0, wherever the viewport sits.
    expect(captureTerminalText(term, 'buffer')).toBe('old-1\nold-2\nnew-1\nnew-2\nnew-3');
  });

  it('clips the screen scope at the buffer end', () => {
    // A viewport taller than what is left below it (the last screen of a
    // short-lived pane) must not read past the buffer.
    const term = fakeTerminal(['only'], 10, { viewportY: 0, height: 30 });
    expect(captureTerminalText(term, 'screen')).toBe('only');
    expect(captureTerminalText(term, 'buffer')).toBe('only');
  });
});

describe('captureTerminalText — rows and joins', () => {
  it('glues a row xterm flagged wrapped onto the row above, and nothing else', () => {
    const term = fakeTerminal(
      ['https://example.com/very/lo', 'ng/path', 'plain after'],
      30,
      { wrapped: [1] },
    );
    expect(captureTerminalText(term, 'screen')).toBe(
      'https://example.com/very/long/path\nplain after',
    );
  });

  it('leaves rows that merely follow one another as separate lines', () => {
    const term = fakeTerminal(['one', 'two'], 10);
    expect(captureTerminalText(term, 'screen')).toBe('one\ntwo');
  });

  it('does not join a wrapped row onto nothing at the top of its range', () => {
    // A viewport scrolled into the middle of a wrapped line: its first row IS
    // a continuation, and with no row above in range it stands alone.
    const term = fakeTerminal(['head-continuation', 'next'], 20, { wrapped: [0] });
    expect(captureTerminalText(term, 'screen')).toBe('head-continuation\nnext');
  });

  it('chains a run of wrapped rows into one line', () => {
    const term = fakeTerminal(['a', 'b', 'c', 'after'], 4, { wrapped: [1, 2] });
    expect(captureTerminalText(term, 'screen')).toBe('abc\nafter');
  });
});

describe('captureTerminalText — cells and trimming', () => {
  it('reads an untouched cell as a space, and drops trailing padding', () => {
    // Three unwritten cells between `one` and `two`: the interior gap is
    // content — a token boundary, the space the pane renders — and the
    // padding past `two` is not.
    const term = buildTerminal([
      {
        cells: [
          { chars: 'o', width: 1 },
          { chars: 'n', width: 1 },
          { chars: 'e', width: 1 },
          { chars: '', width: 1 },
          { chars: '', width: 1 },
          { chars: '', width: 1 },
          { chars: 't', width: 1 },
          { chars: 'w', width: 1 },
          { chars: 'o', width: 1 },
        ],
        isWrapped: false,
      },
    ]);
    expect(captureTerminalText(term, 'screen')).toBe('one   two');
  });

  it('trims trailing blank rows off the capture', () => {
    const term = fakeTerminal(['prompt $', '', '', ''], 10);
    expect(captureTerminalText(term, 'screen')).toBe('prompt $');
    expect(captureTerminalText(term, 'buffer')).toBe('prompt $');
  });

  it('keeps interior blank rows — they are the layout the user sees', () => {
    const term = fakeTerminal(['top', '', 'bottom'], 10);
    expect(captureTerminalText(term, 'screen')).toBe('top\n\nbottom');
  });

  it('gives a double-width character one character and skips its empty half', () => {
    // 漢 occupies two cells; xterm stores the right half as a width-0 cell
    // holding no character. The capture walks cells, so the pair comes out as
    // the one character it renders as, and the row's trailing padding is gone.
    const term = buildTerminal([
      {
        cells: [
          { chars: '\u6F22', width: 2 },
          { chars: '', width: 0 },
          { chars: 'x', width: 1 },
        ],
        isWrapped: false,
      },
    ]);
    expect(captureTerminalText(term, 'screen')).toBe('\u6F22x');
  });

  it('returns an empty string for a pane with no rows', () => {
    const term = fakeTerminal([], 10);
    expect(captureTerminalText(term, 'screen')).toBe('');
    expect(captureTerminalText(term, 'buffer')).toBe('');
  });

  it('returns an empty string when every captured row is blank', () => {
    const term = fakeTerminal(['', ''], 10);
    expect(captureTerminalText(term, 'screen')).toBe('');
  });
});
