/**
 * The xterm side of "click a path in the terminal, land on it in the Files tab".
 *
 * Three jobs, in order:
 *   1. flatten a buffer line (with its wrapped continuation rows) back into a
 *      string, remembering which cell produced each character;
 *   2. run the pure detector over that string (./terminalPaths.ts);
 *   3. hand xterm an ILink per match, whose `activate` asks the files store to
 *      reveal the path.
 *
 * Step 1 is the only part that is not obvious. xterm has no "give me the
 * logical line" call: a line longer than the window is stored as several rows,
 * each flagged `isWrapped`, and a link's range is expressed in CELLS. So the
 * flattening keeps a parallel array of cell positions — one entry per UTF-16
 * code unit of the string — and the match offsets are mapped back through it.
 * Walking the cells (rather than using `translateToString` and doing
 * arithmetic) is what keeps the mapping right when a row contains a double-width
 * character, which occupies two cells but one string index.
 *
 * ## Why `isWrapped` is not enough, in THIS pane
 *
 * `isWrapped` is set when xterm itself ran out of columns — the writer kept
 * printing past the right margin and the terminal moved to the next row. That
 * is not how anything writes to this pane. The pane is always a tmux client and
 * tmux redraws row by row (`tty_cursor(tty, 0, y)` before each one), and the
 * agent TUIs inside it are full-screen renderers that position every cell they
 * paint. Neither ever lets a line overflow, so a line the USER sees broken
 * across two rows arrives here as two rows with `isWrapped` false on both — and
 * a path that spans the break is never seen whole by the detector.
 *
 * Five user reports are the shapes the rules below reconstruct:
 *
 *   - the Codex TUI wrapped mid-token and continued at column 0 of the next
 *     row, i.e. exactly the hard wrap xterm would have flagged had it done the
 *     wrapping (rule 1);
 *   - the Codex TUI wrapped its own block and prefixed the continuation with
 *     its box-drawing gutter (`  │ `), which has to be dropped as well as
 *     joined (rule 2);
 *   - this app's own CLI wraps long tokens at the hyphens inside them instead
 *     of at the margin, so the row above the break ends a few columns SHORT of
 *     full — `…/event-webinar-` / `og.png` — and rule 1b reads the hyphen as
 *     the break opportunity it is;
 *   - a markdown-rendering CLI fills the row up to the last `/` inside the
 *     token instead of to the margin — `…vectorize-agent/` / `diagrams` —
 *     which is the same shape with the slash as the opportunity, so rule 1b
 *     takes both characters;
 *   - the same CLI also breaks tokens when the row is nowhere near the pane's
 *     margin — `…work-chronicle-` / `overview.png` sat a dozen columns short
 *     in a wider window — because tmux keeps rows painted at the width they
 *     were RENDERED at, and the window has since been resized. No fixed
 *     "how far short of the margin" bound survives that; rule 1b's fit
 *     arithmetic therefore runs against the render width inferred from the
 *     fullest nearby row ({@link inferWrapWidth}), never against the pane's
 *     live width.
 *   - Claude Code's transcript paints its rows up to a small inset inside
 *     the pane and cuts the token at that width wherever the width happens
 *     to land — `…-b30c-ed8` / `60a6cb317…`, a UUID severed mid-hex — so
 *     neither of the evidences above is present: the row is one or two
 *     columns short of full (no rule 1) and the cut is at no opportunity
 *     character (no rule 1b). Rule 1a reads the nearly-full row: within a
 *     bounded few columns of the margin is still "ran out of room", provided
 *     the continuation's first token could not have been placed in the
 *     columns left over, and the tail does not already end looking like a
 *     finished `name.ext` — which is what a COMPLETE path about to be
 *     followed by the next line's prose looks like.
 *   - the Codex transcript hang-indents the wrapped rows of its own blocks:
 *     the continuation began with ELEVEN spaces before the content that
 *     continued the row above's cut — `…list in image-` / `
 *     regeneration-workflow.md`. Every rule used to refuse any row whose
 *     first cell held a space, on the grounds that a space means the row
 *     above's token ended cleanly; but the spaces are the renderer's LAYOUT,
 *     and a token cannot contain a space, so the run is decoration and the
 *     content after it is what the guards must judge. Rules 1a and 1b now
 *     read past a bounded indent (rule 1 stays column-0 — an indent is the
 *     renderer choosing where a row begins, which is the opposite of the
 *     overflow rule 1 reconstructs).
 *
 * Both rules are deliberately narrow, for the reason terminalPaths.ts's header
 * gives: joining two rows that were never one line can only invent a path that
 * does not exist, and an underline stretched across a boundary is the most
 * visible way this feature can look broken. Each condition is spelled out at
 * the rule.
 *
 * ## Appearance
 *
 * A path link is decorated exactly like the http links this terminal already
 * has: pointer cursor and an underline, both on hover only — the decoration
 * vocabulary xterm's link provider API offers. The underline inherits the
 * cell's own foreground, so a path printed green underlines green and the
 * terminal keeps saying what the program said.
 *
 * Hover is not the layer the user judges by, though. The remote CLI colours
 * and underlines its file references itself, and when ITS wrapper breaks a
 * path across rows the underline covers only the first row's fragment — so
 * at rest a path read as highlighted halfway no matter how well the join
 * worked. Persistent highlighting therefore exists as its own layer:
 * terminalPathHighlights.ts blocks the whole joined path in the theme's
 * selection tint, re-derived from the buffer for every row the renderer
 * touches — the rescan is what answers the marker-staleness objection that
 * once kept this hover-only. The tint is the theme's own selection colour
 * solidified over the terminal ground (themes.ts terminalLinkTint): no new
 * palette values, per docs/DESIGN.md §3.
 *
 * ## Clicking while the remote app owns the mouse
 *
 * This pane is ALWAYS a tmux client, and the agent TUIs it runs turn mouse
 * reporting on, so "does a link still fire when the remote program is grabbing
 * clicks?" decides whether any of this works in practice rather than only in a
 * bare shell. It does fire, and the reason is that the two mechanisms are bound
 * to different elements (xterm 6.0.0, verified against its sources):
 *
 *   - mouse REPORTING binds to `.xterm` — `CoreBrowserTerminal.bindMouse()`
 *     opens with `const el = this.element`;
 *   - the LINKIFIER binds to `.xterm-screen`, a child of it —
 *     `createInstance(Linkifier, this.screenElement)`.
 *
 * A click lands inside the screen, so the linkifier's own mousedown/mouseup run
 * first on the way up, and `Linkifier._handleMouseUp` calls `link.activate`
 * with no consultation of `areMouseEventsActive` anywhere along that path. The
 * outer handler's `cancel(ev)` calls `stopPropagation`, which only stops the
 * event travelling FURTHER up — it cannot un-run a listener on a descendant.
 * The decorations survive too: `.xterm.enable-mouse-events { cursor: default }`
 * is overridden by the later and equally specific `.xterm .xterm-cursor-pointer`
 * in xterm's own stylesheet.
 *
 * What the user ALSO used to get was the same click delivered to the remote
 * program, so tmux could move its cursor or select the pane under the pointer
 * on the way. That side effect is gone for plain clicks:
 * terminalMouseSelection.ts replaces `SelectionService.shouldForceSelection`,
 * the predicate `bindMouse`'s mousedown handler consults before `sendEvent`,
 * so a plain button-1 press is never reported and follows the link cleanly.
 * SHIFT is the deliberate hand-off: a Shift-click is reported to tmux and
 * still follows the link, because the linkifier's listener on the descendant
 * runs regardless.
 */
