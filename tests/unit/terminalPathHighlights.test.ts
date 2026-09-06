import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

/**
 * The at-rest half of terminal path links: the block of tint the user sees
 * without touching the mouse, redrawn from the buffer every time the renderer
 * touches a row. What the tests pin is the contract the screenshots judge —
 * a path wrapped by the remote CLI shows as ONE highlighted span, not the
 * CLI's first-row fragment — plus the repaint contract: nothing survives a
 * row changing under it.
 */

vi.mock('../../src/renderer/ipc', () => ({
  api: { sftp: {}, preview: { onStats: () => () => undefined } },
}));

const { PathHighlighter } = await import('../../src/renderer/terminalPathHighlights');
const { terminalLinkTint } = await import('../../src/renderer/themes');

const FIRST =
  'assets/images/ai-engineering-buildcamp-cohort-3-projects/work-chronicle/work-chronicle-';

interface RecordedDecoration {
  line: number;
  x?: number;
  width?: number;
  backgroundColor?: string;
}

/**
 * A fake buffer wired for the highlighter: render handlers, cursor-relative
 * markers, and a registry of live decorations the tests can assert on. The
 * buffer starts on the NORMAL buffer; `setAlternate` flips it. Decoration
 * registration is accepted on EITHER buffer, mirroring xterm 6.0.0 — its
 * alternate-buffer gate covers the decoration-ELEMENT renderer only, not the
 * cell-colour path the tint goes through.
 */
function fakeHighlightTerminal(
  rows: string[],
  width: number,
  options: { viewportY?: number; cursorY?: number } = {},
): {
  term: Terminal;
  decorations: RecordedDecoration[];
  registrations: () => number;
  render: (start: number, end: number) => void;
  rewriteRow: (index: number, text: string) => void;
  setAlternate: (value: boolean) => void;
} {
  const viewportY = options.viewportY ?? 0;
  const cursorY = options.cursorY ?? 0;
  let alternate = false;
  let registered = 0;
  const cells = rows.map((row) => [...row.padEnd(width, ' ')].map((ch) => ({ chars: ch, width: 1 })));
  const decorations: RecordedDecoration[] = [];
  const renderHandlers: Array<(range: { start: number; end: number }) => void> = [];

  const makeBuffer = () => ({
    viewportY,
    cursorY,
    getNullCell: () => ({ getChars: () => '', getWidth: () => 1 }),
    getLine: (y: number) => {
      const line = cells[y];
      if (!line) return undefined;
      return {
        length: line.length,
        isWrapped: false,
        getCell: (x: number) => {
          const cell = line[x];
          if (!cell) return undefined;
          return { getChars: () => cell.chars, getWidth: () => cell.width };
        },
      };
    },
  });

  const normalBuffer = makeBuffer();
  const alternateBuffer = makeBuffer();

  const term = {
    cols: width,
    buffer: {
      get active() {
        return alternate ? alternateBuffer : normalBuffer;
      },
      alternate: alternateBuffer,
    },
    onRender: (handler: (range: { start: number; end: number }) => void) => {
      renderHandlers.push(handler);
      return { dispose: () => undefined };
    },
    onResize: () => ({ dispose: () => undefined }),
    registerMarker: (offset: number) => {
      const marker = { line: viewportY + cursorY + offset, disposed: false };
      return {
        get line() {
          return marker.disposed ? -1 : marker.line;
        },
        dispose: () => {
          marker.disposed = true;
        },
      };
    },
    registerDecoration: (decorationOptions: {
      marker: { line: number };
      x?: number;
      width?: number;
      backgroundColor?: string;
    }) => {
      registered++;
      const record: RecordedDecoration = {
        line: decorationOptions.marker.line,
        x: decorationOptions.x,
        width: decorationOptions.width,
        backgroundColor: decorationOptions.backgroundColor,
      };
      const decoration = {
        dispose: () => {
          const at = decorations.indexOf(record);
          if (at >= 0) decorations.splice(at, 1);
        },
      };
      decorations.push(record);
      return decoration;
    },
  } as unknown as Terminal;

  return {
    term,
    decorations,
    registrations: () => registered,
    render: (start: number, end: number) => {
      for (const handler of renderHandlers) handler({ start, end });
    },
    rewriteRow: (index: number, text: string) => {
      cells[index] = [...text.padEnd(width, ' ')].map((ch) => ({ chars: ch, width: 1 }));
    },
    setAlternate: (value: boolean) => {
      alternate = value;
    },
  };
}

const context = (): { sessionName: string } => ({ sessionName: 'git-foo' });
const tint = (): string => '#112233';

