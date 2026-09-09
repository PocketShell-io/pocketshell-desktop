import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resetWorkspaceState, ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * End-to-end test for the restructured navigation and the terminal wiring.
 *
 * Nav: host picker -> host (persistent folder panel on the left, no host-level
 * tab bar) -> click a FOLDER -> its workspace fills the right pane with one tab
 * per tmux session in the folder — no Files tab until something asks for one —
 * while the panel stays put -> close the folder -> back to the host list. Port
 * forwarding and Provider usage are host header icons that open overlays, one
 * click each.
 *
 * Terminal: switching between the fixture's two sessions repeatedly used to
 * stack an extra xterm `onData`/`onResize` handler per switch, so tmux's
 * `ESC[>c` device-attributes probe was answered N times and the surplus
 * `0;276;0c` replies were echoed into the shell. The regression assertion
 * below reads the xterm DOM rows and requires that string to be absent.
 *
 * SAFETY: same guarded ~/.ssh/config seeding as core-flow.spec.ts — only runs
 * backing the file up first, and restores the original on teardown.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e-nav (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e-nav (temporary) <<<';
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
    launch(opts: {
      executablePath: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    }): Promise<ElectronApplication>;
  };
  // `require('electron')` resolves to the real binary (electron.exe on Windows).
  // Pointing at electron/cli.js instead makes launch fail with "Process failed
  // to launch!", which is why core-flow.spec.ts cannot start the app today.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    // Linux CI needs --no-sandbox: the runner allows no setuid sandbox and
