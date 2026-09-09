import type { WebContents } from 'electron';
import { ipc } from '../shared/channels.js';
import { zoomCommandForInput } from '../shared/zoomKeys.js';
import { windowCommandForInput } from '../shared/windowKeys.js';

/**
 * Keyboard chords main intercepts before the page sees them: zoom (decided in
 * the renderer) and window commands (decided here).
 *
 * Zoom — two jobs, and they are inseparable. The first is to catch every
 * spelling of "zoom in" — Ctrl+=, Ctrl+Shift+=, a layout's dedicated +, the
 * numeric keypad's + — which is the reported bug: Electron's default menu
 * binds `CommandOrControl+Plus`, and `Plus` is SHIFTED `=`, so plain Ctrl+=
 * hit nothing while Ctrl+- and Ctrl+0 worked. See src/shared/zoomKeys.ts.
 *
 * The second is `preventDefault()`, which is load-bearing rather than
 * tidy-up: it suppresses the page's keydown AND the menu shortcut, and
 * suppressing the menu shortcut is what stops the default menu's zoom roles
 * driving Chromium's zoom directly, behind the settings store's back. With
 * them live, Ctrl+- would move the window without the store ever hearing
 * about it and the percentage in Settings would be a lie one keystroke later.
 * That is why the intent is forwarded rather than applied here: main does not
 * know the current zoom and must not guess it. The renderer's settings store
 * steps its own value, persists it, and applies it — one value, one writer,
 * no way for the two to disagree.
 *
 * Window chords, and unlike zoom these are DECIDED here: closing a window and
 * opening DevTools are main's own business, with no renderer state to keep in
 * step. See src/shared/windowKeys.ts for the whole argument — in short, the
 * default menu that used to carry them is gone on Windows and Linux (it had
 * Ctrl+W on Close, which cost the app to a keystroke meant for a text field),
 * and these two are the only entries worth bringing back. `preventDefault()`
 * here is the same instrument as above and cuts the same two ways: it
 * suppresses the page's keydown as well as any accelerator, which is exactly
 * why nothing the terminal uses may be matched.
 */
export function applyChordDispatch(webContents: WebContents, close: () => void): void {
  webContents.on('before-input-event', (event, input) => {
    const zoom = zoomCommandForInput(input);
    if (zoom) {
      event.preventDefault();
      webContents.send(ipc.win.zoomCommand, zoom);
      return;
    }

    const command = windowCommandForInput(input);
    if (!command) return;
    event.preventDefault();
    if (command === 'close') close();
    else webContents.toggleDevTools();
  });
}
