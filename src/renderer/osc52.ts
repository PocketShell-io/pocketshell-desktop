/**
 * The receive side of OSC 52 — "set the clipboard" — for the terminal pane.
 *
 * ## Why the pane wants this
 *
 * The pane is a tmux client, and an ALT+drag (plain and Shift+drag select in
 * THIS pane now — terminalMouseSelection.ts) or a tmux keyboard yank
 * (`prefix+[` … `y`) selects in TMUX: tmux paints the highlight, and the
 * gesture's end runs its copy — the drag-end also cancels copy-mode, so the
 * highlight vanishes, which is the vanishing that once read as "my selection
 * disappeared" on the plain path. The text's way out of the remote box is the
 * escape sequence tmux offers the outer terminal (`set-clipboard` defaults to
 * `external`):
 * `ESC ] 52 ; Pc ; Pt BEL`, with Pt the yanked text as base64. Nothing here
 * answered that sequence, so such a yank landed nowhere the user could paste
 * from. This decoder is the answer: TerminalView registers it as an OSC 52
 * handler and writes what it returns to the system clipboard.
 *
 * The same sequence is how ANY remote program (an agent among them) may set
 * the local clipboard. That is the feature and also the risk surface, so the
 * decoder is deliberately narrow: a payload this function refuses is a yank
 * that never happened, not a corrupt one.
 */

/**
 * Cap on the base64 payload, before decoding. Clipboard-shaped text is far
 * below this; the cap exists so a runaway sequence — an agent echoing a
 * megabyte of base64, a broken program looping — cannot balloon the user's
 * clipboard. ~0.75 MiB of decoded text is generous for a yank.
 */
const MAX_PAYLOAD_CHARS = 1_000_000;

/**
 * Decode the data xterm hands the OSC 52 handler — everything between the
 * `52;` identifier and the string terminator, i.e. `Pc ; Pt`.
 *
 * Returns the decoded text, or null when the sequence must not touch the
 * clipboard: malformed, an unknown clipboard selector, over the cap, or an
 * explicit "clear the clipboard" request (empty Pt) — a remote should not be
 * able to blank what the user had there.
 */
export function decodeOsc52SetClipboard(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep === -1) return null;
  const selector = data.slice(0, sep);
  const payload = data.slice(sep + 1);
  // Pc per the spec: `c` (system clipboard), `p` (primary), `s` (cut buffer /
  // selection), `0`..`9` (named), or empty (terminal's default). Anything else
  // is not a clipboard name this terminal offered to write to.
  if (!/^([cps]?|\d{0,4})$/.test(selector)) return null;
  if (payload === '') return null; // "clear the clipboard" — refused, above
  if (payload.length > MAX_PAYLOAD_CHARS) return null;
  let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '='; // padding is optional on the wire
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Non-fatal: remote bytes must not be able to make the pane throw. tmux
  // sends UTF-8; a program that does not just mangles its own copy.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
