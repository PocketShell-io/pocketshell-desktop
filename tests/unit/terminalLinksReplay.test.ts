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
const HISTORY = readFileSync(
  fileURLToPath(new URL('./fixtures/aplexer-history-window.bin', import.meta.url)),
  'utf8',
);

async function replay(bytes: string): Promise<XtermTerminal> {
  const term = new Terminal({ cols: 91, rows: 40, allowProposedApi: true }) as unknown as XtermTerminal;
  await new Promise<void>((resolve) => term.write(bytes, resolve));
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
    const term = await replay(SCREEN);
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
    const term = await replay(SCREEN);
    const y = rowOf(term, 'list in image-');

    expect(pathLinks(term, y, () => ({ sessionName: 'zoomcamp-ops' }))).toEqual([]);
    expect(pathLinks(term, y + 1, () => ({ sessionName: 'zoomcamp-ops' }))).toEqual([]);
  });

  it('joins the ls output the opencode TUI wrapped under its hang indent', async () => {
    // The eighth report, from a captured history window: the opencode
    // transcript indents its tool output four spaces, and the wrapped `ls -la`
    // line broke after `cohorts/2026/05-monitoring/` — the continuation row
    // leading with those four indent cells. The tail ends in `/` and the
    // head could not have fitted at the render width the block's own diffstat
    // row sets, so the rows join and the whole relative path linkifies,
    // whichever row the mouse is over.
    const term = await replay(HISTORY);
    const y = rowOf(term, '16384 Sep');
    expect(y).toBeGreaterThan(0);

    const PATH = 'cohorts/2026/05-monitoring/images/12-grafana-01-docker-run-command.jpg';
    const links = pathLinks(term, y, () => ({ sessionName: 'git' }));
    expect(links.map((l) => l.text)).toEqual([PATH]);
    // From `cohorts/` (after the `10:15 ` stamp) through the indented row to
    // the last `jpg` cell — the four indent cells skipped.
    expect(links[0]?.range).toEqual({ start: { x: 51, y }, end: { x: 47, y: y + 1 } });
    expect(pathLinks(term, y + 1, () => ({ sessionName: 'git' }))[0]?.text).toBe(PATH);
  });

  it('links the same path when the agent later names it whole', async () => {
    // The very next command in the capture names the path unwrapped; the
    // detector agrees with itself across the two presentations.
    const term = await replay(HISTORY);
    const y = rowOf(term, 'file cohorts/2026');
    expect(y).toBeGreaterThan(0);

    const links = pathLinks(term, y, () => ({ sessionName: 'git' }));
    expect(links.map((l) => l.text)).toContain(
      'cohorts/2026/05-monitoring/images/12-grafana-01-docker-run-command.jpg',
    );
  });

  it('still keeps the indented sentence below a finished filename separate', async () => {
    // `  └ Read current-illustration-audit.md` is a finished token and the
    // indented `    Search decision|…` row below it is a new sentence. The
    // indent alone must not glue them: the logical line stays one row.
    const term = await replay(SCREEN);
    const y = rowOf(term, 'Read current-illustration-audit.md');

    const scanned = scanBufferLine(term, y).text.trimEnd();
    expect(scanned).toBe('  └ Read current-illustration-audit.md');
    // (The bare filename itself is the detector's deliberate no-slash no.)
    expect(pathLinks(term, y, () => ({ sessionName: 'zoomcamp-ops' }))).toEqual([]);
  });
});
