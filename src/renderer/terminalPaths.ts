/**
 * Finding file paths in a line of terminal output.
 *
 * Pure on purpose: no DOM, no Vue, no xterm, no SFTP. The only input is a
 * string that was already flattened out of the terminal buffer, and the only
 * output is a list of offsets into it. That is what makes the rules below
 * testable one false positive at a time (tests/unit/terminalPaths.test.ts),
 * and this module is nothing BUT rules.
 *
 * ## Why the rules are so suspicious
 *
 * Terminal output is not a document with a grammar; it is whatever the remote
 * program felt like printing. Underlining half a sentence because it contained
 * `and/or` does not read as a missing feature, it reads as a broken terminal —
 * so every rule here is biased towards saying no. A path that is not linkified
 * costs the user a copy-paste. A word that is wrongly linkified costs the
 * terminal its credibility on every line it prints.
 *
 * The consequence is that some real paths are deliberately NOT matched:
 *
 *   - anything with a space in it (`/tmp/my file.mp3`), because a space is the
 *     only token boundary a terminal reliably gives us and guessing where the
 *     path ends would produce a link that opens the wrong thing;
 *   - a bare name with no slash (`preview-1.mp3`, `Makefile`), because every
 *     English word ending in `.py` in prose would become a link;
 *   - a single-slash relative path with no extension (`src/main`), because
 *     `and/or`, `client/server`, `read/write`, `w/o`, `y/N` and `n/a` are the
 *     same shape and appear far more often in real output.
 *
 * ## What a match is
 *
 * `start`/`end` are offsets into the scanned line rather than a substring,
 * because xterm's link provider wants cell POSITIONS: it has to map the match
 * back onto buffer coordinates to know which cells to underline. `path` is the
 * path alone — the surrounding quotes, brackets, sentence punctuation and any
 * `:12:5` position suffix have already been peeled off it, while `start`/`end`
 * still span the suffix so the whole of `src/main.ts:12` underlines as one
 * link the way an editor shows it.
 */

export interface PathMatch {
  /** Offset of the first character of the match within the scanned line. */
  start: number;
  /** Offset one past the last character, so `line.slice(start, end)` is the match. */
  end: number;
  /**
   * The path itself: no enclosing punctuation, no `:line:col` suffix. This —
   * never `line.slice(start, end)` — is what gets opened.
   */
  path: string;
  /** 1-based line number from a `path:12` or `path:12:5` suffix, when present. */
  line?: number;
  /** 1-based column from a `path:12:5` suffix, when present. */
  column?: number;
}

/**
 * Longest line we will look at. A terminal line is bounded by the window
 * width, but a wrapped line is joined before it gets here and tmux can hand us
 * a very long one; the scan is linear, but there is no point spending it on
 * output nobody can read anyway.
 */
const MAX_LINE = 4096;

/** POSIX NAME_MAX. A "segment" longer than this cannot be a real filename. */
const MAX_SEGMENT = 255;

/**
 * Punctuation that can sit in front of a path without being part of it.
 * `*` is here for markdown-ish emphasis (`**tmp/x.md**`) — note it is still
 * forbidden INSIDE a candidate, where it means a glob rather than decoration.
 */
const LEADING_NOISE = new Set(['"', "'", '`', '(', '[', '{', '<', '*']);

/**
 * Call-like wrappers that can put a path directly after a word (`Write(path)`).
 * They are considered only when the word before them has not already become a
 * path segment; this preserves names such as `tmp/report(1).pdf`.
 */
const INLINE_OPENERS = new Set(['(', '[', '{', '<']);
const INLINE_PREFIX = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Punctuation that can trail a path without being part of it. The colon is the
 * one that matters most: `preview-1.mp3:` is how ffprobe and half the tools on
 * a box introduce a file before saying something about it, and a link that
 * swallowed the colon would open a filename that does not exist.
 */
const TRAILING_PUNCT = new Set([',', ';', ':', '.', '!', '?', '*']);

/**
 * Closing brackets and quotes, mapped to their openers. These are only dropped
 * when the candidate does not contain a matching opener — so `(see tmp/a/b.txt)`
 * loses its `)` while a file genuinely named `report(1).pdf` keeps its own.
 */