import type { IBuffer, IBufferCell, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { continuesPath, findPaths, HAS_EXTENSION, stripFileScheme } from './terminalPaths';
import { useFilesStore } from './stores/files';
import { useSessionsStore } from './stores/sessions';

/**
 * What a click needs to know, read fresh on every call.
 *
 * A getter rather than a value because both facts move: the pane re-points at
 * another session without being re-created (see TerminalView's `showTarget`),
 * and the sessions store is refreshed lazily, so at mount time it may not yet
 * know the session's working directory at all.
 */
export interface TerminalPathContext {
  /** tmux session the pane is showing, or '' for a bare shell. */
  sessionName: string;
}

/**
 * Cap on how many rows one flattening may join. A pathological wrapped line
 * (a 9000-row scrollback of one string) must not turn a mouse-move into a
 * full-buffer walk; the same 2048-character budget WebLinkProvider uses.
 */
const MAX_SCAN_CHARS = 2048;

/**
 * Cap on rows joined by RECONSTRUCTION ({@link joinedRowSkip}), in each
 * direction. xterm's own `isWrapped` chain is left uncapped because it is a
 * fact the terminal recorded; a reconstruction is a guess, and a guess that
 * chained down a screenful of gutter-prefixed rows would spend a whole buffer
 * walk on a hover. Eight is headroom above the longest joined run the repair
 * reports needed (see WRAP_SHORTFALL's derivation below); the rule's own
 * guards, not this cap, are what keep normal prose from gluing together.
 */
const MAX_JOIN_ROWS = 8;

/**
 * How many columns short of the margin a row may sit and still read as "ran
 * out of room" for RULE 1a below.
 *
 * Full to the very last column (rule 1) is the strongest geometric evidence
 * there is; nearly full is the next strongest, and nearly has to mean a
 * bounded few. The renderers that wrap short of the margin reserve a small
 * fixed inset — the Claude Code transcript the rule was written from
 * measured at one to two columns (a 91-character row in a 92- or 93-cell
 * pane) — so four covers the family without letting an ordinary word-wrap
 * line, which can end anywhere, qualify. What bounds the risk the extra
 * columns admit is the rule's own guards, not this number.
 */
const WRAP_SHORTFALL = 4;

/**
 * The gutter a TUI puts in front of the continuation rows of a block it wrapped
 * itself — `  │ ` in the Codex output the user reported.
 *
 * Box-drawing only, and only with the single trailing space the TUIs actually
 * emit. ASCII `|` is deliberately NOT here: `| ` starts a markdown table row
 * and appears in the middle of shell pipelines, and admitting it would let this
 * rule glue together two rows of a table.
 */
const GUTTER = /^ {0,8}[│┃] /;

/**
 * The hanging indent a transcript renderer puts in front of the wrapped rows of
 * its own block — `           regeneration-workflow.md` in the Codex output the
 * seventh report was read from: the continuation row began with ELEVEN spaces,
 * the block's indent plus the wrap column, before the content that continues
 * the row above's `…list in image-`.
 *
 * The run is decoration, not a token boundary: a token cannot contain a space,
 * so spaces at the head of a continuation are always the renderer's indent, and
 * the content after them is what may or may not continue the tail. Capped at
 * {@link INDENT_LIMIT} columns — past that sits deep code-block territory where
 * a join has no business guessing.
 */
const HANGING_INDENT = /^ +/;

/** How much leading indentation a continuation row may carry and still join. */
const INDENT_LIMIT = 16;

/** One flattened logical line, plus the cell each character came from. */
export interface ScannedLine {
  text: string;
  /** `cells[i]` is the 0-based buffer cell that produced `text[i]`. */
  cells: { x: number; y: number }[];
}

/** A row read for the join rules: its text and where its content actually ends. */
interface RowRead {
  /** The whole row, untouched cells read as spaces. Never trimmed. */
  text: string;
  /** Column of the last cell holding anything but a space, or -1 for a blank row. */
  lastCol: number;
  /** Cells in the row — which, in xterm, is the terminal's column count. */
  width: number;
}

/**
 * Read one row for the join rules only.
 *
 * Separate from the flattening loop because the rules need to look at a row
 * BEFORE deciding whether to consume it, and because they need a COLUMN
 * (`lastCol`) rather than a string offset — the two part company the moment the
 * row holds a double-width character, which is the same reason the flattening
 * walks cells instead of using `translateToString`.
 */
function readRow(buf: IBuffer, y: number, scratch: IBufferCell): RowRead | null {
  const line = buf.getLine(y);
  if (!line) return null;
  const parts: string[] = [];
  let lastCol = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell || cell.getWidth() === 0) continue;
    const content = cell.getChars();
    if (content === '' || content === ' ') {
      parts.push(' ');
      continue;
    }
    parts.push(content);
    lastCol = x;
  }
  return { text: parts.join(''), lastCol, width: line.length };
}

