import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  resetWorkspaceState, ensureHelperUp,
  execInFixture,
  seedProjectFolders,
  E2E_HOST_NAME,
  HOST_PORT,
  TEST_KEY,
  stopHelper,
} from './helpers';

/**
 * End-to-end test for folder-first session creation and the rebuilt port panel.
 *
 * The session panel used to end in a bare "new session name" text field. That
 * had the model backwards: a session belongs to a project FOLDER and its name
 * is derived from that folder, so a typed name produced sessions no other
 * PocketShell client could group. The field is gone; this spec asserts it is
 * gone and that the three folder routes replacing it work end to end against
 * the real helper (0.4.44) on the Docker fixture.
 *
 * Two fixture facts this spec leans on deliberately:
 *   - `seedProjectFolders()` creates `~/git/demo-repo` and `~/git/Hello-World`
 *     so the browser and the repo list both have real rows. It runs in
 *     `beforeAll`, not once: the helper IMAGE ships no `~/git`, and
 *     `ensureHelperUp` recreates the container whenever the image changes;
 *   - it ships NO `gh`, which is a NORMAL state — `reposList` still returns
 *     ok, the local clones still render, and the UI owes a hint rather than an
 *     error. That is asserted rather than worked around.
 *
 * SAFETY: same guarded ~/.ssh/config seeding as core-flow.spec.ts — only runs
 * backing the file up first, and restores the original on teardown.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e-projects (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e-projects (temporary) <<<';
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

/**
 * Unique per run. The compose container survives a `stop`/`up` cycle, so a
 * fixed name would already have its folder — and, if `afterAll` did not get to
 * run, its session — on the second run. The dialog asks for a `unique` name, so
 * the host would answer with `<name>-2` while the picker had previewed
 * `<name>`, and the assertion that the session which opened is the one that was
 * previewed would fail for a reason that has nothing to do with the code.
 */
const PROJECT_FOLDER = `e2e-proj-${Date.now().toString(36)}`;

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
  // `require('electron')` resolves to the real binary path (electron.exe on
  // Windows); the ESM import does not, and electron/cli.js is not launchable.
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

// Serial: one app walks one journey; a failure must skip the rest rather than
// restart the worker and re-seed a half-written config.
test.describe.configure({ mode: 'serial' });

