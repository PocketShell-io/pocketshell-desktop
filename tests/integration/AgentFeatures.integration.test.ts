import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for the agent-awareness features against the real
 * `pocketshell-test:helper` image: usage returns provider rows, and the env
 * editor reads a folder's `.env`.
 *
 * The agent-log / conversation / resumable cases that used to live here went
 * with the Conversation feature.
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('Agent features integration', () => {
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
  }, 120_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  it('usage returns the seeded provider rows', async () => {
    const rows = await helper.usage(connectionId!);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.provider === 'claude')).toBe(true);
    // The stub's unknown provider key normalizes through as its own row too.
    expect(rows.some((r) => r.provider === 'quse')).toBe(true);
  });

  /**
   * Regression for the drift that unit tests could not see: on helper 0.4.44
   * `env get` REQUIRES a repeatable `--key`, so the old
   * `env get --dir D --json` exited 2 and `envGet` silently answered `{}` for
   * every folder. Only a real helper can catch that — a fake `SshService`
   * would have happily returned whatever stdout the test author imagined.
   */
  it('envList names a folder\'s keys and envGet reveals their values', async () => {
    const dir = '/home/testuser/env-int';
    await ssh.exec(
      connectionId!,
      `mkdir -p ${dir} && printf 'FOO=bar\\nBAZ=qux\\n' > ${dir}/.env`,
    );

    const listed = await helper.envList(connectionId!, dir);
    expect(listed.map((row) => (row as { key: string }).key).sort()).toEqual(['BAZ', 'FOO']);
    // `list` is write-only by design — it must never carry the values.
    expect(JSON.stringify(listed)).not.toContain('bar');

    // No keys supplied: read the whole folder (list, then get).
    expect(await helper.envGet(connectionId!, dir)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    // Keys supplied: reveal only those.
    expect(await helper.envGet(connectionId!, dir, ['FOO'])).toEqual({ FOO: 'bar' });
    // A key that is not there is absent, not an error.
    expect(await helper.envGet(connectionId!, dir, ['NOPE'])).toEqual({});
  });

});