const CLOSERS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
  '>': '<',
  '"': '"',
  "'": "'",
  '`': '`',
};

/**
 * Characters that disqualify a candidate outright.
 *
 * Globs (`*`, `?`) are excluded because we linkify optimistically and never
 * stat: `tmp/*.mp3` would produce a link that cannot possibly open. The shell
 * metacharacters and the backslash are excluded because their presence means
 * we are looking at a command line, a quoted fragment or an escape — not at a
 * name the remote filesystem actually holds.
 */
const FORBIDDEN = /[\\*?<>|"'`$;&]/;

/**
 * `path:12` and `path:12:5`, the shape compilers, linters and grep emit. The
 * digits are capped so a stray `:` followed by a long number cannot make a
 * nonsense line number, and group 1 is non-greedy but non-empty so `:12` on its
 * own is not read as a path called "".
 */
const LINE_SUFFIX = /^(.+?):(\d{1,9})(?::(\d{1,9}))?$/;

/** A segment that is only a number: `1/4`, `2026/08/25`, `9/10`. */
const NUMERIC_SEGMENT = /^\d+(?:\.\d+)?$/;

/**
 * A first segment shaped like a hostname: `www.example.com`, `example.io`.
 *
 * WebLinksAddon only claims `http(s)://`, so a bare `www.example.com/index.html`
 * reaches us unclaimed — and it has the exact shape of a relative path with an
 * extension, which is the one relative shape we do accept. Rejecting a
 * domain-like first segment is what keeps a URL someone typed without a scheme
 * from opening the Files tab.
 */
const HOSTNAME_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/i;

/**
 * A trailing `.ext`. Deliberately permissive about the extension itself.
 *
 * Shared with the join rules in terminalLinks.ts, which read it not as "this
 * is a path" but as "this tail looks FINISHED": a fragment a wrapper cut
 * mid-token rarely happens to end extension-shaped, while a whole path one
 * line of prose is about to follow usually does.
 */
export const HAS_EXTENSION = /\.[A-Za-z0-9_-]{1,16}$/;

/**
 * A `file://` URL is a path wearing a scheme, and everything it names is on
 * the machine this terminal is attached to — so it is this detector's to
 * claim, and the Files tab is where a click lands. WebLinksAddon cannot take
 * it (its regex admits only http/https) and opening it as a LOCAL file would
 * be wrong twice over: the renderer is sandboxed, and the file is not local.
 *
 * Only the empty-authority form (`file:///…`) passes. A program printing a
 * URL for a file of its own always prints that form, while `file://host/path`
 * stripped of its scheme is a hostname wearing a path, and would resolve to
 * the wrong place if it resolved at all.
 *
 * The path under the scheme is read LITERALLY, without percent-decoding: what
 * a CLI prints in a `Saved to:` line is the raw filesystem path, and decoding
 * would corrupt a name that genuinely holds `%20`.
 */
export function stripFileScheme(token: string): string | null {
  if (!token.startsWith('file://')) return null;
  const path = token.slice('file://'.length);
  return path.startsWith('/') ? path : null;
}

/**
 * Every path-looking token in `line`, left to right.
 *
 * Tokens are whitespace-separated runs, which is the whole reason paths with
 * spaces are out of scope: the alternative is a regex that decides for itself
 * where a name stops, and it is wrong far more often than it is right.
 */
export function findPaths(line: string): PathMatch[] {
  const out: PathMatch[] = [];
  if (line.length === 0 || line.length > MAX_LINE) return out;

  const tokens = /\S+/g;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(line)) !== null) {
    const match = matchToken(token[0], token.index);
    if (match !== null) out.push(match);
  }
  return out;
}

