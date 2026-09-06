import { describe, expect, it } from 'vitest';
import { sessionIdentityKey } from '../../src/renderer/sessionIdentity';

/**
 * Renderer-side session identity: which registry key a session row files
 * under in the shells map and the composer store.
 *
 * The whole point is what does NOT collide. tmux names are host-global, so
 * the bare name is the identity (and stays the identity — every persisted
 * `conn/name` draft keeps working). aplexer tags repeat across workspaces, so
 * they qualify with the workspace. Anything without a workspace to qualify
 * with falls back to the bare name rather than refusing: a merged draft beats
 * a dropped write, and the destructive paths resolve strictly main-side.
 */
describe('sessionIdentityKey', () => {
  it('leaves tmux rows on their bare name', () => {
    expect(sessionIdentityKey('git-dataops')).toBe('git-dataops');
    expect(sessionIdentityKey('git-dataops', { backend: 'tmux' })).toBe('git-dataops');
    expect(sessionIdentityKey('git-dataops', { backend: 'tmux', workspace: '/home/u/git/dataops' })).toBe(
      'git-dataops',
    );
  });

  it('leaves rows with no backend on their bare name', () => {
    expect(sessionIdentityKey('git-dataops', {})).toBe('git-dataops');
    expect(sessionIdentityKey('git-dataops', { workspace: '/home/u/git/dataops' })).toBe('git-dataops');
  });

  it('qualifies aplexer tags with their workspace', () => {
    expect(
      sessionIdentityKey('review', { backend: 'aplexer', workspace: '/home/u/git/pocketshell' }),
    ).toBe('aplexer:/home/u/git/pocketshell:review');
  });

  it('tells same-named tags in different folders apart', () => {
    const a = sessionIdentityKey('review', { backend: 'aplexer', workspace: '/home/u/git/a' });
    const b = sessionIdentityKey('review', { backend: 'aplexer', workspace: '/home/u/git/b' });
    expect(a).not.toBe(b);
  });

  it('falls back to the bare name when an aplexer row carries no workspace', () => {
    expect(sessionIdentityKey('review', { backend: 'aplexer' })).toBe('review');
    expect(sessionIdentityKey('review', { backend: 'aplexer', workspace: null })).toBe('review');
  });
});