// no unprivileged user namespaces, so the stock launcher dies instantly.
// The switch is understood (and a no-op) on Windows and macOS too.
args: ['--no-sandbox', mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

/** Text currently rendered in the terminal's DOM rows. */
async function terminalText(page: Page): Promise<string> {
  return page.locator('.terminal-area .terminal-slot:visible .xterm-rows').first().innerText();
}

// Serial: the tests walk one app through a single navigation journey, so a
// failure must skip the rest rather than restart the worker and re-run
// beforeAll against a half-seeded config.
test.describe.configure({ mode: 'serial' });

test.describe('session-scoped navigation + terminal wiring', () => {

  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    await ensureHelperUp();
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    mkdirSync(dirname(SSH_CONFIG), { recursive: true }); // ~/.ssh may not exist yet (fresh CI runners).
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await resetWorkspaceState(page);
    await page.getByText(E2E_HOST_NAME).click();
    // The host's default view is the folder panel - no tab bar at host level,
    // and no session rows either; folders are the level.
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    if (originalConfig !== null) writeFileSync(SSH_CONFIG, originalConfig);
    stopHelper();
  });

  test('the host shows a two-level folder panel and no host-level tabs', async () => {
    // The panel is `root -> folder`, TWO levels, always.
    // Both fixture sessions sit in $HOME ITSELF, which has no root folder to be
    // named after, so the whole fixture lands in the `other` bucket as ONE
    // folder row holding two sessions.
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.folder-header')).toHaveCount(1);
    await expect(page.locator('.folder-header .folder-label')).toHaveText('other');
    await expect(page.locator('.folder-header .folder-count')).toHaveText('2');
    await expect(page.locator('.dir-header')).toHaveCount(1);
    // `$HOME` itself: the folder key collapses to `~`, so the row takes
    // `defaultLabelForPath`'s named fallback rather than the account name.
    await expect(page.locator('.dir-header .label')).toHaveText('~ (home)');
    // THE SESSION LEVEL IS GONE. Not conditionally, not for this fixture —
    // there is no session row in the panel at any depth, for any folder.
    await expect(page.locator('.session-row')).toHaveCount(0);
    // Two sessions behind one row, said once, by the count.
    await expect(page.locator('.dir-header .folder-count')).toHaveText('2');
    // The `attached` tag stays retired — the dot, the weight and the sort say it.
    await expect(page.locator('.dir-header .tag')).toHaveCount(0);
    // Files is NOT a host-level tab.
    await expect(page.locator('.workspace > .body > nav.tabs')).toHaveCount(0);
    // Nothing selected yet -> the right pane shows the placeholder.
    await expect(page.locator('.session-placeholder')).toBeVisible();
  });

  test('Port forwarding and Provider usage are header icons that open overlays', async () => {
    // Each overlay answers to its OWN button — one click, no menu. The
    // names are the buttons' tooltips, as they were for every trigger this
    // strip has had.
    await page.getByRole('button', { name: 'Port forwarding' }).click();
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Provider usage' }).click();
    await expect(page.getByRole('dialog', { name: 'Provider usage' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Provider usage' })).toHaveCount(0);
  });

  test('selecting a folder fills the right pane and keeps the panel visible', async () => {
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 15_000 });
    // One tab per session in the folder, and NO Files tab: one appears only
    // when something asks for it (the `+` menu, the file tree, a path clicked
    // in the terminal). Neither fixture session is named after `$HOME` (`main`,
    // `build` vs a derived `home-testuser`), so both keep their own names.
    await expect(page.getByRole('button', { name: 'main', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'build', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
    // The Conversation tab is gone with the feature.
    await expect(page.getByRole('button', { name: 'Conversation' })).toHaveCount(0);
    await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible({ timeout: 15_000 });
    // The panel is persistent, and it marks the open FOLDER — one row, however
    // many session tabs the workspace is showing.
    await expect(page.locator('.session-panel')).toBeVisible();
    await expect(page.locator('.dir-header.current')).toHaveCount(1);
  });

  test('the Files tab is per-folder and the terminal survives switching to it', async () => {
    // No Files tab is standing, so this opens one the way the user does: the
    // tab bar's `+`, then "New Files tab".
    await page.getByTitle('New session or Files tab').click();
    await page.getByRole('button', { name: 'New Files tab' }).click();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.locator('.files')).toBeVisible({ timeout: 15_000 });
    // v-show, not v-if: unmounting the terminal would close the SSH shell and
    // drop the tmux attach.
    await expect(page.locator('.terminal-area')).toBeHidden();
    await page.getByRole('button', { name: 'main', exact: true }).click();
    await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible();
  });

  test('there is a way back to hosts', async () => {
    // The tab strip's "Close folder" `×` is gone — the user asked for that whole
    // end of the strip to go. Nothing is lost: the
    // session panel is persistent, so another folder row switches workspace
    // directly and its back arrow leaves the host, which is what this asserts.
    // The only state no longer reachable is the placeholder pane once a folder
    // has been picked, and nobody navigates to that on purpose.
    await expect(page.locator('.folder-workspace')).toBeVisible();
    await page.getByTitle('Back to hosts').click();
    await expect(page.getByText(E2E_HOST_NAME)).toBeVisible();
    // Return to the host for the remaining tests.
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 15_000 });
  });

  test('the session panel collapses and reappears', async () => {
    await page.getByTitle('Hide session panel').click();
    await expect(page.locator('.session-panel')).toBeHidden();
    await page.getByTitle('Show session panel').click();
    await expect(page.locator('.session-panel')).toBeVisible();
  });

  test('repeated session switching leaves no duplicated DA2 replies', async () => {
    // Switching is now a TAB switch rather than a panel selection, but it goes
    // through the same `session-key` change on the same TerminalView, which is
    // the code path this regression lives in.
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < 4; i += 1) {
      const target = i % 2 === 0 ? 'main' : 'build';
      await page.getByRole('button', { name: target, exact: true }).click();
      await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1200);
    }

    await page.getByRole('button', { name: 'main', exact: true }).click();
    await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);
    expect(await terminalText(page)).not.toContain('0;276;0c');

    // One keystroke must reach the shell exactly once. `echo` a sentinel and
    // assert the echoed command line is not duplicated on the same row.
    await page.locator('.terminal-area > .terminal-slot:visible > .terminal').first().click();
    await page.keyboard.type('echo nav_sentinel_ok', { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const text = await terminalText(page);
    expect(text).toContain('nav_sentinel_ok');
    expect(text).not.toContain('echo nav_sentinel_okecho');
    expect(text).not.toContain('0;276;0c');
  });

  test('selecting terminal text copies it on mouse-up', async () => {
    // Seed the clipboard with a sentinel so we can tell "copied" from "unchanged".
    await app.evaluate(({ clipboard }) => clipboard.writeText('__not_copied__'));

    const row = page.locator('.terminal-area .terminal-slot:visible .xterm-rows > div', { hasText: 'nav_sentinel_ok' }).first();
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    // Drag across the row to select it.
    await page.mouse.move(box!.x + 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height / 2, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toContain('nav_sentinel_ok');
  });

  test('a click that clears the selection does not blank the clipboard', async () => {
    await page.mouse.click(400, 400);
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('nav_sentinel_ok');
  });

  test('the right-click pastes the clipboard into the shell', async () => {
    // The right-click, not Ctrl+Shift+V. That chord pasted here until a user
    // reported reaching for it and having the clipboard go to the shell instead
    // of the composer; both paste CHORDS belong to the composer now, and the
    // mouse is the whole of the shell's paste.
    await app.evaluate(({ clipboard }) => clipboard.writeText('paste_probe_42'));
    await page.locator('.terminal-area > .terminal-slot:visible > .terminal').first().click({ button: 'right' });
    await expect
      .poll(() => terminalText(page), { timeout: 5_000 })
      .toContain('paste_probe_42');
  });

  test('Ctrl+Shift+V puts the clipboard in the composer, not in the shell', async () => {
    // The reported defect, end to end. The draft is what must receive it, and
    // the pane must NOT — which is the half a jsdom unit test cannot prove,
    // since jsdom performs no default action and so cannot produce the second,
    // browser-driven paste this chord is capable of.
    await app.evaluate(({ clipboard }) => clipboard.writeText('composer_probe_77'));
    await page.locator('.terminal-area > .terminal-slot:visible > .terminal').first().click();
    await page.keyboard.press('Control+Shift+V');
    await expect(page.locator('.composer .draft')).toHaveValue(/composer_probe_77/, {
      timeout: 5_000,
    });
    expect(await terminalText(page)).not.toContain('composer_probe_77');
  });
});