/** Peel one whitespace-delimited token down to a path, or reject it. */
function matchToken(token: string, base: number): PathMatch | null {
  // A URL is never a path — with one exception: `file://` IS one, the path
  // under a scheme, and {@link stripFileScheme} below hands it to the rules
  // whole. For everything else this check comes FIRST — before any peeling —
  // so no part of a URL can survive to be examined on its own. Without it,
  // `https://host/a=b/c.txt` would lose its scheme to the `key=value` rule
  // below and re-emerge as the perfectly path-shaped `b/c.txt`.
  //
  // This is also half of how a link is kept from being claimed twice. The
  // other half is registration order: WebLinksAddon registers its provider
  // first and xterm gives an earlier provider priority over a later one for
  // the same cells, so even a URL shape this rule failed to recognise stays
  // the web link it already was. (WebLinksAddon's regex never matches
  // `file://` at all, so a file URL has only ever had this detector to
  // claim it.)
  if (token.includes('://') && stripFileScheme(token) === null) return null;

  let start = 0;
  const end = token.length;

  // A markdown link `[label](target)`: the label is prose — often itself a
  // filename-shaped word, which is exactly what the agent transcripts print —
  // and the target is the address a click can open. Only the target
  // underlines and opens; a target that is no path (an `#anchor`, a bare
  // word) falls through to the rules below, which reject the whole token the
  // way they reject any prose. This must come before the punctuation peeling
  // below, whose closer-counting would otherwise keep the `)` and admit a
  // nonsense candidate wearing the label and the brackets.
  const mdTarget = /\]\(([^)]+)\)(?:[.,;:!?*]+)?$/.exec(token);
  if (mdTarget !== null) {
    const mdStart = token.length - mdTarget[0].length + 2;
    const target = matchCandidate(token, base, mdStart, mdStart + (mdTarget[1]?.length ?? 0));
    if (target !== null) return target;
  }

  // `--output=tmp/a.mp3` — take the value, not the flag. The `=` only counts
  // as an assignment when nothing before it looks like a path, so a file
  // genuinely named `tmp/a=b/c.txt` is left whole rather than being cut at its
  // own equals sign.
  const eq = token.indexOf('=');
  if (eq !== -1 && !token.slice(0, eq).includes('/')) start = eq + 1;

  while (start < end && LEADING_NOISE.has(token.charAt(start))) start++;

  // Tool output often writes `Write(path)` without a space. Treat the
  // function-like wrapper as decoration, but only when the prefix is a plain
  // label and contains no slash. A path's own parenthesised filename remains
  // whole because its prefix already includes the directory slash.
  for (let i = start + 1; i < end; i++) {
    if (!INLINE_OPENERS.has(token.charAt(i))) continue;
    if (!INLINE_PREFIX.test(token.slice(start, i))) continue;
    const inline = matchCandidate(token, base, i + 1, end);
    if (inline !== null) return inline;
  }

  return matchCandidate(token, base, start, end);
}

