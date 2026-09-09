/**
 * Filename sanitiser for staged prompt attachments.
 *
 * Ported faithfully from the Android app's
 * `share/FilenameSanitiser.kt` (issue #138). The Android share intent
 * hands us a display name supplied by the source app; on desktop the
 * equivalent inputs are a clipboard item's suggested name and the
 * basename of a file the user picked. Both can contain path traversal
 * segments (`../`), null bytes, control characters, leading dots, or be
 * absurdly long. Before we land the file under
 * `~/.pocketshell/attachments/<scope>/` we massage that name into
 * something safe-on-disk on a Unix remote and reasonable to display.
 *
 * The rules are intentionally narrow — the goal is not a perfect
 * portable-POSIX filename, only that the result cannot escape the
 * attachments directory and stays under common filename length limits.
 *
 * Rules (in order):
 *
 * 1. Strip directory components — keep only the basename (anything
 *    after the last `/` or `\`). This removes `../` traversal attempts
 *    structurally; rule 5 mops up leftover dot-runs.
 * 2. Collapse whitespace runs to a single `_` BEFORE stripping control
 *    characters, so `foo\nbar` becomes the readable `foo_bar` rather
 *    than `foobar`.
 * 3. Strip null bytes and remaining control characters (< 0x20, 0x7F).
 * 4. Split stem/extension on the LAST dot. A dot at index 0
 *    (`.bashrc`) or at the end (`foo.`) means "no extension".
 * 5. Allow-list `[A-Za-z0-9._-]` plus non-ASCII letters/digits;
 *    everything else becomes `_`. Then collapse `_+` and trim leading
 *    and trailing `_ . -`.
 * 6. A stem that collapsed to empty or a pure dot-run falls back to
 *    {@link DEFAULT_NAME}.
 * 7. Cap the extension at {@link MAX_EXT_LENGTH} and the whole name at
 *    {@link MAX_LENGTH}, preserving the extension and trimming the stem.
 */

/**
 * Maximum sanitised filename length. Most Linux filesystems allow 255
 * bytes for a filename; we leave headroom for the
 * `<timestamp>-<NN>-` prefix the caller prepends.
 */
export const MAX_LENGTH = 200;

/** Fallback stem when the input sanitises to empty. */
export const DEFAULT_NAME = 'shared';

/**
 * Extension length cap. SFTP does not care, but absurdly long
 * extensions (the kind a malicious sender might craft to push the file
 * past readable lengths) are noise.
 */
const MAX_EXT_LENGTH = 16;

/**
 * Sanitised representation of a filename. `base` is the stem (no dot),
 * `ext` is the extension without its leading dot (may be empty).
 */
export interface SanitisedName {
  base: string;
  ext: string;
}

/** Render as a single filename string, dotted only when `ext` is non-empty. */
export function renderSanitised(name: SanitisedName): string {
  return name.ext === '' ? name.base : `${name.base}.${name.ext}`;
}

/**
 * Sanitise `input` for use as the name portion of the
 * `<timestamp>-<NN>-<name>` pattern. Defensive against null bytes, path
 * traversal, control characters, and absurd lengths.
 *
 * When `defaultExtension` is non-null it is applied only when `input`
 * has no extension of its own. That is how a clipboard paste (bytes
 * with a mime type but no usable filename) still lands as `.png`,
 * while an uploaded `report.pdf` keeps its own extension.
 */
