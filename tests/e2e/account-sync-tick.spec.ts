import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * pocketshell#3072 in the real app: after Check account, a host that is both
 * in ~/.ssh/config and in the sync account reads "In account", ticked — not
 * "In account · remove on sync" — and an untouched Sync now keeps it in the
 * account. Only an explicit untick shows "remove on sync" and removes it.
 *
 * Everything the user sees is real: the built Electron app, its preload and
 * IPC bridge, the shared renderer (core's AccountView and sync store) in the
 * real Account window. Only the network end is faked: the main-process
 * `sync:*` handlers are swapped for an in-memory account (no Google sign-in,
 * no sync Lambda), the same seam a scripted api is in the unit suite. The app
 * runs under a throwaway HOME, so it reads a seeded ~/.ssh/config and its own
 * userData without touching the developer's. No Docker is needed.
 *
 * Screenshots land in the test's output dir, and also in
 * $PS_E2E_SCREENSHOT_DIR when set.
 */

const ACCOUNT = [
  { name: 'hetzner', hostname: 'hetzner.example.net', port: 22, user: 'alexey' },
  { name: 'fixture', hostname: 'fixture.other.machine', port: 22, user: 'alexey' },
];

let home: string;
let app: ElectronApplication;

async function launchApp(): Promise<ElectronApplication> {
  const { _electron } = await import('playwright');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return (_electron as unknown as {
    launch(opts: { executablePath: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<ElectronApplication>;
  }).launch({
    executablePath: electronPath,
    args: ['--no-sandbox', mainPath],
    env: { ...process.env, HOME: home, NODE_ENV: 'production' },
  });
}

/** Replace main's sync handlers with an in-memory, signed-in account. */
async function fakeSyncBackend(electronApp: ElectronApplication, hosts: unknown[]): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, initial) => {
    const state = { hosts: initial as Array<{ name: string }>, version: 3, cache: null as unknown[] | null };
    (globalThis as Record<string, unknown>)['__fakeAccount'] = state;
    const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_evt, ...args) => fn(...args));
    };
    handle('sync:status', () => ({ loggedIn: true, email: 'e2e@example.test', keychainAvailable: true }));
    handle('sync:login', () => 'e2e@example.test');
    handle('sync:logout', () => undefined);
    handle('sync:accountHosts', () => state.cache);
    handle('sync:pull', () => {
      state.cache = state.hosts;
      return { kind: 'ok', version: state.version, plaintext: JSON.stringify({ hosts: state.hosts }) };
    });
    handle('sync:push', (_slot, plaintext, _passphrase, baseVersion) => {
      if (baseVersion !== state.version) return { kind: 'conflict', currentVersion: state.version };
      state.hosts = (JSON.parse(plaintext as string) as { hosts: Array<{ name: string }> }).hosts;
      state.cache = state.hosts;
      state.version += 1;
      return { kind: 'ok', version: state.version };
    });
  }, hosts);
}

async function accountNames(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() =>
    ((globalThis as Record<string, unknown>)['__fakeAccount'] as { hosts: Array<{ name: string }> }).hosts.map((h) => h.name));
}

async function shot(page: Page, name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const extra = process.env['PS_E2E_SCREENSHOT_DIR'];
  if (extra) {
    mkdirSync(extra, { recursive: true });
    await page.screenshot({ path: join(extra, `${name}.png`), fullPage: true });
  }
}

function row(page: Page, alias: string) {
  return page.locator('.account-host-row').filter({ has: page.locator('.host-alias', { hasText: new RegExp(`^${alias}$`) }) });
}

test.describe('Account & sync tick rule (#3072)', () => {
  test.beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ps-e2e-account-'));
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'config'), [
      'Host hetzner',
      '  HostName hetzner.example.net',
      '  User alexey',
      '',
      'Host other',
      '  HostName other.example.net',
      '  User alexey',
      '',
    ].join('\n'));
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test.afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('an overlapping host is kept by an untouched Sync now; only an untick removes it', async () => {
    app = await launchApp();
    await fakeSyncBackend(app, ACCOUNT);
    const picker = await app.firstWindow();
    await picker.waitForLoadState('domcontentloaded');

    const accountWindow = app.waitForEvent('window');
    await picker.evaluate(() => (window as unknown as { api: { win: { openAccount(): Promise<void> } } }).api.win.openAccount());
    const account = await accountWindow;
    await account.waitForLoadState('domcontentloaded');
    await expect(account.locator('h1', { hasText: 'Account & sync' })).toBeVisible();

    // The user's own earlier choice: tick `other` to sync it.
    await expect(row(account, 'other')).toBeVisible();
    await row(account, 'other').locator('input[type=checkbox]').check();

    await account.locator('.passphrase-field input').fill('correct horse');
    await account.getByRole('button', { name: 'Check account' }).click();
    await expect(account.getByText('Your account has 2 synced hosts.')).toBeVisible();

    // The reported bug: hetzner (config + account) read "remove on sync".
    await expect(row(account, 'hetzner').locator('.status-chip')).toHaveText('In account');
    await expect(row(account, 'hetzner').locator('input[type=checkbox]')).toBeChecked();
    await expect(account.getByText('remove on sync')).toHaveCount(0);
    await shot(account, '1-after-check-account-overlap-ticked');

    // Untouched Sync now keeps it in the account.
    await account.getByRole('button', { name: 'Sync now' }).click();
    await expect(account.locator('.account-message')).toContainText('Synced: 3 hosts in your account');
    expect(await accountNames(app)).toEqual(['other', 'hetzner', 'fixture']);
    await shot(account, '2-after-untouched-sync-now');

    // An explicit untick is the one way to remove it.
    await row(account, 'hetzner').locator('input[type=checkbox]').uncheck();
    await expect(row(account, 'hetzner').locator('.status-chip')).toHaveText('In account · remove on sync');
    await shot(account, '3-after-explicit-untick');
    await account.getByRole('button', { name: 'Sync now' }).click();
    await expect(account.locator('.account-message')).toContainText('Synced: 2 hosts in your account');
    expect(await accountNames(app)).toEqual(['other', 'fixture']);
    await shot(account, '4-after-untick-sync-now');
  });
});