/** Parse one possible path span inside a token. */
function matchCandidate(
  token: string,
  base: number,
  candidateStart: number,
  tokenEnd: number,
): PathMatch | null {
  const start = candidateStart;
  let end = tokenEnd;

  for (;;) {
    if (end <= start) return null;
    const ch = token.charAt(end - 1);
    if (TRAILING_PUNCT.has(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener !== undefined) {
      const inner = token.slice(start, end - 1);
      if (countChar(inner, opener) <= countChar(inner, ch)) {
        end--;
        continue;
      }
    }
    break;
  }

  let candidate = token.slice(start, end);
  let lineNo: number | undefined;
  let columnNo: number | undefined;
  const suffix = LINE_SUFFIX.exec(candidate);
  if (suffix !== null) {
    candidate = suffix[1] ?? '';
    lineNo = Number(suffix[2]);
    if (suffix[3] !== undefined) columnNo = Number(suffix[3]);
  }

  // A `file://` URL is validated and opened as the path under its scheme,
  // while start/end keep spanning the whole URL: the underline has to cover
  // what the user reads, exactly as it covers a `:12:5` suffix it will not
  // open.
  const path = stripFileScheme(candidate) ?? candidate;
  if (!isPath(path, suffix !== null)) return null;

  const match: PathMatch = { start: base + start, end: base + end, path };
  if (lineNo !== undefined) match.line = lineNo;
  if (columnNo !== undefined) match.column = columnNo;
  return match;
}

/**
 * The actual verdict, given a candidate already stripped of decoration.
 *
 * [hasPosition] is true when the token carried a `:12` / `:12:5` suffix. That
 * suffix is strong evidence: nothing in prose is shaped like `src/main:12`, so
 * it buys the candidate an exemption from the single-slash extension rule that
 * would otherwise throw away every compiler error pointing at an extensionless
 * file.
 */
function isPath(p: string, hasPosition: boolean): boolean {
  if (p.length === 0) return false;

  // A leading dash is a command-line flag, not a name. This does cost us
  // `-I/usr/include`-style compiler arguments, which is a trade worth making:
  // an argument is something the user typed, a path in output is something
  // they want to look at.
  if (p.startsWith('-')) return false;

  // Any colon still here after the `:line:col` suffix was taken off means we
  // are not looking at a single path: `PATH=/usr/bin:/bin` is a list,
  // `alexey@hetzner:/tmp/x` is an scp target, and a timestamp glued to a name
  // is a mis-parse. A colon is legal in a POSIX filename and vanishingly rare
  // in practice, so rejecting is much cheaper than being wrong.
  if (p.includes(':')) return false;

  // THE rule. A name with no slash is indistinguishable from a word, and
  // terminal output is full of words that end in something extension-shaped.
  if (!p.includes('/')) return false;

  if (FORBIDDEN.test(p)) return false;

  // A control character cannot be part of a path we could open, and its
  // presence means the flattening picked up something that is not text.
  if (hasControlChar(p)) return false;

  // `~/x` is our own home and `stripTilde` in remotePaths.ts knows how to
  // resolve it. `~other/x` is somebody else's, which relative resolution would
  // silently get wrong — the same reason `stripTilde` refuses to touch it.
  if (p.startsWith('~') && !p.startsWith('~/')) return false;

  const segments = p.split('/');
  if (segments.some((s) => s.length > MAX_SEGMENT)) return false;

  // Segments that name something, as opposed to `.`, `..` and the empty
  // strings that `/` and `//` split into. With none of them there is no target
  // to open: `/`, `../..` and `./` are rejected here.
  const named = segments.filter((s) => s !== '' && s !== '.' && s !== '..');
  if (named.length === 0) return false;

  // All-numeric segments are counters and dates, not paths: `[3/10]` progress,
  // `2026/08/25`, `9/10`, `24/7`. A real path with only numeric segments
  // exists (`/proc/1234/fd`) but is absolute, and `named` for that includes
  // `proc` and `fd`, so this only fires on the shapes we mean it to.
  if (named.every((s) => NUMERIC_SEGMENT.test(s))) return false;

  const rooted =
    p.startsWith('/') || p.startsWith('~/') || p.startsWith('./') || p.startsWith('../');
  if (rooted) return true;

  const first = segments[0] ?? '';
  if (HOSTNAME_LIKE.test(first)) return false;

  if (!hasPosition && countChar(p, '/') === 1) {
    // One slash, no anchor, no line number: this is where `and/or`, `w/o`,
    // `y/N`, `read/write` and `TODO/FIXME` live. An extension on the last
    // segment (`tmp/preview-1.mp3`) or a trailing slash (`tmp/`) is the
    // evidence required to call it a path anyway.
    const last = segments[segments.length - 1] ?? '';
    if (last !== '' && !HAS_EXTENSION.test(last)) return false;
  }

  return true;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++;
  return n;
}

/**
 * Is [token] a path a continuation row could be glued onto — the join rules'
 * answer to "unambiguously a path SO FAR".
 *
 * The standard it applies is the detector's own, because the two must never
 * disagree about a token the user can already see underlined: a root anchor
 * (`/`, `~/`, `./`, `../`, a `file:///` scheme) or two or more slashes. That
 * last clause is what admits RELATIVE paths — `assets/images/exam/` is the
 * shape agent TUIs print in the commands they echo, and their wraps break
 * mid-token exactly like an absolute path's. One slash stays out: `and/or`,
 * `w/o`, `client/server`, `9/10` are prose, and a prose row ending in one
 * must never pick up the row below it.
 */
export function continuesPath(token: string): boolean {
  const match = matchCandidate(token, 0, 0, token.length);
  if (match === null) return false;
  const p = match.path;
  if (
    p.startsWith('/') ||
    p.startsWith('~/') ||
    p.startsWith('./') ||
    p.startsWith('../')
  ) {
    return true;
  }
  return countChar(p, '/') >= 2;
}
