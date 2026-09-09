import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import type { SshService } from '@main/ssh/SshService';
import type { ExecResult } from '../../src/shared/types';

/**
 * The durable tree registry's placement wiring: `pocketshell tree get/upsert` — the record
 * the phone keeps and the desktop never called.
 *
 * The flow under test is `listSessions`'s placement failure path: a session
 * the cwd probe cannot see used to be placed by ASKING THE HOST which of the
 * name's candidate directories exists (`test -d`). The registry answers the
 * same question from a RECORD, and a record beats a guess — so:
 *
 *   1. a registry hit places the session and SPARES the `test -d` probe;
 *   2. a registry that exists but knows nothing changes nothing (the probe
 *      still runs — today's behaviour, verbatim);
 *   3. a host whose stub cannot even answer "which alias am I?" never sends a
 *      `tree get` at all — fail closed, and cheaply;
 *   4. the create path records the new session's folder, merging into the
 *      host's list rather than replacing it (upsert is wholesale, so a
 *      single-node payload would drop every node the phone recorded).
 *
 * The fake answers by command text and CAPTURES STDIN — the payload is the
 * contract here as much as the command.
 */

interface Call {
  command: string;
  stdin?: string;
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (exitCode: number, stderr = '', stdout = ''): ExecResult => ({
  stdout,
  stderr,
  exitCode,
});

const CONN = 'conn-1';
const ALIAS = 'hetzner';
const HOME = '/home/testuser';
const SESSION = 'git-red-stamp-sound';
const RECORDED = `${HOME}/git/red-stamp-sound`;

interface SshOptions {
  stdin?: string;
}

function fakeSsh(
  responders: Array<(command: string, stdin?: string) => ExecResult | null>,
  withRegistry = true,
): { ssh: SshService; calls: Call[] } {
  const calls: Call[] = [];
  const ssh = {
    // `registry_` is read by the client to resolve the host key; a stub
    // without it is the fail-closed case (a host key that cannot resolve).
    registry_: withRegistry
      ? {
          require: () => ({
            hostAlias: ALIAS,
            host: '135.181.114.209',
          }),
        }
      : undefined,
    exec: (_connectionId: string, command: string, opts?: SshOptions): Promise<ExecResult> => {
      calls.push({ command, stdin: opts?.stdin });
      for (const responder of responders) {
        const answer = responder(command, opts?.stdin);
        if (answer) return Promise.resolve(answer);
      }
      return Promise.resolve(fail(127, 'sh: not found'));
    },
  } as unknown as SshService;
  return { ssh, calls };
}

const treeGetAnswer = (body: unknown): ((c: string) => ExecResult | null) =>
  (c) => (c.includes('pocketshell tree get') ? ok(JSON.stringify(body)) : null);

/** Force the fallback branch: no helper, raw tmux answers with one UNPLACED row. */
const FALLBACK_RESPONDERS = [
  (c: string) => (c.includes('pocketshell sessions list') ? fail(1) : null),
  (c: string) => (c.includes('list-panes') ? ok('') : null),
  (c: string) =>
    c.includes('tmux list-sessions')
      ? ok(`${SESSION}::1700000000::1700000000::0::\n`)
      : null,
  (c: string) => (c.includes('printf %s "$HOME"') ? ok(`${HOME}\n`) : null),
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the durable tree registry as a placement source', () => {
  it('a recorded folder places the session and spares the test -d probe', async () => {
    const { ssh, calls } = fakeSsh([
      ...FALLBACK_RESPONDERS,
      treeGetAnswer({
        nodes: [{ session: SESSION, order: 1, folder_path: RECORDED, collapsed: false }],
        version: 1,
      }),
    ]);
    const client = new PocketshellClient(ssh);

    const sessions = await client.listSessions(CONN, 'activity');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.path).toBe(RECORDED);
    // A record is not a guess: the UI's inferred-path flag must be gone.
    expect(sessions[0]!.pathInferred).toBeFalsy();
    // The probe never ran — the whole point of the record.
    expect(calls.some((c) => c.command.includes('[ -d '))).toBe(false);
    // And the registry was asked exactly once, even across refreshes.
    const before = calls.filter((c) => c.command.includes('tree get')).length;
    await client.listSessions(CONN, 'activity');
    expect(calls.filter((c) => c.command.includes('tree get')).length).toBe(before);
  });

