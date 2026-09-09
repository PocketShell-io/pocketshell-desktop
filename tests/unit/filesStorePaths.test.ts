//
// The Files store's pure path helpers, on the suite's default `node`
// environment. The sibling filesStore*.test.ts files keep a jsdom because
// minting a preview resolves design tokens out of `getComputedStyle` and
// opening a binary mints an object URL; nothing here opens state or mints —
// these are string functions, and running them without a DOM keeps that
// honest. The store module itself still has to be importable, and
// `src/renderer/ipc` reads `window.api` at module scope, so the ipc mock is
// registered even though no test ever calls it (see helpers/filesApi).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/ipc', async () => ({
  api: (await import('./helpers/filesApi')).api,
}));

const { resolveRemotePath, stripTilde, normaliseTypedPath } = await import(
  '../../src/renderer/stores/files'
);

describe('stripTilde', () => {
  it('drops a leading ~/ so the path resolves relative to the login home', () => {
    // An SFTP session's relative root IS the home directory, so this reaches
    // the same place `~/git` names without costing a lookup to expand it.
    expect(stripTilde('~/git/pocketshell')).toBe('git/pocketshell');
  });

  it('maps a bare ~ and an empty path to the home directory', () => {
    expect(stripTilde('~')).toBe('.');
    expect(stripTilde('~/')).toBe('.');
    expect(stripTilde(undefined)).toBe('.');
    expect(stripTilde('')).toBe('.');
  });

  it('passes absolute paths through untouched', () => {
    expect(stripTilde('/home/alexey/git')).toBe('/home/alexey/git');
  });

  it("leaves another user's ~home alone rather than resolving it wrongly", () => {
    // `~other/x` is not our home; resolving it relatively would silently open
    // the wrong directory, and failing honestly is better than that.
    expect(stripTilde('~other/x')).toBe('~other/x');
  });
});

/**
 * Resolving a path that was PRINTED, not browsed to.
 *
 * The rule here is the one the Files tab already fought for once: a session's
 * relative path is relative to where that SESSION runs, which is neither the
 * login home nor wherever this tab happens to be pointing. The second half is
 * that the session's own cwd can be an unexpanded `~/git/foo`, so the base has
 * to go through the same `stripTilde` the tab's own opening does.
 */
describe('resolveRemotePath', () => {
  it('joins a relative path onto the session cwd, not the login home', () => {
    expect(resolveRemotePath('tmp/a.mp3', '/home/alexey/git/foo')).toBe(
      '/home/alexey/git/foo/tmp/a.mp3',
    );
  });

  it('strips a tilde session cwd so the join stays SFTP-resolvable', () => {
    // `~/git/foo` + `tmp/a.mp3` must not become a directory literally named `~`.
    expect(resolveRemotePath('tmp/a.mp3', '~/git/foo')).toBe('git/foo/tmp/a.mp3');
  });

  it('leaves an absolute path exactly as printed', () => {
    expect(resolveRemotePath('/srv/media/a.mp3', '/home/alexey')).toBe('/srv/media/a.mp3');
  });

  it('anchors a tilde path on the home, ignoring the session cwd', () => {
    expect(resolveRemotePath('~/notes.md', '/home/alexey/git/foo')).toBe('notes.md');
  });

  it('falls back to home-relative when the session reported no path', () => {
    // Same fallback `open()` makes for the same missing fact.
    expect(resolveRemotePath('tmp/a.mp3', null)).toBe('tmp/a.mp3');
    expect(resolveRemotePath('tmp/a.mp3', undefined)).toBe('tmp/a.mp3');
  });

  it('drops a leading ./ rather than embedding it in the join', () => {
    expect(resolveRemotePath('./tmp/a.mp3', '/home/alexey')).toBe('/home/alexey/tmp/a.mp3');
  });

  it('leaves .. for the remote realpath to fold', () => {
    // Folding it here would mean guessing about symlinks only the host knows.
    expect(resolveRemotePath('../b.txt', '/home/alexey/git')).toBe('/home/alexey/git/../b.txt');
  });
});