/**
 * The render width the rows around a hover were painted at.
 *
 * THE PANE'S CURRENT WIDTH IS NOT EVIDENCE. This pane is a tmux client and
 * tmux keeps history rows painted at the width they were rendered at: the
 * window can be resized — or a CLI can wrap at its own narrower width — after
 * the fact, so a row can sit ANY distance short of the live margin. What
 * survives both is the rows themselves: the fullest row of the hovered row's
 * own block is the best surviving measurement of the width its neighbours
 * were wrapped at. Rule 1b's fit guard below runs against this, never
 * against `prev.width`.
 *
 * "Block" is the contiguous run of non-blank rows around the hover, and the
 * walk stops at the first blank row in each direction: blocks separated by a
 * blank were wrapped independently, and rows beyond it say nothing about this
 * one's width. That bound is what keeps the estimate honest in exactly the
 * pane this was rebuilt for — the agent CLI's footer draws `Worked for 23m
 * 29s ────────` to the PANE's own width a row or two below the text, and one
 * such row collected into a whole-window maximum would drag the inferred
 * width back up to the pane, reverting every guard to the live-width
 * arithmetic this exists to escape. A row of one repeated character (a bare
 * `────` rule or `====` bar) is refused as decoration as well, and ends the
 * walk the way a blank does: what lies beyond it is a different block anyway.
 *
 * The window is capped at {@link MAX_JOIN_ROWS} rows per direction — the same
 * rows the reconstruction walk may consume. Rows cannot exceed the pane, so
 * the result is a sane width even when the block is all short lines: there
 * the estimate degrades to the hovered block's own widest row, and the fit
 * guard degenerates to the lexical tail/head checks alone — the deliberate
 * fallback, not a bug.
 */
