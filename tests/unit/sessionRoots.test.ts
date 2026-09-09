import { describe, it, expect } from 'vitest';
// `UNTRACKED_PATH` is the grouping module's sentinel; a root test only ever
// passes it through, to pin that the sentinels are keys like any other.
import { UNTRACKED_PATH } from '../../src/renderer/sessionGrouping';
import {
  SESSION_ROOTS_MAX,
  OTHER_LABEL,
  OTHER_ROOT,
  bestRootForPath,
  directoryKey,
  inferHome,
  normaliseRootList,
  normaliseRootPath,
  pathWithinRoot,
  resolveRoots,
  rootForPath,
  rootFromSessionName,
  rootHostPath,
} from '../../src/renderer/sessionRoots';

describe('inferHome', () => {
  it('reads the standard home layouts out of the paths themselves', () => {
    expect(inferHome(['/home/alexey/git/a'])).toBe('/home/alexey');
    expect(inferHome(['/Users/alexey/git/a'])).toBe('/Users/alexey');
    expect(inferHome(['/var/home/alexey/git/a'])).toBe('/var/home/alexey');
    expect(inferHome(['/root/git/a'])).toBe('/root');
    expect(inferHome(['/root'])).toBe('/root');
  });

  it('lets the majority win, so one stray path cannot move home', () => {
    expect(inferHome(['/home/alexey/git/a', '/home/alexey/git/b', '/root/scratch'])).toBe(
      '/home/alexey',
    );
  });

  it('returns null when nothing looks like a home directory', () => {
    expect(inferHome(['/srv/app', '/var/log', null, '   '])).toBeNull();
    expect(inferHome([])).toBeNull();
  });

  it('does not mistake the home parent itself for a home', () => {
    expect(inferHome(['/home'])).toBeNull();
    expect(inferHome(['/Users'])).toBeNull();
  });
});

