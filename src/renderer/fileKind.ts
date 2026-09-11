/**
 * What kind of thing is behind a filename, decided BEFORE its bytes are read.
 *
 * ## Why this exists
 *
 * The Files tab used to have no type gating whatsoever: every click ran
 * `sftp:readFile`, which decodes the whole file as UTF-8 and binds the result
 * to a textarea. Clicking an mp3 therefore decoded several megabytes of
 * binary into replacement characters and asked the renderer to lay them out
 * as one enormous line of text — which is not a slow render, it is a hang.
 * A PDF did the same, and so would a 200 MB log, which is text but is still
 * more of it than a textarea can lay out.
 *
 * So the classifier's real job is a NEGATIVE one: guarantee that nothing but
 * decodable text ever reaches the editor. Everything else routes to a viewer
 * that understands bytes (audio, PDF, image) or to an honest panel that says
 * what the file is and offers to download it. There is deliberately no path
 * from "I could not render this" back to the text editor — a wall of mojibake
 * is a worse answer than a sentence saying the file is binary.
 *
 * ## Two stages, because a filename is a hint and bytes are evidence
 *
 * {@link classifyByName} is the cheap stage and runs first, off the SFTP
 * listing alone. It is enough for the common cases and it is what lets an
 * oversized file be refused without transferring it.
 *
 * {@link classifyBytes} is the second stage, for the extensions the first
 * cannot place — no extension at all (`README`, `Makefile`, `Dockerfile`), or
 * one nobody tabulates. Those get their bytes fetched under the text ceiling
 * and inspected: a magic number first, then a printability sniff. A file with
 * a weird extension that really is text still opens in the editor; a file with
 * a weird extension that is really a zip does not.
 *
 * The mime strings come from src/main/attachments/mimeTypes.ts rather than a
 * table of our own — see the note there about why there is exactly one.
 */

import { extensionOfPath, mimeTypeForExtension } from '../main/attachments/mimeTypes';
import { isMarkdownPath } from '../main/preview/previewPaths';

/** What the Files tab will do with a file. */
export type FileKind =
  /** Decodable text: the editor. */
  | 'text'
  /** `<img>` on a blob URL. */
  | 'image'
  /** `<audio controls>` on a blob URL. */
  | 'audio'
  /** Chromium's PDF viewer, via `<embed>` on a blob URL. */
  | 'pdf'
  /**
   * A web page: BOTH a rendered preview in a sandboxed frame and the editor.
   *
   * The only kind with two presentations, and it is not a special case for its
   * own sake. HTML is text — it edits and saves exactly like any other source
   * file, and losing that would be a regression, since a file browser with an
   * editor in it is where people fix a typo in a page. But it is also the one
   * text format whose whole point is what it looks like when a browser runs
   * it, and reading `<div class="wrapper">` is a poor substitute for that.
   * So `html` gets a toggle rather than a choice made for it. See
   * src/renderer/views/FilesView.vue for which side is the default and why,
   * and src/main/preview/HtmlPreviewService.ts for what the preview may and
   * may not do.
   */
  | 'html'
  /**
   * A markdown document: the same two presentations `html` gets, for the same
   * reason and through the same pipeline.
   *
   * Markdown is source AND a document, which is exactly the shape that earned
   * HTML its toggle. It is a separate kind rather than a flag on `html`
   * because the two are converted differently — an HTML file is served to the
   * frame byte-for-byte, a markdown file is rendered in main first (see
   * src/main/preview/markdownDocument.ts) — and because a `.md` must keep
   * opening in the editor with markdown highlighting when the user picks
   * Source, which a mode called `html` would have quietly broken.
   */
  | 'markdown'
  /**
   * An SVG document: the same two presentations `html` and `markdown` get,
   * served through the same pipeline.
   *
   * SVG is text AND a picture, which is the exact shape that earned HTML its
   * toggle. It is its own kind rather than a flavour of `html` because the
   * bytes are served at their own content type (`image/svg+xml`, as a
   * drawing, not as a page) and because the source half must keep opening
   * with XML highlighting — an `.svg` called HTML would quietly lose both.
   * Rendered as a document an SVG can carry `<script>` and remote
   * references, so it travels under exactly the same sandbox and CSP as a
   * page; see src/main/preview/HtmlPreviewService.ts.
   */
  | 'svg'
  /** Opaque bytes: the binary panel, with a download button. */
  | 'binary'
  /** Not placeable from the name alone — sniff the bytes. */
  | 'unknown';