function inferWrapWidth(buf: IBuffer, y0: number, scratch: IBufferCell): number {
  let width = 1;
  const collect = (row: RowRead): boolean => {
    if (row.lastCol < 0) return false;
    const trimmed = row.text.trim();
    if (trimmed.length >= 4 && /^(.)\1+$/.exec(trimmed) !== null) return false;
    if (row.lastCol + 1 > width) width = row.lastCol + 1;
    return true;
  };
  for (let y = y0, steps = 0; y >= 0 && steps <= MAX_JOIN_ROWS; y--, steps++) {
    const row = readRow(buf, y, scratch);
    if (row === null || !collect(row)) break;
  }
  for (let y = y0 + 1, steps = 0; steps <= MAX_JOIN_ROWS; y++, steps++) {
    const row = readRow(buf, y, scratch);
    if (row === null || !collect(row)) break;
  }
  return width;
}

/**
 * Does [next] continue [prev], even though xterm did not flag it wrapped?
 *
 * [wrapWidth] is the inferred render width ({@link inferWrapWidth}) — the
 * width rule 1b's fit arithmetic is measured against, never the pane's live
 * width. Rule 1a is the deliberate exception: its near-full claim is about
 * the live margin, so its fit arithmetic runs against the row's own leftover
 * columns.
 *
 * @returns how many leading CELLS of [next] to drop before joining (0 for a
 *   plain wrap, the gutter's width for a gutter-marked one, the hanging
 *   indent's width for an indented one), or null for "these are two different
 *   lines" — which is the answer this function is built to give, and gives for
 *   everything it is not certain about.
 */
