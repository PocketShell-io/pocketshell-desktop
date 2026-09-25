<script setup lang="ts">
// Root component: the router-outlet, plus the one place the app's typography
// settings are written into the document.
//
// @ui/styles.css (the pocketshell-core sibling's packages/ui) supplies the
// no-JS default for every shared token. The three typography settings are
// written as inline custom properties
// on <html>, which outrank that stylesheet and remain visible in devtools.
//
// This is deliberately the whole wiring for three of the four surfaces. The
// app's mono chrome, the file editor (codeEditorTheme.ts reads --font-mono and
// --code-font-size) and the terminal's padding are plain CSS, so a settings
// change repaints them on the next frame with no component involved and no
// restart. xterm is the exception — it rasterises from an options object and
// never reads the cascade — so TerminalView assigns its own font and re-fits.
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import { fontCssVariables } from '@ui/fonts';
import { resolveTheme } from '@ui/themes';
import { zoomFactor } from '@ui/app/zoom';
import { api } from '@ui/app/ipc';
import { useUpdateStore } from '@ui/app/stores/update';
import { useSettingsStore } from '@ui/app/stores/settings';
import { isShortcut } from '../shared/shortcuts';
import { deleteWordBackward } from '../shared/deleteWord';
import DiagBanner from '@ui/app/components/DiagBanner.vue';
import UpdateBanner from '@ui/app/components/UpdateBanner.vue';
import AccountView from '@ui/app/views/AccountView.vue';

const settings = useSettingsStore();
const isAccountWindow = new URLSearchParams(window.location.search).get('window') === 'account';

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
  <AccountView v-if="isAccountWindow" />
  <router-view v-else />
</template>

<style>

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

/* Rows live inside `overflow-y: auto` lists, which clip a +2px offset ring.
   Inset it instead. `.folder-header` is a <button> and benefits today; the
   list rows are forward-compatible for when they become keyboard-reachable. */
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}

</style>