export interface FileClass {
  kind: FileKind;
  /** Canonical mime type, or null when the name said nothing. */
  mime: string | null;
}

/** How the open file is being presented. */
export type OpenMode = FileKind;

/**
 * Kinds that have an editor behind them and can therefore be saved.
 *
 * One predicate rather than an `=== 'text'` at each site, because there are
 * four of them — the Save button, the Ctrl+S chord, the store's `save()` and
 * the dirty-buffer stash — and HTML becoming editable meant every one had to
 * learn the same new fact. Three out of four would have been a Save button
 * that works and a Ctrl+S that does nothing, which is precisely the kind of
 * half-regression the brief warned about.
 */
export function isEditable(mode: OpenMode | null): boolean {
  return mode === 'text' || mode === 'html' || mode === 'markdown' || mode === 'svg';
}

/**
 * Kinds shown as BOTH a render and their source.
 *
 * The trio `html`, `markdown` and `svg` is not a coincidence: these are the
 * formats whose whole point is what they look like when something renders
 * them, and which are still ordinary text files that a person opens a file
 * browser to fix a typo in. Everything else is one or the other. (This
 * comment used to claim the pair was "not likely to grow"; SVG proved the
 * shape — text source, visual render, renderable with no code of its own
 * run — is the definition of the set, and it joined through the same door.)
 */
export function hasPreview(mode: OpenMode | null): boolean {
  return mode === 'html' || mode === 'markdown' || mode === 'svg';
}

/**
 * Extensions that are text even though nothing in the mime table says so.
 *
 * This list is the reason the classifier does not simply ask "does the mime
 * table start this with `text/`": source code, config and log files are the
 * overwhelming majority of what anyone opens in this tab, and almost none of
 * them have a registered `text/*` type. `.ts` is the sharp example — the mime
 * table maps it to `application/typescript`, and a rule keyed on `text/`
 * would have sent every TypeScript file in the repo to the binary panel.
 *
 * Anything missing here is not lost: it falls to `unknown` and gets sniffed,
 * which reaches the same answer one round trip later. The list is a shortcut,
 * not the definition of text.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'text', 'rst', 'adoc', 'org',
  'log', 'out', 'err', 'diff', 'patch',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'csv', 'tsv',
  'xml', 'css', 'scss', 'sass', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  // `.mdx` is JSX inside markdown — source for a page, the way `.vue` beside
  // it is, so it edits rather than previews. Listed explicitly now that
  // `md`/`markdown` have moved out of this set: without it an `.mdx` would
  // fall to `unknown` and pay a sniff to reach the answer this line gives.
  'mdx',
  'py', 'pyi', 'rb', 'php', 'pl', 'pm', 'lua', 'r',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'swift',
  'cs', 'fs', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'ml', 'zig', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'tf', 'tfvars', 'hcl',
  'gitignore', 'gitattributes', 'editorconfig', 'dockerignore', 'lock',
]);

/**
 * Basenames with no extension that are text by convention. Kept short on
 * purpose: everything else with no extension is sniffed, which is correct and
 * costs one read the user asked for anyway.
 */
const TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'readme', 'license', 'licence', 'copying', 'notice', 'authors', 'changelog',
  'makefile', 'dockerfile', 'jenkinsfile', 'procfile', 'vagrantfile', 'rakefile', 'gemfile',
  'todo', 'install', 'news', 'contributing', 'codeowners',
]);

/**
 * Extensions that are definitely opaque bytes. Listing them matters: without
 * it a `.zip` would fall to `unknown` and get its (possibly large) bytes
 * dragged across the wire only to be refused. Naming them refuses on the
 * listing alone.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'tar', '7z', 'rar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'pyo', 'wasm',
  'db', 'sqlite', 'sqlite3', 'mdb', 'dat', 'idx', 'pack',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'm4v',
  'iso', 'img', 'dmg', 'deb', 'rpm', 'apk',
]);

/**
 * Extensions routed to the HTML preview.
 *
 * Kept OUT of {@link TEXT_EXTENSIONS} above rather than merely checked before
 * it, so there is exactly one place that says what an `.html` is. A duplicate
 * entry in both sets would still work today — the html check below runs first
 * — but it would silently become a bug the moment someone reorders the arms,
 * and the reorder would look harmless.
 *
 * `.xhtml` is included because Chromium renders it and the editor edits it,
 * which is the whole contract of this kind. Anything more exotic that happens
 * to contain markup (`.jsp`, `.erb`, `.hbs`, a `.php` template) is NOT here
 * and stays plain text: those are SOURCE for a page rather than a page, and
 * previewing one shows a broken document full of unexecuted directives, which
 * is a worse answer than showing the source the user can actually reason
 * about.
 */
