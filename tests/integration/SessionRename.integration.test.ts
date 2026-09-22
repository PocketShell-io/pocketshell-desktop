import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { ProjectsService } from '@main/projects/ProjectsService';
import { TmuxClientPool } from '@main/ssh/TmuxClientPool';
import { pathAwareCommand } from '@main/helper/bootstrap';
import type { ShellId } from '@pocketshell/core';
import { LIST_SESSIONS_ANY_SOCKET, TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Rename, against the real helper — the operation that turned out not to be
 * real at all.
 *
 * `renameSessionCommand` is raw `tmux rename-session` aimed at the session's
 * own per-session server, and at the tmux level it always worked. What broke
 * was everything keyed to the NAME afterwards: tmuxctl 0.3.5 resolves a join
 * by checking the socket derived from the name (`tmuxctl-<name>`) and the
 * default socket, so the first rename left session `beta` living on
 * `tmuxctl-alpha` — and `tmuxctl beta` answered `tmux session 'beta' was not
 * found` forever, measured on this fixture (`open terminal failed: not a
 * terminal` for a fresh session's join, `was not found` for the renamed
 * one). With the helper join as the app's only join path, a rename committed
 * at the tmux level and orphaned the session out of the app: "rename doesn't
 * really rename". The join now locates its own server by sweeping the socket
 * directory (see sessionAttachCommand), and these tests pin the end-to-end
 * property that made it worth doing: a renamed session is joinable under its
 * new name by a pool that has never seen it, and a rename cannot land on a
 * name some other server already holds.
 */
describeDocker('rename really renames', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let helper: PocketshellClient;
  let projects: ProjectsService;
  let connectionId: string;

  const output = new Map<ShellId, string>();
  const sink = {
    onData: (shellId: ShellId, data: Buffer) => {
      output.set(shellId, (output.get(shellId) ?? '') + data.toString('utf8'));
    },
    onExit: () => {},
  };

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:helper')
      .withExposedPorts(22)
      .start();
    ssh = new SshService();
    const result = await ssh.connect({
      host: container.getHost(),
      port: container.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.connectionId) throw new Error('connect failed');
    connectionId = result.connectionId;
    helper = new PocketshellClient(ssh);
    projects = new ProjectsService(ssh, helper);
  }, 180_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  /** Resolve once `needle` shows up in the shell's accumulated output. */
  function waitForOutput(shellId: ShellId, needle: string, timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        const acc = output.get(shellId) ?? '';
        if (acc.includes(needle)) resolve(acc);
        else if (Date.now() - start > timeoutMs) {
          reject(new Error(`timed out waiting for ${needle}; last 300: ${acc.slice(-300)}`));
        } else setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** Create a helper session the way the app does, and leave a marker on screen. */
  async function createSession(name: string, marker: string): Promise<void> {
    const created = await ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell sessions create '${name}' -c "$HOME"`),
    );
    expect(created.exitCode).toBe(0);
    const located = await helper.locateSession(connectionId, name);
    if (located.status !== 'found') throw new Error(`could not locate fresh ${name}`);
    const keys = await ssh.exec(
      connectionId,
      `tmux -S ${JSON.stringify(located.socketPath ?? '')} send-keys -t '=${name}:' ` +
        `'clear; echo ${marker}' Enter`,
    );
    expect(keys.exitCode).toBe(0);
  }

  /** Kill a session on whatever server it now lives on. */
  async function killEverywhere(name: string): Promise<void> {
    await ssh.exec(
      connectionId,
      pathAwareCommand(
        `for __ps_s in "\${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ` +
          `[ -S "$__ps_s" ] || continue; ` +
          `tmux -S "$__ps_s" kill-session -t '=${name}' 2>/dev/null; done`,
      ),
    );
  }

  it('a renamed session is still joinable — including from a pool that never saw it', async () => {
    await createSession('rename-a', 'MARK-RENAME-A');

    // The join the app ships: a PTY running sessionAttachCommand. It must land
    // in the session BEFORE the rename, when tmuxctl's own resolution works.
    const before = new TmuxClientPool(ssh, helper);
    const first = await before.attach(connectionId, 'rename-a', { cols: 80, rows: 24, ...sink });
    expect(first.switched).toBe(false);
    await waitForOutput(first.shellId, 'MARK-RENAME-A');

    const renamed = await projects.renameSession(connectionId, 'rename-a', 'rename-b');
    expect(renamed).toEqual({ ok: true, sessionName: 'rename-b', error: null, code: null });

    // The helper's own list agrees the new name is the live one...
    const listed = await ssh.exec(connectionId, pathAwareCommand(`pocketshell sessions list`));
    expect(listed.stdout).toContain('rename-b');

    // ...and the decisive half: a FRESH pool — the app-restart shape — joins
    // `rename-b`. This is the join that answered `was not found` for every
    // session this app ever renamed, because `tmuxctl rename-b` looks for a
    // socket called `tmuxctl-rename-b` and the session still lives on the
    // original server. The failure label must never appear either: a failed
    // join used to look like a prompt, which is how the bug hid.
    const after = new TmuxClientPool(ssh, helper);
    const second = await after.attach(connectionId, 'rename-b', { cols: 80, rows: 24, ...sink });
    expect(second.switched).toBe(false);
    const acc = await waitForOutput(second.shellId, 'MARK-RENAME-A');
    // The failure line names the session, and that naming is what the
    // assertion keys on — not the bare label. The join command is typed into
    // a login shell, so its own text is echoed back whether the join succeeds
    // or fails, and that echo carries "[PocketShell]" inside the printf
    // fallback it contains. Only a real failure prints the session's name
    // into the format; the echo holds a literal %s there instead.
    expect(acc).not.toContain('could not join session rename-b');

    // tmux agrees: one session, carrying the new name.
    const sessions = await ssh.exec(
      connectionId,
      pathAwareCommand(LIST_SESSIONS_ANY_SOCKET),
    );
    expect(sessions.stdout).toContain('rename-b');
    expect(sessions.stdout).not.toContain('rename-a');

    await killEverywhere('rename-b');
  }, 120_000);

  it('refuses a rename onto a name another server already holds', async () => {
    // The collision namespace is the JOIN namespace, and that is host-wide:
    // `tmuxctl <name>` derives a socket from the name, and the tab bar,
    // composer and enrichment map are all keyed by name across servers. A
    // rename that only asked the renamed session's own server would succeed
    // here and produce two tabs with one name.
    await createSession('dup-x', 'MARK-DUP-X');
    await createSession('dup-y', 'MARK-DUP-Y');

    const out = await projects.renameSession(connectionId, 'dup-x', 'dup-y');
    expect(out).toMatchObject({ ok: false, code: 'name-taken' });
    expect(out.error).toContain('dup-y');

    // Nothing moved: both sessions survive under their own names.
    const sessions = await ssh.exec(
      connectionId,
      pathAwareCommand(LIST_SESSIONS_ANY_SOCKET),
    );
    expect(sessions.stdout).toContain('dup-x');
    expect(sessions.stdout).toContain('dup-y');

    await killEverywhere('dup-x');
    await killEverywhere('dup-y');
  }, 120_000);
});
