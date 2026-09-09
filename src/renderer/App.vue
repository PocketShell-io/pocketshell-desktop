<script setup lang="ts">
// Root component: the router-outlet, plus the one place the app's typography
// settings are written into the document.
//
// The `:root` block below is the DEFAULT for every token. The three typography
// tokens are the only ones a user can move, and they are moved by setting them
// as inline custom properties on <html> — which outranks `:root` in the
// cascade, so the block below stays readable as "what ships" and the override
// stays visible in devtools as "what the user chose".
//
// This is deliberately the whole wiring for three of the four surfaces. The
// app's mono chrome, the file editor (codeEditorTheme.ts reads --font-mono and
// --code-font-size) and the terminal's padding are plain CSS, so a settings
// change repaints them on the next frame with no component involved and no
// restart. xterm is the exception — it rasterises from an options object and
// never reads the cascade — so TerminalView assigns its own font and re-fits.
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import { fontCssVariables } from './fonts';
import { resolveTheme } from './themes';
import { zoomFactor } from './zoom';
import { api } from './ipc';
import { useUpdateStore } from './stores/update';
import { useSettingsStore } from './stores/settings';
import { isShortcut } from '../shared/shortcuts';
import { deleteWordBackward } from '../shared/deleteWord';
import DiagBanner from './components/DiagBanner.vue';
import UpdateBanner from './components/UpdateBanner.vue';

const settings = useSettingsStore();

/**
 * Readline's `Ctrl+W` (`unix-word-rubout`) in the app's own text fields.
 *
 * The terminal has always had this: xterm encodes ctrl-W as `\x17` and bash
 * kills back to the previous whitespace. Everywhere ELSE the chord was
 * Electron's default-menu Close until that menu was disarmed
 * (src/shared/windowKeys.ts) — which made it a dead key in exactly the places
 * the muscle memory targets. This restores the command on the surfaces whose
 * keyboard a text field is, using the SAME semantics as the shell (see
 * shared/deleteWord.ts): kill the selection, else back through the nearest
 * whitespace.
 *
 * Three stand-downs, each load-bearing:
 *   - `.xterm` inputs are NOT text fields here. xterm's own sink is a
 *     `<textarea>`, and swallowing its keys would eat `\x17` out of the shell
 *     — the one place the command genuinely lives natively.
 *   - The code editor is CodeMirror's keymap, not ours; contentEditable is
 *     outside `<input>`/`<textarea>` and never reaches past the first test.
 *   - macOS is skipped entirely: darwin keeps Electron's default menu, where
 *     Cmd+W still means Close, and a cancelled renderer keydown does not stop
 *     a *window* role — taking the chord there would run BOTH commands.
 *
 * Applied through the native edit path (`execCommand('delete')`, acting on a
 * real selection) rather than splicing `.value`, so Chromium's undo stack
 * hears the deletion — ONE `Ctrl+Z` undoes the whole killed word — and Vue's
 * `v-model` listeners fire as they would for any edit.
 */