test.describe('folder-first session creation + port panel controls', () => {

  let app: ElectronApplication;
  let page: Page;
  /** The name the dialog previewed, captured so the outcome can be matched. */
  let previewedName = '';

  test.beforeAll(async () => {
    await ensureHelperUp();
    seedProjectFolders();
    originalConfig = existsSync(SSH_CONFIG) ? readFileSync(SSH_CONFIG, 'utf8') : '';
    mkdirSync(dirname(SSH_CONFIG), { recursive: true }); // ~/.ssh may not exist yet (fresh CI runners).
    appendFileSync(SSH_CONFIG, `\n${SEED_BLOCK}\n`);
    app = await launchApp();
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await resetWorkspaceState(page);
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    // Put the fixture back to its two seeded sessions. The container survives
    // a stop/start, so a session left running here would show up as a third
    // row in session-nav.spec.ts, which counts them. The create went through
    // the app's MAIN path — aplexer, on a host with `a` — so the cleanup aims
    // there, not at tmux; the settle sleep lets the worker die before `forget`
    // drops the record (an existing record would make the next run's
    // `a start` for this folder refuse the tag).
    try {
      execInFixture([
        previewedName
          ? `a kill --workspace "$HOME" --tag "${previewedName}" --signal KILL --grace-ms 500 2>/dev/null || true`
          : 'true',
        previewedName ? 'sleep 1' : 'true',
        previewedName
          ? `a forget --workspace "$HOME" --tag "${previewedName}" --force 2>/dev/null || true`
          : 'true',
        `rm -rf "$HOME/${PROJECT_FOLDER}"`,
      ]);
    } catch {
      // Best effort: the container may already be gone.
    }
    if (originalConfig !== null) writeFileSync(SSH_CONFIG, originalConfig);
    stopHelper();
  });

  test('the bare "new session name" field is gone', async () => {
    // The footer is a button that opens the folder picker, not a text field.
    await expect(page.locator('.new-session input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New session in any folder' })).toBeVisible();
  });

  test('the picker offers three folder routes and previews the derived name', async () => {
    await page.getByRole('button', { name: 'New session in any folder' }).click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Existing folder' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'New folder' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Clone from GitHub' })).toBeVisible();

    // The browser lands on $HOME and the name preview is populated before
    // anything is committed — the whole point of deriving rather than typing.
    await expect(page.locator('.crumbs')).toContainText('~');
    await expect(page.locator('.preview-name')).not.toHaveText('—', { timeout: 20_000 });
  });

  test('browsing a folder re-derives the name from the path', async () => {
    await page.locator('.folder-row', { hasText: 'git' }).first().click();
    await expect(page.locator('.folder-row', { hasText: 'demo-repo' })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('.folder-row', { hasText: 'demo-repo' }).first().click();
    // `~/git/demo-repo` -> `git-demo-repo`, the same rule tmuxctl and the
    // Android app apply.
    await expect(page.locator('.preview-name')).toHaveText('git-demo-repo', { timeout: 20_000 });
    await expect(page.locator('.preview-path')).toContainText('~/git/demo-repo');
  });

  test('a host with no gh still lists local clones, with a hint not an error', async () => {
    await page.getByRole('tab', { name: 'Clone from GitHub' }).click();
    // The fixture has git but no GitHub CLI: `ok` stays true, the remote scope
    // is empty, and the local scan is unaffected.
    await expect(page.locator('.repo-row', { hasText: 'demo-repo' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.repos .hint')).toContainText('GitHub CLI');
    // A hint, never a failure dialog.
    await expect(page.locator('.repos .error')).toHaveCount(0);
    // A repo already on disk needs no clone, and the UI says so.
    await page.locator('.repo-row', { hasText: 'demo-repo' }).first().click();
    await expect(page.locator('.repos')).toContainText('Already on the host');
  });

  test('the new-folder route creates the folder and opens the session, with no second click', async () => {
    await page.getByRole('tab', { name: 'Existing folder' }).click();
    // Back to $HOME so the folder lands somewhere predictable.
    await page.getByTitle('Home folder').click();
    await expect(page.locator('.crumbs')).toContainText('~', { timeout: 20_000 });

    await page.getByRole('tab', { name: 'New folder' }).click();
    await page.locator('input[placeholder="my-project"]').fill(PROJECT_FOLDER);
    await expect(page.locator('.preview-path')).toContainText(PROJECT_FOLDER, { timeout: 20_000 });
    previewedName = (await page.locator('.preview-name').innerText()).trim();
    expect(previewedName).toContain(PROJECT_FOLDER);

    // `Start shell`, not `Start session…`. The primary button chains to the
    // AGENT step (docs/SESSIONLIST.md §13) — a second `OverlayPanel` that is
    // also titled "New session" — and this test is about what a COMMIT answers
    // with, not about the chain. `Start shell` is the one-click commit, and the
    // chain's own commit lands in exactly the same `commit()` tail
    // (tests/unit/NewSessionDialog.test.ts covers the park-then-navigate order
    // that only the agent route has).
    await page.getByRole('button', { name: 'Start shell' }).click();

    // A create that works no longer answers with a receipt. The dialog closes
    // itself and the app lands in the new session's FOLDER workspace, with that
    // session's tab selected and the panel highlighting the folder — no
    // "Started …" banner in between, and nothing to press.
    await expect(page.getByRole('dialog', { name: 'New session' })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(page.locator('.result-banner')).toHaveCount(0);
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.dir-header.current')).toHaveCount(1);
    await expect(page.locator('.tab.active')).toBeVisible();
    // The session that opened is the one the picker previewed. Asserted on the
    // tooltip rather than the tab's text: a tab strips the folder's own prefix
    // from its label, so the only session in `~/<PROJECT_FOLDER>` is labelled
    // `main` (shared/workspaceTabs.ts) and the full name lives in `title`.
    await expect(page.locator('.tab.active')).toHaveAttribute(
      'title',
      new RegExp(previewedName),
    );
  });

  test('the port panel shows discovered ports with process and folder columns', async () => {
    // Unrelated to the create flow, and repaired only so this spec can finish:
    // the panel's foot row of labelled buttons is gone, and Ports has its own
    // header icon (renderer/hostPanels.ts) whose accessible name is its
    // `title` — one click since §5.3e, no kebab to open first.
    await page.getByRole('button', { name: 'Port forwarding' }).click();
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toBeVisible();

    // Normalise the toggle. Auto-forward is PERSISTED per host (PortfwdStore),
    // so a previous suite run legitimately leaves it on and the assertions
    // below — which are about the un-forwarded state — would otherwise depend
    // on run order rather than on the code.
    if (await page.getByRole('button', { name: 'Auto-forward: ON' }).count()) {
      await page.getByRole('button', { name: 'Auto-forward: ON' }).click();
      await expect(page.getByRole('button', { name: 'Auto-forward: OFF' })).toBeVisible({
        timeout: 20_000,
      });
    }

    for (const column of ['Port', 'Name', 'Local', 'Process', 'Folder', 'Status', 'In', 'Out']) {
      await expect(page.locator('.fwd-table thead')).toContainText(column);
    }

    // sshd is always listening on the fixture, so the port-22 row must arrive
    // even with auto-forward off. The scan runs asynchronously and may first
    // publish the traffic listener only, so wait for the specific row before
    // deciding whether its disclosure row needs opening.
    const port22 = page
      .locator('.fwd-table tbody tr')
      .filter({ has: page.locator('.c-port .port-num', { hasText: /^22$/ }) })
      .first();
    await expect(port22).toHaveCount(1, { timeout: 30_000 });
    if (!(await port22.isVisible())) {
      const more = page.locator('.more-btn');
      await expect(more).toBeVisible({ timeout: 30_000 });
      await more.click();
    }
    await expect(port22).toBeVisible({ timeout: 30_000 });

    // Every discovered row carries the per-row controls, whether or not it is
    // currently forwarded — that is what makes a port above maxAutoPort
    // reachable at all.
    const first = page.locator('.fwd-table tbody tr').first();
    await expect(first.locator('.c-name .cell-input')).toBeEnabled();
    await expect(first.locator('.c-local .cell-input')).toBeEnabled();
    // A discovered local port has one action: force it on. The remove mark is
    // reserved for unkeyed -R/-D forwards, which have no remote port to toggle.
    await expect(first.locator('.actions .icon-btn')).toHaveCount(1);
    await expect(first.locator('.actions .icon-btn').first()).toBeEnabled();
    await expect(first.locator('.actions .icon-btn').first()).toHaveAttribute(
      'title',
      'Force this port on',
    );
  });

  test('auto-forward turns on without a structured-clone failure', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The previous test left the toggle OFF, so this is the OFF -> ON
    // transition — the one that carries the ssh-config LocalForward list
    // across the bridge. Passing the Pinia proxy straight through used to fail
    // structured cloning and kill the toggle silently, with nothing on screen
    // to say so.
    await page.getByRole('button', { name: 'Auto-forward: OFF' }).click();
    await expect(page.getByRole('button', { name: 'Auto-forward: ON' })).toBeVisible({
      timeout: 20_000,
    });
    expect(errors.join('\n')).not.toContain('could not be cloned');

    // Leave the host as we found it, since the setting outlives the run.
    await page.getByRole('button', { name: 'Auto-forward: ON' }).click();
    await expect(page.getByRole('button', { name: 'Auto-forward: OFF' })).toBeVisible({
      timeout: 20_000,
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Port forwarding' })).toHaveCount(0);
  });
});
