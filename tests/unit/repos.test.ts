import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  annotateHelperRejection,
  classifyReposFailure,
  describeHelperRejection,
  isHelperMissing,
  mergeRepos,
  parseReposJson,
  type RepoEntry,
} from '@main/projects/repos';

/**
 * Captured verbatim from the Docker fixture (`tests-docker` helper service,
 * port 3205) running pocketshell **0.4.44** on alpine 3.20 / tmux 3.4 —
 * nothing here is hand-authored.
 *
 * The `--remote` payload needs a `gh` the image does not ship, so it was
 * captured by putting a stub `gh` on PATH that replays the GitHub REST shape
 * `gh api user/repos --paginate --slurp` returns; the REAL helper then did the
 * normalisation, which is the part these tests assert. It came back
 * byte-identical to the 0.4.8 capture, as did every other file here.
 */
const FIXTURES = resolve(__dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

describe('parseReposJson — real `repos list --local --json` output', () => {
  const rows = parseReposJson(readFixture('v0.4.44-repos-list-local.json'));

  it('parses every row', () => {
    expect(rows).toHaveLength(2);
  });

  it('carries a populated local block and a null remote block', () => {
    expect(rows[0]).toEqual({
      name: 'demo-repo',
      owner: null,
      fullName: null,
      local: { path: '/home/testuser/git/demo-repo', head: 'master' },
      remote: null,
    });
  });

  it('leaves owner/fullName null for a clone with no GitHub origin', () => {
    // A plain `git init` folder: the helper cannot infer owner/full_name, so a
    // consumer keying on fullName must fall back to name.
    expect(rows[0]!.fullName).toBeNull();
    expect(rows[0]!.owner).toBeNull();
  });

  it('populates owner/fullName from a GitHub origin', () => {
    expect(rows[1]!.owner).toBe('octocat');
    expect(rows[1]!.fullName).toBe('octocat/Hello-World');
    expect(rows[1]!.local?.path).toBe('/home/testuser/git/Hello-World');
  });
});

describe('parseReposJson — `--remote` schema', () => {
  const rows = parseReposJson(readFixture('v0.4.44-repos-list-remote-schema.json'));

  it('carries a populated remote block and a null local block', () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'pocketshell',
      owner: 'alexeygrigorev',
      fullName: 'alexeygrigorev/pocketshell',
      local: null,
      remote: {
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/alexeygrigorev/pocketshell',
        sshUrl: 'git@github.com:alexeygrigorev/pocketshell.git',
        updatedAt: '2026-05-27T12:00:00Z',
      },
    });
  });
});

describe('parseReposJson — degradation', () => {
  it('returns [] for blank, non-JSON, or non-array payloads', () => {
    expect(parseReposJson('')).toEqual([]);
    expect(parseReposJson('   ')).toEqual([]);
    expect(parseReposJson('not json')).toEqual([]);
    expect(parseReposJson('{"profiles":[]}')).toEqual([]);
  });

  it('drops rows it cannot identify rather than throwing', () => {
    expect(parseReposJson('[null, 3, {}, {"name":"ok"}]')).toEqual([
      { name: 'ok', owner: null, fullName: null, local: null, remote: null },
    ]);
  });

  it('recovers a name from the clone path when `name` is missing', () => {
    const rows = parseReposJson('[{"local":{"path":"/home/a/git/thing","head":null}}]');
    expect(rows[0]!.name).toBe('thing');
    expect(rows[0]!.local?.head).toBeNull();
  });

  it('synthesises fullName from owner + name when the helper omits it', () => {
    const rows = parseReposJson('[{"name":"r","owner":"o"}]');
    expect(rows[0]!.fullName).toBe('o/r');
  });
});

