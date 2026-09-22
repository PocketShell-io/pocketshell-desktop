import { describe, expect, it } from 'vitest';
import type { ExecResult } from '@pocketshell/core';
import type { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';

/**
 * What `[]` from `PocketshellClient.usage` is allowed to mean.
 *
 * `usage()` used to swallow every non-zero exit into an empty list, so a
 * working panel could stop working — expired provider auth, a missing `quse`,
 * a drifted helper — and say only "no usage data — is `pocketshell usage`
 * available on this host?", accusing a helper that was fine while the host's
 * explanation was dropped in the main process.
 *
 * The three-way split held here: exit 0 parses (empty included), a missing
 * binary is still `[]`, and a command that ran and failed throws with the
 * host's line. The renderer half — a rejection becomes the error line and
 * leaves existing rows alone — lives in UsageView.test.ts and
 * agentsStore.test.ts.
 */

const CONN = 'conn-1';

/** One well-formed 0.4.44 NDJSON row. */
const ROW =
  '{"provider":"claude","status":"ok","short_term":{"percent_remaining":62,"reset_at":null,"window":"5h"},"long_term":{"percent_remaining":80,"reset_at":null,"window":"weekly"},"error":null,"details":{}}';

/** A fake SshService that answers every exec with one canned result. */
function clientAnswering(result: ExecResult): { client: PocketshellClient; commands: string[] } {
  const commands: string[] = [];
  const ssh = {
    exec: (_connectionId: string, command: string): Promise<ExecResult> => {
      commands.push(command);
      return Promise.resolve(result);
    },
  } as unknown as SshService;
  return { client: new PocketshellClient(ssh), commands };
}

describe('PocketshellClient.usage — what an empty list is allowed to mean', () => {
  it('parses a clean answer', async () => {
    const { client, commands } = clientAnswering({ stdout: `${ROW}\n`, stderr: '', exitCode: 0 });
    const rows = await client.usage(CONN);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('claude');
    // The command still goes out PATH-aware: sshd runs a non-login shell, so
    // `$HOME/.local/bin` — where uv puts `pocketshell` — is not on PATH.
    expect(commands[0]).toContain('pocketshell usage --json');
  });

  it('treats an ANSWERED empty as empty, not as a failure', async () => {
    const { client } = clientAnswering({ stdout: '\n', stderr: '', exitCode: 0 });
    await expect(client.usage(CONN)).resolves.toEqual([]);
  });

  it('still answers [] when the pocketshell BINARY is absent', async () => {
    // The one case the panel's "is `pocketshell usage` available on this host?"
    // is the right question for — and the missing-tools banner says it louder
    // anyway. An error line here would be a worse sentence, not a better one.
    const { client } = clientAnswering({
      stdout: '',
      stderr: '/bin/sh: 1: pocketshell: not found\n',
      exitCode: 127,
    });
    await expect(client.usage(CONN)).resolves.toEqual([]);
  });

  it('REPORTS a command that ran and failed, carrying the host’s own line', async () => {
    // The regression: this used to resolve to `[]`, so the panel showed the
    // empty state and accused a helper that was present and working of being
    // absent, while the reason the numbers were gone sat on a stderr nobody
    // ever saw.
    const { client } = clientAnswering({
      stdout: '',
      stderr: 'quse: credentials for anthropic have expired\n',
      exitCode: 1,
    });
    await expect(client.usage(CONN)).rejects.toThrow('credentials for anthropic have expired');
  });

  it('explains a Click usage error as drift, the way createSession does', async () => {
    const { client } = clientAnswering({
      stdout: '',
      stderr: 'Error: No such option: --json\n',
      exitCode: 2,
    });
    await expect(client.usage(CONN)).rejects.toThrow(/drifted/);
  });

  it('says something even when the host printed nothing at all', async () => {
    // A silent non-zero exit is still a failure, and "exited 3" is a fact the
    // user can act on where an empty table is not.
    const { client } = clientAnswering({ stdout: '', stderr: '', exitCode: 3 });
    await expect(client.usage(CONN)).rejects.toThrow('pocketshell usage exited 3');
  });
});
