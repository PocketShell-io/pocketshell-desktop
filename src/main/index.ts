import { app, BrowserWindow, Menu, powerMonitor, shell } from 'electron';
import { HtmlPreviewService, registerPreviewScheme } from './preview/HtmlPreviewService.js';
import { GoogleAuth } from './sync/GoogleAuth.js';
import { SyncService } from './sync/SyncService.js';
import { SYNC_API_URL } from '@pocketshell/core';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConnectionRegistry } from './ssh/ConnectionRegistry.js';
import { SshService } from './ssh/SshService.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { AplexerClient } from './helper/AplexerClient.js';
import { SftpService } from './sftp/SftpService.js';
import { ForwardService } from './portfwd/ForwardService.js';
import { ProjectsService } from './projects/ProjectsService.js';
import { registerIpcHandlers } from './ipc.js';
import { APP_TITLE } from '../shared/windowTitle.js';
import { ipc } from '../shared/channels.js';
import { readWindowBounds, writeWindowBounds } from './windowState.js';
import { applyLinkPolicy } from './windowLinks.js';
import { applyChordDispatch } from './windowChords.js';
import { parseLaunchHost } from './launchArgs.js';

// Electron + ESM: __dirname is not defined for the bundled output under some
// loaders; electron-vite emits CJS for main, so __dirname is available. We
// resolve defensively either way.
const __dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

const registry = new ConnectionRegistry();
const ssh = new SshService(registry);
const aplexer = new AplexerClient(ssh);
const helper = new PocketshellClient(ssh, aplexer);
const sftp = new SftpService(registry);
const forwards = new ForwardService(ssh, registry);
const projects = new ProjectsService(ssh, helper, aplexer);
const preview = new HtmlPreviewService(sftp);
// Settings sync: sign-in state lives behind the OS keychain in userData; the
// renderer only ever sees the signed-in email. Constructed eagerly but inert
// until the user opts in — sync is optional and default-off by omission.
const syncAuth = new GoogleAuth({
  userDataDir: app.getPath('userData'),
  openExternal: (url) => shell.openExternal(url),
});
const sync = new SyncService({ auth: syncAuth, baseUrl: SYNC_API_URL });
// Evict cached per-connection state owned by the application entrypoint (SFTP
// wrapper, remote $HOME, aplexer availability, live HTML previews) on close.
// ForwardService owns its own close subscription: forwarding needs to
// distinguish a lost transport from an explicit stop so reconnect can retain
// the host's auto-forward preference.
ssh.onCloseConnection((id) => {
  sftp.evict(id);
  projects.evict(id);
  aplexer.evict(id);
  preview.evict(id);
});

// The `psview:` scheme has to be declared BEFORE app ready — Chromium fixes
// the standard-scheme table when the network service starts — so it happens
// here at module scope rather than in `whenReady`, alongside the service that
// owns it. The request HANDLER is installed after ready; only the declaration
// is early. See HtmlPreviewService for what the scheme is and why the Files
// tab's HTML preview is not a blob URL.
registerPreviewScheme();

let accountWindow: BrowserWindow | null = null;

/**
 * Every live workspace window, the app's real window list.
 *
 * The app holds ONE process and as many workspace windows as the user opens:
 * a second launch of the exe (or the picker's New-window button) opens
 * another one, each an independent renderer that dials its own host — one
 * window on `hetzner`, another on `win35`. The old single `mainWindow`
 * variable was the only thing standing in the way; everything the services
 * share (SSH pool, SFTP, forwards) is already keyed by connection id, and
 * each window mints its own.
 */
const workspaceWindows = new Set<BrowserWindow>();

/**
 * The host the FIRST launch named on its command line, if any —
 * `PocketShell.exe win35` cold-starts straight into win35's workspace.
 * Later launches' arguments arrive through the `second-instance` event and
 * are parsed there, per launch. Unpackaged (`electron <app-path>`, the e2e
 * harness), the first positional is the entry path, not an argument.
 */
const firstLaunchHost = parseLaunchHost(process.argv, {
  firstPositionalIsAppPath: !app.isPackaged,
});

/**
 * The window icon, or undefined when the generated file is not present.
 *
 * Only unpackaged runs need this. A packaged Windows build takes its icon
 * from the .exe resource and a packaged macOS build from the bundle, both
 * written by electron-builder from build/icon.* — so `build/` is deliberately
 * absent from the `files` allow-list in electron-builder.yml and this lookup
 * simply misses there. It matters for `npm run dev` and for the desktop
 * shortcut (scripts/install-desktop-shortcut.ps1), which launch Electron
 * directly and would otherwise show the default Electron atom in the taskbar.
 */
function windowIcon(): string | undefined {
  const icon = join(__dir, '../../build/icon.png');
  return existsSync(icon) ? icon : undefined;
}

/** Load the renderer entry, optionally selecting a window-specific view. */
function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    const url = new URL(devUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dir, '../renderer/index.html'), query ? { query } : undefined);
  }
}

