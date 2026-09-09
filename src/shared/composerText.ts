/**
 * Pure text helpers for the prompt composer.
 *
 * Every function here is a behaviour-for-behaviour port of a piece of Kotlin
 * from the Android client, cited per function. They are the parts of the
 * composer with unit-test-grade contracts, so they live outside the component
 * and outside the store and are tested directly (tests/unit/composerText.test.ts).
 *
 * 
 */

/**
 * Android: `PromptComposerViewModel.appendAttachmentPaths` (:2645-2660).
 *
 * The staged remote paths are appended at the END of the draft — never
 * prepended — as an `Attached files:` header followed by one `- <path>` line
 * per attachment, separated from the user's text by exactly one blank line.
 *
 * A blank draft (whitespace-only counts, matching Kotlin's `isBlank()`) is
 * REPLACED by the block, which is what makes an attachment-only send legal.
 *
 * This runs once, at send time only. Attaching never mutates the draft.
 */
export function appendAttachmentPaths(draft: string, paths: readonly string[]): string {
  if (paths.length === 0) return draft;
  const block = 'Attached files:' + paths.map((p) => `\n- ${p}`).join('');
  if (draft.trim() === '') return block;
  if (draft.endsWith('\n\n')) return draft + block;
  if (draft.endsWith('\n')) return draft + '\n' + block;
  return draft + '\n\n' + block;
}

/**
 * Android: `SlashCommandAutocomplete.slashQueryFor` (:47-61).
 *
 * `null` means the dropdown is CLOSED. It opens only while the draft's leading
 * token starts with `/` AND the caret sits within that token — so typing a
 * space and moving on to the argument closes it. A bare `/` yields `''`, which
 * shows the whole catalog.
 */
export function slashQueryFor(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const ws = text.search(/\s/);
  const tokenEnd = ws < 0 ? text.length : ws;
  if (caret < 0 || caret > tokenEnd) return null;
  return text.slice(1, tokenEnd);
}

/**
 * Android: `SlashCommandAutocomplete.insertCommandText` (:94-105).
 *
 * Replaces the leading slash token if there is one, otherwise prepends;
 * preserves any trailing text. Returns `[newText, newCaret]`, the caret landing
 * at the end of the inserted command.
 */
export function insertCommandText(text: string, commandText: string): [string, number] {
  let tokenEnd = 0;
  if (text.startsWith('/')) {
    const ws = text.search(/\s/);
    tokenEnd = ws < 0 ? text.length : ws;
  }
  return [commandText + text.slice(tokenEnd), commandText.length];
}

/**
 * Android: `PromptComposerViewModel.attachmentDisplayName` (:2675-2679).
 * A tile shows the file name, never the full remote path.
 */
export function attachmentDisplayName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg.trim() === '' ? remotePath : seg;
}

/**
 * Android: `PromptComposerViewModel.seedDraftPrompt` (:482-497) separator rule.
 * Appends `prompt` to `draft` on its own line, collapsing the separator when
 * the draft is empty or already ends in a newline.
 */
export function appendSeededPrompt(draft: string, prompt: string): string {
  if (draft.trim() === '') return prompt;
  if (draft.endsWith('\n')) return draft + prompt;
  return draft + '\n' + prompt;
}

/** User-facing strings, copied verbatim from the Android client. */
export const COMPOSER_STRINGS = {
  placeholder: 'Compose prompt…',
  notSent: 'Not sent. Reconnect, then send again or discard the draft.',
  connectionLost: 'Connection lost — Send will retry once reconnected.',
  /** `PromptComposerViewModel.kt:2687` — `<detail>` is the stager's own text. */
  attachmentFailed: (detail: string): string =>
    `Attachment upload failed: ${detail}. Your draft was kept; reconnect or choose a smaller/readable file.`,
  /** `PromptComposerSheet.kt:1010` */
  uploading: (n: number): string => `Uploading ${n} attachment(s)...`,
} as const;

/**
 * The fixed open/close toggle, which is ONE control in two states rather than
 * two controls in two places.
 *
 * The chevron points the way the panel will travel — down to put it away, up
 * to bring it back — which is the whole of the affordance: the user aims at
 * one unmoving spot and it alternates. Keeping that mapping here rather than in
 * the template is what lets a test pin it.
 *
 * `unsent` is the answer to "is there anything waiting in there?", which the
 * collapsed control has to give without opening. It used to be given by a strip
 * showing the draft's first line; now that the composer floats over the
 * terminal, that strip was the most intrusive thing on screen at rest, so the
 * answer moved into the copy and a pip on the icon. It only applies while the
 * panel is CLOSED — open, the draft is right there to read.
 */
