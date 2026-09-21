import { describe, expect, it } from 'vitest';
import { directoryForSession, groupSessionsIntoRoots } from '../../src/renderer/sessionTree';
import type { SessionSummary } from '../../src/shared/types';

/**
 * The folder lookup behind the panel's create hand-off (`onSessionStarted`).
 *
 * Matched by workspace plus tag, never by the bare name. Reported live on
 * 2026-09-19 from a host where every workspace names its default tag `main`:
 * the name-only lookup answered with the FIRST directory holding any row
 * called `main` — on the accessed-first host order, the folder the user was
 * already reading — so the create navigated to the wrong folder, or to the
 * route already on screen (a no-op), and the user read the whole flow as
 * "I create a session and it keeps the same session."
 */

const HOME = '/home/me';

function aplexer(workspace: string, tag: string, accessed: number): SessionSummary {
  return {
    name: tag,
    created: 1,
    activity: accessed,
    attached: false,
    path: workspace,
    backend: 'aplexer',
    workspace,
    tag,
    aplexerId: `id-${workspace}-${tag}`,
    aplexerPhase: 'running',
  };
}

function tmux(name: string, path: string, accessed: number): SessionSummary {
  return { name, created: 1, activity: accessed, attached: false, path };
}

describe('directoryForSession', () => {
  it('resolves a same-named tag to ITS OWN workspace folder, not the first folder with that name', () => {
    // Two folders, each holding a session named `main` — the reported host's
    // shape. `a` is the most recently active, so the host order draws it first.
    const roots = groupSessionsIntoRoots(
      [aplexer(`${HOME}/git/a`, 'main', 100), aplexer(`${HOME}/git/b`, 'main', 5)],
      HOME,
      [],
    );

    // A create in `b` files its pending row with b's workspace. The name-only
    // lookup returned a's folder here; the identity lookup must answer b's.
    const dir = directoryForSession(roots, aplexer(`${HOME}/git/b`, 'main', 5));
    expect(dir?.path).toBe('~/git/b');
  });

  it('finds a brand-new pending row grouped under a folder with no prior sessions', () => {
    const roots = groupSessionsIntoRoots(
      [aplexer(`${HOME}/git/a`, 'main', 100), aplexer(`${HOME}/git/b`, 'main', 5)],
      HOME,
      [],
    );
    // `c` has never had a session; its group exists only because the pending
    // row was filed (addPending) before this lookup runs.
    const withPending = groupSessionsIntoRoots(
      [aplexer(`${HOME}/git/c`, 'main', 200), aplexer(`${HOME}/git/a`, 'main', 100)],
      HOME,
      [],
    );
    expect(directoryForSession(withPending, aplexer(`${HOME}/git/c`, 'main', 200))?.path).toBe(
      '~/git/c',
    );
    expect(directoryForSession(roots, aplexer(`${HOME}/git/c`, 'main', 200))).toBeNull();
  });

  it('matches a tmux row by its host-unique name', () => {
    const roots = groupSessionsIntoRoots([tmux('build', `${HOME}/tmp`, 10)], HOME, []);
    const dir = directoryForSession(roots, tmux('build', `${HOME}/tmp`, 10));
    expect(dir?.path).toBe('~/tmp');
    expect(directoryForSession(roots, tmux('absent', `${HOME}/tmp`, 10))).toBeNull();
  });
});
