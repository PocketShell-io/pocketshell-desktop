/**
 * Finding http(s) URLs in a line of terminal output.
 *
 * Pure like terminalPaths.ts, and for the same reason: the only input is a
 * string already flattened out of the buffer, the only output offsets into
 * it. The flattening and the join rules live in terminalLinks.ts — this
 * module is nothing but the verdict on a finished line.
 *
 * Why a second detector when WebLinksAddon has matched web links all along:
 * the addon reads ONE buffer row at a time, so a URL the remote CLI's own
 * wrapper broke across rows reaches it as a fragment — the first row's
 * `https://www.comet.com/opik/` linkifies and opens, and the continuation
 * (`alexey-grigorev/projects/…`) sits plain. The join rules reconstruct the
 * whole line; this detector claims the URL in it. Single-row URLs are left
 * to the addon (the provider in terminalLinks.ts skips them), so everything
 * the addon already did well keeps behaving exactly as before.
 *
 * What counts as a URL is deliberately thinner than the addon's regex: the
 * scheme anchors the match, whitespace ends it, and the same trailing
 * decoration the path detector peels — sentence punctuation, closers with no
 * opener inside — comes off the end. `(https://host/x).` underlines
 * `https://host/x`; `%5B` and friends need no special case, because a
 * percent sign is just a character. The one URL-shaped thing refused outright
 * is a scheme with no authority (`https:///x`) — nothing a click could open.
 */
import { hasControlChar, peelTrailingDecoration } from './terminalPaths';

export interface UrlMatch {
  /** Offset of the first character (`h` of the scheme) within the line. */
  start: number;
  /** Offset one past the last character of the URL, decoration excluded. */
  end: number;
  /** The URL itself: no enclosing parenthesis, no trailing sentence dot. */
  url: string;
}

/** Same budget as terminalPaths.ts: a scan nobody can read anyway. */
const MAX_LINE = 4096;

/**
 * The schemes this app opens. xterm core (OSC 8), WebLinksAddon and main's
 * window-open allow-list all draw the same line: http and https, nothing
 * else — so a `file://` URL stays the path detector's claim and `ssh://`
 * stays nobody's.
 */
const SCHEME = /https?:\/\//g;

/** Every http(s) URL in `line`, left to right. */
export function findUrls(line: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  if (line.length === 0 || line.length > MAX_LINE) return out;

  SCHEME.lastIndex = 0;
  for (let m = SCHEME.exec(line); m !== null; m = SCHEME.exec(line)) {
    const start = m.index;
    // The token runs to the next whitespace — the only boundary terminal
    // output reliably gives, and the one the join rules preserve when they
    // glue a wrapped URL back together.
    let end = start;
    while (end < line.length && !/\s/.test(line.charAt(end))) end++;

    const url = peelTrailingDecoration(line.slice(start, end));
    if (url.length <= m[0].length) continue;
    const authority = url.slice(m[0].length).split('/')[0] ?? '';
    if (authority.length === 0) continue;
    if (hasControlChar(url)) continue;

    out.push({ start, end: start + url.length, url });
    // Scan on past this URL: a query string embedding a second `https://`
    // (`?redirect=https://…`) is ONE address, not two links.
    SCHEME.lastIndex = start + url.length;
  }
  return out;
}
