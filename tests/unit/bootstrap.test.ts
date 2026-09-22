import { describe, expect, it } from 'vitest';
import type { SshService } from '@main/ssh/SshService';
import { pathAwareCommand, runBootstrap } from '@main/helper/bootstrap';
import { USER_BIN_DIRS } from '@pocketshell/core';

/**
 * Bootstrap is the app's answer to "is this host ready?", and until now it
 * answered without ever looking at `tmuxctl` — the one binary the session-join
 * command actually runs. A host with `pocketshell` but no `tmuxctl` got a green
 * chip and a terminal that failed on every click, which is precisely the class
 * of bug these tests exist to close.
 */

/** Minimal SshService double: one canned reply per command substring. */
function fakeSsh(
  replies: { match: RegExp; stdout: string; exitCode?: number }[],
  log: string[] = [],
): SshService {
  return {
    exec: (_id: string, command: string) => {
      log.push(command);
      const hit = replies.find((r) => r.match.test(command));
      if (!hit) return Promise.resolve({ stdout: '', stderr: '', exitCode: 127 });
      return Promise.resolve({ stdout: hit.stdout, stderr: '', exitCode: hit.exitCode ?? 0 });
    },
  } as unknown as SshService;
}

describe('pathAwareCommand', () => {
  it('prepends the user-bin dirs the join command also searches', () => {
    const wrapped = pathAwareCommand('command -v tmuxctl');
    for (const dir of USER_BIN_DIRS) {
      expect(wrapped).toContain(dir);
    }
    expect(wrapped).toContain('$PATH');
  });

  it('runs under a login shell, since exec channels get a bare PATH', () => {
    expect(pathAwareCommand('true')).toContain('/bin/sh -lc');
  });

  it('escapes a quote in the wrapped command rather than closing the wrapper', () => {
    expect(pathAwareCommand("echo 'hi'")).toContain("'\\''hi'\\''");
  });
});

describe('runBootstrap', () => {
  it('probes tmuxctl and resolves its absolute path', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(
      [
        { match: /command -v tmuxctl/, stdout: '/home/alexey/.local/bin/tmuxctl\n' },
        { match: /tmuxctl --version/, stdout: 'tmuxctl 0.4.44\n' },
        { match: /command -v pocketshell/, stdout: '/home/alexey/.local/bin/pocketshell\n' },
        { match: /pocketshell --version/, stdout: 'pocketshell 0.4.44\n' },
        { match: /command -v tmux\b/, stdout: '/usr/bin/tmux\n' },
        { match: /tmux --version/, stdout: 'tmux 3.4\n' },
        { match: /command -v uv/, stdout: '/usr/bin/uv\n' },
        { match: /command -v systemctl/, stdout: '/usr/bin/systemctl\n' },
        { match: /is-active/, stdout: 'active\n' },
        { match: /is-enabled/, stdout: 'enabled\n' },
      ],
      log,
    );

    const result = await runBootstrap(ssh, 'conn-1');

    expect(result.tmuxctl.installed).toBe(true);
    expect(result.tmuxctl.path).toBe('/home/alexey/.local/bin/tmuxctl');
    expect(result.tmuxctl.version).toBe('tmuxctl 0.4.44');
    // The probe is PATH-widened, or it would miss ~/.local/bin installs.
    expect(log.some((c) => /command -v tmuxctl/.test(c) && c.includes('.local/bin'))).toBe(true);
  });

  it('reports a host with the helper but no tmuxctl as join-broken', async () => {
    // The exact shape that used to read as a healthy host: pocketshell present,
    // tmuxctl absent, so every session click failed in the terminal instead.
    const ssh = fakeSsh([
      { match: /command -v pocketshell/, stdout: '/usr/bin/pocketshell\n' },
      { match: /pocketshell --version/, stdout: 'pocketshell 0.4.44\n' },
      { match: /command -v tmux\b/, stdout: '/usr/bin/tmux\n' },
      { match: /tmux --version/, stdout: 'tmux 3.4\n' },
      // tmuxctl, uv/pipx and systemctl all fall through to exit 127.
    ]);

    const result = await runBootstrap(ssh, 'conn-1');

    expect(result.pocketshell.installed).toBe(true);
    expect(result.tmuxctl.installed).toBe(false);
    expect(result.tmuxctl.path).toBeNull();
  });

  it('never throws on a host where nothing is installed', async () => {
    const result = await runBootstrap(fakeSsh([]), 'conn-1');

    expect(result.tmuxctl.installed).toBe(false);
    expect(result.pocketshell.installed).toBe(false);
    expect(result.tmux.installed).toBe(false);
    expect(result.installer).toBeNull();
    // No helper means the daemon question was never asked, not answered "no".
    expect(result.daemonRunning).toBeNull();
  });
});
