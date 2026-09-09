import { shell, type WebContents } from 'electron';
import { PREVIEW_SCHEME } from './preview/previewPaths.js';

/**
 * Link-opening policy for the main window, in the two places a click can
 * become a navigation: `window.open` (setWindowOpenHandler) and a link inside
 * the preview frame (will-frame-navigate).
 *
 * Both run the same allow-list. Open external links in the system browser,
 * never in-app — and only if they are web links.
 *
 * `shell.openExternal` hands the URL to the OS to dispatch by SCHEME, and
 * this handler used to pass whatever it was given. Two consequences, one
 * visible and one not:
 *
 *   - A click that produced no real URL still reached here as `about:blank`
 *     (that is what Electron reports when `window.open` has nothing usable),
 *     so Windows popped "We can't open this 'about' link — your device needs
 *     a new app to open this link".
 *   - More seriously, the renderer linkifies TERMINAL OUTPUT, which is bytes
 *     from a remote host. Anything that host can print, it could get handed
 *     to the OS shell: `file:`, `ms-`, a custom protocol registered by some
 *     other installed app. A remote box should not be able to pick which
 *     local program opens.
 *
 * So the scheme is allow-listed, parsing is guarded (a malformed URL throws
 * in the URL constructor rather than falling through), and everything else is
 * dropped with a log rather than silently ignored — a link that does nothing
 * at all is its own bug report.
 */

/** True only for `http:` and `https:`. */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Open web links in the OS browser; refuse and log everything else. */
function handOffOrRefuse(url: string, why: string): void {
  if (isWebUrl(url)) {
    void shell.openExternal(url);
  } else {
    console.warn(`[pocketshell] ${why}:`, url);
  }
}

/**
 * `window.open` never opens in-app: every popup is denied, web URLs are
 * handed to the system browser.
 */
function applyWindowOpenPolicy(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    handOffOrRefuse(url, 'refused to open non-web link');
    return { action: 'deny' };
  });
}

/**
 * A previewed document may contain links, and a link click inside the preview
 * frame is a NAVIGATION rather than a `window.open` — so it does not pass
 * through the window-open handler.
 *
 * The renderer's CSP already lists `psview:` for `frame-src` and nothing
 * remote, and `frame-src` is checked on every navigation of a nested browsing
 * context, not only its first. This is the belt to that braces, and it is
 * worth having because the two failure modes are so different: a CSP mistake
 * here would mean a remote document could make the app fetch an arbitrary
 * http URL — leaking, at minimum, which file the user is looking at and when.
 * Sub-frames may navigate WITHIN the preview scheme (following a relative
 * link to the page next door is a reasonable thing to want) and nowhere else.
 * The main frame is untouched: that is the app's own routing.
 *
 * A WEB link — and only a web link, by the same allow-list the window-open
 * handler uses — is not kept from the user, it is HANDED OFF: the OS browser
 * opens it, which is what clicking a link in a local viewer means. The
 * hand-off carries nothing about the preview: the browser arrives with no
 * referrer naming the file or the host, so the server learns only that
 * someone clicked a link to it. Every other scheme stays refused-and-logged:
 * a remote box must not get to pick which local program opens, here any more
 * than in the window-open handler.
 */
function applyPreviewFramePolicy(webContents: WebContents): void {
  webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    if (details.url.startsWith(`${PREVIEW_SCHEME}://`)) return;
    handOffOrRefuse(details.url, 'refused preview-frame navigation');
    details.preventDefault();
  });
}

/** Install both link policies on the main window's webContents. */
export function applyLinkPolicy(webContents: WebContents): void {
  applyWindowOpenPolicy(webContents);
  applyPreviewFramePolicy(webContents);
}
