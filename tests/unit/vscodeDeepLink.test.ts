import { describe, expect, it } from 'vitest';
import {
  VSCODE_NEW_WINDOW_QUERY,
  VSCODE_REMOTE_PREFIX,
  absoluteRemoteFolder,
  vscodeHostToken,
  vscodeRemoteFolderUrl,
} from '../../src/shared/vscodeDeepLink';

/**
 * The "Open in VS Code" deep link. What is worth pinning: the URL spelling
 * itself (Remote-SSH's authority format is undocumented and a quiet change
 * here breaks the feature with no error anywhere), the new-window query the
 * focused window's folder depends on, the tilde expansion the workspace's
 * folder keys need before the URL can be built, and the refusals — a token
 * or path that would start reading as URL structure must come back null,
 * not half-escaped.
 */

describe('vscodeHostToken', () => {
  it('uses the config alias for a host read from ~/.ssh/config', () => {
    expect(
      vscodeHostToken({
        name: 'hetzner',
        hostname: '135.181.114.209',
        user: 'alexey',
        fromConfig: true,
      }),
    ).toBe('hetzner');
  });

  it('falls back to user@host for a manually entered host', () => {
    expect(
      vscodeHostToken({
        name: '192.168.1.10',
        hostname: '192.168.1.10',
        user: 'me',
        fromConfig: false,
      }),
    ).toBe('me@192.168.1.10');
  });

  it('drops the user part when the entry has none', () => {
    expect(
      vscodeHostToken({ name: '', hostname: 'box.internal', user: '', fromConfig: false }),
    ).toBe('box.internal');
  });

  it('does not hand over a blank alias', () => {
    expect(
      vscodeHostToken({ name: '  ', hostname: 'box.internal', user: 'me', fromConfig: true }),
    ).toBe('me@box.internal');
  });
});

describe('absoluteRemoteFolder', () => {
  const home = '/home/alexey';

  it('passes an absolute path through untouched', () => {
    expect(absoluteRemoteFolder('/srv/git/foo', home)).toBe('/srv/git/foo');
  });

  it('expands ~ and ~/ against the remote home', () => {
    expect(absoluteRemoteFolder('~', home)).toBe(home);
    expect(absoluteRemoteFolder('~/git/foo', home)).toBe('/home/alexey/git/foo');
  });

  it('refuses a tilde path while the home is unknown', () => {
    expect(absoluteRemoteFolder('~/git/foo', null)).toBeNull();
    expect(absoluteRemoteFolder('~', null)).toBeNull();
  });

  it('refuses relative paths and other users homes', () => {
    expect(absoluteRemoteFolder('git/foo', home)).toBeNull();
    expect(absoluteRemoteFolder('~other/git', home)).toBeNull();
  });
});

describe('vscodeRemoteFolderUrl', () => {
  it('spells the Remote-SSH authority the way VS Code answers it', () => {
    expect(vscodeRemoteFolderUrl('hetzner', '/home/alexey/git/foo')).toBe(
      'vscode://vscode-remote/ssh-remote+hetzner/home/alexey/git/foo' + VSCODE_NEW_WINDOW_QUERY,
    );
  });

  it('asks for a NEW window — the focused one must keep its folder', () => {
    const url = vscodeRemoteFolderUrl('hetzner', '/srv/x');
    expect(url?.endsWith('?windowId=_blank')).toBe(true);
    expect(url?.split('?')).toHaveLength(2); // the one query, nothing that reads as a second
  });

  it('starts with the exported prefix — the one main allow-lists', () => {
    const url = vscodeRemoteFolderUrl('hetzner', '/srv/x');
    expect(url?.startsWith(VSCODE_REMOTE_PREFIX)).toBe(true);
  });

  it('percent-encodes path segments, keeping the slashes literal', () => {
    expect(vscodeRemoteFolderUrl('hetzner', '/home/a/my project/идеи')).toBe(
      'vscode://vscode-remote/ssh-remote+hetzner/home/a/my%20project/%D0%B8%D0%B4%D0%B5%D0%B8' +
        VSCODE_NEW_WINDOW_QUERY,
    );
  });

  it('refuses a token that would read as URL structure', () => {
    expect(vscodeRemoteFolderUrl('', '/srv/x')).toBeNull();
    expect(vscodeRemoteFolderUrl('  ', '/srv/x')).toBeNull();
    expect(vscodeRemoteFolderUrl('a/b', '/srv/x')).toBeNull();
    expect(vscodeRemoteFolderUrl('a b', '/srv/x')).toBeNull();
    expect(vscodeRemoteFolderUrl('a?b', '/srv/x')).toBeNull();
    expect(vscodeRemoteFolderUrl('a#b', '/srv/x')).toBeNull();
  });

  it('refuses a path that is not absolute', () => {
    expect(vscodeRemoteFolderUrl('hetzner', 'git/foo')).toBeNull();
    expect(vscodeRemoteFolderUrl('hetzner', '~/git/foo')).toBeNull();
    expect(vscodeRemoteFolderUrl('hetzner', '/')).toBeNull();
  });
});
