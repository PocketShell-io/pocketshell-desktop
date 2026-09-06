/**
 * Host bootstrap probe — the sequence the Android `HostBootstrapper` runs on
 * connect to detect the `pocketshell` helper, `tmux`, and the uv/pipx
 * installer, plus daemon status.
 *
 * The probe runs each check as a single SSH exec, wrapping commands in a
 * PATH-aware shell so user-bin locations ($HOME/.local/bin etc.) are on PATH
 * even under a non-login sshd.
 */

import type { SshService } from '../ssh/SshService.js';
import type { BootstrapResult, ToolState } from '../../shared/types.js';
import { USER_BIN_PATH } from '../../shared/userBinPath.js';
import { shellEscapeInsideSingleQuotes } from '../../shared/shellQuote.js';
import { parseCommandV } from './cliParsers.js';

/**
 * Wrap a command so it runs under the user's full PATH: source the login
 * shell rc, prepend the standard user-bin dirs, then run the command. Mirrors
 * the Android `pathAwareCommand` wrapper.
 *
 * The dir list is shared with the session-join command rather than spelled out
 * here — see src/shared/userBinPath.ts for why the two must not drift.
 */
export function pathAwareCommand(command: string): string {
  return `/bin/sh -lc 'export PATH="${USER_BIN_PATH}:$PATH"; ${shellEscapeInsideSingleQuotes(command)}'`;
}

/** Probe one tool: `command -v <binary>` under the path-aware shell. */
async function probeTool(
  ssh: SshService,
  connectionId: string,
  binary: string,
): Promise<ToolState> {
  const res = await ssh.exec(connectionId, pathAwareCommand(`command -v ${binary}`));
  const path = parseCommandV(res.stdout, res.exitCode);
  if (!path) return { installed: false, path: null, version: null };
  // Best-effort version probe (cheap; ignored if it fails).
  const versionRes = await ssh.exec(connectionId, pathAwareCommand(`${binary} --version`));
  const version = versionRes.exitCode === 0 ? versionRes.stdout.trim().split(/\r?\n/)[0] : null;
  return { installed: true, path, version: version ?? null };
}

/** Detect the python installer: `command -v uv` then `command -v pipx`. */
async function detectInstaller(
  ssh: SshService,
  connectionId: string,
): Promise<'uv' | 'pipx' | null> {
  for (const binary of ['uv', 'pipx'] as const) {
    const res = await ssh.exec(connectionId, pathAwareCommand(`command -v ${binary}`));
    if (parseCommandV(res.stdout, res.exitCode)) return binary;
  }
  return null;
}

/**
 * Run the full bootstrap probe against a connected host.
 *
 * Never throws — missing tools are reported as `installed: false`, not errors.
 */
export async function runBootstrap(
  ssh: SshService,
  connectionId: string,
): Promise<BootstrapResult> {
  // `tmuxctl` is probed in its own right rather than assumed to ship with
  // `pocketshell`. It is the binary the session-join command actually invokes
  // (src/shared/attachCommand.ts), and a host that has the helper but not the
  // join binary used to be invisible here: bootstrap reported a green
  // "pocketshell" chip and every click on a session failed in the terminal.
  // Probing it makes the one binary the join depends on part of the same
  // readiness answer the rest of the UI is already built on.
  //
  // `a` (aplexer) is probed the same way: it is the MAIN session manager when
  // present — listing, creating, attaching, stopping, and renaming all prefer
  // it — and its absence simply runs the tmux path, so nothing warns on it.
  const [pocketshell, tmuxctl, tmux, aplexer, installer] = await Promise.all([
    probeTool(ssh, connectionId, 'pocketshell'),
    probeTool(ssh, connectionId, 'tmuxctl'),
    probeTool(ssh, connectionId, 'tmux'),
    probeTool(ssh, connectionId, 'a'),
    detectInstaller(ssh, connectionId),
  ]);

  let daemonRunning: boolean | null = null;
  let daemonEnabled: boolean | null = null;
  if (pocketshell.installed) {
    // systemctl is required for the daemon check; if absent, both stay null.
    const systemctlRes = await ssh.exec(connectionId, pathAwareCommand('command -v systemctl'));
    if (parseCommandV(systemctlRes.stdout, systemctlRes.exitCode)) {
      const active = await ssh.exec(
        connectionId,
        systemdUserCommand('systemctl --user is-active pocketshell-jobs.service'),
      );
      daemonRunning = active.exitCode === 0;
      const enabled = await ssh.exec(
        connectionId,
        systemdUserCommand('systemctl --user is-enabled pocketshell-jobs.service'),
      );
      daemonEnabled = enabled.exitCode === 0;
    }
  }

  return {
    pocketshell,
    tmuxctl,
    tmux,
    aplexer,
    installer,
    daemonRunning,
    daemonEnabled,
  };
}

/** Wrap a `systemctl --user` command with the env vars systemd needs over SSH. */
function systemdUserCommand(command: string): string {
  const env =
    `XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)} ` +
    `DBUS_SESSION_BUS_ADDRESS=unix:path=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus`;
  return pathAwareCommand(`export ${env}; ${command}`);
}
