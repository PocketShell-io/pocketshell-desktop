import { describe, expect, it } from 'vitest';
import {
  aplexerAttachCommand,
  aplexerSelector,
  isAplexerSessionLive,
} from '../../src/shared/aplexer';
import {
  agentKindFromEngine,
  aplexerRecordToSummary,
  parseAplexerSnapshot,
} from '../../src/main/helper/aplexerParsers';
import { AplexerClient } from '../../src/main/helper/AplexerClient';
import { PocketshellClient } from '../../src/main/helper/PocketshellClient';
import {
  aplexerKillCommand,
  aplexerRenameCommand,
  aplexerSnapshotCommand,
  aplexerStartCommand,
  isAplexerNotFound,
  isAplexerStartRefusal,
} from '../../src/main/helper/AplexerClient';
import { TmuxClientPool } from '../../src/main/ssh/TmuxClientPool';
import type { SshService } from '../../src/main/ssh/SshService';
import type { ExecResult, ShellId } from '../../src/shared/types';
import type { AplexerSessionRecord } from '../../src/shared/aplexer';

/**
 * aplexer as the main session manager: the snapshot contract, the row
 * mapping, the tmux fallback merge, the join command, and the client's
 * lifecycle calls. The host-side evidence (exact `a` output shapes and exit
 * codes) is in the doc comments of the modules under test; these pin the
 * desktop side of that contract.
 */

function record(overrides: Partial<AplexerSessionRecord> = {}): AplexerSessionRecord {
  return {
    id: '72150ffb-5152-42f8-8812-dba0cb974b28',
    workspace: '/home/alexey/git/pocketshell',
    tag: 'review',
    engine: 'codex',
    phase: 'running',
    worker_alive: true,
    created_at_ms: 1_787_738_302_000,
    last_activity_ms: 1_787_738_821_000,
    ...overrides,
  };
}

describe('parseAplexerSnapshot', () => {
  it('parses the bare array newest-first', () => {
    const stdout = JSON.stringify([record(), record({ id: 'other', tag: 'main' })]);
    const rows = parseAplexerSnapshot(stdout);
    expect(rows.map((r) => r.tag)).toEqual(['review', 'main']);
  });

  it('answers [] for garbage, a bare object, and an empty body', () => {
    expect(parseAplexerSnapshot('')).toEqual([]);
    expect(parseAplexerSnapshot('no server running\n')).toEqual([]);
    expect(parseAplexerSnapshot(JSON.stringify(record()))).toEqual([]);
  });

  it('drops rows missing the identity triple without losing the batch', () => {
    const stdout = JSON.stringify([
      { workspace: '/w', tag: 'no-id', phase: 'running' },
      record(),
      { id: 'x', tag: 'no-workspace', phase: 'running' },
    ]);
    expect(parseAplexerSnapshot(stdout).map((r) => r.tag)).toEqual(['review']);
  });

  it('drops dead workers — a killed worker leaves phase running forever', () => {
    const stdout = JSON.stringify([
      record({ tag: 'dead', worker_alive: false }),
      // No liveness enrichment and a terminal phase: an old-host row for a
      // session that will never attach again.
      { ...record({ tag: 'gone', phase: 'exited' }), worker_alive: undefined },
      record({ tag: 'live' }),
    ]);
    expect(parseAplexerSnapshot(stdout).map((r) => r.tag)).toEqual(['live']);
  });
});

describe('aplexerRecordToSummary', () => {
  it('files the row under its workspace with the tag as its name', () => {
    const summary = aplexerRecordToSummary(record());
    expect(summary).toMatchObject({
      name: 'review',
      path: '/home/alexey/git/pocketshell',
      backend: 'aplexer',
      workspace: '/home/alexey/git/pocketshell',
      tag: 'review',
      aplexerId: '72150ffb-5152-42f8-8812-dba0cb974b28',
      attached: false,
      agentKind: 'codex',
    });
    // Milliseconds on the wire, seconds in the row — the panel's order keys
    // off seconds and a ms value would pin every aplexer row after every
    // tmux one for the next fifty thousand years.
    expect(summary.created).toBe(1_787_738_302);
    expect(summary.activity).toBe(1_787_738_821);
    // Authoritative placement is never a guess.
    expect(summary.pathInferred).toBeUndefined();
  });

  it('maps the engine vocabulary through the one shared mapping', () => {
    expect(agentKindFromEngine('claude')).toBe('claude');
    expect(agentKindFromEngine('shell')).toBe('shell');
    expect(agentKindFromEngine('test-engine')).toBeNull();
    expect(aplexerRecordToSummary(record({ engine: 'bogus' })).agentKind).toBeNull();
  });

  it('falls back to the workload cwd when the workspace is unusable', () => {
    const summary = aplexerRecordToSummary(record({ workspace: '', cwd: '/tmp/work' }));
    expect(summary.path).toBe('/tmp/work');
  });
});

