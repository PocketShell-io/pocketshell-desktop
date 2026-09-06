import { app, BrowserWindow, Menu, powerMonitor, shell } from 'electron';
import { HtmlPreviewService, registerPreviewScheme } from './preview/HtmlPreviewService.js';
import { PREVIEW_SCHEME } from './preview/previewPaths.js';
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
import { zoomCommandForInput } from '../shared/zoomKeys.js';
import { windowCommandForInput } from '../shared/windowKeys.js';
import { readWindowBounds, writeWindowBounds } from './windowState.js';

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
// Evict cached per-connection state owned by the application entrypoint (SFTP
// wrapper, remote $HOME, aplexer availability, live HTML previews) on close. ForwardService and ServeService own their own close
// subscriptions: forwarding needs to distinguish a lost transport from an
// explicit stop so reconnect can retain the host's auto-forward preference.
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

  // Open external links in the system browser, never in-app — and only if
  // they are web links.
  //
  // `shell.openExternal` hands the URL to the OS to dispatch by SCHEME, and
  // this handler used to pass whatever it was given. Two consequences, one
  // visible and one not:
  //
  //   - A click that produced no real URL still reached here as
  //     `about:blank` (that is what Electron reports when `window.open` has
  //     nothing usable), so Windows popped "We can't open this 'about'
  //     link — your device needs a new app to open this link".
  //   - More seriously, the renderer linkifies TERMINAL OUTPUT, which is
  //     bytes from a remote host. Anything that host can print, it could
  //     get handed to the OS shell: `file:`, `ms-`, a custom protocol
  //     registered by some other installed app. A remote box should not be
  //     able to pick which local program opens.
  //
  // So the scheme is allow-listed, parsing is guarded (a malformed URL
  // throws in the URL constructor rather than falling through), and
  // everything else is dropped with a log rather than silently ignored —
  // a link that does nothing at all is its own bug report.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[pocketshell] refused to open non-web link:', url);
    }
    return { action: 'deny' };
  });

  // A previewed HTML page may contain links, and a link click inside the
  // preview frame is a NAVIGATION rather than a `window.open` — so it does not
  // pass through the handler above.
  //
  // The renderer's CSP already lists `psview:` for `frame-src` and nothing
  // remote, and `frame-src` is checked on every navigation of a nested
  // browsing context, not only its first. This is the belt to that braces, and
  // it is worth having because the two failure modes are so different: a CSP
  // mistake here would mean a remote document could make the app fetch an
  // arbitrary http URL — leaking, at minimum, which file the user is looking
  // at and when. Sub-frames may navigate WITHIN the preview scheme (following
  // a relative link to the page next door is a reasonable thing to want) and
  // nowhere else. The main frame is untouched: that is the app's own routing.
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    if (details.url.startsWith(`${PREVIEW_SCHEME}://`)) return;
    console.warn('[pocketshell] refused preview-frame navigation:', details.url);
    details.preventDefault();
  });

  // Zoom chords. Recognised here, DECIDED in the renderer.
  //
  // Two jobs, and they are inseparable. The first is to catch every spelling
  // of "zoom in" — Ctrl+=, Ctrl+Shift+=, a layout's dedicated +, the numeric
  // keypad's + — which is the reported bug: Electron's default menu binds
  // `CommandOrControl+Plus`, and `Plus` is SHIFTED `=`, so plain Ctrl+= hit
  // nothing while Ctrl+- and Ctrl+0 worked. See src/shared/zoomKeys.ts.
  //
  // The second is `preventDefault()`, which is load-bearing rather than
  // tidy-up: it suppresses the page's keydown AND the menu shortcut, and
  // suppressing the menu shortcut is what stops the default menu's zoom roles
  // driving Chromium's zoom directly, behind the settings store's back. With
  // them live, Ctrl+- would move the window without the store ever hearing
  // about it and the percentage in Settings would be a lie one keystroke
  // later. That is why the intent is forwarded rather than applied here: main
  // does not know the current zoom and must not guess it. The renderer's
  // settings store steps its own value, persists it, and applies it — one
  // value, one writer, no way for the two to disagree.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const zoom = zoomCommandForInput(input);
    if (zoom) {
      event.preventDefault();
      mainWindow?.webContents.send(ipc.win.zoomCommand, zoom);
      return;
    }

    // Window chords, and unlike zoom these are DECIDED here: closing a window
    // and opening DevTools are main's own business, with no renderer state to
    // keep in step. See src/shared/windowKeys.ts for the whole argument —
    // in short, the default menu that used to carry them is gone on Windows
    // and Linux (it had Ctrl+W on Close, which cost the app to a keystroke
    // meant for a text field), and these two are the only entries worth
    // bringing back. `preventDefault()` here is the same instrument as above
    // and cuts the same two ways: it suppresses the page's keydown as well as
    // any accelerator, which is exactly why nothing the terminal uses may be
    // matched.
    const command = windowCommandForInput(input);
    if (!command) return;
    event.preventDefault();
    if (command === 'close') mainWindow?.close();
    else mainWindow?.webContents.toggleDevTools();
  });

  // electron-vite: dev server URL in dev, built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dir, '../renderer/index.html'));
  }
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

/**
 * True only for `http:` and `https:`.
 *
 * Deliberately an allow-list rather than a deny-list of known-bad schemes:
 * the set of protocols an arbitrary Windows install has registered is
 * unknowable from here, so anything not explicitly a web link is refused.
 */
function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