function joinedRowSkip(prev: RowRead, next: RowRead, wrapWidth: number): number | null {
  if (prev.lastCol < 0) return null;
  const tail = /\S+$/.exec(prev.text.trimEnd())?.[0] ?? '';
  // An http(s) URL belongs to WebLinksAddon and is never extended across a
  // row break: gluing a second row onto one would produce a link to a host
  // nobody named. A `file://` URL is the opposite case — the detector strips
  // its scheme and claims it as a path — and the TUIs wrap long file URLs
  // mid-token exactly like any other path, so it joins under the same rules.
  const asPath = stripFileScheme(tail);
  if (tail.includes('://') && asPath === null) return null;
  // The shape guard is the detector's own standard, not a stricter local one:
  // it used to demand a ROOTED tail, and every relative path failed it — the
  // rows of `assets/images/exam/` + `quizgen-landing-page.png` stayed two
  // lines, the row above kept a link to the truncated directory, and the
  // filename fragment got nothing. One carve-out beside that: a tail ending
  // in `-`. A trailing hyphen is cut evidence in its own right — it is the
  // break-opportunity character the wrapper stopped on, and the one case
  // where the tail need not be a path SO FAR because the joined token is
  // what becomes one (`image-` + `regeneration-workflow.md`, the seventh
  // report's first-segment cut). The per-rule guards below still decide; the
  // slash keeps its stricter treatment, because `and/` is `and/or` prose and
  // not a break anyone's wrapper made.
  if (!tail.endsWith('-') && !continuesPath(asPath ?? tail)) return null;

  const gutter = GUTTER.exec(next.text);
  if (gutter === null) {
    // The hanging indent ({@link HANGING_INDENT}): leading spaces are the
    // renderer's decoration and the CONTENT starts after them. Past the cap,
    // or with nothing but spaces on the row, none of the rules below may
    // speak — `content` starts past the indent, and an all-indent row is a
    // blank one.
    const indentMatch = HANGING_INDENT.exec(next.text);
    const indent = indentMatch !== null && indentMatch[0].length <= INDENT_LIMIT
      ? indentMatch[0].length
      : 0;
    const overIndented = indentMatch !== null && indentMatch[0].length > INDENT_LIMIT;
    const content = next.text.slice(indent);
    const first = content.charAt(0);
    if (first === '' || first === ' ' || overIndented) return null;
    const head = /^\S+/.exec(content)?.[0] ?? '';

    // RULE 1 — the hard wrap tmux repainted away.
    //
    // The evidence is geometric and it is the strongest available: the row
    // above is full to its very last column, so whoever wrote it had no room
    // left, and the row below starts at column 0 with a non-blank. That is the
    // exact situation in which xterm would have set `isWrapped` had the bytes
    // reached it as one overlong line instead of as two positioned rows.
    //
    // A continuation carrying a hanging indent never gets here even when the
    // row above is full: an indent means the renderer CHOSE where this row
    // begins, which is layout, not an overflow — the content-guarded rules
    // below decide those.
    //
    // Not caught, deliberately: a row whose last column was left blank because
    // a double-width character would not fit in it. Reconstructing that needs a
    // second guess on top of this one, and the cost of being wrong is an
    // underline running through unrelated text.
    if (indent === 0 && prev.lastCol === prev.width - 1) return 0;

    // RULE 1a — the hard wrap that stopped a few columns SHORT of the margin.
    //
    // The Claude Code transcript of the sixth report paints its rows up to a
    // small inset inside the pane and cuts the token where that inset lands —
    // `…-b30c-ed8` / `60a6cb317…`, a UUID severed mid-hex. So rule 1's
    // evidence is missing by a cell or two, and rule 1b's is missing because
    // this wrapper wraps at its width, not at opportunity characters. A row
    // ending within {@link WRAP_SHORTFALL} columns of the margin is still a
    // row that ran out of room, and the continuation's content — at column 0
    // or after its hanging indent — still reconstructs it, under guards that
    // name the difference between a cut token and a finished line:
    //
    //   - the continuation's first token could not have been placed in the
    //     columns left over (`head.length > left`). The wrapper's own
    //     arithmetic, run backwards: had the break fallen BETWEEN tokens, the
    //     head would have been put on the row above when it fit. `…result.png`
    //     three columns short plus `and cleaned the cache` refuses here, and
    //     the head check is what refuses it — `and` had room.
    //   - the continuation does not start with `/`. `…` plus `/x` is not a
    //     path anyone wrote; it is two paths, and the second one is whole
    //     already — the same refusal rule 1 makes no exception to.
    //   - the tail does not already end extension-shaped ({@link HAS_EXTENSION}).
    //     `…name.ext` is what a COMPLETE path looks like; a cut leaves a
    //     fragment. This is the guard that refuses the misjoin whose head is
    //     too long for the fit check to catch (`result.png` + `already`),
    //     at the cost of a true cut that happens to leave a dotted fragment
    //     (`…url.t` + `xt`) — the same trade rule 1b's opportunity
    //     characters make.
    const left = prev.width - 1 - prev.lastCol;
    if (
      head !== '' &&
      !head.startsWith('/') &&
      left <= WRAP_SHORTFALL &&
      head.length > left &&
      !HAS_EXTENSION.test(tail)
    ) {
      return indent;
    }

    // RULE 1b — the break a wrapper puts INSIDE the token, at an opportunity
    // the token itself offers, rather than at the margin: hyphens (this app's
    // own CLI) and slashes (the markdown-rendering CLI of the "Cloudflare
    // diagrams" report) are the two characters terminal wrappers are seen to
    // break at. The opportunity character stays at the tail's end, and that
    // is the one trace of a cut — rather than finished — token a row carries.
    // Three guards, each the reason a different way of being wrong stays
    // shut:
    //
    //   - the tail ends with `-` or `/`. That is the break opportunity the
    //     wrapper used, and the one trace of a cut — rather than finished —
    //     token a row's end carries that survives being far short of the
    //     margin: a whole path landing anywhere (`…/result.png` + `and
    //     cleaned up`) ends in something else and never gets here.
    //   - the continuation does not start with `/`. `…-` or `…/` plus `/x` is
    //     not a path anyone wrote; it is two paths, and the second one is
    //     whole already.
    //   - the continuation's first token WOULD NOT HAVE FIT at the render
    //     width ({@link inferWrapWidth}). That is the wrapper's own arithmetic
    //     run backwards: if the token fit, the wrapper would have put it
    //     there, so the row below is a new line. Where the neighbourhood gives
    //     no wider row, the estimate falls back to the block itself and this
    //     guard stops constraining — the tail and head checks then carry the
    //     rule alone, which is the price of surviving resizes.
    if (!tail.endsWith('-') && !tail.endsWith('/')) return null;
    if (head === '' || head.startsWith('/')) return null;
    if (prev.lastCol + 1 + head.length <= wrapWidth) return null;
    return indent;
  }

  // RULE 2 — the TUI wrapped its own block and marked the continuation.
  //
  // Three conditions, each guarding a different way of being wrong:
  //
  //   - the tail ends with `/`. A TUI that wraps its own text breaks at a
  //     boundary it chose, and `…/` is the only break point that leaves the
  //     path visibly unfinished. Without this, `  │ wrote /tmp/out` followed by
  //     `  │ done` would join into `/tmp/outdone`.
  //   - the continuation does not itself start with `/`. `…/` plus `/x` is not
  //     a path anyone wrote; it is two paths, and the second one is whole
  //     already.
  //   - the continuation's first token WOULD NOT HAVE FIT on the row above.
  //     This is the wrapper's own arithmetic, run backwards: if the token fit,
  //     the row above did not end because it ran out of room, so the row below
  //     is a new line that merely happens to carry the same gutter. It is what
  //     stops `  │ created /tmp/out/` + `  │ done` from ever joining, since
  //     `done` had eighty columns of room to sit in.
  if (!tail.endsWith('/')) return null;
  const rest = next.text.slice(gutter[0].length);
  const head = /^\S+/.exec(rest)?.[0] ?? '';
  if (head === '' || head.startsWith('/')) return null;
  if (prev.lastCol + 1 + head.length <= prev.width) return null;
  // The gutter is spaces and a narrow box-drawing character, so its string
  // length is also its cell count — no double-width correction needed.
  return gutter[0].length;
}

