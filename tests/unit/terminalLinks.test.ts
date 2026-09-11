import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Terminal } from '@xterm/xterm';

/**
 * The bridge between xterm's buffer and the path detector.
 *
 * What is actually under test is the COORDINATE mapping. The detector works on
 * a string and reports offsets; xterm underlines CELLS. A logical line can be
 * spread over several wrapped rows, and a double-width character occupies two
 * cells while contributing one string index — so an off-by-one here underlines
 * the wrong run of characters, which looks exactly like a broken detector while
 * being nothing of the sort.
 *
 * The terminal is faked rather than instantiated: a real `Terminal` needs a DOM
 * and a renderer to have any buffer contents at all, and none of that would add
 * anything to the arithmetic being checked.
 */

// The files store subscribes to HTML-preview asset counts as it is created,
// so the stub needs that surface even though nothing here opens a file.
vi.mock('../../src/renderer/ipc', () => ({
  api: { sftp: {}, preview: { onStats: () => () => undefined } },
}));

const { scanBufferLine, pathLinks, urlLinks } = await import('../../src/renderer/terminalLinks');
const { useFilesStore } = await import('../../src/renderer/stores/files');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');

/** One row of the fake buffer. `cells` is one entry per CELL, not per char. */
interface FakeRow {
  cells: { chars: string; width: number }[];
  isWrapped: boolean;
}

/**
 * Build a fake buffer from plain strings, one per row. A row is a continuation
 * of the previous one when it is listed in [wrapped].
 */
function fakeTerminal(rows: string[], wrapped: number[] = []): Terminal {
  const lines: FakeRow[] = rows.map((row, i) => ({
    cells: [...row].map((ch) => ({ chars: ch, width: 1 })),
    isWrapped: wrapped.includes(i),
  }));
  return buildTerminal(lines);
}

/**
 * A fake buffer with a real WIDTH, for the rules that reconstruct a wrap xterm
 * never flagged.
 *
 * Every row of a real xterm buffer is `cols` cells long whether or not anything
 * was written to the far end of it, and both join rules read that geometry: one
 * asks whether the row above is full to its last column, the other whether the
 * next token could have fitted on it. `fakeTerminal` above pads nothing, so a
 * row there is as wide as its text and every row would look full — which is
 * exactly the mistake these tests exist to catch.
 */
function fakeScreen(rows: string[], width: number): Terminal {
  return buildTerminal(
    rows.map((row) => ({
      cells: [...row.padEnd(width, ' ')].map((ch) => ({ chars: ch, width: 1 })),
      isWrapped: false,
    })),
  );
}

function buildTerminal(lines: FakeRow[]): Terminal {
  const buffer = {
    getNullCell: () => ({ getChars: () => '', getWidth: () => 1 }),
    getLine: (y: number) => {
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
      };
    },
  };
  return { buffer: { active: buffer } } as unknown as Terminal;
}

/**
 * The event xterm would pass. Never read by `activate` — the tests run in the
 * node environment, where `MouseEvent` does not exist, and the handler under
 * test only ever uses the match it closed over.
 */
const CLICK = {} as MouseEvent;

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('scanBufferLine', () => {
  it('reads a single row as itself', () => {
    const term = fakeTerminal(['tmp/a.mp3: ok']);
    expect(scanBufferLine(term, 1).text).toBe('tmp/a.mp3: ok');
  });

  it('joins a wrapped continuation row onto the row it continues', () => {
    const term = fakeTerminal(['tmp/voice-p', 'reviews/a.mp3'], [1]);
    // Asked about EITHER row, the answer is the whole logical line: xterm calls
    // the provider with whichever row the mouse is over.
    expect(scanBufferLine(term, 1).text).toBe('tmp/voice-previews/a.mp3');
    expect(scanBufferLine(term, 2).text).toBe('tmp/voice-previews/a.mp3');
  });

  it('does not join a row that merely follows another', () => {
    const term = fakeTerminal(['tmp/a.mp3', 'tmp/b.mp3']);
    expect(scanBufferLine(term, 1).text).toBe('tmp/a.mp3');
  });

  it('reads an untouched cell as a space, so tokens still break', () => {
    const term = buildTerminal([
      {
        cells: [
          { chars: 'a', width: 1 },
          { chars: '', width: 1 },
          { chars: 'b', width: 1 },
        ],
        isWrapped: false,
      },
    ]);
    expect(scanBufferLine(term, 1).text).toBe('a b');
  });

  it('gives a double-width character one string index and its own cell', () => {
    const term = buildTerminal([
      {
        cells: [
          { chars: '漢', width: 2 },
          // xterm stores the right half as an empty cell of width 0.
          { chars: '', width: 0 },
          { chars: 'x', width: 1 },
        ],
        isWrapped: false,
      },
    ]);
    const scanned = scanBufferLine(term, 1);
    expect(scanned.text).toBe('漢x');
    expect(scanned.cells).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ]);
  });
});

/**
 * The two shapes the user reported, transcribed from their pane.
 *
 * Neither row is flagged `isWrapped`, because neither was wrapped BY xterm:
 * this pane is always a tmux client and the agent TUI inside it positions every
 * row it paints. The joining rules reconstruct the break from geometry instead.
 */
