import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  cleanProjSessions,
  dumpFixtureSessionState,
  ensureHelperUp,
  execInFixture,
  E2E_HOST_NAME,
  HOST_PORT,
  TEST_KEY,
  stopHelper,
} from './helpers';

/**
 * Creating a session in a second folder switches to THAT folder's workspace.
 *
 * Reported live 2026-09-19 from a host where every workspace names its default
 * tag `main`: the create hand-off resolved the destination folder by the bare
 * session name, and the name matched the folder the user was ALREADY reading
 * (their dragged-to-top folder), so the navigation resolved to the route
 * already on screen and nothing visibly happened — "I create a session and it
 * keeps the same session." The lookup now matches workspace + tag
 * (directoryForSession), and this spec pins the shape that broke it: a manual
 * folder arrangement drawing the open folder first, and a second, session-less
 * folder whose first session takes the same default tag.
 *
 * Both folders live under `~/proj` so `cleanProjSessions` scrubs them both:
 * the collision needs two workspaces whose first sessions carry the SAME
 * default tag, and that only holds in workspaces no other run (and no other
 * app instance pointed at the fixture) has claimed a name in.
 */

const appRoot = resolve(__dirname, '..', '..');

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

let originalConfig: string | null = null;

async function launchApp(): Promise<ElectronApplication> {
  const { _electron } = await import('playwright');
  const electron = _electron as unknown as {
    launch(opts: { executablePath: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<ElectronApplication>;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  return electron.launch({
    executablePath: electronPath,
    // A private user-data-dir: the developer's own running instance holds the
    // default profile's single-instance lock, and this spec hand-writes
    // localStorage, so it wants a profile nothing else has touched.
    args: [
      '--no-sandbox',
      `--user-data-dir=${resolve(appRoot, 'test-results', 'create-switch-wrong-folder-profile')}`,
      resolve(appRoot, 'out', 'main', 'index.js'),
    ],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

async function activeTabLabel(page: Page): Promise<string> {
  return ((await page.locator('nav.tabs button.active').textContent()) ?? '').trim();
}

/**
 * The panel's `+` picker, browsed to `row` under $HOME, committed with
 * `Start shell`. The Home crumb makes the browse deterministic: the dialog
 * reopens wherever it last browsed (the projects store's cwd outlives the
 * dialog), and the scenario needs Start shell to act on an exact folder.
 */
async function startShellInFolder(page: Page, row: string): Promise<void> {
  await page.locator('button[title="New session in any folder"]').click();
  await expect(page.locator('.overlay-panel')).toBeVisible();
  await page.locator('.overlay-panel button[title="Home folder"]').click();
  await expect(page.locator('.crumbs')).toContainText('~', { timeout: 20_000 });
  await expect(page.locator('.folder-row', { hasText: row }).first()).toBeVisible({ timeout: 20_000 });
  await page.locator('.folder-row', { hasText: row }).first().click();
  await expect(
    page.locator('.new-session .preview-path', { hasText: `~/${row}` }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Start shell' }).click();
}

/** The panel's current-folder row, by its exact label (`proj`). */
function currentFolderRow(page: Page): ReturnType<Page['locator']> {
  return page.locator('.dir-header.current .label');
}

test.describe('create switches to the created folder', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    await ensureHelperUp();
    // Both folders must be SESSION-less at connect: a leftover session makes
    // the folder a panel root and a claimed name, and neither is the shape
    // under test.
    cleanProjSessions();
    // They exist on disk but have NEVER had a session, so each create below is
    // its workspace's first — the 3d-models shape from the report.
    execInFixture(['mkdir -p "$HOME/proj" "$HOME/proj2"']);
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // The user's arrangement: the folder they read (`~/proj`) is dragged to
    // the top, so the draw order must NOT decide where a create navigates.
    await page.evaluate((hostName) => {
      const key = 'pocketshell.settings.v1';
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(
        key,
        JSON.stringify({ ...parsed, folderOrder: { [hostName]: ['~/proj', '~/proj2'] } }),
      );
    }, E2E_HOST_NAME);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: new RegExp(E2E_HOST_NAME) }).first().click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 40_000 });
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

  test.afterEach(async () => {
    if (test.info().status === 'failed') {
      console.log(dumpFixtureSessionState());
    }
  });

  test('panel + -> Start shell in a second folder lands on THAT folder, new tab in front', async () => {
    test.setTimeout(240_000);

    // First the folder the user is reading: create into `~/proj`, which lands
    // the app in that workspace with its first session — tagged `main`, like
    // every workspace's first session on this host — in front.
    await startShellInFolder(page, 'proj');
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 40_000 });
    await expect(currentFolderRow(page)).toHaveText('proj', { timeout: 40_000 });
    await expect
      .poll(async () => activeTabLabel(page), { timeout: 40_000 })
      .toBe('main');

    // Now the create under test: a second, session-less folder whose first
    // session takes the same default tag. The workspace must switch to
    // `~/proj2` with the created session in front — not stay on the folder
    // that was already open. The current-row highlight is the discriminator:
    // both workspaces' tabs read `main`, so the tab alone cannot say where
    // we are.
    await startShellInFolder(page, 'proj2');
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 40_000 });
    await expect(currentFolderRow(page)).toHaveText('proj2', { timeout: 40_000 });
    await expect
      .poll(async () => activeTabLabel(page), { timeout: 30_000 })
      .toBe('main');
  });
});
