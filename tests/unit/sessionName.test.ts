import { describe, expect, it } from 'vitest';
import { resolveSessionName, sanitiseName, sessionBaseName } from '../../src/shared/sessionNameParts';
import { childPath, normaliseProjectFolderName } from '@main/projects/sessionName';

/**
 * The derivation rule is a PORT, so these cases are pinned to the Kotlin they
 * came from (SessionNameDerivation.kt) and to names observed on a real host:
 * `git-dataops`, `git-pocketshell`, `home-alexey`,
 * `git-ai-shipping-labs-web`. Any drift here means the desktop and the phone
 * stop agreeing about which session belongs to which folder.
 */
const HOME = '/home/alexey';

describe('sessionBaseName', () => {
  it('names the home directory itself `home-<basename>`', () => {
    expect(sessionBaseName('/home/alexey', HOME)).toBe('home-alexey');
    expect(sessionBaseName('~', HOME)).toBe('home-alexey');
    expect(sessionBaseName('/root', '/root')).toBe('home-root');
  });

  it('joins home-relative components with `-`', () => {
    expect(sessionBaseName('/home/alexey/git/pocketshell', HOME)).toBe('git-pocketshell');
    expect(sessionBaseName('/home/alexey/git/dataops', HOME)).toBe('git-dataops');
    expect(sessionBaseName('/home/alexey/git/ai-shipping-labs-web', HOME)).toBe(
      'git-ai-shipping-labs-web',
    );
  });

  it('gives a `~/…` path the same name as its absolute form', () => {
    expect(sessionBaseName('~/git/pocketshell', HOME)).toBe(
      sessionBaseName('/home/alexey/git/pocketshell', HOME),
    );
  });

  it('ignores a trailing slash', () => {
    expect(sessionBaseName('/home/alexey/git/pocketshell/', HOME)).toBe('git-pocketshell');
  });

  it('falls back to absolute components outside home', () => {
    expect(sessionBaseName('/var/log', HOME)).toBe('var-log');
    expect(sessionBaseName('/srv/www/site', null)).toBe('srv-www-site');
  });

  it('best-effort resolves a `~` form when home is unknown', () => {
    expect(sessionBaseName('~', null)).toBe('home');
    expect(sessionBaseName('~/git/x', null)).toBe('git-x');
  });

  it('does not treat a sibling directory as being under home', () => {
    // `/home/alexey2` starts with `/home/alexey` as a STRING but is not under
    // it; the `/` in the prefix check is what stops the wrong answer.
    expect(sessionBaseName('/home/alexey2/git', HOME)).toBe('home-alexey2-git');
  });

  it('sanitises characters tmux forbids in a session name', () => {
    // `.` and `:` become `_`; everything else disallowed collapses to `-`.
    expect(sessionBaseName('/home/alexey/git/my.repo', HOME)).toBe('git-my_repo');
    expect(sessionBaseName('/home/alexey/a:b', HOME)).toBe('a_b');
    expect(sessionBaseName('/home/alexey/my project', HOME)).toBe('my-project');
    expect(sessionBaseName("/home/alexey/wei'rd $(x) dir", HOME)).toBe('wei-rd-x-dir');
  });

  it('never returns an empty name', () => {
    expect(sessionBaseName('/', null)).toBe('shell');
    expect(sessionBaseName('/home/alexey/---', HOME)).toBe('shell');
    expect(sessionBaseName('', null)).toBe('shell');
  });
});

// `sanitisePart` itself now lives in src/shared/sessionNameParts.ts and is
// covered by tests/unit/sessionNameParts.test.ts; this module re-exports it.

describe('resolveSessionName', () => {
  it('prefers a meaningful custom label', () => {
    expect(resolveSessionName('My Feature', '/home/alexey/git/x', HOME)).toBe('My-Feature');
  });

  it('falls back to the derived name for a label with no letters or digits', () => {
    expect(resolveSessionName('   ', '/home/alexey/git/x', HOME)).toBe('git-x');
    expect(resolveSessionName('...', '/home/alexey/git/x', HOME)).toBe('git-x');
    expect(resolveSessionName(':::', '/home/alexey/git/x', HOME)).toBe('git-x');
    expect(resolveSessionName(null, '/home/alexey/git/x', HOME)).toBe('git-x');
  });

  it('sanitises the custom label to tmux-safe characters', () => {
    expect(sanitiseName('  release: v1.2  ')).toBe('release_-v1_2');
  });

  it('appends no collision suffix — the host owns uniqueness', () => {
    expect(resolveSessionName(null, '/home/alexey/git/x', HOME)).toBe('git-x');
    expect(resolveSessionName(null, '/home/alexey/git/x', HOME)).toBe('git-x');
  });
});

describe('normaliseProjectFolderName', () => {
  it('accepts a plain single name', () => {
    expect(normaliseProjectFolderName('  my-project ')).toBe('my-project');
  });

  it('rejects anything that is not one folder under the parent', () => {
    expect(normaliseProjectFolderName('')).toBeNull();
    expect(normaliseProjectFolderName('   ')).toBeNull();
    expect(normaliseProjectFolderName('.')).toBeNull();
    expect(normaliseProjectFolderName('..')).toBeNull();
    expect(normaliseProjectFolderName('a/b')).toBeNull();
    expect(normaliseProjectFolderName('a\\b')).toBeNull();
    expect(normaliseProjectFolderName('../escape')).toBeNull();
  });

  it('keeps hostile-looking but legal names — quoting, not filtering, is the guard', () => {
    expect(normaliseProjectFolderName("wei'rd $(touch x)")).toBe("wei'rd $(touch x)");
  });
});

describe('childPath', () => {
  it('joins parent and child', () => {
    expect(childPath('/home/alexey/git', 'x')).toBe('/home/alexey/git/x');
    expect(childPath('/home/alexey/git/', 'x')).toBe('/home/alexey/git/x');
    expect(childPath('/', 'x')).toBe('/x');
    expect(childPath('', 'x')).toBe('/x');
  });
});