describe('scanBufferLine — a path a TUI broke across two rows', () => {
  const PNG =
    '/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-62ab287b-39b5-461a-9d45-69e2eae3d41a.png';
  const TILDE_PNG =
    '~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-4d2d-8a44-c5da743f849e.png';

  /** The Codex block: a wrapped command with `  │ ` in front of every continuation. */
  const GUTTER_ROWS = [
    'Ran for f in /home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
    '  │ exec-62ab287b-39b5-461a-9d45-69e2eae3d41a.png /home/alexey/.codex/',
    '  │ generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
  ];

  it('joins a gutter-marked continuation and drops the gutter itself', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(
      `Ran for f in ${PNG} /home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/`,
    );
  });

  it('gives the same logical line whichever of its rows the mouse is over', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    const first = scanBufferLine(term, 1).text;
    expect(scanBufferLine(term, 2).text).toBe(first);
    expect(scanBufferLine(term, 3).text).toBe(first);
  });

  it('linkifies the split path, underlining from the first row into the second', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));

    expect(links.map((l) => l.text)).toEqual([
      PNG,
      '/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
    ]);
    // 1-based and inclusive: the path starts at column 14 of row 1 and ends at
    // column 49 of row 2 — the gutter's four cells sit inside the underline
    // because an xterm range is a span of cells, which is equally true of the
    // wrapped web links this decoration was copied from.
    expect(links[0]?.range).toEqual({ start: { x: 14, y: 1 }, end: { x: 49, y: 2 } });
  });

  it('opens the whole path, not the directory the first row ended at', () => {
    const term = fakeScreen(GUTTER_ROWS, 100);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: '~/git/foo' },
    ];

    links[0]?.activate(CLICK, links[0].text);
    // Absolute, so the session's cwd is ignored entirely — an image outside the
    // repo is as openable as one inside it.
    expect(files.reveal).toBe(PNG);
  });

  it('joins a hard wrap tmux repainted, where the break lands mid-token', () => {
    // The "Viewed Image" case. The row is full to its last column, so the TUI
    // ran out of room mid-UUID and continued at column 0.
    const first = '    └ ~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-';
    const term = fakeScreen([first, '4d2d-8a44-c5da743f849e.png'], first.length);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(`    └ ${TILDE_PNG}`);
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(TILDE_PNG);
  });

  it('joins a hyphen wrap that left the row short of the margin', () => {
    // The "event-webinar" case, against this app's own CLI: it wraps long
    // tokens at the hyphens inside them, so the row above ends a few columns
    // SHORT of full — the exact-full evidence rule 1 asks for is not there.
    // The tail still ends in `-`, the hyphen that made the break opportunity,
    // and `og.png` could not have fitted in the columns left over.
    const first = '/home/alexey/git/banner-generator/.tmp/issue-312-dtc-banners/output/dtc/event-webinar-';
    const term = fakeScreen([first, 'og.png'], first.length + 5);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(`${first}og.png`);
    // Asked about the continuation row, too: the walk-up applies the same rule.
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(
      `${first}og.png`,
    );
  });

  it('joins a slash wrap that left the row short of the margin', () => {
    // The "Cloudflare diagrams" report, transcribed from the pane: a
    // markdown-rendering CLI fills each row up to the last `/` inside the long
    // path token instead of to the margin, so rule 1's exact-full evidence is
    // missing and the tail ends in `/`, not the `-` rule 1b was first written
    // for. Both breaks of the report reconstruct, whichever row the mouse is
    // over.
    const FIRST = 'Example: Cloudflare diagrams (2026/2026-06-17-cloudflare-workers-vectorize-agent/';
    const SECOND = 'diagrams) and its README (2026/2026-06-17-cloudflare-workers-vectorize-agent/';
    const THIRD = 'README.md:9).';
    const term = fakeScreen([FIRST, SECOND, THIRD], FIRST.length + 3);
    const joined = `${FIRST}${SECOND}${THIRD}`;

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(joined);
    expect(scanBufferLine(term, 3).text.trimEnd()).toBe(joined);
  });

  it('joins a wrap cut mid-token a couple of columns short of the margin', () => {
    // The "maven webhook URL" report, transcribed from the pane: Claude Code
    // paints its rows up to a small inset inside the pane and cuts the token
    // where that inset lands — here mid-hex, `…-b30c-ed8` / `60a6cb317…`. The
    // row above ends two columns short of full, so rule 1's evidence is
    // missing, and the cut is at `8`, so no opportunity character of rule
    // 1b's is there either. Rule 1a reads it: nearly full, and the
    // continuation's first token could not have been placed in the columns
    // left over.
    const FIRST =
      '! cat /data/tmp/claude-1000/-home-alexey-git-ai-shipping-labs/5b319e9a-ca2a-4195-b30c-ed8';
    const PATH =
      '/data/tmp/claude-1000/-home-alexey-git-ai-shipping-labs/5b319e9a-ca2a-4195-b30c-ed860a6cb317/scratchpad/maven_webhook_url.txt';
    const term = fakeScreen([FIRST, '60a6cb317/scratchpad/maven_webhook_url.txt'], FIRST.length + 2);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(`! cat ${PATH}`);
    // Hovered on the continuation row: the same logical line.
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(PATH);
  });

  it('opens the whole mid-token-joined path, not the fragment a row ends at', () => {
    const FIRST =
      '! cat /data/tmp/claude-1000/-home-alexey-git-ai-shipping-labs/5b319e9a-ca2a-4195-b30c-ed8';
    const PATH =
      '/data/tmp/claude-1000/-home-alexey-git-ai-shipping-labs/5b319e9a-ca2a-4195-b30c-ed860a6cb317/scratchpad/maven_webhook_url.txt';
    const term = fakeScreen([FIRST, '60a6cb317/scratchpad/maven_webhook_url.txt'], FIRST.length + 2);
    const files = useFilesStore();

    pathLinks(term, 1, () => ({ sessionName: 'git-foo' }))[0]?.activate(CLICK, PATH);
    // Absolute, so the session's cwd is ignored — and the path is the UUID
    // whole, not the truncated directory `…-b30c-ed8` the first row ends at.
    expect(files.reveal).toBe(PATH);
  });

  it('joins a wrap whose continuation carries the block hanging indent', () => {
    // The seventh report, transcribed from the live pane: the Codex transcript
    // hang-indents the wrapped rows of its own block — the continuation began
    // with ELEVEN spaces before the content completing the row above's cut
    // (`…list in docs/image-`). A space cannot sit inside a token, so the run
    // is the renderer's layout and the content after it is what the guards
    // judge: the tail ends in `-` — the one tail shape that need not already
    // be a path so far — and the head would not have fitted at the render
    // width, so the rows join with the indent's cells dropped.
    const FIRST =
      '    Search decision|screenshot|conceptual|merge|reviewer|imagegen|list in docs/image-';
    const term = fakeScreen([FIRST, '           regeneration-workflow.md'], 91);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(`${FIRST}regeneration-workflow.md`);
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(
      'docs/image-regeneration-workflow.md',
    );
  });

  it('drops the indent cells from the underline range', () => {
    const FIRST =
      '    Search decision|screenshot|conceptual|merge|reviewer|imagegen|list in docs/image-';
    const term = fakeScreen([FIRST, '           regeneration-workflow.md'], 91);

    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    // The path starts on the cut row at `docs/` (cell 75, 1-based) and ends on
    // the indented row after `regeneration-workflow.md` — the eleven indent
    // cells are skipped, not underlined.
    expect(links[0]?.range).toEqual({ start: { x: 75, y: 1 }, end: { x: 35, y: 2 } });
  });

  it('still refuses an indented row when the tail carries no cut evidence', () => {
    // `current-illustration-audit.md` is a finished filename and the indented
    // row below it starts a new sentence — the indent changes where content
    // begins, not whether the row above ended a token.
    const FIRST = '  └ Read current-illustration-audit.md';
    const term = fakeScreen(
      [FIRST, '    Search decision|screenshot|conceptual|merge|original|reviewer'],
      91,
    );

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(FIRST);
  });

  it('refuses an indented continuation indented past the cap', () => {
    // Deep code-block indentation is layout this feature has no business
    // guessing through, whatever the tail looks like.
    const FIRST = 'wrote /home/alexey/git/machine-learning-';
    const term = fakeScreen([FIRST, '                   zoomcamp/README.md'], 60);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(FIRST);
  });

  it('refuses an indented continuation whose head would have fitted above', () => {
    // The fit guard survives the indent: `ok` is two wide and the render width
    // the block's own rows set is 27, so the wrapper left the row by choice.
    const term = fakeScreen(['wrote assets/img/', '    ok', 'and pruned the stale copies'], 27);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe('wrote assets/img/');
  });

  it('does not let rule 1 across an indent, even on a full row', () => {
    // Rule 1's evidence is an overflow: content at column 0 because the writer
    // ran out of room. An indented row is the renderer CHOOSING where a row
    // begins, so even a full row above with a path-so-far tail stays separate
    // unless the content-guarded rules accept it — and here the tail is a
    // finished extension path, which 1a refuses.
    const FIRST = 'moved /var/data/2026/backup.tar';
    const term = fakeScreen([FIRST, '  done earlier today'], FIRST.length);

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(FIRST);
  });

  it('joins the sent-input wrap cut mid-UUID at column two', () => {
    // The ninth report, transcribed from the pane: a `Sent input to` block
    // whose quoted path wraps after `01a07b59-81f1-`, the continuation row
    // beginning at the block's two-space indent. Near-full row, hyphen cut,
    // indent-skipped head — rules 1a and 1b both reach it, and the whole
    // absolute path linkifies.
    const FIRST =
      '  └ The second imagegen candidate at /home/alexey/.codex/generated_images/01a07b59-81f1-';
    const PATH =
      '/home/alexey/.codex/generated_images/01a07b59-81f1-7ad0-8caf-684763eaf05e/exec-a36d8454-8b3d-4ba2-b160-646af7b766fc.png';
    const term = fakeScreen([FIRST, '  7ad0-8caf-684763eaf05e/exec-a36d8454-8b3d-4ba2-b160-646af7b766fc.png is t…'], 91);

    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    expect(links.map((l) => l.text)).toEqual([PATH]);
    // From `/home` (after the candidate-at prose, cell 38) through the
    // indented row to the last `png` cell before ` is t…`.
    expect(links[0]?.range).toEqual({ start: { x: 38, y: 1 }, end: { x: 70, y: 2 } });
  });

  it('joins the hang-indented wrap of a markdown link and opens its target', () => {
    // The same captured pane, the very next block: a `[label](target)` link
    // wrapped across the rows, the continuation indented two. The rows join
    // through the indent and the detector opens the TARGET — the full
    // absolute image path — not the bracketed junk the raw token carries.
    const FIRST =
      '  Changed: - [02-accuracy-02-accuracy-example-crisp.png](/home/alexey/git/machine-learning-';
    const SECOND =
      '  zoomcamp/cohorts/2026/04-evaluation/images/02-accuracy-02-accuracy-example-crisp.png) done';
    const TARGET =
      '/home/alexey/git/machine-learning-zoomcamp/cohorts/2026/04-evaluation/images/02-accuracy-02-accuracy-example-crisp.png';
    const term = fakeScreen([FIRST, SECOND], FIRST.length);

    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    expect(links.map((l) => l.text)).toEqual([TARGET]);
    // The underline spans the target across the wrap: from `/home` (cell 58)
    // to the end of row 1, then through row 2 up to the last `png` character
    // before the closing `)` — the indent's two cells skipped, the label and
    // brackets left out.
    expect(links[0]?.range).toEqual({ start: { x: 58, y: 1 }, end: { x: 86, y: 2 } });

    const files = useFilesStore();
    links[0]?.activate(CLICK, TARGET);
    expect(files.reveal).toBe(TARGET);
  });

  it('linkifies both report paths across their breaks, from the middle row', () => {
    const FIRST = 'Example: Cloudflare diagrams (2026/2026-06-17-cloudflare-workers-vectorize-agent/';
    const SECOND = 'diagrams) and its README (2026/2026-06-17-cloudflare-workers-vectorize-agent/';
    const THIRD = 'README.md:9).';
    const term = fakeScreen([FIRST, SECOND, THIRD], FIRST.length + 3);

    const links = pathLinks(term, 2, () => ({ sessionName: 'git-foo' }));
    // The whole of each path, not the directory the first row of it ended at;
    // the `:9` suffix underlines and the `(` and `).` do not.
    expect(links.map((l) => l.text)).toEqual([
      '2026/2026-06-17-cloudflare-workers-vectorize-agent/diagrams',
      '2026/2026-06-17-cloudflare-workers-vectorize-agent/README.md:9',
    ]);
    // From the `2026` on the first row (after the `(`) into `diagrams` on the
    // second — the cells, not the string offsets.
    expect(links[0]?.range).toEqual({ start: { x: 31, y: 1 }, end: { x: 8, y: 2 } });

    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: '~/git/vect' },
    ];
    links[1]?.activate(CLICK, links[1].text);
    // Relative, so the session's cwd resolves it — the file, not the
    // `-agent/` directory the row above ends at.
    expect(files.reveal).toBe(
      'git/vect/2026/2026-06-17-cloudflare-workers-vectorize-agent/README.md',
    );
  });

  it('joins a hyphen wrap whose leftover columns run to eleven', () => {
    // The "work-chronicle" report, transcribed from the pane: the CLI breaks
    // the token at its last hyphen that fits, and what did not fit is the
    // whole of `overview.png` — twelve characters — so the row above ends
    // NINE columns short of the pane. The fit is measured against the render
    // width the rows themselves set (the widest is 87), not the pane.
    const FIRST =
      'assets/images/ai-engineering-buildcamp-cohort-3-projects/work-chronicle/work-chronicle-';
    const term = fakeScreen([FIRST, 'overview.png'], FIRST.length + 9);
    const joined = `${FIRST}overview.png`;

    expect(scanBufferLine(term, 1).text.trimEnd()).toBe(joined);
    // Hovered on the continuation row: the same logical line.
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(joined);
  });

  it('joins after the pane was resized wider than the render width', () => {
    // The same report on the user's actual window: the rows were painted at
    // ~87 columns and the pane is now 130, so every distance-to-the-margin
    // reading is meaningless — tmux keeps rows painted at their render width.
    // The fullest nearby row IS that width, and `overview.png` did not fit
    // inside it, so the rows still reconstruct.
    const FIRST =
      'assets/images/ai-engineering-buildcamp-cohort-3-projects/work-chronicle/work-chronicle-';
    const term = fakeScreen(['• Done. I used the attached image', '', FIRST, 'overview.png'], 130);
    const joined = `${FIRST}overview.png`;

    expect(scanBufferLine(term, 3).text.trimEnd()).toBe(joined);
    expect(pathLinks(term, 3, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(joined);
  });

  it('joins two paths that wrap on consecutive rows of one summary', () => {
    // The "diagram-creator" report: two absolute paths in one bulleted line,
    // each wrapped at the pane — the first after `skills/`, the second at the
    // hyphen inside `diagram-` — and sharing the middle row. Both reconstruct
    // and both span their breaks, the `)` and ` and rubric (` prose staying
    // outside every range.
    const ROWS = [
      '- Updated the canonical diagram-creator skill (/home/alexey/git/diagram-creator/skills/',
      'diagram-creator/SKILL.md) and rubric (/home/alexey/git/diagram-creator/skills/diagram-',
      'creator/rubric.md) with a strict axis-alignment gate.',
    ];
    const term = fakeScreen(ROWS, ROWS[0]?.length ?? 0);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));

    expect(links.map((l) => l.text)).toEqual([
      '/home/alexey/git/diagram-creator/skills/diagram-creator/SKILL.md',
      '/home/alexey/git/diagram-creator/skills/diagram-creator/rubric.md',
    ]);
    // The first runs from row one into row two, the second from row two into
    // row three — 1-based, inclusive, the opening `(` never underlined.
    expect(links[0]?.range).toEqual({ start: { x: 48, y: 1 }, end: { x: 24, y: 2 } });
    expect(links[1]?.range).toEqual({ start: { x: 39, y: 2 }, end: { x: 17, y: 3 } });
  });

  it('joins with a full-width footer rule two rows below the block', () => {
    // The user's actual pane: the CLI's footer draws `Worked for 23m 29s ────`
    // to the PANE's own width a couple of rows under the path. Collected into
    // a whole-window maximum, that row measures the pane (120) and the fit
    // guard refuses the join again. The blank between block and footer bounds
    // the inference at the block itself, and `overview.png` did not fit in it.
    const FIRST =
      'assets/images/ai-engineering-buildcamp-cohort-3-projects/work-chronicle/work-chronicle-';
    const rows = [
      '• Done. I used the attached image, cropped the side borders, and added it as:',
      '',
      FIRST,
      'overview.png',
      '',
      'Worked for 23m 29s ──────────────────────────────────────────────────────────────────────',
    ];
    const term = fakeScreen(rows, 120);
    const joined = `${FIRST}overview.png`;

    expect(scanBufferLine(term, 3).text.trimEnd()).toBe(joined);
    expect(pathLinks(term, 3, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(joined);
  });

  it('does not let a bare fill rule beside the block set the render width', () => {
    // Same poison without the blank: a rule is decoration drawn to the pane,
    // so the walk refuses it rather than collecting it — and ends there,
    // because what lies beyond a separator is a different block anyway.
    const FIRST =
      'assets/images/ai-engineering-buildcamp-cohort-3-projects/work-chronicle/work-chronicle-';
    const term = fakeScreen(
      ['──────────────────────────────────────────────────────────────────────────', FIRST, 'overview.png'],
      100,
    );

    expect(scanBufferLine(term, 2).text.trimEnd()).toBe(`${FIRST}overview.png`);
  });

  it('opens the tilde form without anyone expanding $HOME', () => {
    const first = '    └ ~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-';
    const term = fakeScreen([first, '4d2d-8a44-c5da743f849e.png'], first.length);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));
    const files = useFilesStore();

    links[0]?.activate(CLICK, links[0].text);
    // `stripTilde` drops the `~/` and leaves a path relative to the SFTP root,
    // which IS the login home. No host lookup, one round trip, and nothing to
    // get wrong when `$HOME` has not been reported.
    expect(files.reveal).toBe(
      '.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-4d2d-8a44-c5da743f849e.png',
    );
  });
});

