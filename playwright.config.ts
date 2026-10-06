import { defineConfig } from '@playwright/test';

// Run the app off-screen by default so a test run does not flash windows onto
// the desktop or steal keyboard focus. The specs spread `...process.env` into
// `_electron.launch`, so setting it here reaches the app. Electron has no true
// headless mode; see the comment in src/main/index.ts for why the window is
// shown-but-offscreen rather than simply never shown (an unshown window never
// composites, and `page.screenshot()` then hangs).
//
// Set POCKETSHELL_HEADLESS=0 to watch a run happen on screen while debugging.
process.env['POCKETSHELL_HEADLESS'] ??= '1';

// E2E tests launch the packaged Electron app against a fixed Docker
// compose port. They require the `helper` compose
// service to be up on 127.0.0.1:3205.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // single app + single compose target
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
