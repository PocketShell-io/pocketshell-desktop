import { describe, it, expect } from 'vitest';
import {
  applyCachedSessionPaths,
  diagnoseSessionPaths,
  inferPathsFromSiblings,
  restoreUnlistedSessions,
} from '@main/helper/sessionPathRecovery';
import type { SessionSummary } from '../../src/shared/types';

/**
 * The orphan problem. Both of these exist because the
 * folder workspace keys everything on the folder, so a session with a null
 * path has nowhere to live and must not silently vanish.
 */
describe('inferPathsFromSiblings', () => {
  const row = (name: string, path: string | null): SessionSummary => ({
    name,
    created: 1,
    activity: 1,
    attached: false,
    path,
    agentKind: null,
  });

  it('adopts the path of the session the orphan is named after', () => {
    // The two pairs the user circled on the screenshot.
    const out = inferPathsFromSiblings([
      row('git-dtc-website', '/home/alexey/git/dtc-website'),
      row('git-dtc-website-import', null),
      row('git-red-stamp', '/home/alexey/git/red-stamp'),
      row('git-red-stamp-sound', null),
    ]);
    expect(out[1]).toMatchObject({
      path: '/home/alexey/git/dtc-website',
      pathInferred: true,
    });
    expect(out[3]).toMatchObject({ path: '/home/alexey/git/red-stamp', pathInferred: true });
  });

  it('takes the LONGEST matching sibling', () => {
    const out = inferPathsFromSiblings([
      row('git-a', '/home/a'),
      row('git-a-b', '/home/a/b'),
      row('git-a-b-c', null),
    ]);
    expect(out[2]).toMatchObject({ path: '/home/a/b' });
  });

  it('requires the `-` boundary, so a longer name is not claimed', () => {
    const out = inferPathsFromSiblings([
      row('git-red-stamp', '/home/alexey/git/red-stamp'),
      row('git-red-stampede', null),
    ]);
    expect(out[1]!.path).toBeNull();
    expect(out[1]!.pathInferred).toBeUndefined();
  });

  it('leaves a session with no matching sibling unplaced rather than guessing', () => {
    const out = inferPathsFromSiblings([row('git-x', '/home/x'), row('git-auth', null)]);
    expect(out[1]!.path).toBeNull();
  });

  it('never rewrites a session that already reported a path', () => {
    const rows = [row('git-a', '/home/a'), row('git-a-b', '/home/elsewhere')];
    expect(inferPathsFromSiblings(rows)[1]).toBe(rows[1]);
  });
});

describe('diagnoseSessionPaths', () => {
  const row = (name: string, path: string | null, inferred = false): SessionSummary => ({
    name,
    created: 1,
    activity: 1,
    attached: false,
    path,
    agentKind: null,
    ...(inferred ? { pathInferred: true } : {}),
  });
  const probeRow = (path: string | null) => ({
    path,
    attached: false,
    agentKind: null,
    socketPath: null,
  });

  it('says nothing when every session placed', () => {
    const report = diagnoseSessionPaths(
      [row('git-a', '/home/a')],
      new Map([['git-a', probeRow('/home/a')]]),
    );
    expect(report.unplaced).toEqual([]);
    expect(report.unmatchedProbeKeys).toEqual([]);
  });

  it('reports `absent` when the probe emitted no row at all', () => {
    const report = diagnoseSessionPaths([row('git-auth', null)], new Map());
    expect(report.unplaced).toEqual([
      { name: 'git-auth', probe: 'absent', lenientKey: 'git-auth', inferred: false },
    ]);
  });

  it('reports `no-path` when a row was there with both path columns empty', () => {
    const report = diagnoseSessionPaths(
      [row('git-auth', null)],
      new Map([['git-auth', probeRow(null)]]),
    );
    expect(report.unplaced[0]).toMatchObject({ probe: 'no-path' });
  });

  it('reports `ambiguous` when the drop-on-collision rule fired', () => {
    // Two non-ASCII names collapsing to one column-sanitised key: 3ac7abc
    // drops the key rather than attaching one session's cwd to another.
    const report = diagnoseSessionPaths(
      [row('git-caf_', null)],
      new Map([
        ['git-café', probeRow('/home/a')],
        ['git-cafè', probeRow('/home/b')],
      ]),
    );
    expect(report.unplaced[0]).toMatchObject({ probe: 'ambiguous', lenientKey: 'git-caf_' });
  });

  it('still reports a session whose path came from a sibling', () => {
    const report = diagnoseSessionPaths([row('git-a-b', '/home/a', true)], new Map());
    expect(report.unplaced[0]).toMatchObject({ inferred: true, probe: 'absent' });
  });

  it('names probe rows that matched no listed session', () => {
    const report = diagnoseSessionPaths(
      [row('git-a', '/home/a')],
      new Map([
        ['git-a', probeRow('/home/a')],
        ['ghost', probeRow('/home/g')],
      ]),
    );
    expect(report.unmatchedProbeKeys).toEqual(['ghost']);
  });
});