/**
 * The "Saved to:" report: a `file://` URL that runs to the right margin and
 * continues at column 0. It was dead on arrival — WebLinksAddon's regex
 * admits only http(s), so the file URL has only ever had the path detector
 * to claim it, and it joins under the path rules like any other path.
 * A WEB url has its own reports below.
 */
describe('scanBufferLine — a file:// URL a TUI broke across two rows', () => {
  const FIRST_ROW =
    'file:///home/alexey/.codex/generated_images/01a06bad-05a4-7fc0-bf41-d63ece15252c/exec-ac';
  const SECOND_ROW = 'a3c94d-2a2f-4150-a501-cd1e2fd26db9.png';
  const FULL = `${FIRST_ROW}${SECOND_ROW}`;
  const PATH = FULL.slice('file://'.length);

  it('joins the hard wrap and linkifies the whole URL', () => {
    const term = fakeScreen([FIRST_ROW, SECOND_ROW], FIRST_ROW.length);
    const links = pathLinks(term, 1, () => ({ sessionName: 'git-foo' }));

    expect(links[0]?.text).toBe(FULL);
    // From the first cell of row 1 to the last cell of row 2, scheme included.
    expect(links[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: SECOND_ROW.length, y: 2 },
    });
    // Hovered on the continuation row instead: the same logical line.
    expect(pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(FULL);
  });

  it('opens the path under the scheme, not the URL itself', () => {
    const term = fakeScreen([FIRST_ROW, SECOND_ROW], FIRST_ROW.length);
    const files = useFilesStore();

    pathLinks(term, 1, () => ({ sessionName: 'git-foo' }))[0]?.activate(CLICK, FULL);

    expect(files.reveal).toBe(PATH);
  });

  it('refuses an http URL whose tail already reads finished', () => {
    // An http(s) tail joins the geometric rules now — that is what the
    // wrapped-URL reports below needed — so the refusals are the
    // finished-token traces instead of the blanket bar this shape once sat
    // behind. A tail ending extension-shaped is a whole address one
    // space-wrap happened to land exactly on the margin, and `and` is where
    // the next sentence starts: rule 1's URL cut-guard refuses it.
    const first = 'saved https://example.com/a/b.png';
    const scan = (rows: string[], width: number): string =>
      scanBufferLine(fakeScreen(rows, width), 1).text.trimEnd();
    expect(scan([first, 'and cleaned up'], first.length)).toBe(first);
    expect(urlLinks(fakeScreen([first, 'and cleaned up'], first.length), 1, () => undefined)).toEqual(
      [],
    );
  });
});

