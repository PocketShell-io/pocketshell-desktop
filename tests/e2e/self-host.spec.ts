import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end: the SELF host — this machine, no SSH.
 *
 * The spec seeds one disposable aplexer session (through the `a` CLI, the
 * same binary the app execs), launches the built app, and walks the path a
 * user walks: the picker's `self` row -> connect (no network, no keys) -> the
 * folder workspace lists the session -> clicking it attaches a LOCAL PTY.
 *
 * Skipped entirely on a machine without `a` on PATH — the self host has
 * nothing to list there.
 */

function aOnPath(): boolean {
  try {
    execFileSync('where.exe', ['a'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test.skip(!aOnPath(), 'self host e2e needs the aplexer CLI (`a`) on PATH');

const TAG = `e2e-self-${Date.now().toString(36)}`;

async function launchApp(): Promise<ElectronApplication> {
  const { _electron } = await import('playwright');
  const electron = _electron as unknown as {
    launch(opts: { executablePath: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<ElectronApplication>;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

test.describe('self host (local, no SSH)', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspace: string;
  let sessionId: string;

  test.beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'ps-self-e2e-'));
    const started = execFileSync(
      'a',
      ['start', '--workspace', workspace, '--tag', TAG, '--json'],
      { encoding: 'utf8', timeout: 20_000 },
    );
    sessionId = (JSON.parse(started) as { id: string }).id;

    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    try {
      execFileSync('a', ['kill', sessionId], { stdio: 'ignore', timeout: 15_000 });
    } catch {
      // already gone
    }
    // The killed session's shell may hold the dir a beat; retry the delete.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rmSync(workspace, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  test('the picker lists self as this computer', async () => {
    const row = page.locator('.host-row', { hasText: 'self' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator('.host-detail')).toContainText('This computer');
    await expect(row.locator('.host-detail')).not.toContainText('@');
  });

  test('clicking self connects and lists the seeded session', async () => {
    await page.locator('.host-row', { hasText: 'self' }).first().click();
    // The folder workspace: the seeded session's temp dir is a folder row.
    const folder = page.locator('.dir-header', { hasText: 'ps-self-e2e' });
    await expect(folder).toBeVisible({ timeout: 20_000 });
    await folder.click();
    const sessionButton = page.getByRole('button', { name: TAG, exact: true });
    await expect(sessionButton).toBeVisible({ timeout: 20_000 });
    await sessionButton.click();
    const term = page.locator('.terminal-area > .terminal-slot:visible > .terminal');
    await expect(term).toBeVisible({ timeout: 15_000 });
  });

  test('the new-session browser starts in the real home, never the MSYS spelling', async () => {
    // The regression: home resolved to Git Bash's `/c/Users/...`, which the
    // fs layers read against the current drive — the browser then walked
    // `C:\c\Users\...`, a different (wrong) tree that happens to exist.
    // Back on the session panel (the workspace went full-screen above), the
    // panel's own "any folder" button raises the folder browser.
    await page.locator('.dir-header', { hasText: 'ps-self-e2e' }).click();
    await page.locator('button[title="New session in any folder"]').click();
    const crumbbar = page.locator('.crumbbar');
    await expect(crumbbar).toBeVisible({ timeout: 10_000 });
    await expect(crumbbar).not.toContainText('c\\Users');
    // Land on `~` and stay there: the real home lists without an error, and
    // its crumbs carry no backslash-MSYS hybrid.
    await crumbbar.locator('button[title="Home folder"]').click();
    await page.waitForTimeout(1_000);
    await expect(crumbbar).not.toContainText('c\\Users');
    await expect(page.locator('.browse-error, .error')).toHaveCount(0);
  });
});
