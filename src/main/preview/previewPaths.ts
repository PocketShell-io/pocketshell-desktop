/**
 * URL <-> remote-path arithmetic for the HTML preview, with no Electron and no
 * SFTP in it, so the part that decides "may this page read that file" can be
 * tested exhaustively as a pure function.
 *
 * ## Why any of this exists
 *
 * The Files tab previews a remote HTML document by serving it — and everything
 * it asks for — from a custom `psview:` scheme registered in main (see
 * HtmlPreviewService). That is what gives the frame a real base URL, so a
 * `<link href="style.css">` inside the page resolves by itself and comes back
 * to us as another request for another remote path.
 *
 * Which means the previewed document — bytes off an untrusted remote host —
 * gets to NAME PATHS THAT THE APP THEN READS OVER SFTP. That is a path
 * traversal boundary of exactly the kind LocalFileReader's header argues
 * about, and it is the reason the resolution below is written as a separate,
 * pure, over-tested module rather than three lines inside a request handler.
 * The rule it enforces is: every path a preview may read is inside ONE
 * directory, given per preview, after normalisation — the previewed file's
 * own for HTML and SVG, `/` (the host) for markdown, whose widening is
 * argued where it is decided, in HtmlPreviewService's mint. Whichever width
 * is chosen, every check here still runs.
 *
 * ## Normalising ourselves rather than trusting the URL parser
 *
 * Chromium DOES fold `..` out of a standard-scheme URL before the request
 * reaches main, so by the time we see it `psview://tok/a/../../etc/passwd` has
 * usually already become `psview://tok/etc/passwd`. That is a convenience, not
 * a guarantee, and it is not the only encoding in play: a percent-encoded
 * `%2e%2e` is not a path segment to the URL parser but decodes to one, and a
 * caller inside main (a future feature, a test) may hand us a raw string that
 * never went near a browser at all. So the sequence here is always the same
 * and never shortcut: decode ONCE, then fold, then check containment.
 *
 * Decoding exactly once matters in both directions. Decoding zero times would
 * let `%2e%2e%2fetc` through as a literal filename that SFTP would then
 * interpret; decoding twice would make `%252e%252e` — which is the literal
 * two-character filename `%2e%2e` on the host — into a traversal. One pass is
 * what the URL spec says the path means, so one pass is what we do.
 *
 * Symlinks are NOT handled here, because they cannot be: a symlink is a fact
 * about the remote filesystem and this module knows only strings. The service
 * closes that hole by re-resolving each accepted path with `realpath` on the
 * host and running {@link containedIn} a SECOND time against the answer. Both
 * checks are needed — this one refuses a path that spells its way out, that
 * one refuses a path that walks out through a link.
 */

/** The scheme the preview is served on. One word, lowercase: it becomes a URL host prefix. */
export const PREVIEW_SCHEME = 'psview';

/** Why a request was refused, in the shape the handler turns into a status code. */
export type PreviewPathError =
  /** The URL did not parse, or its path was not absolute / contained a NUL. */
  | 'malformed'
  /** It parsed and normalised fine, but lands outside the preview's root. */
  | 'outside-root';

export type PreviewPathResult =
  | { ok: true; path: string }
  | { ok: false; error: PreviewPathError };

/**
 * Fold `.` and `..` out of an absolute POSIX path.
 *
 * Returns null for anything that is not a path we are willing to reason
 * about: a relative path (there is no base to resolve it against here — the
 * caller always has an absolute one), a path containing a NUL (which C-string
 * APIs on the far side would truncate at, so `/safe\0/../../etc` is a real
 * technique), or one that climbs above `/`.
 *
 * Climbing above `/` is refused rather than clamped to `/`. Clamping is what
 * most implementations do and it is what makes `../../../../etc/passwd`
 * silently become `/etc/passwd` — a path that then has to be caught by the
 * containment check alone. Refusing outright means a request that TRIED to
 * escape is an error at the first opportunity, whatever the containment check
 * would have said about where it landed.
 *
 * A backslash is an ordinary filename character: the remote is always POSIX
 * (the Files tab says so throughout), so treating `\` as a separator here
 * would corrupt legal filenames without buying any safety.
 */
export function normalisePosixPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  if (path.includes('\0')) return null;
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return '/' + out.join('/');
}