/**
 * The "comet.com" reports, transcribed from the panes they arrived in: an
 * agent CLI renders bullet lists whose long web addresses its own wrapper
 * breaks across rows — after a `/`, after a hyphen inside a UUID, after the
 * query's `?`, and (the second report) mid-hex at a row full to the margin.
 * WebLinksAddon reads one row at a time, so each address used to linkify as
 * no more than its first-row fragment; the joins reconstruct the address and
 * {@link urlLinks} — the provider registered BEFORE the addon — makes it one
 * link again.
 */
describe('scanBufferLine — a web URL a TUI broke across rows', () => {
  const HOME = 'https://www.comet.com/opik/alexey-grigorev/';
  const TRACES = 'https://www.comet.com/opik/alexey-grigorev/projects/01a081da-ba69-7235-9ea8-f0037e30994f/traces';
  const AUTOMATION = 'https://www.comet.com/opik/alexey-grigorev/projects/01a081da-b529-74c6-b2a4-9afe2fa88e74/traces';
  const COMPARE =
    'https://www.comet.com/opik/alexey-grigorev/experiments/01a08215-d194-7638-b00b-9ee98652c456/compare?experiments=%5B%2201a08216-068c-7ee9-9f16-7f6892a78cb6%22%2C%2201a08216-77c3-73df-9873-5ba1e479057f%22%5D';

  /** The report's own block: every bullet, with each wrap where the CLI put it. */
  const ROWS = [
    `- Home: ${HOME}`,
    `- Assistant traces (incl. your live Docker question): https://www.comet.com/opik/`,
    `  alexey-grigorev/projects/01a081da-ba69-7235-9ea8-f0037e30994f/traces`,
    `- Automation project: https://www.comet.com/opik/alexey-grigorev/projects/01a081da-`,
    `b529-74c6-b2a4-9afe2fa88e74/traces`,
    `- Before/after compare (the Friday money slide): https://www.comet.com/opik/alexey-`,
    `grigorev/experiments/01a08215-d194-7638-b00b-9ee98652c456/compare?`,
    `experiments=%5B%2201a08216-068c-7ee9-9f16-7f6892a78cb6%22%2C%2201a08216-77c3-73df-`,
    `9873-5ba1e479057f%22%5D`,
  ];
  const term = (): Terminal => fakeScreen(ROWS, 85);

  it('joins the four-row compare URL and linkifies it whole', () => {
    const links = urlLinks(term(), 6, () => undefined);
    // One address, not a `/opik/alexey-` fragment plus three orphan rows.
    expect(links.map((l) => l.text)).toEqual([COMPARE]);
    // From the `h` of `https` (after the prose and its space) on the bullet
    // row to the last `%5D` cell of the fourth row.
    expect(links[0]?.range.start).toEqual({ x: 50, y: 6 });
    expect(links[0]?.range.end).toEqual({ x: 23, y: 9 });
  });

  it('gives the same whole link whichever of its rows the mouse is over', () => {
    const span = (links: ReturnType<typeof urlLinks>): unknown =>
      links.map((l) => ({ text: l.text, range: l.range }));
    const first = span(urlLinks(term(), 6, () => undefined));
    expect(span(urlLinks(term(), 7, () => undefined))).toEqual(first);
    expect(span(urlLinks(term(), 9, () => undefined))).toEqual(first);
  });

  it('opens the whole address, not the directory the first row ended at', () => {
    const open = vi.fn();
    urlLinks(term(), 6, open)[0]?.activate(CLICK, COMPARE);
    expect(open).toHaveBeenCalledWith(COMPARE);
  });

  it('joins the two-row trace URL that the wrapper indented', () => {
    // The `Assistant traces` bullet: the continuation row carries the
    // renderer's two-space hanging indent, dropped the way the path rules
    // drop it, and the address spans the break.
    const links = urlLinks(term(), 2, () => undefined);
    expect(links.map((l) => l.text)).toEqual([TRACES]);
    expect(links[0]?.range).toEqual({ start: { x: 55, y: 2 }, end: { x: 70, y: 3 } });
  });

  it('joins the UUID the wrapper cut at its hyphen', () => {
    expect(urlLinks(term(), 4, () => undefined).map((l) => l.text)).toEqual([AUTOMATION]);
  });

  it('leaves the single-row Home URL to WebLinksAddon', () => {
    // `https://…/alexey-grigorev/` fits on its own row; the provider only
    // ever answers for addresses that SPAN rows, so the addon keeps every
    // cell it always handled.
    expect(urlLinks(term(), 1, () => undefined)).toEqual([]);
  });

  it('joins the mid-hex cut of the experiment report and peels the `).`', () => {
    // The second report, on its own: the address sits inside parentheses,
    // the wrapper cut it after `…8b64-ab0e95b` at a row full to the margin,
    // and the sentence's `).` closes it on the continuation row. Rule 1's
    // URL cut-guard reads the cut (mid-hex, no dot, head not a second
    // address); the detector peels the decoration off the opened URL.
    const FIRST =
      '(https://www.comet.com/opik/alexey-grigorev/experiments/01a08fa0-1bee-76b6-8b64-ab0e95b';
    const SECOND = '7d5c6/compare?experiments=%5B%2201a08fa0-222c-743b-bcea-47a9d131bb63%22%5D).';
    const URL_TEXT = `${FIRST.slice(1)}${SECOND.slice(0, -2)}`;
    const t = fakeScreen([FIRST, SECOND], FIRST.length);

    const links = urlLinks(t, 1, () => undefined);
    expect(links.map((l) => l.text)).toEqual([URL_TEXT]);
    expect(links[0]?.range).toEqual({
      start: { x: 2, y: 1 },
      end: { x: SECOND.length - 2, y: 2 },
    });

    const open = vi.fn();
    urlLinks(t, 1, open)[0]?.activate(CLICK, URL_TEXT);
    expect(open).toHaveBeenCalledWith(URL_TEXT);
  });

  it('refuses a near-full row whose URL is whole and whose head is the next sentence', () => {
    // The shape that keeps rule 1a closed to web URLs: a COMPLETE address
    // two columns short of the margin and a long word wrapped below it is a
    // space-wrap, not a cut — the URL ends at `guide` and `available` is
    // prose. No opportunity character, no full row, no join.
    const first = 'docs: https://example.com/guide';
    const t = fakeScreen([first, 'available online'], first.length + 2);

    expect(scanBufferLine(t, 1).text.trimEnd()).toBe(first);
    expect(urlLinks(t, 1, () => undefined)).toEqual([]);
  });

  it('refuses a full row whose URL is whole and whose head starts a second address', () => {
    // Two addresses, one per row: the `/` head check refuses the glue even
    // at rule 1's full geometry, or the link would read `x.io/a/b/c`.
    const first = 'see https://x.io/a';
    const t = fakeScreen([first, '/b/c is another'], first.length);

    expect(scanBufferLine(t, 1).text.trimEnd()).toBe(first);
  });

  it('leaves a question-mark cut inert when no scheme ever opened', () => {
    // `?` is a break opportunity only for a URL; without a scheme anywhere
    // in the line the joined token is claimed by nobody — the glue is
    // permitted by the geometry and produces no link.
    const first = 'grigorev/experiments/x/compare?';
    const t = fakeScreen([first, 'experiments=1'], first.length + 4);

    expect(urlLinks(t, 1, () => undefined)).toEqual([]);
    expect(pathLinks(t, 1, () => ({ sessionName: 'git-foo' }))).toEqual([]);
  });
});