describe('isAplexerSessionLive', () => {
  it('reads liveness off the pair, never the phase alone', () => {
    expect(isAplexerSessionLive({ phase: 'running', worker_alive: true })).toBe(true);
    expect(isAplexerSessionLive({ phase: 'running', worker_alive: false })).toBe(false);
    expect(isAplexerSessionLive({ phase: 'exited', worker_alive: true })).toBe(false);
  });
});

describe('aplexer commands', () => {
  it('snapshots the machine API, never the human table', () => {
    expect(aplexerSnapshotCommand()).toBe('a snapshot --json');
  });

  it('starts a shell session for a folder, quoted', () => {
    expect(aplexerStartCommand('/home/alexey/git/pocketshell', 'review')).toBe(
      "a start --workspace '/home/alexey/git/pocketshell' --tag 'review' --json",
    );
    // A workspace with a space is one argument, not two — and a `~` prefix
    // stays expandable outside the quotes.
    expect(aplexerStartCommand('/home/u/my projects', "it's")).toContain(
      "--workspace '/home/u/my projects' --tag 'it'\\''s'",
    );
    expect(aplexerStartCommand('~/git/x', 'review')).toContain('--workspace $HOME/\'git/x\'');
  });

  it('kills and renames by id, never by name', () => {
    const id = '72150ffb-5152-42f8-8812-dba0cb974b28';
    expect(aplexerKillCommand(id)).toBe(`a kill '${id}' --json`);
    expect(aplexerRenameCommand(id, 'staging')).toBe(`a rename '${id}' --tag 'staging'`);
  });

  it('recognises the live-holder refusal and the gone message', () => {
    expect(
      isAplexerStartRefusal(1, 'a: workspace+tag already belongs to session abc; rename it'),
    ).toBe(true);
    expect(isAplexerStartRefusal(0, '')).toBe(false);
    expect(isAplexerStartRefusal(1, 'tag must contain 1..64 bytes')).toBe(false);
    expect(isAplexerNotFound(1, 'a: no matching session')).toBe(true);
    expect(isAplexerNotFound(0, '')).toBe(false);
  });

  it('joins by id when known, by workspace+tag otherwise', () => {
    const byId = aplexerAttachCommand({ id: 'abc-123', workspace: '/w', tag: 'review' });
    expect(byId).toContain("a attach 'abc-123'");
    expect(byId).not.toContain('--workspace');
    const byPair = aplexerAttachCommand({ workspace: '/home/alexey/git/x', tag: 'review' });
    expect(byPair).toContain("a attach --workspace '/home/alexey/git/x' --tag 'review'");
  });

  it('widens PATH in a subshell, never execs, shouts on failure, ends with exit', () => {
    const command = aplexerAttachCommand({ workspace: '/w', tag: 'review' });
    expect(command).toMatch(/^\(\s*PATH=".*:\$PATH"; a attach /);
    expect(command).toContain(') || printf');
    expect(command).toContain('[PocketShell] could not join session');
    expect(command).not.toContain('exec ');
    // The corpse-tab fix: the tab's shell must close when the attach ends, so
    // the diagnostic prints first and the `exit` comes after it.
    expect(command.trim().endsWith('; exit')).toBe(true);
    expect(command.indexOf('; exit')).toBeGreaterThan(command.indexOf('printf'));
  });

  it('cannot be broken out of by a hostile tag', () => {
    const payload = "x'; rm -rf ~; echo '";
    const command = aplexerAttachCommand({ workspace: '/w', tag: payload });
    // The payload arrives POSIX-quoted (close-escape-reopen), so the shell
    // passes it as one argument and interprets none of it.
    expect(command).toContain("'x'\\''; rm -rf ~; echo '\\'''");
    expect(command.match(/--tag /g)).toHaveLength(1);
  });

  it('fails closed on a blank workspace rather than landing in $HOME', () => {
    const command = aplexerAttachCommand({ workspace: '', tag: 'review' });
    // The workspace argument itself is empty (which `a` refuses) — the only
    // `$HOME` in the line is the PATH widening, never the address.
    expect(command).toContain("--workspace '' --tag 'review'");
  });

  it('prints the workspace:tag selector the same way `a` does', () => {
    expect(aplexerSelector('/home/alexey/git/pocketshell', 'review')).toBe(
      '/home/alexey/git/pocketshell:review',
    );
  });
});

/** Minimal SshService fake: scripted exec answers, tracked shells. */
function makeSsh(): {
  ssh: SshService;
  execCalls: string[];
  answerExec: (stdout: string, exitCode: number, stderr?: string) => void;
  /** A per-call script: each exec consumes the head, the tail repeats. */
  answerExecSequence: (answers: { stdout: string; exitCode: number; stderr?: string }[]) => void;
  failExecs: (error: Error) => void;
} {
  const execCalls: string[] = [];
  let answer: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
  let script: ExecResult[] = [];
  let failure: Error | null = null;
  const shells = new Map<ShellId, object>();
  let counter = 0;
  const ssh = {
    shellTracker: { get: (id: ShellId) => shells.get(id) },
    exec: async (_connectionId: string, command: string): Promise<ExecResult> => {
      execCalls.push(command);
      if (failure) throw failure;
      if (script.length > 1) return script.shift()!;
      if (script.length === 1) return script[0]!;
      return answer;
    },
    openTrackedShell: async (
      _connectionId: string,
      o: { command?: string; onData?: (data: Buffer) => void; onExit?: (code: number) => void },
    ): Promise<ShellId> => {
      const id = `shell-${++counter}`;
      shells.set(id, { command: o.command });
      return id;
    },
    shellClose: (id: ShellId): void => {
      shells.delete(id);
    },
  } as unknown as SshService;
  return {
    ssh,
    execCalls,
    answerExec: (stdout, exitCode, stderr = '') => {
      failure = null;
      script = [];
      answer = { stdout, stderr, exitCode };
    },
    answerExecSequence: (answers) => {
      failure = null;
      script = answers.map((a) => ({ stdout: a.stdout, stderr: a.stderr ?? '', exitCode: a.exitCode }));
    },
    failExecs: (error) => {
      failure = error;
    },
  };
}

describe('AplexerClient', () => {
  it('probes once per connection, not once per poll tick', async () => {
    const { ssh, execCalls, answerExec } = makeSsh();
    answerExec('/home/u/.local/bin/a\n', 0);
    const client = new AplexerClient(ssh);
    await expect(client.isAvailable('c1')).resolves.toBe(true);
    await expect(client.isAvailable('c1')).resolves.toBe(true);
    expect(execCalls.filter((c) => c.includes('command -v a'))).toHaveLength(1);
  });

  it('is absent when the probe fails or the transport dies', async () => {
    const { ssh, answerExec, failExecs } = makeSsh();
    answerExec('', 1);
    await expect(new AplexerClient(ssh).isAvailable('c1')).resolves.toBe(false);
    failExecs(new Error('dropped'));
    await expect(new AplexerClient(ssh).isAvailable('c2')).resolves.toBe(false);
  });

  it('lists null without aplexer, rows with it, [] on a failed snapshot', async () => {
    const { ssh, answerExec, answerExecSequence } = makeSsh();
    const client = new AplexerClient(ssh);
    // No `a`: null, so the caller runs the tmux path.
    answerExec('', 1);
    await expect(client.listSessions('c1')).resolves.toBeNull();
    // `a` present but the snapshot fails: [] — the snapshot is the whole list
    // on an aplexer host, so the tree is empty for that poll tick.
    // A fresh connection (the availability cache is per connection).
    answerExecSequence([
      { stdout: '/home/u/.local/bin/a\n', exitCode: 0 },
      { stdout: '', exitCode: 1, stderr: 'boom' },
    ]);
    await expect(client.listSessions('c2')).resolves.toEqual([]);
  });

  it('starts, refuses live pairs, and reports failures with the host sentence', async () => {
    const { ssh, answerExec } = makeSsh();
    const client = new AplexerClient(ssh);
    answerExec(JSON.stringify(record()), 0);
    const created = await client.startSession('c1', { workspace: '/w', tag: 'review' });
    expect(created).toMatchObject({ ok: true, tag: 'review', liveRefusal: false });

    answerExec('', 1, 'a: workspace+tag already belongs to session abc; rename it');
    const refused = await client.startSession('c1', { workspace: '/w', tag: 'review' });
    expect(refused).toMatchObject({ ok: false, liveRefusal: true });

    answerExec('', 1, 'a: tag must contain 1..64 bytes');
    const failed = await client.startSession('c1', { workspace: '/w', tag: 'x'.repeat(70) });
    expect(failed).toMatchObject({ ok: false, liveRefusal: false });
    expect(failed.error).toContain('1..64 bytes');
  });

  it('kills by id, distinguishing gone from failed', async () => {
    const { ssh, answerExec } = makeSsh();
    const client = new AplexerClient(ssh);
    answerExec('{}', 0);
    await expect(client.killSession('c1', 'id-1')).resolves.toMatchObject({ ok: true });
    answerExec('', 1, 'a: no matching session');
    await expect(client.killSession('c1', 'id-1')).resolves.toMatchObject({
      ok: false,
      notFound: true,
    });
    answerExec('', 1, 'permission denied');
    const failed = await client.killSession('c1', 'id-1');
    expect(failed).toMatchObject({ ok: false, notFound: false });
    expect(failed.error).toContain('permission denied');
  });
});

describe('PocketshellClient.listSessions', () => {
  it('lists the snapshot alone on an aplexer host — no helper exec, no tmux probe', async () => {
    const { ssh, execCalls, answerExecSequence } = makeSsh();
    answerExecSequence([
      { stdout: '/home/u/.local/bin/a\n', exitCode: 0 }, // command -v a
      {
        stdout: JSON.stringify([
          record(),
          record({ id: 'r2', tag: 'main', workspace: '/home/alexey/git/aplexer' }),
        ]),
        exitCode: 0,
      },
      { stdout: '', exitCode: 0 }, // the worktree probe: nothing is a worktree
    ]);
    const client = new PocketshellClient(ssh, new AplexerClient(ssh));
    const rows = await client.listSessions('c1');
    expect(rows.map((s) => s.name)).toEqual(['review', 'main']);
    expect(rows.every((s) => s.backend === 'aplexer')).toBe(true);
    expect(execCalls.some((c) => c.includes('pocketshell sessions list'))).toBe(false);
    expect(execCalls.some((c) => c.includes('tmux list-sessions'))).toBe(false);
  });

  it('falls back to the tmux path on a host without aplexer', async () => {
    const { ssh, execCalls, answerExecSequence } = makeSsh();
    answerExecSequence([
      { stdout: '', exitCode: 1 }, // command -v a: absent
      { stdout: '', exitCode: 1 }, // pocketshell sessions list: absent
      {
        // tmux list-sessions fallback
        stdout: 'main::1700000000::1700000100::1::/home/u/git/x\n',
        exitCode: 0,
      },
      { stdout: '', exitCode: 0 }, // the enrichment probe and worktree probe
    ]);
    const client = new PocketshellClient(ssh, new AplexerClient(ssh));
    const rows = await client.listSessions('c1');
    expect(rows.map((s) => s.name)).toEqual(['main']);
    expect(execCalls.some((c) => c.includes('a snapshot'))).toBe(false);
  });
});

describe('TmuxClientPool with aplexer sessions', () => {
  const sink = { onData: () => {}, onExit: () => {} };

  function openedCommands(ssh: { calls: { kind: string; detail: string }[] }): string[] {
    return ssh.calls.filter((c) => c.kind === 'open').map((c) => c.detail);
  }

  function poolWith(ssh: SshService) {
    return new TmuxClientPool(ssh);
  }

  it('joins an aplexer session with `a attach`, not the tmux sweep', async () => {
    const calls: { kind: string; detail: string }[] = [];
    let counter = 0;
    const live = new Set<ShellId>();
    const ssh = {
      shellTracker: { get: (id: ShellId) => (live.has(id) ? { id } : undefined) },
      openTrackedShell: async (_c: string, o: { command?: string }): Promise<ShellId> => {
        const id = `shell-${++counter}`;
        calls.push({ kind: 'open', detail: o.command ?? '' });
        live.add(id);
        return id;
      },
      shellClose: (id: ShellId): void => {
        live.delete(id);
      },
      exec: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as SshService;

    const pool = poolWith(ssh);
    const first = await pool.attach('c1', 'review', {
      ...sink,
      backend: 'aplexer',
      workspace: '/home/alexey/git/pocketshell',
      tag: 'review',
      aplexerId: 'uuid-1',
    });
    expect(first.switched).toBe(false);
    const commands = openedCommands({ calls });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("a attach 'uuid-1'");
    expect(commands[0]).not.toContain('tmux');
    expect(commands[0]).not.toContain('tmuxctl');

    // A repeat attach is free, as with tmux.
    const second = await pool.attach('c1', 'review', {
      ...sink,
      backend: 'aplexer',
      workspace: '/home/alexey/git/pocketshell',
      tag: 'review',
      aplexerId: 'uuid-1',
    });
    expect(second).toEqual({ shellId: first.shellId, switched: true });
    expect(openedCommands({ calls })).toHaveLength(1);
  });

  it('keys same-named tags in different workspaces as two clients', async () => {
    const commands: string[] = [];
    let counter = 0;
    const live = new Set<ShellId>();
    const ssh = {
      shellTracker: { get: (id: ShellId) => (live.has(id) ? { id } : undefined) },
      openTrackedShell: async (_c: string, o: { command?: string }): Promise<ShellId> => {
        const id = `shell-${++counter}`;
        commands.push(o.command ?? '');
        live.add(id);
        return id;
      },
      shellClose: (id: ShellId): void => {
        live.delete(id);
      },
      exec: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as SshService;

    const pool = poolWith(ssh);
    const a = await pool.attach('c1', 'review', { ...sink, backend: 'aplexer', workspace: '/w/a' });
    const b = await pool.attach('c1', 'review', { ...sink, backend: 'aplexer', workspace: '/w/b' });
    expect(a.shellId).not.toBe(b.shellId);
    expect(commands[0]).toContain("--workspace '/w/a'");
    expect(commands[1]).toContain("--workspace '/w/b'");
    // The fence tells the two apart when the caller knows the workspace…
    expect(pool.isShowing(a.shellId, 'review', '/w/a')).toBe(true);
    expect(pool.isShowing(a.shellId, 'review', '/w/b')).toBe(false);
    // …and a rename moves the workspace-qualified key, not a bare name.
    expect(pool.renamed('c1', 'review', 'staging', { backend: 'aplexer', workspace: '/w/a' })).toBe(true);
    expect(pool.isShowing(a.shellId, 'staging', '/w/a')).toBe(true);
    expect(pool.isShowing(b.shellId, 'review', '/w/b')).toBe(true);
    // …and a kill drops exactly one of them.
    expect(pool.killed('c1', 'review', { backend: 'aplexer', workspace: '/w/b' })).toBe(true);
    expect(pool.isShowing(b.shellId, 'review', '/w/b')).toBe(true);
  });

  it('treats redraw as a no-op success and the geometry probe as bare', async () => {
    const { ssh } = makeSsh();
    const pool = poolWith(ssh);
    const { shellId } = await pool.attach('c1', 'review', {
      ...sink,
      backend: 'aplexer',
      workspace: '/w',
    });
    // No exec: there is no tmux client to refresh and no server to ask.
    await expect(pool.redraw(shellId)).resolves.toBe(true);
    await expect(pool.windowSize(shellId)).resolves.toEqual({ kind: 'bare' });
  });

  it('still joins tmux sessions the old way when no backend rides along', async () => {
    const commands: string[] = [];
    let counter = 0;
    const live = new Set<ShellId>();
    const ssh = {
      shellTracker: { get: (id: ShellId) => (live.has(id) ? { id } : undefined) },
      openTrackedShell: async (_c: string, o: { command?: string }): Promise<ShellId> => {
        const id = `shell-${++counter}`;
        commands.push(o.command ?? '');
        live.add(id);
        return id;
      },
      shellClose: (id: ShellId): void => {
        live.delete(id);
      },
      exec: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as SshService;

    const pool = poolWith(ssh);
    await pool.attach('c1', 'git-foo', sink);
    expect(commands[0]).toContain('tmuxctl');
    expect(commands[0]).not.toContain('a attach');
  });
});
