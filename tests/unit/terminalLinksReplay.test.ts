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

vi.mock('@ui/app/ipc', () => ({
  api: { sftp: {}, preview: { onStats: () => () => undefined } },
}));

const { Terminal } = await import('@xterm/headless');
const { pathLinks, scanBufferLine, urlLinks } = await import('@ui/app/terminalLinks');

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

    const links = pathLinks(term, y, () => ({ sessionName: 'git' }));
    // The whole relative path, one fragment per row it spans.
    expect(links.map((l) => l.text)).toEqual([
      'cohorts/2026/05-monitoring/',
      'images/12-grafana-01-docker-run-command.jpg',
    ]);
    // From `cohorts/` (after the `10:15 ` stamp) to the row's cut — column
    // 77, fourteen short of the 91-column pane — then the indented row's
    // fragment to the last `jpg` cell. The four indent cells and the fourteen
    // padding columns are outside every range.
    expect(links[0]?.range).toEqual({ start: { x: 51, y }, end: { x: 77, y } });
    expect(links[1]?.range).toEqual({ start: { x: 5, y: y + 1 }, end: { x: 47, y: y + 1 } });
    expect(pathLinks(term, y + 1, () => ({ sessionName: 'git' })).map((l) => l.text)).toEqual([
      'cohorts/2026/05-monitoring/',
      'images/12-grafana-01-docker-run-command.jpg',
    ]);
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

describe('the thirteenth report: a Codex attachment list that underlines its fill', () => {
  // The Codex transcript underlines attachment paths and then paints each
  // row's remaining columns with the attribute still active, so the at-rest
  // underline runs through empty space to the pane's edge — on the wrapped
  // path's BOTH rows:
  //
  //     - ~/.pocketshell/attachments/ai-shipping-labs/homeowkr/20261007-222328-01-
  //     video1884788668.mp4
  //
  // The fragments must claim what the CLI presents underlined: the click a
  // user lands on that underline has to open the whole path, not fall dead.
  it('claims the underlined fill past the cut, on both rows of the wrapped path', async () => {
    const cols = 91;
    const cut = '- ~/.pocketshell/attachments/ai-shipping-labs/homeowkr/20261007-222328-01-';
    const cont = 'video1884788668.mp4';
    const bytes =
      `Attached files:\r\n` +
      `- \x1b[4m${cut.slice(2)}${' '.repeat(cols - cut.length)}\x1b[24m\r\n` +
      `\x1b[4m${cont}${' '.repeat(cols - cont.length)}\x1b[24m\r\n` +
      `\r\n`;
    const term = new Terminal({ cols, rows: 12, allowProposedApi: true }) as unknown as XtermTerminal;
    await new Promise<void>((resolve) => term.write(bytes, resolve));

    const y = rowOf(term, '222328-01-');
    expect(y).toBeGreaterThan(0);
    // The ranges are absolute, so whichever row the mouse is over answers with
    // the same two fragments: the cut row's claim runs from the path's head
    // through the join-dropped underlined fill to the pane's edge, the
    // continuation's from its first cell through its own fill.
    const expected = [
      { start: { x: 3, y }, end: { x: cols, y } },
      { start: { x: 1, y: y + 1 }, end: { x: cols, y: y + 1 } },
    ];
    for (const line of [y, y + 1]) {
      expect(pathLinks(term, line, () => ({ sessionName: 'zoomcamp-ops' })).map((l) => l.range)).toEqual(
        expected,
      );
    }
  });

  it('keeps a plain-fill row bare: the underline claim follows the attribute only', async () => {
    const cols = 91;
    const whole = '- ~/.pocketshell/attachments/ai-shipping-labs/homeowkr/20261007-222257-01-image.png';
    const bytes =
      `Attached files:\r\n` +
      `- \x1b[4m${whole.slice(2)}\x1b[24m${' '.repeat(cols - whole.length)}\x1b[0m\r\n`;
    const term = new Terminal({ cols, rows: 12, allowProposedApi: true }) as unknown as XtermTerminal;
    await new Promise<void>((resolve) => term.write(bytes, resolve));

    const y = rowOf(term, '222257-01-image.png');
    expect(pathLinks(term, y, () => ({ sessionName: 'zoomcamp-ops' })).map((l) => l.range)).toEqual([
      { start: { x: 3, y }, end: { x: whole.length, y } },
    ]);
  });
});

describe('the fourteenth report: a schemeless address cut at its own slash', () => {
  // The transcript wrapped three addresses at `/` opportunities with the
  // scheme of the second and third stranded on the row ABOVE their rest:
  //
  //     https://github.com/DataTalksClub/dapier/
  //     blob/4b51240…d5/src/web/app.css https://
  //     github.com/DataTalksClub/dapier/
  //     commit/4b51240…d5 https://dapier.dtcdev.click/
  //     connections
  //
  // The middle row's tail is a URL-so-far with no scheme on its row: the
  // gate refused it (continuesPath defers to the path detector, which
  // refuses hostname first segments), the commit URL stayed torn, and the
  // click opened the truncated repo address. The family shape — host with
  // path evidence, cut at its own `/` — is what now vouches for the join.
  it('joins all five rows and opens all three addresses whole', async () => {
    const bytes = [
      'https://github.com/DataTalksClub/dapier/',
      'blob/4b51240cbe9b7443f119d59319fa249e1c11d3d5/src/web/app.css https://',
      'github.com/DataTalksClub/dapier/',
      'commit/4b51240cbe9b7443f119d59319fa249e1c11d3d5 https://dapier.dtcdev.click/',
      'connections',
      '',
    ].join('\r\n');
    const term = new Terminal({ cols: 80, rows: 12, allowProposedApi: true }) as unknown as XtermTerminal;
    await new Promise<void>((resolve) => term.write(bytes, resolve));

    const expected = [
      'https://github.com/DataTalksClub/dapier/blob/4b51240cbe9b7443f119d59319fa249e1c11d3d5/src/web/app.css',
      'https://github.com/DataTalksClub/dapier/commit/4b51240cbe9b7443f119d59319fa249e1c11d3d5',
      'https://dapier.dtcdev.click/connections',
    ];
    for (const line of [1, 2, 3, 4, 5]) {
      const opened: string[] = [];
      urlLinks(term, line, (u) => opened.push(u)).forEach((l) => l.activate({} as never, l.text));
      expect([...new Set(opened)]).toEqual(expected);
    }
  });
});