/**
 * Open one workspace window.
 *
 * The FIRST window restores the saved geometry; windows opened on top of it
 * get the default size and Electron's own placement cascade, because two
 * windows fighting over one stored rect would each leave it half-written.
 * The store keeps ONE record, so it is written only by whichever window
 * closes LAST — the geometry the user actually ended up looking at.
 *
 * `opts.requestedHost` names the host the window is for (a command-line
 * launch, or — later — a renderer request); the renderer reads it from the
 * load query and dials it. Any window that is not a plain first launch also
 * says `window=workspace` in that query: the shared picker reads it and
 * stands down from the stored-default auto-connect, which belongs to the
 * first window — a second window re-dialing the default would open a second
 * connection to a host the first one already holds, with both windows'
 * auto-forwards competing for the same local ports.
 */
function createWindow(opts: { requestedHost?: string | null } = {}): BrowserWindow {
  const firstWindow = workspaceWindows.size === 0;
  // Restore the last session's geometry (F18), unless this is a headless test
  // run: the off-screen placement below would otherwise be captured on close
  // and the next real launch would open at -32000,-32000. A headless run never
  // writes bounds, so the user's real geometry survives the test suite.
  const savedBounds =
    firstWindow && process.env['POCKETSHELL_HEADLESS'] !== '1' ? readWindowBounds() : null;
  const win = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 800,
    // Omitted entirely when there is no usable saved position — passing
    // `x: undefined` would still override Electron's own centering cascade.
    // For a second-and-later window there is no saved position BY DESIGN, so
    // the cascade is what spaces the windows on screen.
    ...(savedBounds?.x != null && savedBounds.y != null
      ? { x: savedBounds.x, y: savedBounds.y }
      : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // The launch title only. Once connected, the renderer retitles the window
    // with the host's identity over `win:setTitle` (the workspace has no
    // identity bar of its own — the native title bar carries it).
    title: APP_TITLE,
    icon: windowIcon(),
    webPreferences: {
      preload: join(__dir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's built-in PDF viewer is a "plugin" as far as Electron's API
      // is concerned, and this is the flag its documentation names for it.
      // The Files tab renders a remote PDF by putting its bytes behind a blob
      // URL and pointing an `<embed type="application/pdf">` at it.
      //
      // Measured on this exact Electron (33.3.1) rather than assumed: the
      // viewer paints from a blob URL with this flag BOTH true and false —
      // `navigator.pdfViewerEnabled` is true either way, and a screenshot of
      // the embed shows the real viewer chrome and the page. So on this
      // version the flag is not what makes it work; the CSP is (see
      // renderer/index.html — without `object-src blob:` the same embed emits
      // a policy violation and paints nothing).
      //
      // It stays on anyway because it is the documented contract, it costs
      // nothing here, and a version or platform where the default flips back
      // would fail SILENTLY — a blank frame with no error is exactly the kind
      // of regression not worth risking to save one line. It does NOT
      // reintroduce NPAPI or any third-party plugin surface; that machinery
      // has been gone from Chromium for years, and `sandbox: true` and
      // `contextIsolation: true` both continue to apply.
      plugins: true,
    },
  });
  workspaceWindows.add(win);

  // Re-maximize AFTER creation, not in the constructor options: the stored
  // rect is the pre-maximize geometry (windowState.ts), and creating with the
  // normal rect and then maximizing is what keeps the un-maximize target where
  // the user left it.
  if (savedBounds?.maximized) win.maximize();

  // Persisted on close rather than on every resize/move: the close-time values
  // are the only ones that are final (a drag writes a dozen interim rects that
  // would each hit the disk), and a crash then costs one launch of geometry —
  // the same trade the workspace's tab memory makes. Written only when this
  // is the LAST workspace window out: with several open, each close would
  // otherwise overwrite the one record with a geometry the user may already
  // have left behind.
  win.on('close', () => {
    if (process.env['POCKETSHELL_HEADLESS'] !== '1' && workspaceWindows.size === 1) {
      writeWindowBounds(win);
    }
  });
  win.on('closed', () => {
    workspaceWindows.delete(win);
    // The account surface orbits the workspace windows: it exists to serve
    // one, so it closes when the last of them does — not when any single one
    // does, which would yank it out from under the windows still open.
    if (workspaceWindows.size === 0) {
      if (accountWindow && !accountWindow.isDestroyed()) accountWindow.close();
      accountWindow = null;
    }
  });

  // Electron has no true headless mode. "Headless" here means the window is
  // shown OFF-SCREEN and without focus, rather than not shown at all.
  //
  // Never calling show() does hide it, but an unshown window never composites
  // a frame, so `page.screenshot()` hangs until it times out — which would
  // break every screenshot-capture harness. Showing it inactive at a
  // far-offscreen origin keeps compositing alive while keeping it off the
  // desktop and out of the focus order, so a test run stops stealing the
  // user's keyboard and flashing windows.
  const headless = process.env['POCKETSHELL_HEADLESS'] === '1';
  win.on('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (headless) {
      win.setPosition(-32000, -32000);
      win.showInactive();
    } else {
      win.show();
    }
  });

  applyLinkPolicy(win.webContents);

  // Zoom chords are recognised here and DECIDED in the renderer; window
  // chords are decided here. Both policies live in windowChords.ts.
  applyChordDispatch(win.webContents, () => {
    if (!win.isDestroyed()) win.close();
  });

  // electron-vite: dev server URL in dev, built file in prod. The query only
  // appears on a window that needs to say something about its own launch —
  // the plain first launch stays query-less, exactly as it has always been.
  const secondary = !firstWindow || opts.requestedHost != null;
  loadRenderer(
    win,
    secondary
      ? { window: 'workspace', ...(opts.requestedHost ? { host: opts.requestedHost } : {}) }
      : undefined,
  );
  return win;
}