function onDeleteWordBackward(e: KeyboardEvent): void {
  if (!isShortcut(settings.shortcutBindings, 'text.deleteWordBackward', e)) return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.disabled || target.readOnly) return;
  if (target.closest('.xterm')) return;
  const { selectionStart, selectionEnd, value } = target;
  if (selectionStart === null || selectionEnd === null) return;

  const result = deleteWordBackward(value, selectionStart, selectionEnd);
  const changed = result.value !== value;
  e.preventDefault();
  e.stopPropagation();
  if (!changed) return;

  try {
    target.setSelectionRange(result.caret, selectionEnd);
    if (!document.execCommand('delete')) throw new Error('unsupported');
  } catch {
    // jsdom, or a Chromium someday without the editing API. setRangeText
    // performs the same splice; it fires no input event, so one is dispatched
    // by hand to keep every framework listener honest.
    target.setRangeText('', result.caret, selectionEnd, 'end');
    target.setSelectionRange(result.caret, result.caret);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Where the platform keeps the default menu — see the stand-down above. */
const KEEPS_DEFAULT_MENU = navigator.userAgent.includes('Mac');

/**
 * The ONE place a theme becomes pixels: the chosen record's tokens are written
 * onto `<html>` as inline custom properties, exactly the way the typography
 * settings land below. Everything that paints from the cascade — which is
 * everything except xterm (TerminalView assigns `term.options.theme` from the
 * same record) — repaints on the next frame, no restart, no remount.
 *
 * `resolveTheme` is reactive on both inputs: the stored choice, and (for
 * `system`) the OS preference ref inside themes.ts, so flipping Windows'
 * light/dark mode restyles a running app.
 *
 * `colorScheme` is set from the record's declared appearance so form controls,
 * scrollbars and the UA's default canvas agree with the surfaces; `data-theme`
 * is stamped for devtools legibility and tests, not for CSS to branch on —
 * components must keep reading tokens, never the theme's name.
 */
watchEffect(() => {
  const theme = resolveTheme(settings.theme);
  const el = document.documentElement;
  el.dataset['theme'] = theme.id;
  el.style.colorScheme = theme.appearance;
  for (const [name, value] of Object.entries(theme.tokens)) {
    el.style.setProperty(name, value);
  }
});

watchEffect(() => {
  const vars = fontCssVariables({
    monospaceFontFamily: settings.monospaceFontFamily,
    terminalFontSize: settings.terminalFontSize,
    editorFontSize: settings.editorFontSize,
  });
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
});

/**
 * The ONE call that actually moves the window's zoom.
 *
 * Zoom cannot be a custom property like the three above — it is not a CSS fact
 * at all but a property of the frame, so it goes through the preload's
 * `webFrame.setZoomFactor`. What it shares with them is the shape that
 * matters: a watcher on the settings store, in the root component, so the
 * stored value is the only input and there is exactly one writer. Running
 * immediately (as `watchEffect` does) is also what restores the user's zoom on
 * launch, before the first frame the user sees.
 */
watchEffect(() => {
  api.win.setZoom(zoomFactor(settings.zoomPercent));
});

/**
 * Zoom chords, caught in main (see src/shared/zoomKeys.ts) because the page
 * never gets to see them — the same `preventDefault()` that disarms Electron's
 * default-menu zoom roles also suppresses the page keydown.
 *
 * They land on the store's actions rather than on `setZoom`, which is the
 * whole point: pressing Ctrl+- and dragging the Settings stepper are the same
 * write to the same value, so the panel cannot show a percentage the window is
 * not actually at.
 */
let stopZoomCommands: (() => void) | null = null;

const updates = useUpdateStore();

onMounted(() => {
  void updates.check();
  stopZoomCommands = api.win.onZoomCommand((command) => {
    if (command === 'in') settings.zoomIn();
    else if (command === 'out') settings.zoomOut();
    else settings.resetZoom();
  });
  if (!KEEPS_DEFAULT_MENU) window.addEventListener('keydown', onDeleteWordBackward, true);
});

onBeforeUnmount(() => {
  stopZoomCommands?.();
  stopZoomCommands = null;
  if (!KEEPS_DEFAULT_MENU) window.removeEventListener('keydown', onDeleteWordBackward, true);
});
</script>

<template>
  <!-- The one app-wide surface: unhandled renderer errors, so a component
       that dies mid-render reports itself instead of leaving a blank screen
       (renderer/diag.ts). -->
  <DiagBanner />
  <UpdateBanner />
  <router-view />
</template>

<style>
/* ---------------------------------------------------------------------------
 * Design tokens; themes.ts holds the theme records.
 *
 * Palette is the Android client's (GitHub-dark-derived): #0D1117 ground,
 * #E6EDF3 text, cyan #22D3EE accent. Contrast ratios in the comments are
 * WCAG 2.1 relative-luminance, computed per pair against --bg unless noted.
 *
 * The six original names (--bg --fg --muted --accent --error --border) are
 * still defined, so nothing that predates the token set breaks.
 *
 * THIS BLOCK IS THE DARK THEME. Since themes became data
 * (src/renderer/themes.ts), every colour-carrying token below is duplicated in
 * the `dark` record there, and the chosen theme's record is written over these
 * as inline properties on <html> (see the script block above). The block stays
 * because it is what ships — the no-JS truth of "what the app looks like" —
 * and tests/unit/themes.test.ts asserts the two copies never drift, so editing
 * a dark colour here without touching the record (or vice versa) fails the
 * suite. The non-colour tokens (type scale, spacing, radii, density, motion)
 * are NOT themed and live only here.
 * ------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  /* ---- Surfaces (elevation 0 -> 3) ----------------------------------- */
  --bg: #0d1117; /* window / page ground */
  --surface: #161b22; /* topbar, side panel, cards, overlay body */
  --surface-2: #1c2129; /* inputs, chips, table heads, menus */
  --surface-3: #232a34; /* popovers / anything above an overlay */
  --scrim: rgba(1, 4, 9, 0.72); /* modal backdrop */

  /* ---- Text ---------------------------------------------------------- */
  --fg: #e6edf3; /* 16.02:1 on --bg */
  --fg-secondary: #8b949e; /*  6.15:1 — subtitles, timestamps, counts */
  --fg-muted: #6e7681; /*  4.12:1 — >=15px or decorative ONLY */

  /* ---- Lines --------------------------------------------------------- */
  --border: #2d333b; /* default hairline */
  --border-soft: #21262d; /* row separators inside a panel */
  --border-strong: #6e7681; /* 4.12:1 — inputs & controls (WCAG 1.4.11) */

  /* ---- Accent -------------------------------------------------------- */
  --accent: #22d3ee; /* 10.47:1 on --bg */
  --accent-dim: #0891b2; /* accent borders, active separators */
  --accent-soft: rgba(34, 211, 238, 0.12); /* selected row fill */
  --on-accent: #04101a; /* 10.62:1 on --accent */

  /* ---- Status -------------------------------------------------------- */
  --success: #22c55e;
  --warning: #f59e0b;
  --error: #ef4444;
  --agent: #a78bfa; /* agent/assistant role, per Android */
  --success-soft: rgba(34, 197, 94, 0.12);
  --warning-soft: rgba(245, 158, 11, 0.12);
  --error-soft: rgba(239, 68, 68, 0.12);
  --agent-soft: rgba(167, 139, 250, 0.14);

  /* ---- Interaction states -------------------------------------------- */
  /* Neutral lift for hover: tinting every hover with the accent makes hover
     read as selection, which is what the old rgba(137,180,250,.08) did. */
  --state-hover: rgba(230, 237, 243, 0.05);
  --state-active: rgba(230, 237, 243, 0.09);
  --state-selected: var(--accent-soft);

  /* ---- Elevation shadows ---------------------------------------------- */
  /* Previously hardcoded per component (OverlayPanel, PromptComposer) as
     rgba(0,0,0,.5), which was fine while there was one dark ground. A light
     theme cannot use them — black at half opacity on white reads as a hole,
     not a lift — so shadows are tokens now and each theme sets its own. */
  --shadow-overlay: 0 16px 48px rgba(0, 0, 0, 0.5);
  --shadow-popover: 0 8px 24px var(--scrim); /* menus, dropdowns — scrim-tinted */
  --shadow-card: 0 8px 32px rgba(0, 0, 0, 0.5);
  --focus-ring: var(--accent);
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --disabled-opacity: 0.45;

  /* ---- Terminal (— Windows Terminal / Campbell) -- */
  --term-bg: #0c0c0c;
  --term-fg: #cccccc;
  --term-font-size: 16px;
  --term-padding: 8px;

  /* ---- Code (file editor syntax colours) ------------------------------
   * Derived from Campbell, because the Files tab's editor sits on
   * `--term-bg` for the reason FilesView already states: an open file and the
   * shell it came from should read as the same surface. A stock editor theme
   * dropped onto that ground would be the only thing in the app not speaking
   * the terminal's palette.
   *
   * Ratios are against `--term-bg` #0C0C0C, computed the same way as the terminal contrast rule's
   * audit. Two roles deliberately step OUTSIDE Campbell, both for the reason
   * identified above — the scheme's dim pairs are unreadable on its own
   * background — and both handled here the way `minimumContrastRatio: 3`
   * handles them in the terminal: lift only the failing pair, leave the rest
   * pixel-identical.
   *   - comment: Campbell brightBlack #767676 is 4.31:1, and the token set reserves
   *     that band for >=15px or decorative text. Comments are 13px prose and
   *     are read, so they take `--fg-secondary`'s value (6.36:1) instead.
   *   - meta: Campbell magenta/brightMagenta are 2.44:1 / 3.20:1 — the exact
   *     pair called out above as "genuinely unreadable". Decorators, preprocessor lines
   *     and doctypes take the app's own `--agent` violet (7.19:1).
   */
  --code-comment: #8b949e; /*  6.36:1 — lifted, see above */
  --code-keyword: #3b78ff; /*  4.95:1 — Campbell brightBlue */
  --code-string: #c19c00; /*  7.47:1 — Campbell yellow */
  --code-number: #16c60c; /*  8.49:1 — Campbell brightGreen */
  --code-function: #f9f1a5; /* 16.91:1 — Campbell brightYellow */
  --code-type: #61d6d6; /* 11.27:1 — Campbell brightCyan */
  --code-variable: #cccccc; /* 12.18:1 — Campbell foreground */
  --code-tag: #3a96dd; /*  6.14:1 — Campbell cyan */
  --code-attribute: #61d6d6; /* 11.27:1 — Campbell brightCyan */
  --code-punctuation: #8b949e; /*  6.36:1 — brackets, dimmed a step */
  --code-meta: #a78bfa; /*  7.19:1 — substituted, see above */
  --code-invalid: #e74856; /*  5.09:1 — Campbell brightRed */
  --code-link: #22d3ee; /* 10.82:1 — the app accent, so links read as links */
  --code-heading: #f2f2f2; /* 17.47:1 — Campbell brightWhite */
  --code-inserted: #16c60c; /*  8.49:1 — diff +, Campbell brightGreen */
  --code-deleted: #e74856; /*  5.09:1 — diff -, Campbell brightRed */

  /* Editor chrome. Line numbers are decorative and may sit at 4.31:1; the
     cursor and selection are Windows Terminal's own (defaults.json cursor
     #FFFFFF, selection = white at ~50% alpha, taken down here because an
     editor selection covers text that is still being read). */
  --code-gutter-fg: #767676;
  --code-gutter-fg-active: #cccccc;
  --code-active-line: rgba(255, 255, 255, 0.04);
  --code-selection: rgba(255, 255, 255, 0.22);
  --code-selection-inactive: rgba(255, 255, 255, 0.1);
  --code-cursor: #ffffff;
  --code-bracket-match: rgba(34, 211, 238, 0.25);

  /* ---- Typography ---------------------------------------------------- */
  --font-ui: 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  /* The shipped mono stack, and the fallback tail a chosen family is prepended
     to. Overridden on <html> by the settings store — see the script block and
     src/renderer/fonts.ts. Must stay in sync with FALLBACK_STACK there. */
  --font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;
  /* The file editor's text size. Its own token rather than `--fs-300` directly
     because it is now user-settable and the UI scale is not: `--fs-300` sizes
     28px rows and 40px bars, and a font preference has no business moving
     those. The default is `--fs-300`'s value, so nothing changed on upgrade. */
  --code-font-size: 13px;

  --fs-100: 11px;
  --lh-100: 1.45;
  --fs-200: 12px;
  --lh-200: 1.45;
  --fs-300: 13px;
  --lh-300: 1.3846; /* = Android bodyDense 13sp/18sp */
  --fs-400: 15px;
  --lh-400: 1.3;
  --fs-500: 18px;
  --lh-500: 1.25;
  --fs-600: 20px;
  --lh-600: 1.2;

  --fw-regular: 400;
  --fw-medium: 500;
  --fw-semibold: 600;
  --fw-bold: 700;

  /* ---- Space (4px grid, per Android Spacing.kt) ----------------------- */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;

  /* ---- Radii --------------------------------------------------------- */
  --r-sm: 4px; /* chips, badges, tags, selected-row band */
  --r-md: 6px; /* buttons, inputs, tab segments */
  --r-lg: 10px; /* cards, panels */
  --r-xl: 14px; /* overlay / modal */

  /* ---- Density ------------------------------------------------------- */
  --row-h: 28px; /* list rows: session, file, forward */
  --row-pad-x: 10px;
  --row-pad-y: 6px;
  --control-h: 28px; /* buttons, inputs, selects */
  --control-h-sm: 24px;
  --topbar-h: 40px;
  --tabbar-h: 32px;

  /* ---- Motion (per Android docs/design-system.md §motion) ------------- */
  --dur-fast: 150ms;
  --dur-normal: 200ms;
  --dur-slow: 280ms; /* overlay entrance only */
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1); /* decelerate: things arriving */
}

* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  /* CSS equivalent of Windows Terminal's "antialiasingMode": "grayscale", so
     the UI and the terminal it frames are rasterised the same way. */
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* Numbers must not jitter between rows: timestamps, ports, percentages. */
.session-time,
.fwd-table,
.meter-pct,
.sz,
.host-detail,
.folder-count {
  font-variant-numeric: tabular-nums;
}

/* One focus treatment for the whole app. The app is keyboard-driven around a
   terminal, and the transparent-background buttons suppress the UA default.
   Deliberately NO border-radius here: Chromium already draws the outline
   along the element's own corners, so setting one would *mutate the focused
   element's geometry* — square things (the editor textarea) visibly rounded
   themselves on focus. */
:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* Rows live inside `overflow-y: auto` lists, which clip a +2px offset ring.
   Inset it instead. `.folder-header` is a <button> and benefits today; the
   list rows are forward-compatible for when they become keyboard-reachable. */
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}

/* Loading spin for refresh icons: the button keeps its icon instead of
   swapping to an ellipsis character, which changed its width mid-action. */
.spin {
  animation: icon-spin 900ms linear infinite;
}
@keyframes icon-spin {
  to {
    transform: rotate(360deg);
  }
}

/* One global reduced-motion guard, covering .spin, the overlay entrance, the
   host-picker pulse and every hover transition. Components no longer carry
   their own @media blocks. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}

/* ---------------------------------------------------------------------------
 * Shared primitives, defined once in this file. 
 *
 * These were previously copy-pasted per component (.icon-btn in 7 files,
 * .muted in 10, .error in 5, .empty in 5), each drifting a little. They live
 * here now; the component <style scoped> blocks no longer redefine them.
 * ------------------------------------------------------------------------- */
/* Ghost SQUARE icon button — toolbars, panel headers, table-row actions. The
   VS Code register: invisible at rest, filled on hover. Square by
   construction, so the icon is optically centred and adjacent buttons are
   identical widths (the old `padding + glyph advance` sizing made `<-` and
   the hamburger visibly different boxes). */
.icon-btn {
  width: var(--control-h);
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.icon-btn:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.icon-btn:active:not(:disabled) {
  background: var(--state-active);
}
.icon-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.icon-btn.sm {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
}

/* Ghost LABELED button — header text actions (Ports, Usage, disconnect).
   Same register as .icon-btn; it just has words in it. */
.btn-ghost {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-ghost:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.btn-ghost:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.muted {
  color: var(--fg-secondary);
}
.error {
  color: var(--error);
  font-size: var(--fs-200);
}
.empty {
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--sp-4);
}
</style>