const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml']);

/**
 * Markdown is decided by {@link isMarkdownPath}, imported rather than restated.
 *
 * The request handler in main decides which served paths it renders as
 * markdown; a second list here that drifted by one extension would mean a file
 * the tab opens with a Preview tab that main then serves as plain text. One
 * list, one owner — the same argument HTML_EXTENSIONS makes one paragraph up,
 * applied across the process boundary. `md` and `markdown` are removed from
 * {@link TEXT_EXTENSIONS} above for exactly that reason.
 */

/** Image extensions a `<img>` on a blob URL can actually paint. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
]);

/**
 * Audio extensions.
 */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'wave', 'aiff', 'aif',
  'wma', 'weba', 'spx',
]);

/** Classify from the filename alone. Never reads anything. */
export function classifyByName(path: string): FileClass {
  const base = (path.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  const ext = extensionOfPath(path);

  if (ext == null) {
    // `.bashrc`, `.gitconfig` and friends: a leading dot is not an extension,
    // and dotfiles are text essentially without exception.
    if (base.startsWith('.') && base.length > 1) return { kind: 'text', mime: 'text/plain' };
    if (TEXT_BASENAMES.has(base)) return { kind: 'text', mime: 'text/plain' };
    return { kind: 'unknown', mime: null };
  }

  const mime = mimeTypeForExtension(ext);
  if (ext === 'pdf') return { kind: 'pdf', mime: mime ?? 'application/pdf' };
  if (HTML_EXTENSIONS.has(ext)) return { kind: 'html', mime: mime ?? 'text/html' };
  // Before the text set, for the same ordering reason `html` is: an `.svg`
  // is XML and would be a perfectly serviceable member of TEXT_EXTENSIONS —
  // it was one for a long time. What it has that a stylesheet does not is a
  // second presentation, so it gets the toggle rather than the editor alone;
  // the editor half of that toggle is what the old text-only answer was, one
  // click away instead of the only answer.
  if (ext === 'svg') return { kind: 'svg', mime: mime ?? 'image/svg+xml' };
  if (isMarkdownPath(path)) return { kind: 'markdown', mime: mime ?? 'text/markdown' };
  if (AUDIO_EXTENSIONS.has(ext)) return { kind: 'audio', mime: mime ?? 'audio/mpeg' };
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', mime: mime ?? 'image/png' };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text', mime: mime ?? 'text/plain' };
  if (BINARY_EXTENSIONS.has(ext)) return { kind: 'binary', mime };
  // A name we cannot place. `unknown`, not `text` — falling through to the
  // editor is exactly the bug this module exists to prevent.
  return { kind: 'unknown', mime };
}

/** One magic-number signature: bytes to match at `offset`. */
interface Signature {
  offset: number;
  bytes: readonly number[];
  kind: FileKind;
  mime: string;
}

/**
 * Magic numbers for the formats the tab can actually RENDER, plus the
 * container formats most likely to be mistaken for text.
 *
 * Only these: a general-purpose `file(1)` table would be a lot of code for no
 * behavioural difference, because anything unrecognised here still gets the
 * printability sniff below and still lands in the binary panel if it fails.
 * What a signature buys is the difference between "binary" and "binary that
 * I can play", which only matters for the renderable kinds.
 */