/**
 * Is `path` at or beneath `root`?
 *
 * Both are expected to be already normalised. The separator is appended to the
 * root before the prefix test, which is the whole point of not writing this
 * inline: a bare `startsWith` says `/home/alexey-secrets` is inside
 * `/home/alexey`, and that is the classic form of this bug.
 */
export function containedIn(root: string, path: string): boolean {
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  if (path === base) return true;
  return path.startsWith(base === '/' ? '/' : base + '/');
}

/**
 * Percent-decode a URL path component exactly once, or null if it is not
 * valid encoding.
 *
 * A malformed escape (`%zz`, a truncated `%4`) throws in `decodeURIComponent`,
 * and that throw is the right answer: it means the string was not produced by
 * a URL serialiser, so we have no idea what it was meant to say.
 */
function decodeOnce(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * The remote path a `psview:` request is asking for, or why it is refused.
 *
 * [rawUrl] is the request URL exactly as the network stack handed it over, so
 * it still carries its query and fragment. Both are dropped: the query is the
 * preview's own cache-buster and never part of the filename, and a fragment
 * never reaches the server anyway.
 *
 * `URL` is used rather than a hand-rolled split because `psview:` is a
 * "standard" scheme (registered as such, which is what makes relative
 * resolution work in the frame at all) and so has real host/path semantics
 * that the parser already implements — including the `//host` form and the
 * rules about which characters terminate the path.
 */
export function resolveRequestPath(rawUrl: string, root: string): PreviewPathResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const decoded = decodeOnce(parsed.pathname);
  if (decoded == null) return { ok: false, error: 'malformed' };
  const normalised = normalisePosixPath(decoded);
  if (normalised == null) return { ok: false, error: 'malformed' };
  if (!containedIn(root, normalised)) return { ok: false, error: 'outside-root' };
  return { ok: true, path: normalised };
}

/** The token (URL host) a `psview:` request names, or null if it has none. */
export function tokenOfUrl(rawUrl: string): string | null {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    if (protocol !== `${PREVIEW_SCHEME}:`) return null;
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * Build the URL for a preview of `path` under `token`.
 *
 * Each segment is percent-encoded on its own so that a `?`, `#` or space in a
 * remote filename cannot change the shape of the URL — encoding the whole path
 * in one call would leave the separators intact but also leave `?` intact,
 * which would turn the rest of the filename into a query string.
 */
export function previewUrlFor(token: string, path: string): string {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${PREVIEW_SCHEME}://${token}${encoded}`;
}

/** The containing directory of an absolute POSIX path; `/` is its own parent. */
export function parentDirOf(path: string): string {
  const cut = path.replace(/\/[^/]+$/, '');
  return cut === '' ? '/' : cut;
}

/**
 * Extensions the Files tab previews as markdown.
 *
 * This set lives HERE, in the dependency-free half of the preview code, rather
 * than beside the converter — and the reason is a real one rather than tidiness.
 * The renderer's classifier (src/renderer/fileKind.ts) has to agree with the
 * request handler about which files are markdown, or the tab offers a Preview
 * tab for a file the handler then serves as plain text. So the two share one
 * list. But `markdownDocument.ts` imports `marked`, and importing that list
 * from there would drag a 45 KB parser into the renderer bundle to answer a
 * question about a filename — which is precisely the cost this feature avoids
 * by converting in main. This module imports nothing at all, so the renderer
 * can share it for free, exactly as it already shares `mimeTypes.ts`.
 *
 * `.mdx` is deliberately absent for the reason `.jsp` and `.erb` are absent
 * from the HTML set: it is JSX embedded in markdown, so it is SOURCE for a page
 * rather than a page, and rendering it would show a document full of
 * unevaluated components. `.rst`, `.adoc` and `.org` are absent because they
 * are different formats that a markdown parser would mangle into
 * plausible-looking nonsense — they stay plain text, which is honest.
 */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdtext',
]);

/**
 * Does this path name a file the markdown converter should render?
 *
 * A leading dot is not an extension (`.markdown` is a dotfile named
 * `markdown`), which is the same rule `classifyByName` applies and the reason
 * the index test is `> 0` rather than `>= 0`.
 */
export function isMarkdownPath(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return MARKDOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}