/**
 * Flatten the logical line that [bufferLineNumber] (1-based, as xterm passes
 * it to a link provider) belongs to.
 */
export function scanBufferLine(term: Terminal, bufferLineNumber: number): ScannedLine {
  const buf = term.buffer.active;
  const chars: string[] = [];
  const cells: { x: number; y: number }[] = [];
  const scratch = buf.getNullCell();
  // One inference per flattening, before any join decision: every
  // reconstruction below measures its fit arithmetic against this width.
  const wrapWidth = inferWrapWidth(buf, bufferLineNumber - 1, scratch);

  // Walk up to the row the logical line STARTS on. A row is a continuation of
  // the one above it when it is flagged wrapped, or when the rules above can
  // reconstruct a wrap xterm never saw; the first row that is neither is where
  // the line begins.
  let y = bufferLineNumber - 1;
  let joined = 0;
  while (y > 0) {
    const line = buf.getLine(y);
    if (line?.isWrapped) {
      y--;
      continue;
    }
    if (joined >= MAX_JOIN_ROWS) break;
    // Two extra row walks, and only on the row the mouse is actually over —
    // xterm asks a link provider once per hovered ROW, not once per cell.
    const above = readRow(buf, y - 1, scratch);
    const here = readRow(buf, y, scratch);
    if (above === null || here === null) break;
    if (joinedRowSkip(above, here, wrapWidth) === null) break;
    joined++;
    y--;
  }

  // Cells to drop from the front of the row about to be read: a reconstructed
  // gutter or a hanging indent, never anything else.
  let skip = 0;
  joined = 0;
  for (;;) {
    const line = buf.getLine(y);
    if (!line) break;
    for (let x = skip; x < line.length; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) continue;
      // Width 0 is the right-hand half of a double-width character: it holds no
      // string content of its own and must not advance the string index.
      if (cell.getWidth() === 0) continue;
      const content = cell.getChars();
      if (content === '') {
        // An untouched cell. It reads as a space, which is what makes it a
        // token boundary for the detector.
        chars.push(' ');
        cells.push({ x, y });
        continue;
      }
      // Pushed per UTF-16 code unit, not per code point, so that string offsets
      // from the detector index this array directly.
      for (let k = 0; k < content.length; k++) {
        chars.push(content.charAt(k));
        cells.push({ x, y });
      }
    }
    if (chars.length >= MAX_SCAN_CHARS) break;

    const next = buf.getLine(y + 1);
    if (next?.isWrapped) {
      skip = 0;
      y++;
      continue;
    }
    if (joined >= MAX_JOIN_ROWS) break;
    const here = readRow(buf, y, scratch);
    const below = readRow(buf, y + 1, scratch);
    if (here === null || below === null) break;
    const continues = joinedRowSkip(here, below, wrapWidth);
    if (continues === null) break;
    // A row a TUI wrapped itself stops short of the margin, so the cells after
    // it read as spaces — and a run of spaces in the middle of the flattened
    // line would break the path back into the two tokens we just went to the
    // trouble of joining. They are dropped rather than emitted. Nothing is lost
    // with them: an `isWrapped` row is full by definition and never gets here,
    // rule 1 fires only on a row whose last column is occupied, and rule 1b
    // leaves behind nothing but the wrap's own blank columns.
    while (chars.length > 0 && chars[chars.length - 1] === ' ') {
      chars.pop();
      cells.pop();
    }
    skip = continues;
    joined++;
    y++;
  }

  return { text: chars.join(''), cells };
}