export function railToggle(
  open: boolean,
  unsent = false,
): {
  icon: 'chevron-up' | 'chevron-down';
  title: string;
  label: string;
  unsent: boolean;
} {
  if (open) {
    return {
      icon: 'chevron-down',
      title: 'Hide the prompt panel (Ctrl+`)',
      label: 'Hide the prompt panel',
      unsent: false,
    };
  }
  return {
    icon: 'chevron-up',
    title: unsent
      ? 'Open the prompt panel — unsent draft (Ctrl+`)'
      : 'Open the prompt panel (Ctrl+`)',
    label: unsent ? 'Open the prompt panel, unsent draft' : 'Open the prompt panel',
    unsent,
  };
}

/**
 * Is this keystroke the user starting to TYPE, or driving the terminal?
 *
 * Used by `typingOpensComposer`: with that setting on, a
 * printable key pressed at a CLOSED composer opens it and lands in the draft
 * instead of reaching the shell. Everything this returns false for still goes
 * straight through, and the list of those is the load-bearing part — a terminal
 * that swallows Ctrl-C is broken, and the user still has to answer prompts,
 * page through `less` and drive tmux while the composer is shut.
 *
 * The line, exactly:
 *
 *   - ANY of Ctrl / Meta / Alt held → not typing. That covers Ctrl-C, Ctrl-D,
 *     Ctrl-Z, Ctrl-R, tmux's own prefix, and every app chord in one rule.
 *     Shift is deliberately NOT in that list: Shift-A is a capital letter.
 *   - A `key` that is not exactly one character → not typing. Named keys are
 *     spelled out by the DOM (`Enter`, `Tab`, `Escape`, `ArrowUp`, `F5`,
 *     `Backspace`, `Home`…), so one rule covers the whole keyboard's worth of
 *     control keys without listing them. Counted by code point, so an astral
 *     character still reads as one.
 *   - A bare SPACE → not typing. It is the near-universal "next page" key in
 *     pagers and tmux copy mode, and nobody begins a prompt with it. Only the
 *     TRIGGER is affected: once the composer is open the draft has focus and a
 *     space types normally.
 *   - Mid-IME-composition → not typing. The composing text belongs to whatever
 *     already has focus; stealing it half-written would drop it.
 */
export function isTypingKey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): boolean {
  if (e.isComposing === true) return false;
  if (e.ctrlKey === true || e.metaKey === true || e.altKey === true) return false;
  if (Array.from(e.key).length !== 1) return false;
  return e.key !== ' ';
}

/**
 * Splice `insert` into `text` at `caret`, returning the new text and where the
 * caret lands. Used to plant the keystroke that OPENED the composer, which must
 * not be lost — having to retype the first letter is the whole failure this
 * feature exists to avoid. The caret is the one the session remembered, so
 * re-opening a half-written draft by typing continues where the user left off
 * rather than appending to the end.
 */
export function insertAtCaret(text: string, caret: number, insert: string): [string, number] {
  const at = Math.max(0, Math.min(caret, text.length));
  return [text.slice(0, at) + insert + text.slice(at), at + insert.length];
}

/**
 * A draft of FEWER than this many characters is handed to the terminal by a
 * dismissal. The limit is "less than five", as the
 * user asked for it: two or three characters read as keystrokes, five read as
 * a prompt.
 */
export const FLUSH_DRAFT_CHAR_LIMIT = 5;

/** The facts a flush decision reads, straight off a composer session state. */
export interface FlushCandidate {
  draft: string;
  attachments: number;
  error: string | null;
  sendInFlight: boolean;
  uploadingCount: number;
}

/**
 * Whether dismissing the composer should hand its draft to the terminal
 *.
 *
 * The user's rule, in as many words: start typing, press Esc, and what was
 * typed should go to the terminal to continue typing there — but only while
 * "it should be less than 5 characters put in composer". A two- or
 * three-letter draft is almost always a shell command (`ls`, `htop`) that the
 * typing intercept caught on its way to the pane, and a dismissal hands it
 * back; a longer draft is a PROMPT, work a dismissal never moves.
 *
 * Every refusal below is load-bearing:
 *
 *  - empty or whitespace-only — nothing to hand over, and spaces at a shell
 *    prompt are noise;
 *  - five or more characters (counted by code point, like `isTypingKey`) —
 *    the rule itself;
 *  - containing a line break — writing one would SUBMIT whatever precedes it,
 *    which is a send wearing a flush's clothes;
 *  - attachments, an error banner, a send or an upload in flight — the
 *    composer is mid-something, so the dismissal is an ordinary one.
 */
export function canFlushDraftToTerminal(s: FlushCandidate): boolean {
  if (s.draft.length === 0 || s.draft.trim() === '') return false;
  if (s.draft.includes('\n')) return false;
  if (Array.from(s.draft).length >= FLUSH_DRAFT_CHAR_LIMIT) return false;
  if (s.attachments > 0) return false;
  return s.error === null && !s.sendInFlight && s.uploadingCount === 0;
}
