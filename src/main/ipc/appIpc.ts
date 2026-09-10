import type { IpcContext } from './context.js';
import { ipcMain, BrowserWindow, app, shell } from 'electron';
import { ipc } from '../../shared/channels.js';
import { APP_TITLE } from '../../shared/windowTitle.js';
import { checkForUpdate } from '../update/ReleaseChecker.js';
import { log } from '../log.js';


export function registerAppIpc(ctx: IpcContext): void {
  // --- win:openAccount ----------------------------------------------------
  // The account surface is a real window rather than a settings overlay, so
  // it remains available while the host picker is being used and gets its
  // own taskbar/Alt-Tab entry.
  ipcMain.handle(ipc.win.openAccount, () => ctx.openAccountWindow());

  // --- win:setTitle --------------------------------------------------------
  // The OS window title mirrors the VIEW — "PocketShell" on the picker, the
  // host's identity in the workspace — which is why the renderer drives it
  // rather than main deriving it from connection events: a connection outlives
  // the workspace view (Back keeps the link alive), so main cannot know which
  // screen the window is showing. The string is built by the shared pure
  // windowTitle(); this side only validates and applies it.
  ipcMain.on(ipc.win.setTitle, (evt, title: unknown) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return;
    win.setTitle(typeof title === 'string' && title.trim() ? title : APP_TITLE);
  });

  // --- diag:log -------------------------------------------------------------
  // The renderer's unhandled errors, forwarded so they land in the desktop log
  // a packaged app leaves nothing else of. Fire-and-forget (`on`, not
  // `handle`): a diagnostic that could block or reject in the process that
  // reported it would be a failure with a failure of its own.
  ipcMain.on(
    ipc.diag.log,
    (_evt, entry: { kind: string; message: string; stack?: string; detail?: Record<string, unknown> }) => {
      // The structured detail (parse-stall reports, first of all) IS the
      // diagnosis; the stack is the other shape a report can take. Either or
      // both may be present.
      const data: Record<string, unknown> = { ...(entry.detail ?? {}) };
      if (entry.stack) data.stack = entry.stack;
      log('renderer', `${entry.kind}: ${entry.message}`, Object.keys(data).length > 0 ? data : undefined);
    },
  );

  // --- update:check / update:open -------------------------------------------
  // The phone's ReleaseChecker, ported: one GitHub Releases poll per check,
  // answered as available / up-to-date / failed — never a thrown error,
  // because the caller is a banner. The download itself stays the user's
  // act: `open` sends the URL to the system browser, nothing self-installs.
  ipcMain.handle(ipc.update.check, () =>
    checkForUpdate({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      fetcher: fetch,
    }),
  );
  ipcMain.handle(ipc.update.open, (_evt, url: string) => {
    // openExternal is the one call that leaves the app with a URL, so it
    // only ever fires for THIS repo's release assets and pages. Anything
    // else is logged and refused, not opened.
    const allowed =
      /^https:\/\/github\.com\/alexeygrigorev\/pocketshell-desktop\/(releases|releases\/download)\//;
    if (typeof url !== 'string' || !allowed.test(url)) {
      log('update', `refused to open non-release URL: ${String(url).slice(0, 120)}`);
      return;
    }
    return shell.openExternal(url);
  });

  // Plumbing: keep references used by the main process bookkeeping.
}