export function sanitiseFilename(
  input: string | null | undefined,
  defaultExtension?: string | null,
): SanitisedName {
  const raw = input ?? '';

  // 1. Keep only the basename — strip everything up to the last path
  //    separator (forward or back slash). This neutralises
  //    `../etc/passwd` style payloads at the structural level.
  const basename = afterLast(afterLast(raw, '/'), '\\');

  // 2. Normalise whitespace runs (including tab / newline / CR, which
  //    are control characters but carry semantic separation we want to
  //    keep as `_`) to a single underscore BEFORE stripping the
  //    remaining control bytes.
  const whitespaceCollapsed = basename.replace(/\s+/g, '_');

  // 3. Strip null bytes + ASCII control characters that were not
  //    consumed by the whitespace pass (0x00..0x1F and 0x7F).
  let noControl = '';
  for (const ch of whitespaceCollapsed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) noControl += ch;
  }

  // 4. Split stem / extension before character substitution so dots
  //    inside the stem are not treated as extension separators. The
  //    LAST dot is the marker; a leading-dot filename like `.bashrc`
  //    therefore has stem `bashrc` and no extension (the leading dot is
  //    dropped by the trim in sanitiseSegment).
  const dotIndex = noControl.lastIndexOf('.');
  let rawStem: string;
  let rawExt: string;
  if (dotIndex <= 0 || dotIndex === noControl.length - 1) {
    rawStem = trimChars(noControl, '.');
    rawExt = '';
  } else {
    rawStem = noControl.slice(0, dotIndex);
    rawExt = noControl.slice(dotIndex + 1);
  }

  const cleanStem = sanitiseSegment(rawStem);
  const cleanExt = sanitiseSegment(rawExt).slice(0, MAX_EXT_LENGTH);

  // 5. Resolve dot-run / empty edge cases.
  const safeStem =
    cleanStem === '' || /^\.+$/.test(cleanStem) ? DEFAULT_NAME : cleanStem;

  let resolvedExt: string;
  if (cleanExt !== '') {
    resolvedExt = cleanExt;
  } else if (defaultExtension != null) {
    resolvedExt = sanitiseSegment(defaultExtension).slice(0, MAX_EXT_LENGTH);
  } else {
    resolvedExt = '';
  }

  // 6. Length cap. Keep the extension and trim the stem.
  const extOverhead = resolvedExt === '' ? 0 : resolvedExt.length + 1;
  const maxStem = Math.max(MAX_LENGTH - extOverhead, 1);
  const cappedStem = safeStem.length > maxStem ? safeStem.slice(0, maxStem) : safeStem;

  return { base: cappedStem, ext: resolvedExt };
}

/**
 * Compose `<timestamp>-<sanitised>` from a {@link SanitisedName}. The
 * timestamp is supplied by the caller (production uses
 * `yyyyMMdd-HHmmss`; tests inject a fixed value for determinism).
 *
 * The attachment stager uses the indexed
 * {@link composeAttachmentName} variant instead; this plain form
 * mirrors the Android share-target path and is kept for parity.
 */
export function composeRemoteName(timestamp: string, sanitised: SanitisedName): string {
  return `${timestamp}-${renderSanitised(sanitised)}`;
}

/**
 * Apply the character allow-list + underscore-collapse + trim to a
 * single path segment (stem or extension). Pulled out so the same rules
 * apply on both sides of the extension split.
 */
function sanitiseSegment(segment: string): string {
  // Iterate by code point rather than UTF-16 unit (Kotlin's `Char`)
  // so a supplementary-plane letter survives as one character instead
  // of two lone surrogates; after the `_+` collapse below the two
  // behaviours are indistinguishable for non-letters anyway.
  let mapped = '';
  for (const ch of segment) {
    if (isAllowed(ch)) mapped += ch;
    else mapped += '_';
  }

  // Collapse `_+` to a single `_`. Avoids "report (final).docx" turning
  // into `report__final__.docx`.
  const collapsed = mapped.replace(/_+/g, '_');

  // Trim leading + trailing separators so we never emit `_foo_.txt` or
  // `-foo-.txt`. Dots are trimmed too: a leading dot would make the
  // file hidden on the remote and a trailing dot is awkward to chain
  // with the extension marker.
  return trimChars(collapsed, '_.-');
}

function isAllowed(ch: string): boolean {
  if (ch >= 'A' && ch <= 'Z') return true;
  if (ch >= 'a' && ch <= 'z') return true;
  if (ch >= '0' && ch <= '9') return true;
  if (ch === '.' || ch === '_' || ch === '-') return true;
  // Allow non-ASCII letters and digits so Unicode names (Cyrillic, CJK,
  // accented Latin) survive instead of collapsing to a row of
  // underscores.
  const code = ch.codePointAt(0) ?? 0;
  return code > 0x7f && /[\p{L}\p{N}]/u.test(ch);
}

/** Substring after the last occurrence of `sep`, or the whole string. */
function afterLast(value: string, sep: string): string {
  const idx = value.lastIndexOf(sep);
  return idx === -1 ? value : value.slice(idx + 1);
}

/** Trim every leading/trailing character that appears in `chars`. */
function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start]!)) start++;
  while (end > start && chars.includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}