/** Open the dedicated account surface, or focus the existing one. */
function openAccountWindow(): void {
  if (accountWindow && !accountWindow.isDestroyed()) {
    if (accountWindow.isMinimized()) accountWindow.restore();
    accountWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Account & sync — PocketShell',
    icon: windowIcon(),
    webPreferences: {
      preload: join(__dir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
    },
  });
  accountWindow = win;

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (accountWindow === win) accountWindow = null;
  });
  applyLinkPolicy(win.webContents);
  applyChordDispatch(win.webContents, () => {
    if (!win.isDestroyed()) win.close();
  });
  loadRenderer(win, { window: 'account' });
}

/**
 * Open another workspace window at the renderer's request (the picker's
 * New-window button). Main owns the window vocabulary — the `window=
 * workspace` query that marks a secondary launch lives here — so the
 * renderer asks with a host name at most and never with a query string.
 */
function openWorkspaceWindow(opts?: { requestedHost?: string | null }): void {
  createWindow(opts);
}

// Ensure only one instance of the app runs.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A second launch of the exe lands here, and it opens a NEW workspace
  // window rather than focusing the old one — that is how a second window on
  // another host gets started (double-click the shortcut again, or launch
  // `PocketShell.exe win35` and the new window dials win35 at once). The
  // window arrives in front by virtue of being new; nothing needs focusing
  // behind it.
  app.on('second-instance', (_evt, argv) => {
    createWindow({ requestedHost: parseLaunchHost(argv, { firstPositionalIsAppPath: !app.isPackaged }) });
  });

  // A rejection here means no window and no error surfaced anywhere, so the
  // app would just look dead on launch. Log it and exit non-zero instead.
  app.whenReady().then(
    () => {
      // NO APPLICATION MENU on Windows and Linux, which also means no default
      // accelerator table. This app has never built a menu and never shown a
      // menu bar, but Electron installs one anyway, and it was quietly holding
      // Ctrl+W (close the window), Ctrl+M (minimize), Ctrl+R (reload) and F11
      // — four chords a terminal app has real uses for, none of them chosen
      // here. Ctrl+W was the one a user hit: it closes the app, and closing the
      // app is closing every session.
      //
      // The full role table, what each chord does at the terminal and what
      // nulling this costs (measured: nothing for cut/copy/paste/select-all,
      // which Chromium's editor owns) is written up in shared/windowKeys.ts,
      // together with why darwin keeps its menu. The two chords worth keeping
      // are re-provided in `before-input-event` above.
      //
      // Placed here because this block is where this app's startup order is
      // expressed, NOT because it has to be: measured on 33.3.1, setting the
      // menu at module scope also works, because Electron skips installing its
      // default once anything has set a menu at all. What does matter is that
      // it happens before a window exists.
      if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

      // After ready and before the window: the handler must be live by the
      // time anything can frame a `psview:` URL.
      preview.install();

      // Sleep/wake (F12). Main is the only process that can observe the OS
      // transition, and the renderer is the only process that may dial — so
      // this is an announcement, not a command. The store probes the link on
      // receipt; a socket that crossed a sleep is the classic silent drop,
      // where the TCP peer is gone but the local stack will not admit it until
      // a write fails or ssh2's keepalive times out (~45s of silence later).
      powerMonitor.on('resume', () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(ipc.app.resumed);
        }
      });

      registerIpcHandlers({
        ssh,
        helper,
        aplexer,
        sftp,
        forwards,
        projects,
        preview,
        syncAuth,
        sync,
        openAccountWindow,
        openWorkspaceWindow,
        getWindows: () => BrowserWindow.getAllWindows(),
      });
      createWindow({ requestedHost: firstLaunchHost });

      app.on('activate', () => {
        if (workspaceWindows.size === 0) createWindow();
      });
    },
    (err: unknown) => {
      console.error('[pocketshell] startup failed:', err);
      app.exit(1);
    },
  );
}

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  registry.clear();
  if (process.platform !== 'darwin') app.quit();
});

// Clean up all SSH connections on quit.
app.on('before-quit', () => {
  registry.clear();
});