describe('PathHighlighter', () => {
  it('blocks in both rows of a path the CLI wrapped, at rest', () => {
    const fake = fakeHighlightTerminal([FIRST, 'overview.png'], 96);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();

    fake.render(0, 1);

    expect(fake.decorations).toEqual([
      { line: 0, x: 1, width: FIRST.length, backgroundColor: '#112233' },
      { line: 1, x: 1, width: 'overview.png'.length, backgroundColor: '#112233' },
    ]);
    highlighter.dispose();
  });

  it('excludes the wrapping punctuation the detector peels', () => {
    const fake = fakeHighlightTerminal(['wrote (assets/img/x.png). done'], 60);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();

    fake.render(0, 0);

    expect(fake.decorations).toEqual([
      { line: 0, x: 8, width: 'assets/img/x.png'.length, backgroundColor: '#112233' },
    ]);
    highlighter.dispose();
  });

  it('leaves rows without a path alone', () => {
    const fake = fakeHighlightTerminal(['all ten diagrams rebuilt in both themes'], 60);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();

    fake.render(0, 0);

    expect(fake.decorations).toEqual([]);
    highlighter.dispose();
  });

  it('drops a highlight the moment its row is repainted with other content', () => {
    const fake = fakeHighlightTerminal([FIRST, 'overview.png'], 96);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();
    fake.render(0, 1);
    expect(fake.decorations).toHaveLength(2);

    fake.rewriteRow(0, 'the banner was replaced by the new one.');
    fake.render(0, 0);

    expect(fake.decorations).toEqual([
      { line: 1, x: 1, width: 'overview.png'.length, backgroundColor: '#112233' },
    ]);
    highlighter.dispose();
  });

  it('highlights on the alternate buffer, where every tmux session lives', () => {
    // `tmux attach` opens with `smcup` (CSI ?1049h, captured from tmux 3.4),
    // so a joined session's whole transcript sits on the alternate buffer.
    // Refusing that buffer used to silence the tint in every real pane.
    const fake = fakeHighlightTerminal([FIRST, 'overview.png'], 96);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();
    fake.setAlternate(true);

    fake.render(0, 1);

    expect(fake.decorations).toEqual([
      { line: 0, x: 1, width: FIRST.length, backgroundColor: '#112233' },
      { line: 1, x: 1, width: 'overview.png'.length, backgroundColor: '#112233' },
    ]);
    highlighter.dispose();
  });

  it('re-touching a row it already highlights registers nothing new', () => {
    // Every registration asks xterm for a full repaint; repaints re-fire
    // onRender. A highlighter that re-registered unchanged rows would chase
    // its own tail at frame rate.
    const fake = fakeHighlightTerminal([FIRST, 'overview.png'], 96);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();

    fake.render(0, 1);
    const afterFirstPass = fake.registrations();
    expect(afterFirstPass).toBe(2);

    fake.render(0, 1);

    expect(fake.registrations()).toBe(afterFirstPass);
    expect(fake.decorations).toEqual([
      { line: 0, x: 1, width: FIRST.length, backgroundColor: '#112233' },
      { line: 1, x: 1, width: 'overview.png'.length, backgroundColor: '#112233' },
    ]);
    highlighter.dispose();
  });

  it('forgets every decoration on dispose', () => {
    const fake = fakeHighlightTerminal([FIRST, 'overview.png'], 96);
    const highlighter = new PathHighlighter(fake.term, context, tint);
    highlighter.attach();
    fake.render(0, 1);
    expect(fake.decorations).toHaveLength(2);

    highlighter.dispose();

    expect(fake.decorations).toEqual([]);
  });
});

describe('premises against the real parser (headless xterm)', () => {
  it('a tmux attach stream lands on the alternate buffer, and the join works there', async () => {
    const { Terminal: HeadlessTerminal } = (await import('@xterm/headless')).default;
    const { pathLinks } = await import('../../src/renderer/terminalLinks');

    // Pane width = the fragment's exact length, so the remote CLI's hard wrap
    // broke the token at the margin — rule 1's shape.
    const term = new HeadlessTerminal({
      cols: FIRST.length,
      rows: 6,
      allowProposedApi: true,
    });
    // The first bytes of a real tmux 3.4 attach under a PTY: smcup, then each
    // row drawn at an explicitly positioned cursor, SGR-styled by the CLI.
    const stream =
      '\x1b[?1049h\x1b[22;0;0t\x1b[H\x1b[2J' +
      `\x1b[4;34m\x1b[2;1H${FIRST}\x1b[0m` +
      '\x1b[3;1Hoverview.png\x1b[0m';
    await new Promise<void>((resolve) => term.write(stream, resolve));

    // The premise that decides where any of this can run: a joined session's
    // transcript is on the ALTERNATE buffer, not scrollback.
    expect(term.buffer.active).toBe(term.buffer.alternate);

    const links = pathLinks(term as unknown as Terminal, 2, context);
    expect(links).toHaveLength(1);
    expect(links[0]?.range).toEqual({
      start: { x: 1, y: 2 },
      end: { x: 'overview.png'.length, y: 3 },
    });
    expect(links[0]?.text).toBe(FIRST + 'overview.png');
  });
});

describe('terminalLinkTint', () => {
  it('solidifies the theme selection over the terminal ground', () => {
    // Campbell: white at 35% over #0C0C0C — 0.35·255 + 0.65·12 = 97 = 0x61.
    expect(terminalLinkTint({ background: '#0C0C0C', selectionBackground: 'rgba(255, 255, 255, 0.35)' })).toBe(
      '#616161',
    );
  });

  it('reads three-digit grounds and keeps each theme distinct', () => {
    expect(terminalLinkTint({ background: '#fff', selectionBackground: 'rgba(0, 0, 0, 0.5)' })).toBe(
      '#808080',
    );
    expect(terminalLinkTint({ background: '#fdf6e3', selectionBackground: 'rgba(7, 54, 66, 0.18)' })).toBe(
      '#d1d3c6',
    );
  });
});
