import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Terminal as XtermTerminal } from '@xterm/xterm';

/**
 * The join rules against a REAL xterm buffer.
 *
 * terminalLinks.test.ts fakes the terminal, and the fake is what let the
 * seventh report slip through: every hand-built row started its content at
 * column 0, while the live Codex transcript hang-indents its wrapped rows.
 * This file replays a screen captured verbatim from the user's pane — `a
 * capture --screen` bytes, cursor positioning and SGR included — into
 * @xterm/headless and runs the very provider the renderer registers. What is
 * under test is the whole pipeline on bytes nobody hand-modelled.
 */

vi.mock('../../src/renderer/ipc', () => ({
  api: { sftp: {}, preview: { onStats: () => () => undefined } },
}));

const { Terminal } = await import('@xterm/headless');
const { pathLinks, scanBufferLine } = await import('../../src/renderer/terminalLinks');

const SCREEN = readFileSync(
  fileURLToPath(new URL('./fixtures/aplexer-codex-screen.bin', import.meta.url)),
  'utf8',
);

async function replay(): Promise<XtermTerminal> {
  const term = new Terminal({ cols: 91, rows: 40, allowProposedApi: true }) as unknown as XtermTerminal;
  await new Promise<void>((resolve) => term.write(SCREEN, resolve));
  return term;
}

/** 1-based number of the first buffer row whose text contains [needle]. */
function rowOf(term: XtermTerminal, needle: string): number {
  const buf = term.buffer.active;
  const scratch = buf.getNullCell();
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    let text = '';
    for (let x = 0; x < (line?.length ?? 0); x++) {
      text += line?.getCell(x, scratch)?.getChars() ?? '';
    }
    if (text.includes(needle)) return y + 1;
  }
  return -1;
}


describe('a captured Codex screen, replayed into a real buffer', () => {
  it('joins the hang-indented wrap of image-regeneration-workflow.md', async () => {
    const term = await replay();
    // The captured block, verbatim from the pane:
    //
    //     Search decision|screenshot|…|imagegen|list in image-
    //            regeneration-workflow.md
    //
    // — the continuation row begins with ELEVEN spaces, the transcript's
    // hanging indent, before the content that completes the path. The logical
    // line is the same whichever row the mouse is over.
    const y = rowOf(term, 'list in image-');
    expect(y).toBeGreaterThan(0);

    const joined = scanBufferLine(term, y).text.trimEnd();
    expect(joined).toBe(
      '    Search decision|screenshot|conceptual|merge|original|reviewer|imagegen|list in image-regeneration-workflow.md',
    );
    expect(scanBufferLine(term, y + 1).text.trimEnd()).toBe(joined);
  });

  it('leaves the joined bare filename unlinked, the no-slash standard holding', async () => {
    // The join is not a link licence: `image-regeneration-workflow.md` has no
    // directory part, and a bare name is exactly what the detector refuses in
    // prose everywhere else (`Read README.md` two rows down is unlinked too).
    // The multi-segment shapes are covered link-and-range in
    // terminalLinks.test.ts.
    const term = await replay();
    const y = rowOf(term, 'list in image-');

    expect(pathLinks(term, y, () => ({ sessionName: 'zoomcamp-ops' }))).toEqual([]);
    expect(pathLinks(term, y + 1, () => ({ sessionName: 'zoomcamp-ops' }))).toEqual([]);
  });

  it('still keeps the indented sentence below a finished filename separate', async () => {
    // `  └ Read current-illustration-audit.md` is a finished token and the
    // indented `    Search decision|…` row below it is a new sentence. The
    // indent alone must not glue them: the logical line stays one row.
    const term = await replay();
    const y = rowOf(term, 'Read current-illustration-audit.md');

    const scanned = scanBufferLine(term, y).text.trimEnd();
    expect(scanned).toBe('  └ Read current-illustration-audit.md');
    // (The bare filename itself is the detector's deliberate no-slash no.)
    expect(pathLinks(term, y, () => ({ sessionName: 'zoomcamp-ops' }))).toEqual([]);
  });
});
