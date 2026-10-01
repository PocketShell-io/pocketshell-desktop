import { execFileSync, execSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * E2E helpers: bring up the Docker `helper` container on the fixed compose
 * port (3205) and seed a disposable ssh-config entry pointing at it, so the
 * app's host picker lists a host that connects to the deterministic fixture.
 *
 * The Playwright test launches the real Electron app, which reads this
 * seeded config and connects to localhost:3205 with the committed test_key.
 */

/**
 * The compose helper's host port. 3205 by default; `PS_E2E_PORT` moves the
 * whole fleet for one run — the app's own port-forward can hold 3205 on a dev
 * box (a running instance binds its remote forwards on the same loopback),
 * and a held port silently hijacks every spec: the probe answers, the specs
 * talk to whatever the forward reaches, and the fixture container never boots.
 * The compose mapping reads the same variable, so one value moves both.
 */
export const HOST_PORT = Number(process.env.PS_E2E_PORT ?? 3205);
export const E2E_HOST_NAME = 'pocketshell-test';
export const PROJECT_ROOT = resolve(__dirname, '..', '..');
export const COMPOSE_FILE = resolve(PROJECT_ROOT, 'tests-docker', 'docker-compose.yml');
export const TEST_KEY = resolve(PROJECT_ROOT, 'tests-docker', 'test_key');

/** True iff the helper container is reachable on the fixed port. */
export function isHelperUp(): boolean {
  try {
    execSync(
      `ssh -i "${TEST_KEY}" -p ${HOST_PORT} -o BatchMode=yes -o ConnectTimeout=2 ` +
        `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 true`,
      { stdio: 'ignore', timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Start the helper compose service (idempotent). Throws if it won't come up. */
export async function ensureHelperUp(deadlineMs = 60_000): Promise<void> {
  if (isHelperUp()) return;
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d --build --wait helper`, {
    stdio: 'inherit',
    timeout: deadlineMs,
  });
  const start = Date.now();
  while (!isHelperUp() && Date.now() - start < deadlineMs) {
    // `setTimeout`, NOT `execSync('sleep 1')`: on win32 that shell string goes
    // through cmd.exe, where `sleep` does not exist — the same trap the
    // `execInFixture` comment below records for command strings generally.
    await delay(1_000);
  }
  if (!isHelperUp()) throw new Error('helper container did not become reachable');
}

/**
 * Seed the project folders the folder-first session tests browse and clone
 * from: `~/git/demo-repo` (a plain `git init`, so `full_name` is null and the
 * merge must fall back to `name`) and `~/git/Hello-World` (a GitHub origin, so
 * it merges as `octocat/Hello-World`).
 *
 * Idempotent and run per spec, deliberately: the helper IMAGE ships no `~/git`
 * at all, and `ensureHelperUp` recreates the container whenever the image
 * changes — so anything a previous run created is not something a later run
 * may assume.
 */
export function seedProjectFolders(): void {
  execInFixture([
    'set -e',
    'mkdir -p "$HOME/git/demo-repo" "$HOME/git/Hello-World"',
    'cd "$HOME/git/demo-repo" && git init -q .',
    'cd "$HOME/git/Hello-World" && git init -q .',
    'cd "$HOME/git/Hello-World" && (git remote add origin ' +
      'https://github.com/octocat/Hello-World.git || true)',
  ]);
}

/**
 * Run a `sh -lc` script inside the helper container as `testuser`.
 *
 * `execFileSync` with an argv array, NOT `execSync` with a command string: on
 * Windows `execSync` goes through cmd.exe, where single quotes are ordinary
 * characters, so a quoted shell script arrives at `sh -lc` in pieces.
 */
export function execInFixture(lines: string[]): void {
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      '-u',
      'testuser',
      'helper',
      'sh',
      '-lc',
      lines.join('\n'),
    ],
    { stdio: 'ignore', timeout: 30_000 },
  );
}

/**
 * Kill every aplexer session in `~/proj`, then WAIT until the snapshot agrees —
 * a kill answers before the record leaves it, and a corpse still listed at
 * connect poisons every step after (the free-name walk, the rename's
 * name-taken probe, the ledger's identity — and a session still in `~/proj`
 * makes that folder a panel root, so a picker meant to open at `$HOME` opens
 * inside it instead). Exits nonzero while anything is still listed, so a failed
 * cleanup fails beforeAll loudly. The seeded `~` workspace is left alone. Runs
 * through execInFixture — a raw ssh command of this shape does not survive the
 * win32 argv quoting between node and the ssh client — and uses awk, not
 * python3: the exec's non-login shell does not carry python on PATH.
 */
export function cleanProjSessions(): void {
  const projIds =
    `awk '/"id"/ {id=$0; sub(/.*"id"[ :]+"/,"",id); sub(/".*/,"",id)}` +
    ` /"workspace"/ {ws=$0; sub(/.*"workspace"[ :]+"/,"",ws); sub(/".*/,"",ws);` +
    ` if (ws ~ /proj/) print id}'`;
  const left = `left=$(a snapshot --json 2>/dev/null | ${projIds} | grep -c .)`;
  execInFixture([
    'export PATH=/usr/local/bin:$HOME/.local/bin:$PATH',
    'i=0',
    'while [ $i -lt 10 ]; do',
    `  ${left}`,
    '  [ "$left" = 0 ] && break',
    `  for id in $(a snapshot --json 2>/dev/null | ${projIds}); do a kill "$id" >/dev/null 2>&1; done`,
    '  i=$((i+1))',
    '  sleep 2',
    'done',
    left,
    '[ "$left" = 0 ] || { echo "fixture cleanup failed: $left proj session(s) still listed"; exit 1; }',
  ]);
}

/** Stop the helper compose service. */
export function stopHelper(): void {
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" stop helper`, { stdio: 'ignore' });
  } catch {
    // best-effort
  }
}

/**
 * Wipe the renderer's persisted workspace state and reload.
 *
 * The workspace remembers tabs across relaunches (workspaceState.ts), so a
 * Files tab a previous run left behind would reappear here and tests that
 * count tabs would be reading history, not behaviour. Every spec calls this
 * right after opening the window.
 */
export async function resetWorkspaceState(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Ask the FIXTURE (not the app) what sessions it is actually running, over a
 * plain ssh exec on the compose port. The point is to split one question in
 * two when a session tab vanishes: did the session die on the host, or
 * did the app fail to list it? Both arrive in the test as "the button is
 * gone"; only the host can say which. The fixture runs BOTH runtimes, and the
 * app's panel reads the aplexer snapshot alone wherever `a` answers, so the
 * snapshot is the dump's primary evidence; the tmux sweep and the helper
 * list cover the fallback path.
 *
 * Best effort by design - called from a failure path that is already throwing.
 */
export function dumpFixtureSessionState(): string {
  // execFileSync with an argv array: the remote command must reach sshd
  // verbatim, and any local shell quoting (JSON.stringify included) mangles
  // the embedded quotes - the first version of this probe exported a PATH
  // that contained literal quote characters and then wondered why
  // pocketshell was not found.
  const probe = (cmd: string): string => {
    try {
      return execFileSync(
        'ssh',
        [
          '-i', TEST_KEY,
          '-p', String(HOST_PORT),
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=3',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          'testuser@127.0.0.1',
          cmd,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000 },
      )
        .toString()
        .trim();
    } catch (err) {
      return `(probe failed: ${(err as Error).message.slice(0, 80)})`;
    }
  };
  const sweep =
    'for s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do [ -S "$s" ] || continue; ' +
    'echo "-- $s"; tmux -S "$s" list-sessions -F "#{session_name} attached=#{session_attached}" 2>/dev/null; done';
  return [
    'host tmux sweep:',
    probe(sweep),
    'aplexer snapshot:',
    probe('export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"; a snapshot --json 2>&1 | head -40'),
    'helper sessions list:',
    probe('export PATH="$HOME/.local/bin:$PATH"; pocketshell sessions list 2>&1 | head -20'),
  ].join('\n');
}