describe('restoreUnlistedSessions', () => {
  // The CI measurement this pins: the tab bar held only 'build' while the
  // host sweep answered 'main attached=1' and the helper's own list named
  // both - a truncated helper table accepted as the whole truth, which
  // pruned a live session's tab. The probe saw what the table forgot.

  const build = {
    name: 'build',
    created: 100,
    activity: 200,
    attached: false,
    path: '/home/testuser',
  };
  const enrichment = new Map([
    [
      'build',
      {
        path: '/home/testuser',
        attached: false,
        agentKind: null,
        socketPath: '/tmp/tmux-1000/default',
      },
    ],
    [
      'main',
      {
        path: '/home/testuser',
        attached: true,
        agentKind: null,
        socketPath: '/tmp/tmux-1000/default',
      },
    ],
  ]);

  it('restores a session the probe saw and the table omitted', () => {
    const out = restoreUnlistedSessions([build], enrichment);
    expect(out.map((session) => session.name)).toEqual(['build', 'main']);
    const main = out[1]!;
    expect(main.attached).toBe(true);
    expect(main.path).toBe('/home/testuser');
    // Timestamps are the one thing the probe does not carry: report 0 rather
    // than inventing a number, and let the next complete poll replace the row.
    expect(main.created).toBe(0);
    expect(main.activity).toBe(0);
  });

  it('changes nothing when the table listed everything the probe saw', () => {
    const listed = [{ ...build }];
    expect(restoreUnlistedSessions(listed, new Map([['build', enrichment.get('build')!]]))).toBe(
      listed,
    );
  });

  it('changes nothing on an empty probe - no evidence, no invention', () => {
    const listed = [{ ...build }];
    expect(restoreUnlistedSessions(listed, new Map())).toBe(listed);
  });
});

describe('applyCachedSessionPaths', () => {
  // The CI measurement this pins: the enrichment probe flapped
  // (list-panes exiting 1) while main sat alive and attached on the host,
  // and a poll whose placement evidence had dropped out pruned the
  // session's tab. A directory a session was in does not stop being true
  // because one read of it failed.

  const cache = new Map<string, string>();

  it('remembers paths it has seen and reuses them on a null-path poll', () => {
    applyCachedSessionPaths(
      [{ name: 'main', created: 1, activity: 2, attached: true, path: '/home/testuser' }],
      cache,
    );
    const out = applyCachedSessionPaths(
      [{ name: 'main', created: 1, activity: 2, attached: true, path: null }],
      cache,
    );
    const row = out[0]!;
    expect(row.path).toBe('/home/testuser');
    expect(row.pathInferred).toBe(true);
  });

  it('new evidence overwrites, and absence never deletes', () => {
    cache.set('main', '/old');
    applyCachedSessionPaths(
      [{ name: 'main', created: 1, activity: 2, attached: true, path: '/new' }],
      cache,
    );
    expect(cache.get('main')).toBe('/new');
    applyCachedSessionPaths(
      [{ name: 'main', created: 1, activity: 2, attached: true, path: null }],
      cache,
    );
    expect(cache.get('main')).toBe('/new');
  });

  it('a session with no cached path is returned unchanged', () => {
    const before = [{ name: 'stranger', created: 1, activity: 2, attached: false, path: null }];
    expect(applyCachedSessionPaths(before, cache)).toBe(before);
  });
});