/**
 * 1-based column one past the last non-blank cell of the buffer line [y]
 * (1-based), or 1 for a blank line.
 *
 * The at-rest highlighter clamps the intermediate rows of a multi-row link
 * with this: a reconstructed row stops short of the pane, the link's range
 * records only its two endpoints, and the cells between a fragment's last
 * character and the margin are padding the tint must not cover.
 */
export function lastTextColumn(term: Terminal, y: number): number {
  const buffer = term.buffer.active;
  const line = buffer.getLine(y - 1);
  if (!line) return 1;
  const scratch = buffer.getNullCell();
  let end = 1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell || cell.getWidth() === 0) continue;
    const content = cell.getChars();
    if (content !== '' && content !== ' ') end = x + 1;
  }
  return end;
}

/**
 * The links for one buffer line. Exported for testing without a live terminal. */
export function pathLinks(
  term: Terminal,
  bufferLineNumber: number,
  context: () => TerminalPathContext,
): ILink[] {
  const scanned = scanBufferLine(term, bufferLineNumber);
  const links: ILink[] = [];

  for (const match of findPaths(scanned.text)) {
    const from = scanned.cells[match.start];
    const to = scanned.cells[match.end - 1];
    if (from === undefined || to === undefined) continue;

    // xterm's range is 1-based and inclusive at both ends.
    links.push({
      range: {
        start: { x: from.x + 1, y: from.y + 1 },
        end: { x: to.x + 1, y: to.y + 1 },
      },
      text: scanned.text.slice(match.start, match.end),
      decorations: { pointerCursor: true, underline: true },
      // `match.path` deliberately, NOT the `text` xterm hands back: the text is
      // what is underlined, which still carries the `:12:5` suffix.
      activate: () => {
        revealInFiles(context(), match.path);
      },
    });
  }
  return links;
}

