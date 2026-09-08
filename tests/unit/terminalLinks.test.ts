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

const { scanBufferLine, pathLinks } = await import('../../src/renderer/terminalLinks');
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
 * admits only http(s), and before the URL guard learned about `file://` the
 * join rules refused the break exactly as they refuse a web link's. The URL
 * is remote bytes like everything else in the pane: the path under its
 * scheme lives on the SSH host, and the Files tab is where a click lands.
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

  it('still refuses to extend an http URL across the same break', () => {
    const first = 'saved https://example.com/a/b.png';
    const scan = (rows: string[], width: number): string =>
      scanBufferLine(fakeScreen(rows, width), 1).text.trimEnd();
    expect(scan([first, 'and cleaned up'], first.length)).toBe(first);
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
    // which is the exact shape rule 2 fires on — except that `done` had sixty
    // columns of room, so the row above did not end because it was full.
    expect(scan(['  │ created /tmp/out/', '  │ done'], 80)).toBe('  │ created /tmp/out/');
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
