/**
 * Character widths the pane agrees on with the far end.
 *
 * xterm ships with Unicode 6 width tables, and Unicode 6 is where emoji width
 * goes to die: U+1F389 🎉, U+1F331 🌱, U+2705 ✅ and most of the rest of the
 * emoji blocks measure **1 column** under it. The fonts that actually draw
 * them — Segoe UI Emoji on Windows, whatever the system falls back to
 * elsewhere — render every one of them about two cells wide, and the DOM
 * renderer gives a glyph only the advance of the columns xterm counted. The
 * next cell paints straight over the overflow: on a diff row with an opaque
 * red/green background, the right half of every emoji simply does not exist
 * (the broken party-popper sliver this fixes). The far end never had a chance
 * to agree — tmux and modern TUIs measure emoji with current Unicode tables
 * and lay out for two columns.
 *
 * So the pane runs the Unicode 11 provider from `@xterm/addon-unicode11`,
 * which knows these ranges are Wide: the buffer reserves both columns, the
 * continuation cell exists, and drawing, selection and the remote's idea of
 * the row line up again. Applied once at construction, before any output is
 * parsed — cells keep the width they were parsed with, so a pane that has
 * already streamed emoji must not switch underneath them.
 *
 * Kept out of `TerminalView.vue` so the decision and its regression test
 * (against the real `@xterm/headless`, `tests/unit/terminalUnicode.test.ts`)
 * have one home. `unicode` is proposed API — the pane already constructs with
 * `allowProposedApi`.
 */

import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Terminal } from '@xterm/xterm';

/** The slice of Terminal the wiring needs; headless terminals satisfy it too. */
type WidthTerminal = Pick<Terminal, 'loadAddon' | 'unicode'>;

/**
 * Register the Unicode 11 width provider and make it active.
 *
 * Loading the addon only registers it — xterm never switches versions on a
 * provider's behalf, so `unicode.activeVersion` is assigned here. Idempotent
 * per terminal: the provider is registered once and `'11'` is the value being
 * set.
 */
export function applyUnicode11Widths(term: WidthTerminal): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
}
