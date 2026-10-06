import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * End-to-end test: the app holds ONE process and SEVERAL workspace windows.
 *
 * A second launch of the binary is answered by the running instance with a
 * NEW window (the single-instance lock makes the new process a courier that
 * quits after handing over its argv), and that window may name its host —
 * `PocketShell.exe win35` opens a window that dials win35 at launch. A name
 * that is not in the host list still opens the window, on the picker, with
 * the banner saying why. The picker's New-window button is the in-app route
 * to the same place.
 *
 * Every window this spec opens stays on the PICKER: the secondary-window
 * marker (`?window=workspace`) stands down from the stored-default
 * auto-connect, so no test here dials anything and no session state is
 * needed beyond the seeded config entry. (The core-flow spec covers the
 * connect itself.)
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e (temporary) <<<';
const SEED_BLOCK = [
  BEGIN_MARKER,
  `Host ${E2E_HOST_NAME}`,
  `  HostName 127.0.0.1`,
  `  Port ${HOST_PORT}`,
  `  User testuser`,
  `  IdentityFile ${TEST_KEY}`,
  `  StrictHostKeyChecking no`,
  `  UserKnownHostsFile /dev/null`,
  END_MARKER,
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

let originalConfig: string | null = null;

async function launchApp(): Promise<ElectronApplication> {
  const { _electron } = await import('playwright');
  const electron = _electron as unknown as {
    launch(opts: { executablePath: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<ElectronApplication>;
  };
  return electron.launch({
    executablePath: electronPath,
    // See core-flow.spec.ts: --no-sandbox is for the Linux CI runner.
    args: ['--no-sandbox', mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

/**
 * Launch the binary AGAIN while the app is running. The courier process
 * loses the single-instance lock and quits; its argv is what the running
 * app sees. Fire-and-forget: the assertion is on the WINDOW the running app
 * opens, not on the courier's exit.
 */
function launchSecondInstance(extraArgs: string[]): void {
  spawn(electronPath, ['--no-sandbox', mainPath, ...extraArgs], {
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

/** The window the running app opened in response, identified by exclusion. */
async function newWindow(app: ElectronApplication, before: number): Promise<Page> {
  let pages = app.windows();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(before + 1);
  pages = app.windows();
  const win = pages[pages.length - 1]!;
  await win.waitForLoadState('domcontentloaded');
  return win;
}

test.describe('multi-window (second launch, named host, New-window button)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    await ensureHelperUp();
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    mkdirSync(dirname(SSH_CONFIG), { recursive: true });
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // The picker lists hosts on mount; wait for the seeded row before any
    // test counts windows or clicks anything.
    await expect(page.getByText(E2E_HOST_NAME).first()).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    if (originalConfig !== null) {
      writeFileSync(SSH_CONFIG, originalConfig);
    }
    stopHelper();
  });

  test('a second launch of the binary opens another workspace window on the picker', async () => {
    const before = app.windows().length;
    launchSecondInstance([]);
    const win = await newWindow(app, before);
    // A plain second window carries the secondary marker: the picker is
    // there, and the stored-default auto-connect is NOT what brought us
    // here — the seeded row is visible because the picker loaded it.
    await expect(win.getByText(E2E_HOST_NAME).first()).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText('(your default host)')).toHaveCount(0);
  });

  test('a second launch naming an unknown host opens on the picker with the banner', async () => {
    const before = app.windows().length;
    launchSecondInstance(['ghost-host']);
    const win = await newWindow(app, before);
    // The window exists, is on the picker, and SAYS why the requested host
    // is not in front of the user.
    await expect(win.getByText('This window was opened for')).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText('ghost-host').first()).toBeVisible();
    await expect(win.getByText(E2E_HOST_NAME).first()).toBeVisible({ timeout: 10_000 });
  });

  test("the picker's New-window button opens a window too", async () => {
    const before = app.windows().length;
    await page.getByRole('button', { name: 'Open a new window' }).click();
    const win = await newWindow(app, before);
    await expect(win.getByText(E2E_HOST_NAME).first()).toBeVisible({ timeout: 10_000 });
  });
});