/**
 * The "Ran montage" report: the agent TUI echoed a shell command whose
 * RELATIVE path broke at the margin mid-token, with the block's `│ ` gutter
 * on every continuation row. The join guard used to demand a rooted
 * (`/`, `~/`, `./`) tail, which every relative path fails — so the row above
 * kept a link to the truncated directory (clicking it opened the wrong
 * thing) and the filename fragment on the next row got nothing.
 */
describe('scanBufferLine — a relative path a TUI broke across two rows', () => {
  const DIR =
    'assets/images/ai-engineering-buildcamp-cohort-3-projects/exam-questions-generator/';
  const FULL = `${DIR}quizgen-landing-page.png`;
  const ROWS = ['• Ran montage \\', `│ ${DIR}`, '│ quizgen-landing-page.png \\'];

  it('joins the gutter continuation and linkifies the whole relative path', () => {
    const term = fakeScreen(ROWS, `│ ${DIR}`.length);
    const links = pathLinks(term, 2, () => ({ sessionName: 'git-foo' }));

    // One link, from `assets/` through `.png` — not a directory on row one
    // and a bare word on row two. The bullet line above the block stays
    // separate: its tail is `\`, which is no path to continue.
    expect(links.map((l) => l.text)).toEqual([FULL]);
  });

  it('opens the relative path for the session cwd to resolve', () => {
    const term = fakeScreen(ROWS, `│ ${DIR}`.length);
    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: '~/git/camp' },
    ];

    pathLinks(term, 2, () => ({ sessionName: 'git-foo' }))[0]?.activate(CLICK, FULL);

    expect(files.reveal).toBe(
      'git/camp/assets/images/ai-engineering-buildcamp-cohort-3-projects/exam-questions-generator/quizgen-landing-page.png',
    );
  });

  it('joins a margin wrap of a relative path with no gutter at all', () => {
    // The same command echoed without the block gutter: the row is full to
    // its last column, the hard-wrap evidence rule 1 reads.
    const first = 'montage assets/images/exam-questions-generator/';
    const term = fakeScreen([first, 'quizgen-landing-page.png \\'], first.length);

    expect(pathLinks(term, 1, () => ({ sessionName: 'git-foo' }))[0]?.text).toBe(
      'assets/images/exam-questions-generator/quizgen-landing-page.png',
    );
  });
});

