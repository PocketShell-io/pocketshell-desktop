import { app, BrowserWindow, Menu, powerMonitor, shell } from 'electron';
import { HtmlPreviewService, registerPreviewScheme } from './preview/HtmlPreviewService.js';
import { GoogleAuth } from './sync/GoogleAuth.js';
import { SyncService } from './sync/SyncService.js';
import { SYNC_API_URL } from '../shared/syncConfig.js';
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

let mainWindow: BrowserWindow | null = null;
let accountWindow: BrowserWindow | null = null;

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

function createWindow(): void {
  // Restore the last session's geometry (F18), unless this is a headless test
  // run: the off-screen placement below would otherwise be captured on close
  // and the next real launch would open at -32000,-32000. A headless run never
  // writes bounds, so the user's real geometry survives the test suite.
  const savedBounds = process.env['POCKETSHELL_HEADLESS'] === '1' ? null : readWindowBounds();
  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 800,
    // Omitted entirely when there is no usable saved position — passing
    // `x: undefined` would still override Electron's own centering cascade.
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

  // Re-maximize AFTER creation, not in the constructor options: the stored
  // rect is the pre-maximize geometry (windowState.ts), and creating with the
  // normal rect and then maximizing is what keeps the un-maximize target where
  // the user left it.
  if (savedBounds?.maximized) mainWindow.maximize();

  // Persisted on close rather than on every resize/move: the close-time values
  // are the only ones that are final (a drag writes a dozen interim rects that
  // would each hit the disk), and a crash then costs one launch of geometry —
  // the same trade the workspace's tab memory makes.
  mainWindow.on('close', () => {
    if (mainWindow && process.env['POCKETSHELL_HEADLESS'] !== '1') writeWindowBounds(mainWindow);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (accountWindow && !accountWindow.isDestroyed()) accountWindow.close();
    accountWindow = null;
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
  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) return;
    if (headless) {
      mainWindow.setPosition(-32000, -32000);
      mainWindow.showInactive();
    } else {
      mainWindow.show();
    }
  });

  applyLinkPolicy(mainWindow.webContents);

  // Zoom chords are recognised here and DECIDED in the renderer; window
  // chords are decided here. Both policies live in windowChords.ts.
  applyChordDispatch(mainWindow.webContents, () => mainWindow?.close());

  // electron-vite: dev server URL in dev, built file in prod.
  loadRenderer(mainWindow);
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

// Ensure only one instance of the app runs.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
        getWindows: () => BrowserWindow.getAllWindows(),
      });
      createWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
