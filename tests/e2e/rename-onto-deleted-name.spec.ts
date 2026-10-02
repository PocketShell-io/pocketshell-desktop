import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  cleanProjSessions,
  ensureHelperUp,
  E2E_HOST_NAME,
  HOST_PORT,
  TEST_KEY,
  dumpFixtureSessionState,
} from './helpers';

/**
 * Renaming a session onto a just-deleted session's name keeps the session.
 *
 * Reported live (repeatedly): create `test`, Stop it, then rename another
 * session in the same folder to `test` — the renamed session VANISHED from the
 * bar and the panel, and only quitting and relaunching brought it back. The
 * store's kill ledger was the cause: a stop files the killed session's
 * workspace+name identity as a tombstone, and every refresh drops fetched rows
 * carrying it. A create reusing the name lifted the grave (addPending), but a
 * RENAME onto that name filed no pending row — the renamed row inherited the
 * deleted session's tombstone instead, and each retry (a rename refused while
 * the host's corpse lingers ends in another stop) re-armed it, which is why
 * the session seemed gone until a restart. `renameLocal` now lifts the grave
 * the same rule a reusing create applies, and this spec pins the shape that
 * broke: stop `test`, rename the spare onto `test`, and the renamed session
 * must stay on the bar across the span the ledger used to own.
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
    // default profile's single-instance lock, and the spec wants a clean
    // localStorage besides.
    args: [
      '--no-sandbox',
      `--user-data-dir=${resolve(appRoot, 'test-results', 'rename-onto-deleted-name-profile')}`,
      resolve(appRoot, 'out', 'main', 'index.js'),
    ],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

async function tabLabels(page: Page): Promise<string[]> {
  return page.locator('nav.tabs button:not(.add)').allTextContents().then((list) =>
    list.map((t) => t.trim()),
  );
}

test.describe('rename onto a deleted name', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    await ensureHelperUp();
    execFileSync(
      'ssh',
      [
        '-i', TEST_KEY,
        '-p', String(HOST_PORT),
        '-o', 'StrictHostKeyChecking no',
        '-o', 'UserKnownHostsFile /dev/null',
        'testuser@127.0.0.1',
        'mkdir -p /home/testuser/proj',
      ],
      { stdio: 'pipe' },
    );
    cleanProjSessions();
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
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
    // The test deliberately leaves the renamed `test` session RUNNING in
    // `~/proj` (that persistence is the point). A live session there is a
    // panel root, and session-nav.spec.ts — next in the serial order — counts
    // folders, so leave the fixture as it was found.
    cleanProjSessions();
    if (originalConfig !== null) {
      writeFileSync(SSH_CONFIG, originalConfig);
    }
  });

  /** Create a session in `~/proj` through the panel's `+` dialog. */
  async function createSessionInProj(): Promise<void> {
    await page.locator('button[title="New session in any folder"]').click();
    await expect(page.locator('.overlay-panel')).toBeVisible();
    // The dialog reopens wherever it last browsed; home makes the target
    // deterministic, and `proj` is a sub-folder of home.
    await page.locator('.overlay-panel button[title="Home folder"]').click();
    await expect(page.locator('.folder-row', { hasText: 'proj' }).first()).toBeVisible({ timeout: 20_000 });
    await page.locator('.folder-row', { hasText: 'proj' }).first().click();
    await expect(
      page.locator('.new-session .preview-path', { hasText: '~/proj' }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Start shell' }).click();
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 40_000 });
    await expect
      .poll(async () => (await tabLabels(page)).join(','), { timeout: 30_000 })
      .toContain('main');
  }

  /** Rename the given tab through the double-click gesture. */
  async function renameTab(from: string, to: string): Promise<void> {
    await page.locator('nav.tabs button', { hasText: from }).first().dblclick();
    const field = page.locator('.rename-input');
    await expect(field).toBeVisible();
    await field.fill(to);
    await field.press('Enter');
    await expect
      .poll(async () => (await tabLabels(page)).join(','), { timeout: 15_000 })
      .toContain(to);
  }

  test('stopped test, then renamed main to test, comes back within the ledger TTL', async () => {
    test.setTimeout(360_000);
    // The first create IS the navigation: it opens the `~/proj` workspace with
    // the created session in front (a wiped `proj` has no panel row to click).
    await createSessionInProj();
    await expect(page.locator('nav.tabs button.active')).toBeVisible({ timeout: 40_000 });
    await renameTab('main', 'test');

    // Delete `test` through the tab's stop confirm.
    await page.locator('.tab-close[title="Stop this session"]').first().click();
    await expect(page.locator('.stop-confirm')).toBeVisible();
    await page.locator('.stop-confirm .btn-danger').click();
    await expect
      .poll(async () => (await tabLabels(page)).join(','), { timeout: 30_000 })
      .not.toContain('test');

    // Session B: create again (the free name is `main` once more), rename it
    // onto the deleted name. The rename lifts the tombstone (renameLocal's
    // addPending rule), so the row survives every refresh from here on —
    // before the lift, the very next poll tick swallowed it.
    await createSessionInProj();
    await renameTab('main', 'test');

    // The renamed session must PERSIST across the span the kill ledger used
    // to own (KILLED_TTL_MS plus several poll ticks) — not flicker back.
    await page.waitForTimeout(10_000);
    expect(await tabLabels(page)).toContain('test');
    await page.waitForTimeout(25_000);
    expect(await tabLabels(page)).toContain('test');
  });

  test.afterEach(async () => {
    if (test.info().status === 'failed') {
      console.log(dumpFixtureSessionState());
    }
  });
});
