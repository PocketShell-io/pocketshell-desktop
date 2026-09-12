import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resetWorkspaceState, ensureHelperUp, E2E_HOST_NAME, HOST_PORT, TEST_KEY, stopHelper } from './helpers';

/**
 * The terminal pane must never render xterm's own injected CSS as content.
 *
 * Reported live on 2026-09-12 (twice): a pane filled top to bottom with the
 * DOM renderer's runtime stylesheet — `.xterm-dom-renderer-owner-1 …`, the
 * 256-colour rule wall — laid out in the app's proportional UI font instead
 * of the terminal's mono face, one clipped slice per row. The bytes never
 * crossed the wire: the aplexer session histories on the host hold none of
 * it. The stylesheet lives in the document as two `<style>` elements xterm
 * appends inside `.xterm-screen`; whatever the escape path is, the thing the
 * user SEES is that text outside of any `<style>`, and the row font off the
 * mono stack. Both facts are cheap to assert, in the real renderer, under
 * the stress that surrounds every report: session tabs mounting hidden and
 * shown again (restored workspaces), rapid switching, Files tabs, panel
 * collapse, back-to-hosts, window resizes.
 *
 * The xterm-bundle marker (`xterm-dom-renderer-owner-`) is legitimate inside
 * `<style>` and `<script>` elements only. Anywhere else it is the bug.
 */

const SSH_CONFIG = resolve(homedir(), '.ssh', 'config');
const BEGIN_MARKER = '# >>> pocketshell-e2e-style-escape (temporary) >>>';
const END_MARKER = '# <<< pocketshell-e2e-style-escape (temporary) <<<';
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string;
  const mainPath = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
  return electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

interface EscapeProbe {
  /** Text nodes carrying the marker outside `<style>`/`<script>`, as DOM chains. */
  stray: string[];
  /** Injected style elements and their computed display. */
  styles: { display: string; length: number }[];
  /** Computed font of each live pane's rows — the mono stack, or the bug. */
  rowFonts: (string | null)[];
}

async function probePanes(page: Page): Promise<EscapeProbe> {
  return page.evaluate(() => {
    const stray: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.includes('xterm-dom-renderer-owner')) continue;
      let p: Element | null = node.parentElement;
      let styled = false;
      while (p) {
        if (p.tagName === 'STYLE' || p.tagName === 'SCRIPT') styled = true;
        p = p.parentElement;
      }
      if (!styled) {
        const chain: string[] = [];
        p = node.parentElement;
        while (p && chain.length < 8) {
          chain.push(`${p.tagName}.${String(p.className).slice(0, 60)}`);
          p = p.parentElement;
        }
        stray.push(chain.join(' < '));
      }
    }
    const styles = [...document.querySelectorAll('.xterm-screen > style')].map((s) => {
      const offenders: string[] = [];
      const display = getComputedStyle(s).display;
      if (display !== 'none') {
        for (const sheet of document.styleSheets) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of rules) {
            if (!(rule instanceof CSSStyleRule)) continue;
            if (!rule.style.display) continue;
            try {
              if (s.matches(rule.selectorText)) offenders.push(rule.cssText);
            } catch {
              // unparsable selector in a rule we do not care about
            }
          }
        }
      }
      return { display, length: s.textContent.length, offenders };
    });
    const rowFonts = [...document.querySelectorAll('.xterm-rows')].map(
      (r) => getComputedStyle(r).fontFamily || null,
    );
    return { stray, styles, rowFonts };
  });
}

async function expectNoEscape(page: Page, label: string): Promise<void> {
  const probe = await probePanes(page);
  expect(probe.stray, `${label}: injected stylesheet text escaped into the DOM`).toEqual([]);
  for (const s of probe.styles) {
    expect(
      s.display,
      `${label}: an injected style element became visible: ${JSON.stringify(probe.styles)}`,
    ).toBe('none');
  }
  for (const font of probe.rowFonts) {
    expect(font, `${label}: pane rows lost the mono stack`).toContain('monospace');
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('the injected terminal stylesheet never becomes visible content', () => {
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
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible({
      timeout: 15_000,
    });
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

  test('a fresh workspace is clean', async () => {
    await expectNoEscape(page, 'fresh workspace');
  });

  test('rapid tab switching keeps every pane clean', async () => {
    for (let i = 0; i < 6; i += 1) {
      const target = i % 2 === 0 ? 'build' : 'main';
      await page.getByRole('button', { name: target, exact: true }).click();
      await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForTimeout(250);
    }
    await expectNoEscape(page, 'after rapid tab switching');
  });

  test('hidden panes and the way back keep every pane clean', async () => {
    // Back to hosts and in again: the workspace unmounts and its tabs mount
    // hidden, then restore — the restored-workspace path behind both reports.
    // (No Files-tab leg: the `+` menu is not clickable in the current build —
    // session-nav.spec.ts trips on the same interception, so that surface is
    // exercised there when it is fixed.)
    await page.getByTitle('Back to hosts').click();
    await expect(page.getByText(E2E_HOST_NAME)).toBeVisible();
    await expectNoEscape(page, 'back at the host picker');
    await page.getByText(E2E_HOST_NAME).click();
    await expect(page.locator('.dir-header').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('.dir-header').first().click();
    await expect(page.locator('.folder-workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.terminal-area > .terminal-slot:visible > .terminal')).toBeVisible({
      timeout: 15_000,
    });
    await expectNoEscape(page, 'after workspace restore');
  });

  test('window resizes and panel collapse keep every pane clean', async () => {
    const win = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      const size = w.getSize();
      w.setSize(900, 700);
      return size;
    });
    await page.waitForTimeout(600);
    await page.getByTitle('Hide session panel').click().catch(() => {});
    await page.waitForTimeout(400);
    await page.getByTitle('Show session panel').click().catch(() => {});
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
    await page.waitForTimeout(600);
    await expectNoEscape(page, 'after resizes');
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setSize(w, h),
      win,
    );
  });
});