/**
 * What the path bar accepts.
 *
 * The cleanup in front of the resolver exists because of how paths reach a
 * clipboard, not because of anything about paths themselves: a shell quotes
 * what it had to quote, and a log or a chat message brings whitespace with it.
 * Refusing either would be a needless "invalid path" for something perfectly
 * unambiguous.
 */
describe('normaliseTypedPath', () => {
  it('takes an absolute path as typed', () => {
    expect(normaliseTypedPath('/tmp/olya-v3tts.mp3', '/home/alexey')).toBe('/tmp/olya-v3tts.mp3');
  });

  it('never joins an absolute path onto the browsed directory', () => {
    // The classic bug in this shape of code: `/home/alexey//tmp/x.mp3`.
    expect(normaliseTypedPath('/tmp/x.mp3', '/home/alexey/git/foo')).toBe('/tmp/x.mp3');
    expect(normaliseTypedPath('/', '/home/alexey/git/foo')).toBe('/');
  });

  it('resolves a tilde path against the login home, not the browsed directory', () => {
    expect(normaliseTypedPath('~/git/foo', '/srv/media')).toBe('git/foo');
    expect(normaliseTypedPath('~', '/srv/media')).toBe('.');
  });

  it('resolves a bare relative path against the directory on screen', () => {
    // The Files tab's base is where the USER is looking, which is what makes
    // typing `tmp/a.mp3` mean the same thing as clicking through to it.
    expect(normaliseTypedPath('tmp/a.mp3', '/home/alexey/git/foo')).toBe(
      '/home/alexey/git/foo/tmp/a.mp3',
    );
    expect(normaliseTypedPath('./tmp/a.mp3', '/home/alexey')).toBe('/home/alexey/tmp/a.mp3');
    expect(normaliseTypedPath('../sibling', '/home/alexey/git')).toBe('/home/alexey/git/../sibling');
  });

  it('trims whitespace from a pasted path', () => {
    expect(normaliseTypedPath('  /tmp/x.mp3  ', '/home/alexey')).toBe('/tmp/x.mp3');
    expect(normaliseTypedPath('\t/tmp/x.mp3\n', '/home/alexey')).toBe('/tmp/x.mp3');
  });

  it('strips the quotes a shell put around a path with a space in it', () => {
    expect(normaliseTypedPath("'/tmp/my file.mp3'", '/home/alexey')).toBe('/tmp/my file.mp3');
    expect(normaliseTypedPath('"/tmp/my file.mp3"', '/home/alexey')).toBe('/tmp/my file.mp3');
    expect(normaliseTypedPath('  "/tmp/x.mp3"  ', '/home/alexey')).toBe('/tmp/x.mp3');
  });

  it('keeps a space inside the path, unlike the terminal-output detector', () => {
    // The detector refuses these because a space in a LINE of output may or may
    // not end the path. In a field that is nothing but the path there is no
    // such ambiguity, so the space is just a character.
    expect(normaliseTypedPath('/tmp/my file.mp3', '/home/alexey')).toBe('/tmp/my file.mp3');
    expect(normaliseTypedPath('my file.mp3', '/home/alexey')).toBe('/home/alexey/my file.mp3');
  });

  it('leaves an unmatched or interior quote alone', () => {
    // A filename may legitimately contain one; only a matched surrounding pair
    // is shell quoting.
    expect(normaliseTypedPath(`/tmp/it's.mp3`, '/home/alexey')).toBe(`/tmp/it's.mp3`);
    // An unmatched leading quote stays a literal character, so the path is not
    // absolute and resolves relatively — and then fails honestly at stat time.
    // Guessing that the user meant `/tmp/x.mp3` would be the same class of
    // silent correction as opening a "nearest existing ancestor".
    expect(normaliseTypedPath(`"/tmp/x.mp3`, '/home/alexey')).toBe(`/home/alexey/"/tmp/x.mp3`);
  });

  it('returns null for an empty field, which is not an error', () => {
    expect(normaliseTypedPath('', '/home/alexey')).toBeNull();
    expect(normaliseTypedPath('   ', '/home/alexey')).toBeNull();
    expect(normaliseTypedPath('""', '/home/alexey')).toBeNull();
  });

  it('falls back to home-relative when nothing is browsed yet', () => {
    expect(normaliseTypedPath('tmp/a.mp3', '')).toBe('tmp/a.mp3');
  });
});