/**
 * The "PKG=" report, transcribed from the pane: an agent TUI echoes a shell
 * command inside a `  │ ` block, the block wrapped at its own width inside a
 * far wider pane, and the long path in the assignment broke after
 * `python3.12/` onto a gutter continuation. Two stale assumptions refused
 * the join: the tail gate judged the raw token `PKG="/home/…` and hit the
 * quote an assignment carries (FORBIDDEN in a path — even though the matcher
 * itself underlined that path-so-far on row one), and the gutter rule
 * measured its fit against the pane's live width, where every continuation
 * head "had room". The gate now reads past the assignment, and the fit runs
 * against the inferred render width like every other rule's.
 */
describe('scanBufferLine — a command echo wrapped inside a KEY=" assignment', () => {
  const ROW1 = '• Ran PKG="/home/alexey/.cache/uv/archive-v0/jxlQadaEgujN7Zj_8P0GJ/lib/python3.12/';
  const ROW2 =
    `  │ site-packages/linkedin_api"; sed -n '40,120p' "$PKG/linkedin.py"; echo ===CLIENT===;`;
  const ROW3 = `  │ sed -n '1,80p' "$PKG/client.py"`;
  const PATH =
    '/home/alexey/.cache/uv/archive-v0/jxlQadaEgujN7Zj_8P0GJ/lib/python3.12/site-packages/linkedin_api';

  /** The pane is 200 wide; the block renders at 87. That gap is the report. */
  const term = (): Terminal => fakeScreen([ROW1, ROW2, ROW3], 200);

  it('joins the gutter continuation, dropping gutter and assignment alike', () => {
    // The join stops after ROW2: its own tail (`===CLIENT===;`) is no path
    // so far, and the third row is a fresh statement, not a continuation.
    expect(scanBufferLine(term(), 1).text.trimEnd()).toBe(
      `${ROW1}${ROW2.slice(4)}`,
    );
  });

  it('linkifies the whole path across the break, from either row', () => {
    const fromRow1 = pathLinks(term(), 1, () => ({ sessionName: 'git-foo' }));
    expect(fromRow1.map((l) => l.text)).toEqual([PATH]);
    // From `/home` (after `• Ran PKG="`, cell 12) through `linkedin_api` —
    // the `";` that closes the assignment stays outside the underline.
    expect(fromRow1[0]?.range).toEqual({ start: { x: 12, y: 1 }, end: { x: 30, y: 2 } });

    // Hovered on the continuation row: the same logical line.
    expect(pathLinks(term(), 2, () => ({ sessionName: 'git-foo' })).map((l) => l.text)).toEqual([
      PATH,
    ]);
  });

  it('opens the whole path, not the directory row one ended at', () => {
    const files = useFilesStore();
    pathLinks(term(), 1, () => ({ sessionName: 'git-foo' }))[0]?.activate(CLICK, PATH);
    // Absolute, so the session cwd is ignored entirely.
    expect(files.reveal).toBe(PATH);
  });
});

