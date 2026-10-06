import { describe, expect, it } from 'vitest';
import type { SshService } from '@main/ssh/SshService';
import { pathAwareCommand, runBootstrap } from '@main/helper/bootstrap';
import { USER_BIN_DIRS } from '@pocketshell/core';

/**
 * Bootstrap is the app's answer to "is this host ready?". Readiness is
 * `pocketshell` alone (`missingHostTools` in the core decides it): the 0.5.x
 * helper carries aplexer as a pinned dependency, and the app finds its
 * bundled `a` through the USER_BIN_DIRS the probe also searches. The tmuxctl
 * and tmux probes ride along for the record — a pre-0.5 helper still routes
 * its legacy tmux paths through them — which is why these tests pin how they
 * are probed, not what the host is judged to be missing.
 */

/** Minimal SshService double: one canned reply per command substring. */
function fakeSsh(
  replies: { match: RegExp; stdout: string; exitCode?: number }[],
  log: string[] = [],
  platform: 'posix' | 'windows' = 'posix',
): SshService {
  return {
    exec: (_id: string, command: string) => {
      log.push(command);
      const hit = replies.find((r) => r.match.test(command));
      if (!hit) return Promise.resolve({ stdout: '', stderr: '', exitCode: 127 });
      return Promise.resolve({ stdout: hit.stdout, stderr: '', exitCode: hit.exitCode ?? 0 });
    },
    hostPlatform: (_id: string) => Promise.resolve(platform),
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

  it('reports a host with the helper but no tmuxctl for the record — readiness rides the bundled aplexer', async () => {
    // The shape the old framing called broken: pocketshell present, tmuxctl
    // absent. On a current helper that is just a host without the legacy tmux
    // paths — the join rides the bundled `a` — so the probe records the
    // absence without any readiness verdict hanging off it.
    const log: string[] = [];
    const ssh = fakeSsh(
      [
        { match: /command -v pocketshell/, stdout: '/usr/bin/pocketshell\n' },
        { match: /pocketshell --version/, stdout: 'pocketshell 0.4.44\n' },
        { match: /command -v tmux\b/, stdout: '/usr/bin/tmux\n' },
        { match: /tmux --version/, stdout: 'tmux 3.4\n' },
        // tmuxctl, `a`, uv/pipx and systemctl all fall through to exit 127.
      ],
      log,
    );

    const result = await runBootstrap(ssh, 'conn-1');

    expect(result.pocketshell.installed).toBe(true);
    expect(result.tmuxctl.installed).toBe(false);
    expect(result.tmuxctl.path).toBeNull();
    // The aplexer probe rides the same widened PATH as the helper probe — on
    // a uv/pipx pocketshell host that PATH is what makes the bundled `a`
    // findable, so this is the join's real binary being searched properly.
    expect(log.some((c) => /command -v a[' ]/.test(c) && c.includes('uv/tools/pocketshell/bin'))).toBe(true);
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

  it('skips the helper and tmux probes on a Windows host, and says so', async () => {
    // A Windows dev box (OpenSSH, bash DefaultShell) can never answer those
    // probes; running them is five round trips spent confirming the known.
    const log: string[] = [];
    const ssh = fakeSsh(
      [
        { match: /command -v a[' ]/, stdout: 'C:/Users/alexey/bin/a\n' },
        { match: /command -v uv/, stdout: 'C:/Users/alexey/.local/bin/uv.exe\n' },
      ],
      log,
      'windows',
    );

    const result = await runBootstrap(ssh, 'conn-1');

    expect(result.platform).toBe('windows');
    expect(result.pocketshell.installed).toBe(false);
    expect(result.tmuxctl.installed).toBe(false);
    expect(result.tmux.installed).toBe(false);
    expect(result.aplexer.installed).toBe(true);
    expect(log.some((c) => /command -v pocketshell/.test(c))).toBe(false);
    expect(log.some((c) => /command -v tmuxctl/.test(c))).toBe(false);
    expect(log.some((c) => /command -v tmux\b/.test(c))).toBe(false);
    expect(log.some((c) => /command -v a[' ]/.test(c))).toBe(true);
    expect(log.some((c) => /command -v uv/.test(c))).toBe(true);
  });
});
