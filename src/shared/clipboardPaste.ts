/**
 * What a `Ctrl+V` aimed at the PROMPT COMPOSER should do, decided from the
 * clipboard's contents and from nothing else.
 *
 * ## Why this is a module and not four lines inside the component
 *
 * The Ctrl+V-in-the-terminal feature has exactly one interesting decision in
 * it — *is this clipboard worth opening the composer for, and if so, as an
 * attachment or as text?* — and that decision has a nasty failure mode: a
 * clipboard the composer cannot do anything with must leave the screen exactly
 * as it was. An empty composer that pops open because the user copied a chunk
 * of rich-text formatting is worse than nothing happening at all, because the
 * user then has to put it away again.
 *
 * Everything around that decision is unavoidably impure — `navigator.clipboard`
 * needs a permission and a real browser, `getType()` hands back a `Blob`, the
 * staging path talks to SFTP. The decision itself needs none of that: it is a
 * function of the mime types present and whether there is any text. So it lives
 * here, where a test can enumerate every clipboard shape in a few lines instead
 * of building a fake `ClipboardItem` for each one.
 *
 * ## The line between "attach" and "type"
 *
 * `PromptComposer.onPaste` — the handler this feature deliberately reuses
 * rather than reimplementing — draws it by asking the ClipboardEvent for
 * `clipboardData.files`: if the platform materialised files, they become tiles
 * and the paste is cancelled; otherwise the textarea takes the text natively.
 * There is no ClipboardEvent on a synthesised read, so the same line has to be
 * drawn from mime types, and this is where the two definitions are kept
 * honest with each other.
 *
 * BINARY FAMILIES ATTACH: `image/*` (the whole point — a screenshot),
 * `application/*` (PDFs, archives, office documents), `audio/*` and `video/*`
 * (a voice memo is an ordinary thing to hand a coding agent; see the audio
 * block in src/main/attachments/mimeTypes.ts). `text/*` NEVER attaches: the
 * clipboard carries the same content as plain text alongside it, and text in
 * the draft is what the user can actually edit. That single rule is also what
 * disposes of the "unstageable type" case: a rich copy out of a browser carries
 * `text/html` and `text/plain`, so it types; a copy that somehow carries
 * `text/html` and nothing else has no text to type and produces nothing.
 */

/**
 * The clipboard as it looked when it was read, reduced to the two facts the
 * decision needs.
 *
 * Deliberately NOT the `ClipboardItem[]` itself. Holding the real items here
 * would drag a DOM type into a module that both TS projects compile, and would
 * tempt the decision into calling `getType()` — an async read of possibly many
 * megabytes — while it is still deciding whether to do anything at all.
 */
export interface ClipboardSnapshot {
  /**
   * The mime types carried by each item `navigator.clipboard.read()` returned,
   * in its order: one inner array per item. Empty when the read was refused or
   * the API is not there, which is a normal state and not an error.
   */
  items: readonly (readonly string[])[];
  /**
   * What `navigator.clipboard.readText()` gave, or null when it threw or was
   * unavailable. Null and `''` are deliberately distinct in the type even
   * though they lead to the same place — the caller should not have to flatten
   * "refused" into "empty" to build a snapshot.
   */
  text: string | null;
}

/** Which item to ask, and for which type. Both are needed to call `getType`. */
interface ClipboardPick {
  /** Index into {@link ClipboardSnapshot.items}. */
  item: number;
  /**
   * The type string to hand back to `ClipboardItem.getType`, VERBATIM as it
   * appeared in `item.types`. Matching there is exact, so the normalised
   * lower-cased form this module compares against must never escape into it.
   */
  type: string;
}

/** The three outcomes, and there are only three. */
export type ClipboardPasteAction =
  /** Pull these blobs and stage them as attachments. Never empty. */
  | { readonly kind: 'attach'; readonly picks: readonly ClipboardPick[] }
  /** Put this text in the draft at the caret. Never `''`. */
  | { readonly kind: 'draft'; readonly text: string }
  /** Nothing usable. The composer must not open, move, or flicker. */
  | { readonly kind: 'none' };

/**
 * The families that become attachments. `text/` is conspicuously absent and
 * that absence is the rule — see the header.
 */
const STAGEABLE_FAMILIES: readonly string[] = ['image/', 'application/', 'audio/', 'video/'];

/**
 * A mime type reduced to the form worth comparing: no parameters, no case, no
 * surrounding space. `image/png;charset=utf-8` and `IMAGE/PNG` are the same
 * type, and Chromium is not consistent about which spelling it hands back.
 */
export function normaliseClipboardType(type: string): string {
  const semicolon = type.indexOf(';');
  return (semicolon === -1 ? type : type.slice(0, semicolon)).trim().toLowerCase();
}

/**
 * Can the attachment path do anything with this type?
 *
 * The shape test is not pedantry. Chromium's clipboard exposes web custom
 * formats as `web application/x-thing` — a type with a SPACE in it, which is
 * not a mime type and which `getType()` will hand back as an opaque blob that
 * no agent can read. Requiring a well-formed `type/subtype` rejects that whole
 * class without having to know what any particular application invented.
 */
export function isStageableClipboardType(type: string): boolean {
  const normalised = normaliseClipboardType(type);
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+_-]*$/.test(normalised)) return false;
  return STAGEABLE_FAMILIES.some((family) => normalised.startsWith(family));
}

/**
 * The one type worth pulling off a single clipboard item, or null.
 *
 * IMAGES WIN over any other stageable type on the same item, whatever the
 * order `types` came in. A screenshot copied out of an editor can arrive
 * alongside an `application/*` flavour of the same picture; the image is the
 * one that renders as a tile thumbnail and the one every agent can read.
 */
function stageableTypeOf(types: readonly string[]): string | null {
  let fallback: string | null = null;
  for (const type of types) {
    if (!isStageableClipboardType(type)) continue;
    if (normaliseClipboardType(type).startsWith('image/')) return type;
    fallback ??= type;
  }
  return fallback;
}

/**
 * THE decision. Pure, total, and the only place the precedence lives.
 *
 * Attachments beat text, and that ordering matters: a screenshot on the
 * clipboard almost always carries a `text/plain` flavour too (a filename, a
 * URL, an empty string), and staging the picture while ALSO pasting its
 * filename into the draft would be two results for one keystroke. It is the
 * same precedence `onPaste` already applies — files first, and `preventDefault`
 * so the text never lands — expressed against mime types instead of against a
 * `FileList`.
 *
 * Whitespace-only text counts as text, deliberately, even though `isEmpty` in
 * the composer treats a whitespace draft as nothing worth keeping. The two
 * questions are different: that guard asks "may this vanish without telling
 * anyone", while this one asks "did the user ask for something". They pressed
 * the key with spaces on the clipboard; they get spaces.
 */
export function decideClipboardPaste(snapshot: ClipboardSnapshot): ClipboardPasteAction {
  const picks: ClipboardPick[] = [];
  snapshot.items.forEach((types, item) => {
    const type = stageableTypeOf(types);
    if (type !== null) picks.push({ item, type });
  });
  if (picks.length > 0) return { kind: 'attach', picks };

  const { text } = snapshot;
  if (text !== null && text !== '') return { kind: 'draft', text };

  return { kind: 'none' };
}