/**
 * The other half of the joining rules, and the half that decides whether this
 * feature is trustworthy: two rows that merely follow one another must stay two
 * lines. A join that should not have happened invents a path nothing can open
 * and drags an underline through text the remote program never meant to link.
 */
describe('scanBufferLine — rows that must NOT be joined', () => {
  const scan = (rows: string[], width: number): string =>
    scanBufferLine(fakeScreen(rows, width), 1).text.trimEnd();

  it('refuses a full row whose last token is not an anchored path', () => {
    // `and/` is the false-positive suite's own shape — and by the detector's
    // own trailing-slash standard it is even a "directory" — but with ONE
    // slash it is just as much `and/or` cut at the margin, so continuesPath
    // refuses it and a row ending in one picks up nothing. A row can end in
    // one and be exactly as wide as the window; that is not evidence of
    // anything.
    const first = 'the mount is configured read/write and/';
    expect(scan([first, 'or so the docs claim'], first.length)).toBe(first);
  });

  it('refuses a nearly full row whose last token is already a whole path', () => {
    // The hyphen rule asks for a tail that ends in `-` precisely so that a
    // complete path landing near the margin — the common shape — never picks
    // up the word the wrapper put on the next row after it.
    const first = 'downloaded /tmp/out/result.png';
    expect(scan([first, 'and cleaned the cache'], first.length + 3)).toBe(first);
  });

  it('refuses a nearly full row whose head is too long for the fit check', () => {
    // The sibling of the test above with a head that would NOT have fitted in
    // the leftover columns, so the fit guard passes and the join is refused
    // by the extension guard instead: `…result.png` is what a finished path
    // looks like, and `already` is where the next sentence starts. A cut
    // mid-token leaves a fragment, not a name with its extension on.
    const first = 'downloaded /tmp/out/result.png';
    expect(scan([first, 'already cleaned the cache'], first.length + 3)).toBe(first);
  });

  it('refuses a row that sits too far short of the margin to be nearly full', () => {
    // Six columns short is a word wrap until a `-` or `/` says otherwise
    // (rule 1b's business): the renderers rule 1a exists for sit within a
    // bounded few columns of the margin. `set.tar` would not have fitted in
    // the leftover columns, so the shortfall bound is what refuses here.
    const first = 'wrote /data/backups/nightly';
    expect(scan([first, 'set.tar done'], first.length + 6)).toBe(first);
  });

  it('refuses a hyphen row whose continuation would have fitted above', () => {
    // The block's own context sets the render width: `done` is four wide and
    // the fullest row nearby is 27, so `done` had room — the wrapper left the
    // row because it chose to, not because it ran out, and these rows are two
    // lines of one block.
    expect(
      scan(['/tmp/nightly-lock-', 'done', 'queued locks released today'], 27),
    ).toBe('/tmp/nightly-lock-');
  });

  it('refuses a hyphen row that continues as a rooted path of its own', () => {
    expect(scan(['/tmp/nightly-lock-', '/srv/x.mp3'], 20)).toBe('/tmp/nightly-lock-');
  });

  it('refuses a slash row whose continuation would have fitted above', () => {
    // The slash shape of the hyphen guard above: the block's context sets the
    // render width at 27 and `ok` is two wide — the wrapper left the row by
    // choice, so these are two lines.
    expect(scan(['wrote assets/img/', 'ok', 'and pruned the stale copies'], 27)).toBe(
      'wrote assets/img/',
    );
  });

  it('refuses a slash row that continues as a rooted path of its own', () => {
    expect(scan(['assets/img/', '/srv/x.mp3'], 13)).toBe('assets/img/');
  });

  it('refuses a slash row whose fragment had room at the render width', () => {
    // A paragraph that happens to end in a directory name must not pick up
    // the line below it. The paragraph's own fuller rows set the render width
    // at 50, and `quizgen-landing-page.png` — twenty-four wide — fits in the
    // columns the row above left free: a word wrap, not a mid-token cut.
    const rows = [
      'the nightly build wrote all of its rendered assets',
      'wrote assets/images/exam/',
      'quizgen-landing-page.png',
    ];
    expect(scanBufferLine(fakeScreen(rows, 60), 2).text.trimEnd()).toBe(
      'wrote assets/images/exam/',
    );
  });

  it('refuses two complete paths on consecutive rows', () => {
    // The row above stops well short of the margin, so nothing ran out of room
    // and there is no wrap to reconstruct. Joining these would produce
    // `/tmp/a.txt/tmp/b.txt`, a link to a file that cannot exist.
    expect(scan(['wrote /tmp/a.txt', '/tmp/b.txt is next'], 80)).toBe('wrote /tmp/a.txt');
  });

  it('refuses a gutter row whose first token would have fitted above', () => {
    // Both rows carry the block's gutter and the row above ends at a directory,
    // which is the exact shape rule 2 fires on — except that `done` had room at
    // the RENDER width, and the block's own fuller row is the proof: the guard
    // measures against the inferred width (never the pane), and at 27 columns
    // four more characters were never going to fit after column 21.
    expect(
      scan(['  │ created /tmp/out/', '  │ done', 'queued locks released today'], 27),
    ).toBe('  │ created /tmp/out/');
  });

  it('refuses a gutter row when the path above is already finished', () => {
    // No trailing slash: `/tmp/out` is a whole name, and gluing `done` onto it
    // would silently rename it.
    expect(scan(['  │ wrote /tmp/out', '  │ done and dusted'], 80)).toBe('  │ wrote /tmp/out');
  });

  it('refuses a gutter row that starts a path of its own', () => {
    expect(scan(['  │ cp /tmp/out/', '  │ /srv/media/b.mp3'], 80)).toBe('  │ cp /tmp/out/');
  });

  it('refuses an ASCII pipe, which is a table or a shell pipeline', () => {
    // Only box-drawing counts as a gutter. A markdown table's `| ` looks the
    // same to a naive rule and appears far more often.
    expect(scan(['| /tmp/out/', '| next.png    |'], 80)).toBe('| /tmp/out/');
  });

  it('still refuses to join when the row above is blank', () => {
    expect(scan(['', '  │ tmp/a.mp3'], 80)).toBe('');
  });
});