  it('an empty registry changes nothing — the probe runs as it always did', async () => {
    const { ssh, calls } = fakeSsh([
      ...FALLBACK_RESPONDERS,
      // The dir probe confirms the flat candidate, as dirExistsResponder did.
      (c) => (c.includes('[ -d ') ? ok('0\n') : null),
      treeGetAnswer({ nodes: [], version: 0 }),
    ]);
    const client = new PocketshellClient(ssh);

    const sessions = await client.listSessions(CONN, 'activity');

    expect(sessions[0]!.path).toBe(`${HOME}/git/red-stamp-sound`);
    expect(calls.some((c) => c.command.includes('[ -d '))).toBe(true);
  });

  it('fails closed and cheaply when there is no host key to ask with', async () => {
    const { ssh, calls } = fakeSsh(
      [
        ...FALLBACK_RESPONDERS,
        (c) => (c.includes('[ -d ') ? ok('0\n') : null),
        treeGetAnswer({ nodes: [], version: 0 }),
      ],
      false,
    );
    const client = new PocketshellClient(ssh);

    const sessions = await client.listSessions(CONN, 'activity');

    expect(sessions[0]!.path).toBe(`${HOME}/git/red-stamp-sound`);
    expect(calls.some((c) => c.command.includes('tree get'))).toBe(false);
  });
});

describe('the create path records the session', () => {
  it('upserts the new session merged into the host list, not replacing it', async () => {
    let upsertStdin: string | undefined;
    const { ssh: recorded } = fakeSsh([
      (c: string) => (c.includes('printf %s "$HOME"') ? ok(`${HOME}\n`) : null),
      (c: string) => (c.includes('[ -d ') ? ok() : null),
      (c: string) => (c.includes('pwd -P') ? ok(`${HOME}/git/x\n`) : null),
      (c: string) => (c.includes('has-session') ? fail(1) : null),
      (c: string) => (c.includes('sessions create') ? ok('git-x\n') : null),
      (c: string) =>
        c.includes('pocketshell tree get')
          ? ok(
              JSON.stringify({
                nodes: [
                  {
                    session: 'existing',
                    order: 1,
                    folder_path: `${HOME}/git/existing`,
                    collapsed: false,
                  },
                ],
                version: 3,
              }),
            )
          : null,
      (_c: string, stdin?: string) => {
        upsertStdin = stdin;
        return ok(JSON.stringify({ status: 'ok', version: 4 }));
      },
    ]);
    const client = new PocketshellClient(recorded);

    await client.treeRecordSession(CONN, 'git-x', `${HOME}/git/x`);

    expect(upsertStdin).toBeDefined();
    const payload = JSON.parse(upsertStdin!) as {
      host: string;
      nodes: Array<{ session: string; folder_path: string; order: number }>;
    };
    expect(payload.host).toBe(ALIAS);
    // The phone's own node survived the merge — upsert is wholesale, so a
    // single-node payload would have erased it.
    expect(payload.nodes.map((n) => n.session)).toContain('existing');
    expect(payload.nodes.map((n) => n.session)).toContain('git-x');
    const added = payload.nodes.find((n) => n.session === 'git-x')!;
    expect(added.folder_path).toBe(`${HOME}/git/x`);
    // Ordered last, after everything the registry already had.
    expect(added.order).toBe(2);
  });

  it('a failed read never reaches the write — nothing recorded, nothing lost', async () => {
    let upsertSeen = false;
    const { ssh } = fakeSsh([
      (c: string) => (c.includes('pocketshell tree get') ? fail(1, 'nope') : null),
      (_c: string) => {
        upsertSeen = true;
        return ok(JSON.stringify({ status: 'ok', version: 4 }));
      },
    ]);
    const client = new PocketshellClient(ssh);

    await client.treeRecordSession(CONN, 'git-x', `${HOME}/git/x`);

    expect(upsertSeen).toBe(false);
  });
});