/**
 * A provider for TerminalView to register.
 *
 * It must be registered AFTER `WebLinksAddon` is loaded. xterm consults link
 * providers in registration order and drops a lower-priority link that
 * intersects a higher-priority one, so registering second is what guarantees a
 * URL stays a web link even if the path detector were ever to be fooled by one.
 * (It is not: terminalPaths.ts rejects any http(s) token outright, and a
 * `file://` token is not a web link at all — the detector strips its scheme and
 * opens the path.)
 */
export function createPathLinkProvider(
  term: Terminal,
  context: () => TerminalPathContext,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      const links = pathLinks(term, bufferLineNumber, context);
      // `undefined`, not an empty array: xterm treats an array as "this
      // provider answered" when it decides which provider owns a cell.
      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * Hand the path to the files store.
 *
 * The session's working directory is looked up HERE, at click time, rather than
 * being captured when the provider was built: a workspace opened by deep link
 * renders before the sessions store has been refreshed, so a path captured at
 * mount would be resolved against a cwd of `undefined`.
 */
function revealInFiles(context: TerminalPathContext, path: string): void {
  const sessions = useSessionsStore();
  const cwd = context.sessionName
    ? (sessions.sessions.find((s) => s.name === context.sessionName)?.path ?? null)
    : null;
  useFilesStore().requestReveal(path, cwd);
}