const SIGNATURES: readonly Signature[] = [
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], kind: 'pdf', mime: 'application/pdf' }, // %PDF
  { offset: 0, bytes: [0x49, 0x44, 0x33], kind: 'audio', mime: 'audio/mpeg' }, // ID3 tag
  { offset: 0, bytes: [0xff, 0xfb], kind: 'audio', mime: 'audio/mpeg' }, // MPEG-1 layer 3 frame
  { offset: 0, bytes: [0xff, 0xf3], kind: 'audio', mime: 'audio/mpeg' },
  { offset: 0, bytes: [0xff, 0xf2], kind: 'audio', mime: 'audio/mpeg' },
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43], kind: 'audio', mime: 'audio/flac' }, // fLaC
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], kind: 'audio', mime: 'audio/ogg' }, // OggS
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], kind: 'image', mime: 'image/png' },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], kind: 'image', mime: 'image/jpeg' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], kind: 'image', mime: 'image/gif' }, // GIF8
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], kind: 'binary', mime: 'application/zip' },
  { offset: 0, bytes: [0x1f, 0x8b], kind: 'binary', mime: 'application/gzip' },
  { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], kind: 'binary', mime: 'application/x-elf' },
];

/** RIFF containers carry their real type at byte 8 (`WAVE`, `WEBP`). */
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;

function matches(bytes: Uint8Array, sig: { offset: number; bytes: readonly number[] }): boolean {
  if (bytes.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => bytes[sig.offset + i] === b);
}

/** The kind a magic number proves, or null when no signature matched. */
export function magicKind(bytes: Uint8Array): FileClass | null {
  if (matches(bytes, { offset: 0, bytes: RIFF })) {
    if (matches(bytes, { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] })) {
      return { kind: 'audio', mime: 'audio/wav' };
    }
    if (matches(bytes, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] })) {
      return { kind: 'image', mime: 'image/webp' };
    }
    return { kind: 'binary', mime: null };
  }
  // ISO-BMFF (`....ftyp`) covers m4a/m4b as well as mp4 video. The brand at
  // byte 8 separates them: `M4A`/`M4B` are audio, everything else is not
  // something this tab renders.
  if (matches(bytes, { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] })) {
    const brand = String.fromCharCode(...Array.from(bytes.slice(8, 12)));
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) {
      return { kind: 'audio', mime: 'audio/mp4' };
    }
    return { kind: 'binary', mime: null };
  }
  for (const sig of SIGNATURES) {
    if (matches(bytes, sig)) return { kind: sig.kind, mime: sig.mime };
  }
  return null;
}

/** How much of a file the printability sniff looks at. */
const SNIFF_WINDOW = 4096;

/**
 * Does this look like text a textarea can hold?
 *
 * Three tests, cheapest first, and all three have to pass:
 *
 *  1. No NUL byte. One NUL in the first few KiB is the classic `file(1)`
 *     binary test and is on its own conclusive.
 *  2. Under 10% "wild" control bytes. Tab, newline, carriage return, form
 *     feed, backspace and ESC are all normal in real logs and terminal
 *     captures; the rest of C0 is not.
 *  3. Valid UTF-8 over the sniff window. This is the test that catches the
 *     files the first two miss — an mp3 body is mostly high bytes with few
 *     NULs — and it is run last because it is the only one that allocates.
 *
 * A UTF-8 sequence straddling the end of the window would fail (3) spuriously,
 * so the decoder runs in streaming mode, which tolerates a truncated tail.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, SNIFF_WINDOW);
  if (window.length === 0) return true; // an empty file is a fine empty buffer
  let wild = 0;
  for (const b of window) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x08 && b !== 0x1b) {
      wild++;
    }
  }
  if (wild / window.length > 0.1) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Second-stage classification, once bytes are in hand.
 *
 * `named` is what {@link classifyByName} concluded, and it WINS whenever it
 * was decisive — the extension is the user's own statement of intent, and a
 * `.mp3` whose header we do not recognise is still an mp3 the browser may
 * well play. The bytes only get to decide the `unknown` case, and only ever
 * downwards: the outcome here is `text` when the bytes read as text and one
 * of the concrete kinds otherwise. There is no arm that returns `text` for
 * bytes that failed the sniff.
 */
export function classifyBytes(named: FileClass, bytes: Uint8Array): FileClass {
  if (named.kind !== 'unknown') return named;
  const magic = magicKind(bytes);
  if (magic) return magic;
  if (looksLikeText(bytes)) return { kind: 'text', mime: named.mime ?? 'text/plain' };
  return { kind: 'binary', mime: named.mime };
}

/** Human label for a kind, used by the binary panel. */
export function describeKind(cls: FileClass): string {
  if (cls.mime) return cls.mime;
  switch (cls.kind) {
    case 'binary':
      return 'binary file';
    default:
      return 'unknown file type';
  }
}
