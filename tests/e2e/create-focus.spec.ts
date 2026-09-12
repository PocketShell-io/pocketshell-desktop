import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resetWorkspaceState, ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * Keyboard focus after creating a session.
 *
 * The user report: "when I click create a new session or new shell, the
 * screen doesn't focus on that shell." Both create surfaces are driven here
 * the way a user drives them — the folder workspace's `+` -> "New session…"
 * -> "Create session", and the session panel's `+` -> "Start shell" — and the
 * assertion is the DOM truth about the keyboard: `document.activeElement`
 * must be the new pane's xterm textarea once the tab is in front.
 *
 * Where focus IS, is diagnosable rather than assertable blind: on failure the
 * active element is dumped so the fix aims at what actually holds the
 * keyboard.
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

let originalConfig: string | null = null;

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
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  });
}

/** What holds the keyboard right now, as something a failure can name. */
function focusSnapshot(page: Page): Promise<{ tag: string; cls: string; title: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? 'none',
      cls: el?.getAttribute('class') ?? '',
      title: el?.closest('button')?.getAttribute('title') ?? el?.getAttribute('title') ?? '',
    };
  });
}

/** The pane actually on screen — DOM order is visit order, so `.first()` can be a hidden one. */
function visibleTerminal(page: Page): ReturnType<Page['locator']> {
  return page.locator('.terminal-area > .terminal-slot:visible > .terminal');
}

async function activeTabLabel(page: Page): Promise<string> {
  return (await page.locator('nav.tabs button.active').textContent()) ?? '';
}

/** Connect to the fixture host and open its first folder workspace. */
async function openFirstFolderWorkspace(page: Page): Promise<void> {
  if ((await page.locator('.dir-header').count()) === 0) {
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 20_000 });
  }
  await page.locator('.dir-header').first().click();
  await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 20_000 });
  await expect(visibleTerminal(page)).toBeVisible({ timeout: 20_000 });
}

test.describe('keyboard focus after creating a session', () => {
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
    await resetWorkspaceState(page);
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

  test('workspace + -> New session -> Create session lands the keyboard in the new pane', async () => {
    await openFirstFolderWorkspace(page);

    // Real-host timing: the create round trip and the pane's join each take
    // seconds, so every focus decision that used to race them is visible here.
    // The fixture is instant and would hide a focus loss that only exists in
    // the gaps.
    await page.evaluate(() => {
      const api = (window as unknown as {
        api: Record<string, Record<string, (...a: unknown[]) => unknown>>;
      }).api;
      const delay = <T>(ms: number, value: T): Promise<T> =>
        new Promise<T>((r) => setTimeout(() => r(value), ms));
      const wrap = (obj: Record<string, (...a: unknown[]) => unknown>, name: string): void => {
        const orig = obj[name];
        obj[name] = (...a: unknown[]) => delay(1_500, orig.apply(obj, a));
      };
      wrap(api.projects, 'startSession');
      wrap(api.shell, 'attachSession');
      wrap(api.shell, 'open');
    });

    // The folder's first tab joins before anything is created; the create
    // below then has a bar with a selection to move OFF of.
    const before = await activeTabLabel(page);

    await page.locator('button.add').click();
    await page.getByRole('button', { name: 'New session…' }).click();
    await expect(page.locator('.overlay-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Create session' }).click();

    // The new tab exists and is in front.
    await expect
      .poll(async () => activeTabLabel(page), { timeout: 20_000 })
      .not.toBe(before);
    await expect(visibleTerminal(page)).toBeVisible();

    // Sample the keyboard for a while: the create round trip, the selection,
    // and the join's completion each get a say, and any of them may move it.
    const timeline: { t: number; focus: { tag: string; cls: string; title: string } }[] = [];
    for (let i = 0; i < 16; i += 1) {
      timeline.push({ t: i * 250, focus: await focusSnapshot(page) });
      await page.waitForTimeout(250);
    }
    const last = timeline[timeline.length - 1].focus;
    expect(
      last.cls.includes('xterm-helper-textarea'),
      `keyboard should stay in the pane; focus timeline was ${JSON.stringify(timeline)}`,
    ).toBe(true);
  });

  test('panel + -> Start shell lands the keyboard in the created tab', async () => {
    await openFirstFolderWorkspace(page);

    // The panel's own `+` (the general one) opens the folder-first dialog.
    await page.locator('button[title="New session in any folder"]').click();
    await expect(page.locator('.overlay-panel')).toBeVisible();

    // The dialog opens on the `existing` route, browsed to the panel's start
    // folder; `Start shell` commits and the hand-off navigates to the folder
    // workspace with ?tab=<the created session>.
    await page.getByRole('button', { name: 'Start shell' }).click();

    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);

    const settled = await focusSnapshot(page);
    expect(
      settled.cls.includes('xterm-helper-textarea'),
      `keyboard should be in the created pane; focus was ${JSON.stringify(settled)}`,
    ).toBe(true);
  });
});