describe('rootForPath', () => {
  const home = '/home/alexey';

  it('takes the first component under $HOME as the root', () => {
    expect(rootForPath('/home/alexey/git/dataops', home)).toEqual({ key: '~/git', label: 'git' });
    expect(rootForPath('/home/alexey/tmp/scratch', home)).toEqual({ key: '~/tmp', label: 'tmp' });
  });

  it('folds a literal ~ path onto the same root as its absolute spelling', () => {
    expect(rootForPath('~/git/dataops', home)).toEqual(rootForPath('/home/alexey/git/x', home));
  });

  it('resolves ~ without needing $HOME at all', () => {
    expect(rootForPath('~/git/dataops', null)).toEqual({ key: '~/git', label: 'git' });
  });

  it('keeps a root-level project folder as its own root', () => {
    expect(rootForPath('/home/alexey/git', home)).toEqual({ key: '~/git', label: 'git' });
  });

  it('buckets paths outside $HOME as other — they share no parent with the rest', () => {
    expect(rootForPath('/srv/app', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('/var/log', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('/', home).key).toBe(OTHER_ROOT);
  });

  it('buckets $HOME itself as other — there is no root folder to name', () => {
    expect(rootForPath('/home/alexey', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('~', home).key).toBe(OTHER_ROOT);
    expect(rootForPath('$HOME', home).key).toBe(OTHER_ROOT);
  });

  it('buckets sessions with no known folder as other', () => {
    expect(rootForPath(UNTRACKED_PATH, home)).toEqual({ key: OTHER_ROOT, label: OTHER_LABEL });
  });

  it('sends absolute paths to other when home is neither known nor inferable', () => {
    expect(rootForPath('/opt/weird/git/x', null).key).toBe(OTHER_ROOT);
  });

  it('tolerates a trailing slash on the supplied home', () => {
    expect(rootForPath('/home/alexey/git/x', '/home/alexey/')).toEqual({
      key: '~/git',
      label: 'git',
    });
  });
});

describe('directoryKey', () => {
  const home = '/home/alexey';

  it('writes a directory under $HOME home-relative, at full depth', () => {
    expect(directoryKey('/home/alexey/git/dataops', home)).toBe('~/git/dataops');
  });

  it('folds the two spellings tmux reports for one directory into one key', () => {
    expect(directoryKey('~/git/dataops', home)).toBe(
      directoryKey('/home/alexey/git/dataops', home),
    );
  });

  it('resolves ~ without needing $HOME at all', () => {
    expect(directoryKey('~/git/dataops', null)).toBe('~/git/dataops');
  });

  it('keeps $HOME itself as ~', () => {
    expect(directoryKey('/home/alexey', home)).toBe('~');
    expect(directoryKey('~', home)).toBe('~');
  });

  it('leaves a path outside $HOME exactly as it is', () => {
    expect(directoryKey('/var/log', home)).toBe('/var/log');
    expect(directoryKey('/srv/app', null)).toBe('/srv/app');
  });

  it('passes the untracked sentinel through', () => {
    expect(directoryKey(UNTRACKED_PATH, home)).toBe(UNTRACKED_PATH);
  });
});

describe('rootFromSessionName', () => {
  it('reads the root back out of a derived name', () => {
    expect(rootFromSessionName('git-red-stamp-sound', ['git', 'tmp'])).toBe('git');
    expect(rootFromSessionName('tmp-scratch', ['git', 'tmp'])).toBe('tmp');
  });

  it('matches a name that is exactly one component', () => {
    expect(rootFromSessionName('git', ['git'])).toBe('git');
  });

  it('refuses to conjure a root nothing else lives in', () => {
    expect(rootFromSessionName('foo-bar', ['git', 'tmp'])).toBeNull();
    expect(rootFromSessionName('git-a', [])).toBeNull();
  });

  it('compares against the sanitised root name, as the derivation wrote it', () => {
    expect(rootFromSessionName('my_project-thing', ['my.project'])).toBe('my.project');
  });

  it('returns null for a name with no usable leading component', () => {
    expect(rootFromSessionName('', ['git'])).toBeNull();
    expect(rootFromSessionName('---', ['git'])).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Registered roots — the configured top level
 * ------------------------------------------------------------------------- */

describe('normaliseRootPath', () => {
  it('keeps the spelling the user typed, trailing slashes aside', () => {
    // `~/git` and `/home/alexey/git` stay DIFFERENT stored strings: settings
    // are app-level and $HOME is per-host, so there is no home to fold them
    // against until a connection exists. resolveRoots does that, per host.
    expect(normaliseRootPath('~/git')).toBe('~/git');
    expect(normaliseRootPath('~/git/')).toBe('~/git');
    expect(normaliseRootPath('  ~/git//  ')).toBe('~/git');
    expect(normaliseRootPath('/home/alexey/git')).toBe('/home/alexey/git');
    expect(normaliseRootPath('~')).toBe('~');
    expect(normaliseRootPath('/')).toBe('/');
  });

  it('refuses anything that is not anchored to / or ~', () => {
    expect(normaliseRootPath('git')).toBeNull();
    expect(normaliseRootPath('./git')).toBeNull();
    expect(normaliseRootPath('')).toBeNull();
    expect(normaliseRootPath('   ')).toBeNull();
  });

  it('refuses .. rather than resolving it', () => {
    // Resolving needs a real filesystem, and a root that names a different
    // directory depending on where it resolves from is not a root.
    expect(normaliseRootPath('~/git/../tmp')).toBeNull();
    expect(normaliseRootPath('/home/alexey/..')).toBeNull();
    // A component that merely CONTAINS dots is fine.
    expect(normaliseRootPath('~/git/..hidden')).toBe('~/git/..hidden');
  });

  it('refuses control characters and non-strings', () => {
    expect(normaliseRootPath('~/git\nrm -rf')).toBeNull();
    expect(normaliseRootPath(42)).toBeNull();
    expect(normaliseRootPath(null)).toBeNull();
    expect(normaliseRootPath(['~/git'])).toBeNull();
  });
});

describe('normaliseRootList', () => {
  it('drops bad entries without losing the good ones', () => {
    expect(normaliseRootList(['~/git', 'nonsense', 42, '~/tmp/'])).toEqual(['~/git', '~/tmp']);
  });

  it('drops exact repeats, keeping the first', () => {
    expect(normaliseRootList(['~/git', '~/git/', '~/tmp'])).toEqual(['~/git', '~/tmp']);
  });

  it('caps a pathological list', () => {
    const many = Array.from({ length: SESSION_ROOTS_MAX + 10 }, (_, i) => `~/r${i}`);
    expect(normaliseRootList(many)).toHaveLength(SESSION_ROOTS_MAX);
  });
});

describe('pathWithinRoot (FolderTreeProjection.kt:310)', () => {
  it('matches the root itself and anything below it', () => {
    expect(pathWithinRoot('~/git', '~/git')).toBe(true);
    expect(pathWithinRoot('~/git/dataops', '~/git')).toBe(true);
    expect(pathWithinRoot('~/git/a/b/c', '~/git')).toBe(true);
  });

  it('respects the / boundary, so ~/git never claims ~/gitlab', () => {
    expect(pathWithinRoot('~/gitlab', '~/git')).toBe(false);
    expect(pathWithinRoot('~/gitlab/thing', '~/git')).toBe(false);
  });

  it('handles the degenerate roots', () => {
    expect(pathWithinRoot('~/git/x', '~')).toBe(true);
    expect(pathWithinRoot('/var/log', '/')).toBe(true);
  });
});

describe('resolveRoots', () => {
  const home = '/home/alexey';

  it('folds the tilde and absolute spellings of one root onto one key', () => {
    // Duplicates must not produce two identical branches. The phone dedupes on
    // the STORED spelling and does render both; we dedupe on the resolved key.
    const resolved = resolveRoots(['~/git', '/home/alexey/git'], home);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.key).toBe('~/git');
    expect(resolved[0]!.label).toBe('git');
  });

  it('resolves ~ without needing $HOME at all', () => {
    expect(resolveRoots(['~/git'], null).map((r) => r.key)).toEqual(['~/git']);
  });

  it('leaves a root outside $HOME absolute', () => {
    const [root] = resolveRoots(['/srv/apps'], home);
    expect(root!.key).toBe('/srv/apps');
    expect(root!.label).toBe('apps');
  });

  it('keeps registered order and drops unusable entries', () => {
    expect(resolveRoots(['~/tmp', 'garbage', '~/git'], home).map((r) => r.label)).toEqual([
      'tmp',
      'git',
    ]);
  });

  it('grows two roots that share a basename apart', () => {
    expect(resolveRoots(['~/git/work', '~/clients/work'], home).map((r) => r.label)).toEqual([
      'git/work',
      'clients/work',
    ]);
  });
});

describe('bestRootForPath', () => {
  const home = '/home/alexey';
  const roots = resolveRoots(['~/git', '~/git/work'], home);

  it('gives a nested path to the LONGEST matching root', () => {
    expect(bestRootForPath('/home/alexey/git/work/thing', home, roots)!.key).toBe('~/git/work');
    expect(bestRootForPath('/home/alexey/git/dataops', home, roots)!.key).toBe('~/git');
  });

  it('matches a session sitting exactly on a root', () => {
    expect(bestRootForPath('/home/alexey/git/work', home, roots)!.key).toBe('~/git/work');
  });

  it('treats the two spellings of one directory identically', () => {
    expect(bestRootForPath('~/git/dataops', home, roots)!.key).toBe(
      bestRootForPath('/home/alexey/git/dataops', home, roots)!.key,
    );
  });

  it('returns null for a path under no root, and for an untracked one', () => {
    expect(bestRootForPath('/var/log', home, roots)).toBeNull();
    expect(bestRootForPath('/home/alexey/gitlab/x', home, roots)).toBeNull();
    expect(bestRootForPath(UNTRACKED_PATH, home, roots)).toBeNull();
  });
});

describe('rootHostPath', () => {
  /**
   * The inverse of `directoryKey`, and the reason the session panel's per-root
   * `+` can hand the folder picker a directory that exists.
   *
   * The bug it prevents is specific: the picker browses over SFTP, which runs
   * no shell, so a `~` reaching it is a literal directory name. A root key is
   * `~/git` by construction — that spelling is what folds tmux's two forms of
   * one directory into a single node — so something has to expand it, once, in
   * a place both the panel and the tests can see.
   */
  const home = '/home/alexey';

  it('expands a home-relative root key against $HOME', () => {
    expect(rootHostPath('~/git', home)).toBe('/home/alexey/git');
    expect(rootHostPath('~/git/work', home)).toBe('/home/alexey/git/work');
  });

  it('round-trips with directoryKey, which is the property that matters', () => {
    const absolute = '/home/alexey/git';
    expect(rootHostPath(directoryKey(absolute, home), home)).toBe(absolute);
  });

  it('resolves the bare home key to $HOME itself', () => {
    expect(rootHostPath('~', home)).toBe(home);
  });

  it('passes an absolute root outside $HOME straight through', () => {
    // A registered `/srv/apps` keys absolutely, because there is nothing to
    // rewrite it against — and nothing to expand either.
    expect(rootHostPath('/srv/apps', home)).toBe('/srv/apps');
  });

  it('has no answer for the `other` bucket or an untracked session', () => {
    // Neither is a directory. The panel renders no `+` on `other` at all;
    // this is the guard behind that decision rather than a duplicate of it.
    expect(rootHostPath(OTHER_ROOT, home)).toBeNull();
    expect(rootHostPath(UNTRACKED_PATH, home)).toBeNull();
  });

  it('refuses to expand `~` when $HOME is unknown, rather than guessing', () => {
    // The failure the panel shows as a disabled `+`. Substituting a literal
    // `~` would create the session in a directory called `~` under wherever
    // SFTP happened to be — silently, and only discoverable later.
    expect(rootHostPath('~/git', null)).toBeNull();
    expect(rootHostPath('~', null)).toBeNull();
    expect(rootHostPath('~', '   ')).toBeNull();
  });

  it('tolerates a trailing slash on $HOME, which normaliseHome strips', () => {
    expect(rootHostPath('~/git', '/home/alexey/')).toBe('/home/alexey/git');
  });

  it('rejects a relative key, which is not a root anything can resolve', () => {
    expect(rootHostPath('git', home)).toBeNull();
  });
});
