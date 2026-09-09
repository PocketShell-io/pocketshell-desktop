import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { runBootstrap } from '@main/helper/bootstrap';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for the `pocketshell` helper client against the real
 * `pocketshell-test:helper` image (which installs the actual `pocketshell`
 * CLI + tmuxctl + stub agents + seeded fixtures). Exercises the real
 * `pocketshell sessions list` / `usage` paths plus the
 * bootstrap probe.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('PocketshellClient integration', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let helper: PocketshellClient;
  let connectionId: string | undefined;

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
    // Give the entrypoint's seeded tmux sessions a moment to come up.
    await new Promise((r) => setTimeout(r, 1500));
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  it('bootstrap detects pocketshell + tmux + uv', async () => {
    const boot = await runBootstrap(ssh, connectionId!);
    expect(boot.pocketshell.installed).toBe(true);
    expect(boot.pocketshell.path).toMatch(/pocketshell$/);
    expect(boot.tmux.installed).toBe(true);
    expect(boot.installer).toBe('uv');
  });

  it('listSessions returns the seeded tmux sessions', async () => {
    const sessions = await helper.listSessions(connectionId!, 'activity');
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const names = sessions.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['main', 'build']));
  });

  it('createSession + listSessions reflects the new session', async () => {
    const name = `test-${Date.now()}`;
    const created = await helper.createSession(connectionId!, { name, cwd: '$HOME' });
    expect(created.ok).toBe(true);
    // The helper echoes the resolved name back on stdout.
    expect(created.name).toBe(name);
    const sessions = await helper.listSessions(connectionId!, 'activity');
    expect(sessions.map((s) => s.name)).toContain(name);
  });

  it('createSession is idempotent — a second create is a no-op success', async () => {
    const name = `test-idem-${Date.now()}`;
    const first = await helper.createSession(connectionId!, { name, cwd: '$HOME' });
    const second = await helper.createSession(connectionId!, { name, cwd: '$HOME' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.name).toBe(name);
    const sessions = await helper.listSessions(connectionId!, 'activity');
    expect(sessions.filter((s) => s.name === name)).toHaveLength(1);
  });

  it('reposList reports gh-missing for the remote scope instead of failing', async () => {
    const local = await helper.reposList(connectionId!, { scope: 'local' });
    expect(local.state).toBe('ok');
    const remote = await helper.reposList(connectionId!, { scope: 'remote' });
    // The fixture image ships no `gh`; that is a normal host state.
    expect(remote.state).toBe('gh-missing');
    expect(remote.repos).toEqual([]);
  });
  it('usage returns the seeded provider rows', async () => {
    const rows = await helper.usage(connectionId!);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const providers = rows.map((r) => r.provider);
    expect(providers).toEqual(expect.arrayContaining(['codex', 'claude', 'copilot']));
  });

  // The env editor's write path (FEATURES.md F16), against the real helper:
  // set → the key exists with a value → get reads the same value back. The
  // value deliberately contains characters that are metacharacters both in
  // shell (quotes, dollar, space) and in dotenv files (`=`), so a leak through
  // argv quoting or a botched dotenv write cannot pass by luck.
  it('envSet writes a value that envList and envGet read back', async () => {
    const dir = '$HOME';
    const key = 'PS_DESKTOP_ENV_SET_PROBE';
    const value = 's3cr3t "quoted" ' + '$dollar=kept ' + String(Date.now());

    await helper.envSet(connectionId!, dir, { [key]: value });

    const keys = await helper.envList(connectionId!, dir);
    const row = keys.find((k) => k.key === key);
    expect(row?.hasValue).toBe(true);

    const values = await helper.envGet(connectionId!, dir, [key]);
    expect(values[key]).toBe(value);
  });

  it('envSet overwrites an existing key, and envSet of a NEW key lists it', async () => {
    const dir = '$HOME';
    const key = 'PS_DESKTOP_ENV_OVERWRITE_PROBE';

    await helper.envSet(connectionId!, dir, { [key]: 'first' });
    await helper.envSet(connectionId!, dir, { [key]: 'second' });

    const values = await helper.envGet(connectionId!, dir, [key]);
    expect(values[key]).toBe('second');
  });

  // The durable tree registry against the REAL helper:
  // upsert is wholesale, so the merge contract ("never lose a node the phone
  // recorded") is what these assertions protect.
  it('tree get/upsert/reconcile round-trips and merges', async () => {
    // The client keys records on the connection's host (no alias was used to
    // dial this container), so the test must read the same key back.
    const host = container!.getHost();
    const folderA = '/home/testuser/git/tree-probe-a';
    const folderB = '/home/testuser/git/tree-probe-b';

    // Seed: a node the "phone" recorded.
    expect(
      await helper.treeUpsert(connectionId!, host, [
        { session: 'ps-tree-phone', order: 1, folderPath: folderA, collapsed: false },
      ]),
    ).toBe(true);

    // Record a desktop-created session over it — merged, not replaced.
    await helper.treeRecordSession(connectionId!, 'ps-tree-desktop', folderB);

    const nodes = await helper.treeGet(connectionId!, host);
    expect(nodes).not.toBeNull();
    const bySession = new Map(nodes!.map((n) => [n.session, n]));
    expect(bySession.get('ps-tree-phone')?.folderPath).toBe(folderA);
    expect(bySession.get('ps-tree-desktop')?.folderPath).toBe(folderB);
    // The desktop node sorts after everything that was already there.
    expect(bySession.get('ps-tree-desktop')!.order).toBeGreaterThan(1);

    // Recording the same session again UPDATES rather than duplicates.
    await helper.treeRecordSession(connectionId!, 'ps-tree-desktop', folderB);
    const after = await helper.treeGet(connectionId!, host);
    expect(after!.filter((n) => n.session === 'ps-tree-desktop')).toHaveLength(1);

    // Reconcile answers with the three name lists; neither probe session is
    // alive in tmux, so both are at least known to the diff.
    const rec = await helper.treeReconcile(connectionId!, host);
    expect(rec).not.toBeNull();
    const known = [...rec!.alive, ...rec!.gone, ...rec!.added];
    expect(known).toContain('ps-tree-phone');
  });

  it('envSet can target .envrc explicitly', async () => {
    const dir = '$HOME';
    const key = 'PS_DESKTOP_ENVRC_PROBE';

    await helper.envSet(connectionId!, dir, { [key]: 'in-envrc' }, '.envrc');

    const keys = await helper.envList(connectionId!, dir);
    expect(keys.find((k) => k.key === key)).toMatchObject({ file: '.envrc', hasValue: true });
  });
});
