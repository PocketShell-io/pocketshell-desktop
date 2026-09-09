import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecResult } from '../../src/shared/types.js';
import type { SshService } from '@main/ssh/SshService';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { AplexerClient } from '@main/helper/AplexerClient';
import { ProjectsService, type CloneProgress } from '@main/projects/ProjectsService';

const FIXTURES = resolve(__dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

const CONN = 'conn-1';
const HOME = '/home/testuser';

/** A recorded exec: what the host was asked, and what it answered. */
type Responder = (command: string) => ExecResult | null;

/**
 * Strip the `pathAwareCommand` wrapper so an assertion can read the command
 * that was actually built.
 *
 * Every exec goes out as `/bin/sh -lc 'export PATH="…"; <command>'` (sshd runs
 * a non-login shell, so `$HOME/.local/bin` — where uv puts `pocketshell` and
 * `tmuxctl` — is not on PATH otherwise). That wrapper re-escapes the inner
 * command's own quotes, which is exactly the layering these tests want to see
 * survive; unwrapping it here keeps the expectations readable while still
 * exercising the real, doubly-quoted string.
 */
function inner(command: string): string {
  const match = /^\/bin\/sh -lc '(.*)'$/s.exec(command);
  if (!match) return command;
  return match[1]!.replace(/'\\''/g, "'").replace(/^export PATH="[^"]*"; /, '');
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (exitCode: number, stderr = '', stdout = ''): ExecResult => ({
  stdout,
  stderr,
  exitCode,
});

/**
 * A fake SshService that answers by matching the command text.
 *
 * Matching on the command is the point: these tests assert on WHAT is sent to
 * the host as much as on what comes back, so a change to the wire form of a
 * command shows up here rather than only on a live box.
 */
function fakeSsh(responders: Responder[]): { ssh: SshService; commands: string[] } {
  const commands: string[] = [];
  const ssh = {
    exec: (_connectionId: string, command: string): Promise<ExecResult> => {
      commands.push(command);
      for (const responder of responders) {
        const answer = responder(command);
        if (answer) return Promise.resolve(answer);
      }
      return Promise.resolve(fail(127, 'sh: not found'));
    },
  } as unknown as SshService;
  return { ssh, commands };
}

const homeResponder: Responder = (c) => (c.includes('printf %s "$HOME"') ? ok(HOME) : null);
const pwdResponder: Responder = (c) => (c.includes('pwd -P') ? ok(`${HOME}/git/x\n`) : null);
const noSessionResponder: Responder = (c) => (c.includes('has-session') ? fail(1) : null);

function service(responders: Responder[]): {
  projects: ProjectsService;
  commands: string[];
} {
  const { ssh, commands } = fakeSsh(responders);
  return { projects: new ProjectsService(ssh, new PocketshellClient(ssh)), commands };
}

/** The same harness, with the aplexer client wired — the main-session path. */
function serviceWithAplexer(responders: Responder[]): {
  projects: ProjectsService;
  commands: string[];
} {
  const { ssh, commands } = fakeSsh(responders);
  const aplexer = new AplexerClient(ssh);
  return {
    projects: new ProjectsService(ssh, new PocketshellClient(ssh, aplexer), aplexer),
    commands,
  };
}

describe('ProjectsService.home', () => {
  it('resolves and caches $HOME', async () => {
    const { projects, commands } = service([homeResponder]);
    expect(await projects.home(CONN)).toEqual({ ok: true, home: HOME, error: null });
    await projects.home(CONN);
    // Cached: one exec for two calls. $HOME cannot change under a connection.
    expect(commands.filter((c) => c.includes('$HOME"')).length).toBe(1);
  });

  it('reports failure rather than inventing a home', async () => {
    const { projects } = service([(c) => (c.includes('$HOME') ? fail(1, 'nope') : null)]);
    const out = await projects.home(CONN);
    expect(out).toEqual({ ok: false, home: null, error: 'nope' });
  });

  it('drops the cache on evict', async () => {
    const { projects, commands } = service([homeResponder]);
    await projects.home(CONN);
    projects.evict(CONN);
    await projects.home(CONN);
    expect(commands.filter((c) => c.includes('$HOME"')).length).toBe(2);
  });
});

describe('ProjectsService.deriveSessionName', () => {
  it('derives the phone-compatible name from the folder', async () => {
    const { projects } = service([homeResponder]);
    expect(await projects.deriveSessionName(CONN, `${HOME}/git/pocketshell`)).toBe(
      'git-pocketshell',
    );
    expect(await projects.deriveSessionName(CONN, '~/git/pocketshell')).toBe('git-pocketshell');
    expect(await projects.deriveSessionName(CONN, HOME)).toBe('home-testuser');
  });

  it('honours a custom label', async () => {
    const { projects } = service([homeResponder]);
    expect(await projects.deriveSessionName(CONN, `${HOME}/git/x`, 'My Label')).toBe('My-Label');
  });
});

describe('ProjectsService.startSession', () => {
  const createResponder: Responder = (c) =>
    c.includes('sessions create') ? ok('git-x\n') : null;

  it('runs the folder pre-flight, derives the name, and passes --cwd but not --mem', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      noSessionResponder,
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out).toEqual({
      ok: true,
      sessionName: 'git-x',
      folder: `${HOME}/git/x`,
      reused: false,
      via: 'helper',
      aplexerId: null,
      error: null,
      code: null,
    });
    const create = inner(commands.find((c) => c.includes('sessions create'))!);
    expect(create).toContain("sessions create 'git-x'");
    expect(create).toContain(`-c '${HOME}/git/x'`);
    expect(create).not.toContain('--mem');
  });

  it('refuses a folder that does not exist instead of creating a misplaced session', async () => {
    // The helper itself exits 0 for a missing --cwd and lands the pane in
    // $HOME, so this guard is the only thing between the user and a session
    // that claims to be somewhere it is not. The guard IS the canonicalise
    // now: `cd` failing is the missing-folder answer, and no separate
    // `[ -d ]` exec runs ahead of it.
    const { projects, commands } = service([
      homeResponder,
      (c) => (c.includes('pwd -P') ? fail(1) : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/typo' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('folder-missing');
    expect(out.error).toContain('~/git/typo');
    expect(commands.some((c) => c.includes('sessions create'))).toBe(false);
    // The collapse this asserts: $HOME plus ONE canonicalise exec, and the
    // missing-folder refusal falls out of that exec's exit code.
    expect(commands).toHaveLength(2);
  });

  it('reports reuse when the folder already has a session (idempotent, no second create)', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      (c) => (c.includes('has-session') ? ok() : null),
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(true);
    expect(out.reused).toBe(true);
    expect(out.sessionName).toBe('git-x');
    expect(commands.filter((c) => c.includes('sessions create'))).toHaveLength(1);
  });

  it('asks the HOST for a free name under the unique policy', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      (c) => (c.includes('__ps_n=') ? ok('git-x-2\n') : null),
      (c) => (c.includes('sessions create') ? ok('git-x-2\n') : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.sessionName).toBe('git-x-2');
    expect(commands.map(inner).some((c) => c.includes("__ps_n='git-x'"))).toBe(true);
    expect(inner(commands.find((c) => c.includes('sessions create'))!)).toContain("'git-x-2'");
  });

  /**
   * The `+` -> New session bug, pinned at the layer that caused it.
   *
   * This used to assert the opposite — `ok: true` with `sessionName: 'git-x'` —
   * under the heading "never blocks a create". That is the wrong trade for THIS
   * policy, and the symptom is what proves it. `git-x` is the folder's existing
   * session; `pocketshell sessions create` is attach-or-create; so answering
   * `git-x` to "give me a NEW session" hands the caller back a session it
   * already has open, with `ok: true` and `reused: false`, i.e. with no way to
   * tell. In the workspace that re-selected the tab that was already selected
   * (nothing happened) and, with an agent chosen, typed the launch line into the
   * terminal the user was working in.
   *
   * Fail closed, and create NOTHING: the user gets a sentence, and the session
   * they were using is untouched.
   */
  it('refuses a unique start rather than reusing when the free-name probe fails', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      (c) => (c.includes('__ps_n=') ? fail(1) : null),
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('name-unavailable');
    expect(out.sessionName).toBeNull();
    expect(out.error).toContain('git-x');
    expect(commands.some((c) => c.includes('sessions create'))).toBe(false);
  });

  it('refuses a unique start whose probe answered with nothing readable', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      (c) => (c.includes('__ps_n=') ? ok('   \n\n') : null),
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('name-unavailable');
    expect(commands.some((c) => c.includes('sessions create'))).toBe(false);
  });

  /**
   * The helper echoes the resolved name and every other path trusts it. Under
   * `unique` that trust is checked: a name we did not ask for is a name nothing
   * walked the suffix chain for, and it is also the shape a chatty login shell
   * produces, since the echo is read as the first non-blank line of stdout.
   */
  it('refuses a unique start whose create came back under another name', async () => {
    const { projects } = service([
      homeResponder,
      pwdResponder,
      (c) => (c.includes('__ps_n=') ? ok('git-x-2\n') : null),
      (c) => (c.includes('sessions create') ? ok('Welcome to example.com\ngit-x-2\n') : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('name-unavailable');
    expect(out.error).toContain('Welcome to example.com');
  });

  /** The same probe failure under `reuse` is harmless and must stay allowed. */
  it('still creates under the reuse policy when the free-name probe is not run', async () => {
    const { projects } = service([
      homeResponder,
      pwdResponder,
      noSessionResponder,
      createResponder,
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(true);
    expect(out.sessionName).toBe('git-x');
  });

  it('uses the raw tmux create when the helper is absent', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      noSessionResponder,
      (c) => (c.includes('sessions create') ? fail(127, 'sh: pocketshell: not found') : null),
      (c) => (c.includes('new-session') ? ok() : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(true);
    expect(out.via).toBe('tmux-fallback');
    expect(commands.map(inner).some((c) => c.includes("tmux new-session -A -d -s 'git-x'"))).toBe(
      true,
    );
  });

  it('surfaces a GENUINE create failure instead of downgrading to the uncapped fallback', async () => {
    const { projects, commands } = service([
      homeResponder,
      pwdResponder,
      noSessionResponder,
      (c) => (c.includes('sessions create') ? fail(1, 'tmuxctl: systemd-run refused') : null),
    ]);
    const out = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('create-failed');
    expect(out.error).toBe('tmuxctl: systemd-run refused');
    expect(commands.some((c) => c.includes('new-session'))).toBe(false);
  });

  it('takes the name the host echoes back over the one it asked for', async () => {
    const { projects } = service([
      homeResponder,
      pwdResponder,
      noSessionResponder,
      (c) => (c.includes('sessions create') ? ok('git-x-7\n') : null),
    ]);
    expect((await projects.startSession(CONN, { folder: '~/git/x' })).sessionName).toBe('git-x-7');
  });
});

describe('ProjectsService.startSession on an aplexer host', () => {
  const WS = `${HOME}/git/x`;

  /** `a` is present, the canonicalise answers, and the snapshot is [records]. */
  function aplexerResponders(records: unknown[]): Responder[] {
    return [
      homeResponder,
      pwdResponder,
      (c) => (c.includes('command -v a') ? ok('/usr/local/bin/a') : null),
      (c) => (c.includes('a snapshot --json') ? ok(JSON.stringify(records)) : null),
    ];
  }

  /** The JSON record `a start --json` prints for a created session. */
  const startRecord = (id: string, tag: string): string =>
    JSON.stringify({ id, workspace: WS, tag, phase: 'running', worker_alive: true });

  it('names the FIRST session in a workspace `main`, not the folder-derived name', async () => {
    const { projects, commands } = serviceWithAplexer(
      aplexerResponders([]).concat([
        (c) => (c.includes('a start') ? ok(startRecord('apx-1', 'main')) : null),
      ]),
    );
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out).toMatchObject({
      ok: true,
      sessionName: 'main',
      folder: WS,
      reused: false,
      via: 'aplexer',
      aplexerId: 'apx-1',
    });
    // The tag the host was asked for is the tag the user will see on `a ls`.
    expect(commands.map(inner).some((c) => c.includes(`--tag 'main'`))).toBe(true);
    expect(commands.map(inner).some((c) => c.includes('git-x'))).toBe(false);
  });

  it('walks `main-2`, `main-3`… PER WORKSPACE for the ones after it', async () => {
    const { projects, commands } = serviceWithAplexer(
      aplexerResponders([
        { id: 'apx-1', workspace: WS, tag: 'main', phase: 'running', worker_alive: true },
      ]).concat([(c) => (c.includes('a start') ? ok(startRecord('apx-2', 'main-2')) : null)]),
    );
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.sessionName).toBe('main-2');
    expect(commands.map(inner).some((c) => c.includes(`--tag 'main-2'`))).toBe(true);
  });

  it('does not let ANOTHER workspace’s `main` block the walk', async () => {
    const { projects } = serviceWithAplexer(
      aplexerResponders([
        { id: 'apx-9', workspace: '/home/testuser/other', tag: 'main', phase: 'running', worker_alive: true },
      ]).concat([(c) => (c.includes('a start') ? ok(startRecord('apx-1', 'main')) : null)]),
    );
    const out = await projects.startSession(CONN, { folder: '~/git/x', namePolicy: 'unique' });
    expect(out.sessionName).toBe('main');
  });

  it('reuses the live `main` under the reuse policy, and honours a custom label', async () => {
    const { projects, commands } = serviceWithAplexer(
      aplexerResponders([
        { id: 'apx-1', workspace: WS, tag: 'main', phase: 'running', worker_alive: true },
      ]),
    );
    const reused = await projects.startSession(CONN, { folder: '~/git/x' });
    expect(reused).toMatchObject({ ok: true, sessionName: 'main', reused: true, via: 'aplexer' });
    expect(commands.some((c) => c.includes('a start'))).toBe(false);

    const custom = await serviceWithAplexer(
      aplexerResponders([]).concat([
        (c) => (c.includes('a start') ? ok(startRecord('apx-3', 'Staging')) : null),
      ]),
    ).projects.startSession(CONN, { folder: '~/git/x', customName: 'Staging!' });
    expect(custom.sessionName).toBe('Staging');
  });
});

describe('ProjectsService.deriveSessionName on an aplexer host', () => {
  it('previews `main`, because that is what the create will tag', async () => {
    const { projects } = serviceWithAplexer([
      homeResponder,
      pwdResponder,
      (c) => (c.includes('command -v a') ? ok('/usr/local/bin/a') : null),
    ]);
    expect(await projects.deriveSessionName(CONN, '~/git/pocketshell')).toBe('main');
    expect(await projects.deriveSessionName(CONN, '~/git/pocketshell', 'My Label')).toBe(
      'My-Label',
    );
  });

  it('keeps the folder derivation on a host without aplexer', async () => {
    const { projects } = serviceWithAplexer([
      homeResponder,
      (c) => (c.includes('command -v a') ? fail(1) : null),
    ]);
    expect(await projects.deriveSessionName(CONN, '~/git/pocketshell')).toBe('git-pocketshell');
  });
});

describe('ProjectsService.createFolder', () => {
  it('creates the folder and returns its canonical path', async () => {
    const { projects, commands } = service([
      (c) => (c.includes('mkdir -p --') ? ok() : null),
      (c) => (c.includes('pwd -P') ? ok(`${HOME}/git/new-thing`) : null),
    ]);
    const out = await projects.createFolder(CONN, { parent: '~/git', name: ' new-thing ' });
    expect(out).toEqual({ ok: true, path: `${HOME}/git/new-thing`, error: null });
    expect(inner(commands[0]!)).toBe("mkdir -p -- $HOME/'git/new-thing'");
  });

  it('rejects a name that is not a single folder', async () => {
    const { projects, commands } = service([]);
    for (const name of ['', '..', 'a/b', 'a\\b']) {
      const out = await projects.createFolder(CONN, { parent: '~/git', name });
      expect(out.ok).toBe(false);
      expect(out.path).toBeNull();
    }
    expect(commands).toEqual([]);
  });

  it('quotes a hostile folder name rather than executing it', async () => {
    const { projects, commands } = service([
      (c) => (c.includes('mkdir') ? ok() : null),
      (c) => (c.includes('pwd -P') ? ok(`${HOME}/git/x`) : null),
    ]);
    // No `/` in the NAME — that is rejected outright by the validator above —
    // so the payload rides in on the parent path and on a slash-free name.
    await projects.createFolder(CONN, {
      parent: "~/git/wei'rd $(touch PWNED)",
      name: "a'; touch PWNED; :",
    });
    // The payload never leaves its quoted region, through BOTH quoting layers:
    // the command builder's, and pathAwareCommand's re-escape on top of it.
    expect(inner(commands[0]!)).toBe(
      "mkdir -p -- $HOME/'git/wei'\\''rd $(touch PWNED)/a'\\''; touch PWNED; :'",
    );
    // The `$(…)` and the `;` are present as DATA, never as syntax.
    expect(commands[0]).toContain('touch PWNED');
    expect((commands[0]!.replace(/\\'/g, '').match(/'/g)?.length ?? 0) % 2).toBe(0);
  });

  it('reports the host message when mkdir fails', async () => {
    const { projects } = service([(c) => (c.includes('mkdir') ? fail(1, 'Permission denied') : null)]);
    const out = await projects.createFolder(CONN, { parent: '/root', name: 'x' });
    expect(out).toEqual({ ok: false, path: null, error: 'Permission denied' });
  });
});

describe('ProjectsService.reposList', () => {
  const localOk: Responder = (c) =>
    c.includes('repos list --local') ? ok(readFixture('v0.4.44-repos-list-local.json')) : null;
  const ghMissing: Responder = (c) =>
    c.includes('repos list --remote')
      ? fail(127, readFixture('v0.4.44-repos-list-remote-gh-missing.stderr.txt'))
      : null;

  it('runs both scopes and merges them', async () => {
    const { projects } = service([
      localOk,
      (c) =>
        c.includes('repos list --remote')
          ? ok(readFixture('v0.4.44-repos-list-remote-schema.json'))
          : null,
    ]);
    const out = await projects.reposList(CONN);
    expect(out.ok).toBe(true);
    expect(out.local?.state).toBe('ok');
    expect(out.remote?.state).toBe('ok');
    expect(out.repos.map((r) => r.name)).toEqual([
      'demo-repo',
      'Hello-World',
      'pocketshell',
      'dataops',
    ]);
  });

  it('stays ok when the host has no gh — the local list is what matters', async () => {
    const { projects } = service([localOk, ghMissing]);
    const out = await projects.reposList(CONN);
    expect(out.ok).toBe(true);
    expect(out.remote?.state).toBe('gh-missing');
    expect(out.remote?.repos).toEqual([]);
    expect(out.remote?.error).toContain('`gh` is not installed');
    expect(out.repos).toHaveLength(2);
  });

  it('runs only the requested scope', async () => {
    const { projects, commands } = service([localOk]);
    const out = await projects.reposList(CONN, { scope: 'local' });
    expect(out.remote).toBeNull();
    expect(commands.some((c) => c.includes('--remote'))).toBe(false);
  });

  it('clears ok for a genuine scope failure', async () => {
    const { projects } = service([
      (c) => (c.includes('--local') ? fail(1, 'boom') : null),
      ghMissing,
    ]);
    const out = await projects.reposList(CONN);
    expect(out.ok).toBe(false);
    expect(out.local?.state).toBe('failed');
  });
});

describe('ProjectsService.cloneRepo', () => {
  it('emits started/finished around the clone and returns the path', async () => {
    const { projects } = service([
      (c) => (c.includes('repos clone') ? ok('/home/testuser/git/Hello-World\n') : null),
    ]);
    const events: CloneProgress[] = [];
    const out = await projects.cloneRepo(
      CONN,
      { repository: 'octocat/Hello-World', requestId: 'r1' },
      (p) => events.push(p),
    );
    expect(out).toEqual({
      ok: true,
      path: '/home/testuser/git/Hello-World',
      alreadyExists: false,
      error: null,
    });
    expect(events.map((e) => e.phase)).toEqual(['started', 'finished']);
    expect(events[0]!.requestId).toBe('r1');
    expect(events[1]!.path).toBe('/home/testuser/git/Hello-World');
  });

  it('recovers the path from the "already exists" failure so the flow can continue', async () => {
    // Real stderr, exit 1, from re-cloning on the fixture.
    const { projects } = service([
      (c) =>
        c.includes('repos clone')
          ? fail(1, readFixture('v0.4.44-repos-clone-exists.stderr.txt'))
          : null,
    ]);
    const out = await projects.cloneRepo(CONN, { repository: 'octocat/Hello-World' });
    expect(out).toEqual({
      ok: true,
      path: '/home/testuser/git/Hello-World',
      alreadyExists: true,
      error: null,
    });
  });

  it('reports a git failure with the host message', async () => {
    const { projects } = service([
      (c) =>
        c.includes('repos clone')
          ? fail(128, readFixture('v0.4.44-repos-clone-failed.stderr.txt'))
          : null,
    ]);
    const out = await projects.cloneRepo(CONN, { repository: 'nosuchowner/nosuchrepo-xyz' });
    expect(out.ok).toBe(false);
    expect(out.path).toBeNull();
    expect(out.error).toContain('could not read Username');
  });

  it('still emits finished when the clone fails, so the UI stops spinning', async () => {
    const { projects } = service([(c) => (c.includes('repos clone') ? fail(128, 'nope') : null)]);
    const events: CloneProgress[] = [];
    await projects.cloneRepo(CONN, { repository: 'o/r', requestId: 'r2' }, (p) => events.push(p));
    expect(events.map((e) => e.phase)).toEqual(['started', 'finished']);
    expect(events[1]!.error).toBe('nope');
  });
});

describe('PocketshellClient.createSession — real fixture output', () => {
  it('reads the resolved name off stdout and ignores the tmuxctl stderr notice', async () => {
    // Captured from `pocketshell sessions create fixture-probe-2 -c $HOME`
    // on the Docker fixture (helper 0.4.44): the name on stdout, a
    // "systemd-run unavailable; session runs without a memory cap" notice on
    // stderr, exit 0.
    const { ssh } = fakeSsh([
      (c) =>
        c.includes('sessions create')
          ? {
              stdout: readFixture('v0.4.44-sessions-create.stdout.txt'),
              stderr: readFixture('v0.4.44-sessions-create.stderr.txt'),
              exitCode: 0,
            }
          : null,
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 'fixture-probe-2',
      cwd: '$HOME',
    });
    expect(out).toEqual({ ok: true, name: 'fixture-probe-2', via: 'helper', error: null });
  });

  it('falls back to raw tmux when the helper binary is absent', async () => {
    // The one case the fallback still exists for: no `pocketshell` on PATH.
    // The session comes up WITHOUT a memory cap, which is why `via` has to say
    // `tmux-fallback` — the dialog turns that into a sentence for the user.
    const { ssh, commands } = fakeSsh([
      (c) => (c.includes('sessions create') ? fail(127, 'sh: pocketshell: not found') : null),
      (c) => (c.includes('tmux new-session') ? ok('') : null),
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 's',
      cwd: '/home/testuser/git/x',
    });
    expect(out).toEqual({ ok: true, name: 's', via: 'tmux-fallback', error: null });
    expect(commands.some((c) => inner(c).includes('tmux new-session -A -d'))).toBe(true);
  });

  it('does NOT fall back when the helper rejects the command — that would drop the memory cap', async () => {
    // Click exits 2 with "No such command" for a subcommand the installed
    // helper does not have. That used to trigger this fallback as an
    // old-helper shim, which meant a command WE got wrong was laundered into a
    // successful-looking, uncapped session. Against 0.4.44 it is a real fault,
    // so it must fail loudly and never reach raw tmux.
    const { ssh, commands } = fakeSsh([
      (c) => (c.includes('sessions create') ? fail(2, "Error: No such command 'sessions'.") : null),
      (c) => (c.includes('tmux new-session') ? ok('') : null),
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 's',
      cwd: '/home/testuser/git/x',
    });
    expect(out.ok).toBe(false);
    expect(out.via).toBe('helper');
    expect(out.error).toContain("No such command 'sessions'.");
    expect(out.error).toContain('pocketshell --version');
    expect(commands.some((c) => c.includes('tmux new-session'))).toBe(false);
  });

  it('reports a rejected option instead of quietly creating an uncapped session', async () => {
    const { ssh, commands } = fakeSsh([
      (c) => (c.includes('sessions create') ? fail(2, 'Error: No such option: --cwd') : null),
      (c) => (c.includes('tmux new-session') ? ok('') : null),
    ]);
    const out = await new PocketshellClient(ssh).createSession(CONN, {
      name: 's',
      cwd: '/home/testuser/git/x',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('drifted');
    expect(commands.some((c) => c.includes('tmux new-session'))).toBe(false);
  });
});

/**
 * The session name is the join namespace: tmuxctl derives a socket from it and
 * every desktop-side structure is keyed by it, so a rename that produces a
 * duplicate name mangles the tab bar, and a join that could only resolve
 * name-derived sockets is what made the last rename strand its session. These
 * pin the guards that keep a rename real: the host-wide taken sweep, the
 * alphabet, and the rename landing on the session's own server.
 */
describe('ProjectsService.renameSession', () => {
  it('renames with an exact-match target and an option terminator', async () => {
    const { projects, commands } = service([
      noSessionResponder,
      (c) => (c.includes('rename-session') ? ok() : null),
    ]);
    const out = await projects.renameSession(CONN, 'git-x', 'git-x-staging');
    expect(out).toEqual({ ok: true, sessionName: 'git-x-staging', error: null, code: null });
    expect(commands.map(inner)).toContain(
      "tmux rename-session -t '=git-x' -- 'git-x-staging'",
    );
  });

  it('sanitises to the alphabet `tmuxctl <name>` can still join', async () => {
    const { projects, commands } = service([
      noSessionResponder,
      (c) => (c.includes('rename-session') ? ok() : null),
    ]);
    const out = await projects.renameSession(CONN, 'git-x', 'feat/my.branch');
    expect(out.sessionName).toBe('feat-my_branch');
    expect(commands.map(inner).join('\n')).toContain("-- 'feat-my_branch'");
  });

  it('asks the HOST whether the name is free, and refuses when it is not', async () => {
    const { projects, commands } = service([(c) => (c.includes('has-session') ? ok() : null)]);
    const out = await projects.renameSession(CONN, 'git-x', 'git-y');
    expect(out).toMatchObject({ ok: false, code: 'name-taken' });
    // The exact-match `=` is what stops `git-y` probing as taken because
    // `git-y-2` exists; the sweep is what stops `git-y` probing as free
    // because it lives on a socket other than the one being renamed.
    expect(commands.map(inner).join('\n')).toContain("__ps_taken 'git-y'");
    expect(commands.some((c) => c.includes('rename-session'))).toBe(false);
  });

  it('refuses a name with nothing alphanumeric left rather than inventing one', async () => {
    const { projects, commands } = service([]);
    const out = await projects.renameSession(CONN, 'git-x', ':::');
    expect(out).toMatchObject({ ok: false, code: 'illegal-name' });
    expect(commands).toEqual([]);
  });

  it('treats an unchanged name as a success, and never probes for it', async () => {
    // Committing an unchanged tab label is the commonest thing a rename field
    // does; probing would find the session itself and report its own name taken.
    const { projects, commands } = service([]);
    expect(await projects.renameSession(CONN, 'git-x', 'git-x')).toMatchObject({
      ok: true,
      sessionName: 'git-x',
    });
    expect(commands).toEqual([]);
  });

  it("surfaces tmux's own stderr when the rename fails", async () => {
    const { projects } = service([
      noSessionResponder,
      (c) => (c.includes('rename-session') ? fail(1, "can't find session: git-x") : null),
    ]);
    const out = await projects.renameSession(CONN, 'git-x', 'git-y');
    expect(out).toMatchObject({ ok: false, code: 'rename-failed' });
    expect(out.error).toContain("can't find session");
  });
});

/**
 * The only destructive operation in this app, and the
 * only one with no undo — a tmux session is usually an agent mid-task.
 *
 * The lever was chosen against the pinned 0.4.44 fixture rather than picked:
 * `pocketshell sessions` has no kill verb at all, and `tmuxctl kill` cannot
 * kill a numerically-named session and issues its own kill with a bare `-t`.
 * See killSessionCommand for the captures.
 */
describe('ProjectsService.killSession', () => {
  /** The session is alive: `has-session` exits 0. */
  const aliveResponder: Responder = (c) => (c.includes('has-session') ? ok() : null);

  it('probes first, then kills with an exact-match target', async () => {
    const { projects, commands } = service([
      aliveResponder,
      (c) => (c.includes('kill-session') ? ok() : null),
    ]);
    expect(await projects.killSession(CONN, 'git-x')).toEqual({
      ok: true,
      error: null,
      code: null,
    });
    // Both `=`s matter. On the probe it stops `git-x` reading as taken because
    // `git-x-2` exists; on the kill it stops a bare `-t` prefix-matching a
    // neighbour once `git-x` is gone — which exits 0 having killed the wrong
    // session.
    expect(commands.map(inner)).toContain("tmux has-session -t '=git-x' 2>/dev/null");
    expect(commands.map(inner)).toContain("tmux kill-session -t '=git-x'");
  });

  it('reports a session that is ALREADY GONE as its own outcome, and kills nothing', async () => {
    // Not an edge case: the tab bar refreshes on a timer, so the session behind
    // a tab can be killed from the phone or from the user's own terminal at any
    // moment before the menu item is clicked. A distinct code lets the UI say
    // "already gone" and refresh, rather than showing a failure for a state the
    // user asked for.
    const { projects, commands } = service([noSessionResponder]);
    const out = await projects.killSession(CONN, 'git-x');
    expect(out).toMatchObject({ ok: false, code: 'not-found' });
    expect(out.error).toContain('git-x');
    expect(commands.some((c) => c.includes('kill-session'))).toBe(false);
  });

  it('separates the two outcomes by PROBING, never by parsing tmux prose', async () => {
    // "can't find session" is a message, and messages are not an API.
    const { projects } = service([
      aliveResponder,
      (c) => (c.includes('kill-session') ? fail(1, "can't find session: git-x") : null),
    ]);
    const out = await projects.killSession(CONN, 'git-x');
    expect(out).toMatchObject({ ok: false, code: 'kill-failed' });
    expect(out.error).toContain("can't find session");
  });

  it('never falls back to a bare -t when the exact target fails', async () => {
    const { projects, commands } = service([
      aliveResponder,
      (c) => (c.includes('kill-session') ? fail(1, 'nope') : null),
    ]);
    await projects.killSession(CONN, 'git-x');
    // One attempt only. A retry without the `=` would be the fail-open path
    // this design exists to avoid.
    expect(commands.map(inner).filter((c) => c.includes('kill-session'))).toHaveLength(1);
  });
});

/**
 * The locator's three answers, aimed at the user's own report: "when I click
 * on stop session it doesn't actually stop". The host's helper had migrated to
 * one tmux SERVER per session (`tmuxctl-*` sockets), while both halves of Stop
 * asked the default socket only — so a live session answered "already gone"
 * silently, forever. Each test pins one of the three ways a sweep can come
 * back, and what Stop must do about it.
 */
describe('ProjectsService.killSession — aimed by the locator', () => {
  const SOCKET = '/tmp/tmux-1000/tmuxctl-42';

  /** The multi-socket sweep, answering with `names`, each on its own server. */
  const sweepResponder =
    (names: string[]): Responder =>
    (c) =>
      c.includes('list-panes -a')
        ? ok(
            names
              .map((n) => `${n}::1::1::/home/x::/home/x::0::claude::${SOCKET}-${n}`)
              .join('\n'),
          )
        : null;

  it('aims probe AND kill at the session’s own tmux server', async () => {
    const { projects, commands } = service([
      sweepResponder(['git-aplexer']),
      (c) => (c.includes('has-session') ? ok() : null),
      (c) => (c.includes('kill-session') ? ok() : null),
    ]);
    expect(await projects.killSession(CONN, 'git-aplexer')).toEqual({
      ok: true,
      error: null,
      code: null,
    });
    const aimed = commands.map(inner).filter((c) => c.includes("-S '"));
    // Both the existence probe and the kill carry `-S` to the server the sweep
    // reported — the default socket is never consulted for this session.
    expect(aimed).toContain(
      `tmux -S '${SOCKET}-git-aplexer' has-session -t '=git-aplexer' 2>/dev/null`,
    );
    expect(aimed).toContain(`tmux -S '${SOCKET}-git-aplexer' kill-session -t '=git-aplexer'`);
    expect(commands.map(inner).some((c) => c.includes('has-session') && !c.includes('-S'))).toBe(
      false,
    );
  });

  it('answers not-found from the sweep alone when the name is on NO server', async () => {
    // The sweep enumerated servers and the name is on none of them — asking
    // again through a bare probe could only repeat the sweep's own answer.
    const { projects, commands } = service([sweepResponder(['git-other'])]);
    const out = await projects.killSession(CONN, 'git-aplexer');
    expect(out).toMatchObject({ ok: false, code: 'not-found' });
    expect(out.error).toContain('git-aplexer');
    expect(commands.some((c) => c.includes('kill-session'))).toBe(false);
    expect(commands.some((c) => c.includes('has-session'))).toBe(false);
  });

  it('keeps the legacy bare commands when the sweep itself failed', async () => {
    // A dead sweep proves nothing, and Stop is destructive: absence may never
    // be claimed on a transport failure. The pre-locator spelling runs.
    const { projects, commands } = service([
      (c) => (c.includes('list-panes -a') ? fail(1, 'ssh died') : null),
      noSessionResponder,
    ]);
    const out = await projects.killSession(CONN, 'git-x');
    expect(out).toMatchObject({ ok: false, code: 'not-found' });
    expect(commands.map(inner)).toContain("tmux has-session -t '=git-x' 2>/dev/null");
    // The sweep's own loop body contains a `-S` — the assertion is about the
    // two real commands, not about the sweep text.
    const real = commands.map(inner).filter((c) => !c.includes('list-panes'));
    expect(real.every((c) => !c.includes('-S '))).toBe(true);
  });
});

describe('ProjectsService.renameSession — aimed like the kill', () => {
  it('renames on the session’s own server, and asks the whole host about the target', async () => {
    const SOCKET = '/tmp/tmux-1000/tmuxctl-7-api';
    const { projects, commands } = service([
      (c) =>
        c.includes('list-panes -a')
          ? ok(`api::1::1::/home/x::/home/x::0::shell::${SOCKET}`)
          : null,
      (c) => (c.includes('has-session') ? fail(1) : null), // target name is free
      (c) => (c.includes('rename-session') ? ok() : null),
    ]);
    const out = await projects.renameSession(CONN, 'api', 'api-2');
    expect(out).toEqual({ ok: true, sessionName: 'api-2', error: null, code: null });
    const innered = commands.map(inner);
    // The rename runs where the session lives — usually not the default socket.
    expect(innered).toContain(`tmux -S '${SOCKET}' rename-session -t '=api' -- 'api-2'`);
    // Uniqueness is a question about the JOIN namespace, which is host-wide:
    // tmuxctl derives a socket from the name, and every desktop-side structure
    // (tabs, composer, enrichment map) is keyed by name across servers.
    expect(innered.filter((c) => c.includes('__ps_taken'))).toHaveLength(1);
    expect(innered.some((c) => c.includes(`-S '${SOCKET}' has-session`))).toBe(false);
  });
});