describe('pathLinks', () => {
  const context = (): { sessionName: string } => ({ sessionName: 'git-foo' });

  it('spans exactly the cells of the path, and no further', () => {
    const term = fakeTerminal(['wrote tmp/a.mp3: ok']);
    const links = pathLinks(term, 1, context);

    expect(links).toHaveLength(1);
    // 1-based and inclusive at both ends: `tmp/a.mp3` starts at column 7 and
    // ends at column 15, leaving the colon undecorated.
    expect(links[0]?.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 15, y: 1 } });
    expect(links[0]?.text).toBe('tmp/a.mp3');
  });

  it('does not include an inline writer label in the clickable range', () => {
    const term = fakeTerminal(['Write(docs/runbooks/production-data-migration.md).']);
    const links = pathLinks(term, 1, context);

    expect(links[0]?.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 48, y: 1 } });
    expect(links[0]?.text).toBe('docs/runbooks/production-data-migration.md');
  });

  it('spans two rows when the path is wrapped across them', () => {
    const term = fakeTerminal(['tmp/voice-p', 'reviews/a.mp3'], [1]);
    const links = pathLinks(term, 1, context);

    expect(links[0]?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 13, y: 2 } });
  });

  it('underlines the :line:col suffix but opens the path without it', () => {
    const term = fakeTerminal(['src/main.ts:12:5 warning']);
    const links = pathLinks(term, 1, context);

    expect(links[0]?.text).toBe('src/main.ts:12:5');

    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: '~/git/foo' },
    ];
    links[0]?.activate(CLICK, links[0].text);

    // Resolved against the SESSION's cwd, tilde already stripped, no `:12:5`.
    expect(files.reveal).toBe('git/foo/src/main.ts');
  });

  it('asks for pointer + underline, the same decoration the web links get', () => {
    const term = fakeTerminal(['tmp/a.mp3']);
    expect(pathLinks(term, 1, context)[0]?.decorations).toEqual({
      pointerCursor: true,
      underline: true,
    });
  });

  it('returns nothing for a line with no path in it', () => {
    const term = fakeTerminal(['duration=9.613042 and/or 2m 19s']);
    expect(pathLinks(term, 1, context)).toEqual([]);
  });

  it('falls back to home-relative when the session has no reported cwd', () => {
    const term = fakeTerminal(['tmp/a.mp3']);
    const files = useFilesStore();
    const sessions = useSessionsStore();
    sessions.sessions = [
      { name: 'git-foo', created: 0, activity: 0, attached: true, path: null },
    ];

    pathLinks(term, 1, context)[0]?.activate(CLICK, 'tmp/a.mp3');

    expect(files.reveal).toBe('tmp/a.mp3');
  });
});