describe('mergeRepos', () => {
  const local = parseReposJson(readFixture('v0.4.44-repos-list-local.json'));
  const remote = parseReposJson(readFixture('v0.4.44-repos-list-remote-schema.json'));

  it('joins a cloned repo and its GitHub row into ONE entry carrying both blocks', () => {
    const merged = mergeRepos(local, [
      {
        name: 'Hello-World',
        owner: 'octocat',
        fullName: 'octocat/Hello-World',
        local: null,
        remote: { defaultBranch: 'master', htmlUrl: null, sshUrl: null, updatedAt: null },
      },
    ]);
    expect(merged).toHaveLength(2);
    const joined = merged.find((r) => r.fullName === 'octocat/Hello-World')!;
    expect(joined.local?.path).toBe('/home/testuser/git/Hello-World');
    expect(joined.remote?.defaultBranch).toBe('master');
  });

  it('appends remote-only rows after the local ones', () => {
    const merged = mergeRepos(local, remote);
    expect(merged.map((r) => r.name)).toEqual([
      'demo-repo',
      'Hello-World',
      'pocketshell',
      'dataops',
    ]);
  });

  it('keys on name when fullName is null on both sides', () => {
    const merged = mergeRepos(
      [{ name: 'x', owner: null, fullName: null, local: { path: '/a/x', head: null }, remote: null }],
      [{ name: 'x', owner: null, fullName: null, local: null, remote: null }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.local?.path).toBe('/a/x');
  });

  it('keeps every local clone that shares a GitHub origin — a worktree is a destination too', () => {
    // Captured on a real host: `~/git/dapier` and its `~/git/dapier-worktrees/*`
    // checkouts all carry the main repository's `remote.origin.url`, so all
    // three rows share one fullName. The merge used to key LOCAL rows on it and
    // keep the alphabetically last, which is how the picker ended up offering
    // `oauth-popup-redirect` while `dapier` itself — the folder the user asked
    // for by name — was gone from the catalog.
    const dapier: RepoEntry[] = [
      {
        name: 'connections-ux',
        owner: null,
        fullName: 'DataTalksClub/dapier',
        local: { path: '/home/alexey/git/dapier-worktrees/connections-ux', head: 'main' },
        remote: null,
      },
      {
        name: 'dapier',
        owner: null,
        fullName: 'DataTalksClub/dapier',
        local: { path: '/home/alexey/git/dapier', head: 'main' },
        remote: null,
      },
      {
        name: 'oauth-popup-redirect',
        owner: null,
        fullName: 'DataTalksClub/dapier',
        local: { path: '/home/alexey/git/dapier-worktrees/oauth-popup-redirect', head: 'workflows' },
        remote: null,
      },
    ];
    const merged = mergeRepos(dapier, [
      {
        name: 'dapier',
        owner: 'DataTalksClub',
        fullName: 'DataTalksClub/dapier',
        local: null,
        remote: { defaultBranch: 'main', htmlUrl: null, sshUrl: null, updatedAt: null },
      },
    ]);
    expect(merged.map((r) => r.local?.path)).toEqual([
      '/home/alexey/git/dapier-worktrees/connections-ux',
      '/home/alexey/git/dapier',
      '/home/alexey/git/dapier-worktrees/oauth-popup-redirect',
    ]);
    // The GitHub row's block reaches every clone of that origin, and no
    // remote-only duplicate is appended for a key the clones already claim.
    expect(merged).toHaveLength(3);
    expect(
      merged.every((r) => r.owner === 'DataTalksClub' && r.remote?.defaultBranch === 'main'),
    ).toBe(true);
  });

  it('handles either side being empty', () => {
    expect(mergeRepos([], [])).toEqual([]);
    expect(mergeRepos(local, [])).toHaveLength(2);
    expect(mergeRepos([], remote)).toHaveLength(2);
  });
});

describe('classifyReposFailure', () => {
  it('reports a missing `gh` as gh-missing, not as a broken helper', () => {
    // Real stderr, exit 127, from `repos list --remote --json` on the fixture.
    const stderr = readFixture('v0.4.44-repos-list-remote-gh-missing.stderr.txt');
    const out = classifyReposFailure(127, '', stderr);
    expect(out.state).toBe('gh-missing');
    expect(out.error).toContain('`gh` is not installed on this host');
  });

  it('does not let the gh-missing message read as gh-unauthenticated', () => {
    // The gh-missing text mentions `gh auth login`, which is also the
    // unauthenticated marker — the "is not installed" check has to win.
    const stderr = readFixture('v0.4.44-repos-list-remote-gh-missing.stderr.txt');
    expect(stderr).toContain('gh auth login');
    expect(classifyReposFailure(127, '', stderr).state).toBe('gh-missing');
  });

  it('reports a logged-out gh as gh-unauthenticated', () => {
    expect(classifyReposFailure(1, '', 'gh: not authenticated. Run gh auth login.').state).toBe(
      'gh-unauthenticated',
    );
    expect(classifyReposFailure(4, '', 'authentication required').state).toBe(
      'gh-unauthenticated',
    );
  });

  it('reports an absent helper as helper-missing', () => {
    expect(classifyReposFailure(127, '', 'sh: pocketshell: not found').state).toBe(
      'helper-missing',
    );
  });

  it('reports an unknown subcommand as a FAILURE, not as an absent helper', () => {
    // Was `helper-missing` while the v0.4.8 shim stood ("too old to know the
    // subcommand"). Against 0.4.44 that reading is dead: `repos` exists, so
    // this is a real fault on the host or in the command we built, and the UI
    // must show it in an error tone rather than as "this host just has no
    // helper".
    const out = classifyReposFailure(2, '', "Error: No such command 'repos'.");
    expect(out.state).toBe('failed');
    expect(out.error).toContain("No such command 'repos'."); // the host's own line survives
    expect(out.error).toContain('pocketshell --version'); // …plus something to act on
  });

  it('reports a rejected option as a failure too, with its own wording', () => {
    const out = classifyReposFailure(2, '', 'Error: No such option: --json');
    expect(out.state).toBe('failed');
    expect(out.error).toContain('drifted');
  });

  it('leaves an ordinary failure message untouched', () => {
    expect(classifyReposFailure(1, '', 'boom').error).toBe('boom');
  });

  it('reports anything else as a plain failure, keeping the host message', () => {
    const out = classifyReposFailure(1, '', 'boom');
    expect(out.state).toBe('failed');
    expect(out.error).toBe('boom');
  });

  it('falls back to stdout, then to the exit code, for the message', () => {
    expect(classifyReposFailure(1, 'on stdout', '').error).toBe('on stdout');
    expect(classifyReposFailure(9, '', '').error).toBe('pocketshell repos exited 9');
  });
});

describe('isHelperMissing', () => {
  it('is true for the shell 127 — the binary is not on PATH', () => {
    expect(isHelperMissing(127, 'sh: pocketshell: not found')).toBe(true);
    expect(isHelperMissing(127, '/bin/sh: 1: pocketshell: command not found')).toBe(true);
  });

  it('is FALSE for a Click usage error — the old-helper shim is gone', () => {
    // These were true while `isHelperMissing` doubled as a version check. They
    // must be false now: this predicate is what makes `createSession` drop to
    // an UNCAPPED raw tmux create, so a command we got wrong must never be
    // able to reach that path.
    expect(isHelperMissing(2, "Error: No such command 'sessions'.")).toBe(false);
    expect(isHelperMissing(2, 'Error: No such option: --cwd')).toBe(false);
  });

  it('needs the 127, not just the words — a helper that PRINTS them still ran', () => {
    expect(isHelperMissing(1, 'fatal: command not found in $PATH')).toBe(false);
  });

  it('is false for the gh 127, which is a different absence entirely', () => {
    expect(
      isHelperMissing(127, readFixture('v0.4.44-repos-list-remote-gh-missing.stderr.txt')),
    ).toBe(false);
  });

  it('is false for a genuine runtime failure — never downgrade one silently', () => {
    expect(isHelperMissing(1, 'tmuxctl: failed to start session')).toBe(false);
    expect(isHelperMissing(3, 'session is live')).toBe(false);
  });
});

describe('describeHelperRejection', () => {
  it('tells an unknown subcommand and a rejected option apart', () => {
    // Two different bugs: "the pocketshell on that host is not the helper" vs
    // "this client and the installed helper have drifted". Lumping them was
    // the shape of the removed shim; the fixes are not the same.
    const command = describeHelperRejection("Error: No such command 'sessions'.");
    const option = describeHelperRejection('Error: No such option: --cwd');
    expect(command).toContain('subcommand');
    expect(option).toContain('option');
    expect(command).not.toBe(option);
  });

  it('matches the Click wording whatever case or quoting it arrives in', () => {
    expect(describeHelperRejection('error: no such command')).not.toBeNull();
    expect(describeHelperRejection("Error: No such option '--json'")).not.toBeNull();
  });

  it('is null for anything that is not a usage error', () => {
    expect(describeHelperRejection('tmuxctl: failed to start session')).toBeNull();
    expect(describeHelperRejection('sh: pocketshell: not found')).toBeNull();
    expect(describeHelperRejection('')).toBeNull();
  });
});

describe('annotateHelperRejection', () => {
  it('keeps the host message first and appends the explanation', () => {
    const out = annotateHelperRejection(
      "Error: No such command 'repos'.",
      "Error: No such command 'repos'.",
    );
    expect(out.startsWith("Error: No such command 'repos'.")).toBe(true);
    expect(out.split('\n')).toHaveLength(2);
  });

  it('returns the host message unchanged when there is nothing to explain', () => {
    expect(annotateHelperRejection('boom', 'boom')).toBe('boom');
  });
});
