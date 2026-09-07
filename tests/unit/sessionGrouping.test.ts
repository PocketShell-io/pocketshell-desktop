import { describe, it, expect } from 'vitest';
import {
  UNTRACKED_LABEL,
  UNTRACKED_PATH,
  canonicalisePath,
  defaultLabelForPath,
  groupSessionsByFolder,
  isAgentSession,
} from '../../src/renderer/sessionGrouping';
import {
  bestRootForPath,
  directoryKey,
  inferHome,
  normaliseRootList,
  normaliseRootPath,
  OTHER_LABEL,
  OTHER_ROOT,
  pathWithinRoot,
  resolveRoots,
  rootForPath,
  rootFromSessionName,
  rootHostPath,
  SESSION_ROOTS_MAX,
} from '../../src/renderer/sessionRoots';
import { groupSessionsIntoRoots, type SessionRootFolder } from '../../src/renderer/sessionTree';
import type { SessionAgentKind, SessionSummary } from '../../src/shared/types';

/** Terse SessionSummary factory — only the fields grouping cares about. */
function session(
  name: string,
  path: string | null,
  activity: number,
  attached = false,
): SessionSummary {
  return { name, created: activity, activity, attached, path };
}

/** Same, plus the host-recorded agent kind. */
function agentSession(
  name: string,
  path: string | null,
  activity: number,
  agentKind: SessionAgentKind | null,
): SessionSummary {
  return { name, created: activity, activity, attached: false, path, agentKind };
}

describe('isAgentSession (FolderTreeProjection.kt:588)', () => {
  it('counts every launched engine, plus the transient detector states', () => {
    for (const k of ['claude', 'codex', 'opencode', 'grok', 'probing', 'exited'] as const) {
      expect(isAgentSession(k)).toBe(true);
    }
  });

  it('groups shells, unknown and absent kinds together as non-agents (#821)', () => {
    expect(isAgentSession('shell')).toBe(false);
    expect(isAgentSession('unknown')).toBe(false);
    expect(isAgentSession(null)).toBe(false);
    expect(isAgentSession(undefined)).toBe(false);
  });
});

describe('within-folder order: agents first (recencySessionSort)', () => {
  it('sorts an agent session ahead of a more recent shell', () => {
    const folders = groupSessionsByFolder([
      agentSession('shell-new', '/srv/app', 900, 'shell'),
      agentSession('claude-old', '/srv/app', 100, 'claude'),
    ]);
    expect(folders[0]?.sessions.map((s) => s.name)).toEqual(['claude-old', 'shell-new']);
  });

  it('falls back to activity-desc then name-asc within each agent/non-agent band', () => {
    const folders = groupSessionsByFolder([
      agentSession('b-shell', '/srv/app', 500, null),
      agentSession('a-shell', '/srv/app', 500, null),
      agentSession('codex-1', '/srv/app', 100, 'codex'),
      agentSession('claude-1', '/srv/app', 700, 'claude'),
    ]);
    expect(folders[0]?.sessions.map((s) => s.name)).toEqual([
      'claude-1',
      'codex-1',
      'a-shell',
      'b-shell',
    ]);
  });

  it('leaves rows with no agentKind at all ordered purely by recency', () => {
    const folders = groupSessionsByFolder([
      session('old', '/srv/app', 100),
      session('new', '/srv/app', 900),
    ]);
    expect(folders[0]?.sessions.map((s) => s.name)).toEqual(['new', 'old']);
  });
});

describe('canonicalisePath', () => {
  it('strips trailing slashes so /a/b/ and /a/b are one folder', () => {
    expect(canonicalisePath('/srv/app/')).toBe('/srv/app');
    expect(canonicalisePath('/srv/app')).toBe('/srv/app');
  });

  it('collapses blank/unknown to the untracked sentinel', () => {
    expect(canonicalisePath(null)).toBe(UNTRACKED_PATH);
    expect(canonicalisePath('')).toBe(UNTRACKED_PATH);
    expect(canonicalisePath('   ')).toBe(UNTRACKED_PATH);
  });

  it('keeps the filesystem root as /', () => {
    expect(canonicalisePath('/')).toBe('/');
    expect(canonicalisePath('///')).toBe('/');
  });

  it('does not expand ~', () => {
    expect(canonicalisePath('~/git/pocketshell')).toBe('~/git/pocketshell');
  });
});

describe('defaultLabelForPath', () => {
  it('uses the trailing path segment', () => {
    expect(defaultLabelForPath('/home/alexey/git/pocketshell')).toBe('pocketshell');
  });

  it('names the degenerate cases instead of rendering a blank header', () => {
    expect(defaultLabelForPath(UNTRACKED_PATH)).toBe(UNTRACKED_LABEL);
    expect(defaultLabelForPath('')).toBe(UNTRACKED_LABEL);
    expect(defaultLabelForPath('/')).toBe('/ (root)');
    expect(defaultLabelForPath('~')).toBe('~ (home)');
    expect(defaultLabelForPath('$HOME')).toBe('~ (home)');
  });
});

describe('groupSessionsByFolder', () => {
  it('buckets sessions by canonical working directory', () => {
    const folders = groupSessionsByFolder([
      session('a', '/srv/app', 300),
      session('b', '/srv/app/', 200),
      session('c', '/srv/other', 100),
    ]);
    expect(folders.map((f) => f.path)).toEqual(['/srv/app', '/srv/other']);
    expect(folders[0]!.sessions.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('orders folders by most-recent activity, descending', () => {
    const folders = groupSessionsByFolder([
      session('old', '/srv/old', 100),
      session('new', '/srv/new', 900),
      session('mid', '/srv/mid', 500),
    ]);
    expect(folders.map((f) => f.label)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks folder ties on a case-insensitive label', () => {
    const folders = groupSessionsByFolder([
      session('x', '/srv/Beta', 100),
      session('y', '/srv/alpha', 100),
    ]);
    expect(folders.map((f) => f.label)).toEqual(['alpha', 'Beta']);
  });

  it('sorts sessions inside a folder by activity desc then name', () => {
    const folders = groupSessionsByFolder([
      session('zulu', '/srv/app', 100),
      session('alpha', '/srv/app', 100),
      session('newest', '/srv/app', 500),
    ]);
    expect(folders[0]!.sessions.map((s) => s.name)).toEqual(['newest', 'alpha', 'zulu']);
  });

  it('pins the untracked bucket last even when it is the most recent', () => {
    const folders = groupSessionsByFolder([
      session('nowhere', null, 9_000),
      session('somewhere', '/srv/app', 10),
    ]);
    expect(folders.map((f) => f.label)).toEqual(['app', UNTRACKED_LABEL]);
  });

  it('falls back to created when activity is missing', () => {
    const stale: SessionSummary = {
      name: 's',
      created: 700,
      activity: 0,
      attached: false,
      path: '/srv/app',
    };
    expect(groupSessionsByFolder([stale])[0]!.mostRecentActivity).toBe(700);
  });

  it('marks a folder active when any of its sessions is attached', () => {
    const folders = groupSessionsByFolder([
      session('a', '/srv/app', 1, false),
      session('b', '/srv/app', 2, true),
      session('c', '/srv/idle', 3, false),
    ]);
    expect(folders.find((f) => f.path === '/srv/app')!.active).toBe(true);
    expect(folders.find((f) => f.path === '/srv/idle')!.active).toBe(false);
  });

  it('returns nothing for an empty session list', () => {
    expect(groupSessionsByFolder([])).toEqual([]);
  });
});

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

describe('groupSessionsIntoRoots', () => {
  const home = '/home/alexey';

  /** Every session under a root, in render order, across its directories. */
  function sessionNames(root: SessionRootFolder): string[] {
    return root.directories.flatMap((d) => d.rows.map((r) => r.session.name));
  }

  it('renders one root per $HOME child, holding that root directories', () => {
    // The sessions arrive in the order the assertions expect: the panel
    // preserves the host's order (§6), so the tree folds the list without
    // rearranging it.
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 100),
        session('git-pocketshell', '/home/alexey/git/pocketshell', 200),
        session('tmp-scratch', '/home/alexey/tmp/scratch', 300),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    expect(roots[0]!.directories.map((d) => d.label)).toEqual(['dataops', 'pocketshell']);
    expect(roots[0]!.sessionCount).toBe(2);
    expect(roots[1]!.directories.map((d) => d.label)).toEqual(['scratch']);
  });

  it('names a lone session row after its DIRECTORY, not after the session', () => {
    const [git] = groupSessionsIntoRoots(
      [session('git-dtc-website', '/home/alexey/git/merry-sniffing-token', 100)],
      home,
    );
    const [dir] = git!.directories;
    // The worktree case: the name diverges from the folder, and the folder
    // still wins the row. The name is not lost — it is in the tooltip.
    expect(dir!.label).toBe('merry-sniffing-token');
    expect(dir!.rows).toHaveLength(1);
    expect(dir!.rows[0]!.session.name).toBe('git-dtc-website');
  });

  it('gives a single-session directory a node of its own, with the session inside it', () => {
    // docs/SESSIONLIST.md revision 3: the directory level is unconditional.
    // Revisions 1 and 2 collapsed this case into one row, which at the real
    // 1:1 distribution collapsed the entire tree into a flat list.
    const [git] = groupSessionsIntoRoots(
      [session('git-dataops', '/home/alexey/git/dataops', 100)],
      home,
    );
    expect(git!.directories).toHaveLength(1);
    expect(git!.directories[0]!.path).toBe('~/git/dataops');
    expect(git!.directories[0]!.label).toBe('dataops');
    expect(git!.directories[0]!.rows.map((r) => r.session.name)).toEqual(['git-dataops']);
  });

  it('shapes every real directory the same way, whatever it holds', () => {
    // The guard against a fourth revision quietly reintroducing a size test:
    // one node per directory, its sessions as children, at every size.
    const [git] = groupSessionsIntoRoots(
      [
        session('git-solo', '/home/alexey/git/solo', 200),
        session('git-pair-a', '/home/alexey/git/pair', 300),
        session('git-pair-b', '/home/alexey/git/pair', 400),
      ],
      home,
    );
    expect(git!.directories.map((d) => [d.label, d.rows.length])).toEqual([
      ['solo', 1],
      ['pair', 2],
    ]);
    // Every session is reachable at depth three, none as a direct root child.
    expect(sessionNames(git!)).toEqual(['git-solo', 'git-pair-a', 'git-pair-b']);
  });

  it('names every leaf by its session name, so a header never repeats itself', () => {
    // A leaf carries `nameHead + nameTail` whether or not it has siblings —
    // revision 2 only split the name for branch children.
    const [git] = groupSessionsIntoRoots(
      [session('git-dtc-website', '/home/alexey/git/merry-sniffing-token', 100)],
      home,
    );
    const [dir] = git!.directories;
    expect(dir!.label).toBe('merry-sniffing-token');
    expect(dir!.rows[0]!.nameHead + dir!.rows[0]!.nameTail).toBe('git-dtc-website');
  });

  it('branches a directory holding more than one session, listing them by name', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-pocketshell', '/home/alexey/git/pocketshell', 100),
        session('git-pocketshell-quse', '/home/alexey/git/pocketshell', 200),
        session('git-dataops', '/home/alexey/git/dataops', 300),
      ],
      home,
    );
    const branch = git!.directories.find((d) => d.label === 'pocketshell')!;
    expect(branch.rows.map((r) => r.session.name)).toEqual([
      'git-pocketshell',
      'git-pocketshell-quse',
    ]);
    // The child label is the session name, split for middle truncation — the
    // siblings share a derived prefix, so an end-ellipsis would merge them.
    expect(branch.rows.map((r) => r.nameHead + r.nameTail)).toEqual([
      'git-pocketshell',
      'git-pocketshell-quse',
    ]);
    expect(branch.rows[1]!.nameTail).toBe('ell-quse');
    expect(git!.directories.find((d) => d.label === 'dataops')!.rows).toHaveLength(1);
  });

  it('gives a branch the newest age and the aggregate dot of its sessions', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-a', '/home/alexey/git/app', 100),
        session('git-app-b', '/home/alexey/git/app', 900, true),
      ],
      home,
    );
    expect(git!.directories[0]!.mostRecentActivity).toBe(900);
    expect(git!.directories[0]!.active).toBe(true);
  });

  it('folds the two spellings of one directory into a single node, not two rows', () => {
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-a', '/home/alexey/git/app', 300),
        session('git-app-b', '~/git/app', 200),
      ],
      home,
    );
    expect(git!.directories).toHaveLength(1);
    expect(git!.directories[0]!.rows).toHaveLength(2);
  });

  it('infers home when it was not supplied, instead of dumping everything in other', () => {
    const roots = groupSessionsIntoRoots([
      session('git-a', '/home/alexey/git/a', 200),
      session('tmp-b', '/home/alexey/tmp/b', 300),
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
  });

  it('collects untracked and out-of-home sessions into one other bucket', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', '/home/alexey/git/a', 300),
        session('var-log', '/var/log', 100),
        session('nowhere', null, 200),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
    expect(roots[1]!.other).toBe(true);
    expect(sessionNames(roots[1]!)).toEqual(['var-log', 'nowhere']);
    // `/var/log` is a real directory and gets a directory row like any other.
    expect(roots[1]!.directories[0]!.label).toBe('log');
  });

  it('names a directory that IS $HOME after home, not after the account', () => {
    // The directory key collapses to `~`, so the leaf component is gone and
    // `defaultLabelForPath`'s named fallback takes over. That is the better
    // label anyway: a row reading `alexey` looks like a user, not a project.
    const [other] = groupSessionsIntoRoots([session('home-alexey', '/home/alexey', 100)], home);
    expect(other!.directories[0]!.label).toBe('~ (home)');
    expect(other!.directories[0]!.path).toBe('~');
  });

  it('pins other last however recent it is', () => {
    const roots = groupSessionsIntoRoots(
      [session('unplaceable', null, 9_000), session('git-a', '/home/alexey/git/a', 10)],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
  });

  it('keeps derived roots in the order the host listed them', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('a', '/home/alexey/first/a', 100),
        session('b', '/home/alexey/third/b', 900),
        session('c', '/home/alexey/second/c', 500),
      ],
      home,
    );
    // First appearance in the list: `third` holds the newest session and
    // still renders where the host put it, not where its timestamp or its
    // label would sort it.
    expect(roots.map((r) => r.label)).toEqual(['first', 'third', 'second']);
    // The age is still the NEWEST activity — it is what the header displays,
    // and it is not what the header sorts on. Two different questions,
    // two fields.
    expect(roots[0]!.mostRecentActivity).toBe(100);
  });

  it('does not move a root when its newest activity changes', () => {
    // The poll re-samples `activity` every five seconds. Under the old
    // recency sort that was enough to swap two headers under the cursor; the
    // projection preserves the order it is given, so the two lists are
    // identical — the order changes only when the host's list does.
    const before = groupSessionsIntoRoots(
      [
        { name: 'a', created: 100, activity: 100, attached: false, path: '/home/alexey/one/a' },
        { name: 'b', created: 200, activity: 200, attached: false, path: '/home/alexey/two/b' },
      ],
      home,
    );
    const after = groupSessionsIntoRoots(
      [
        { name: 'a', created: 100, activity: 100, attached: false, path: '/home/alexey/one/a' },
        // `two` just produced output, and `one` did not.
        { name: 'b', created: 200, activity: 9_000, attached: false, path: '/home/alexey/two/b' },
      ],
      home,
    );
    expect(before.map((r) => r.label)).toEqual(['one', 'two']);
    expect(after.map((r) => r.label)).toEqual(['one', 'two']);
  });

  it('orders roots by first appearance, so a new root cannot displace them', () => {
    // `two` holds the newest session on the box and still sits where its
    // first row landed. The client never reorders on its own — where a
    // brand-new root appears is the host's decision (its sort), applied
    // verbatim.
    const roots = groupSessionsIntoRoots(
      [
        session('one-a', '/home/alexey/one/a', 100),
        session('two-b', '/home/alexey/two/b', 200),
        session('two-c', '/home/alexey/two/c', 9_000),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['one', 'two']);
  });

  it('keeps the arrival order of roots that the host tied', () => {
    // Equal timestamps arrive in the order the host printed them and stay
    // that way — there is no client-side tiebreak left to invent an order.
    const roots = groupSessionsIntoRoots(
      [session('x', '/home/alexey/Beta/x', 100), session('y', '/home/alexey/alpha/y', 100)],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['Beta', 'alpha']);
  });

  it('orders directories by first appearance in the host\'s list', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-first', '/home/alexey/git/first', 10),
        session('git-third', '/home/alexey/git/third', 900),
        session('git-second', '/home/alexey/git/second', 100),
      ],
      home,
    );
    // Arrival order, not creation order: `third` is the youngest folder and
    // stays where the host put it.
    expect(roots[0]!.directories.map((d) => d.label)).toEqual(['first', 'third', 'second']);
  });

  it('keeps the arrival order of directories that the host tied', () => {
    const [git] = groupSessionsIntoRoots(
      [session('x', '/home/alexey/git/Beta', 100), session('y', '/home/alexey/git/alpha', 100)],
      home,
    );
    expect(git!.directories.map((d) => d.label)).toEqual(['Beta', 'alpha']);
  });

  it('does not move an attached folder on its own', () => {
    // Pinned as a property of the projection: the client never reorders on
    // `active`. Opening a folder workspace used to jump its row to the top of
    // its root — the list rearranging itself in response to being used
    // (docs/SESSIONLIST.md §6). Whether attaching moves a row NOW is the
    // host's decision — its `--sort accessed` will — and the client applies
    // that answer verbatim on the next poll. The mark stays (`active`).
    const roots = groupSessionsIntoRoots(
      [
        session('git-old', '/home/alexey/git/old', 100),
        session('git-new', '/home/alexey/git/new', 900),
        session('git-live', '/home/alexey/git/live', 950, true),
      ],
      home,
    );
    expect(roots[0]!.directories.map((d) => d.label)).toEqual(['old', 'new', 'live']);
    expect(roots[0]!.directories.find((d) => d.label === 'live')!.active).toBe(true);
  });

  it('keeps the host\'s row order inside a branch', () => {
    // Rows are not re-sorted to match the tab bar: the bar still orders by
    // creation (`buildWorkspaceTabs`, its own stability argument), and the
    // panel shows the host's order. The two surfaces disagree on purpose —
    // the bar's rows are hit targets, the panel's rows are the host's list.
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-new', '/home/alexey/git/app', 900),
        session('git-app-live', '/home/alexey/git/app', 10, true),
      ],
      home,
    );
    expect(git!.directories[0]!.rows.map((r) => r.session.name)).toEqual([
      'git-app-new',
      'git-app-live',
    ]);
  });

  it('gains a session in a folder without moving any folder', () => {
    // The client-side half of the property the panel rests on: a second
    // session in `app` reorders nothing anywhere — the projection only ever
    // folds the host's list. Whether the host moves `app` afterwards is its
    // sort's decision, not ours.
    const [git] = groupSessionsIntoRoots(
      [
        session('git-app-a', '/home/alexey/git/app', 100),
        session('git-app-b', '/home/alexey/git/app', 9_000),
        session('git-zoo', '/home/alexey/git/zoo', 200),
      ],
      home,
    );
    expect(git!.directories.map((d) => d.label)).toEqual(['app', 'zoo']);
    expect(git!.directories[0]!.rows.map((r) => r.session.name)).toEqual(['git-app-a', 'git-app-b']);
  });

  it('marks a root active when any session under it is attached', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', '/home/alexey/git/a', 1, false),
        session('git-b', '/home/alexey/git/b', 2, true),
        session('tmp-c', '/home/alexey/tmp/c', 3, false),
      ],
      home,
    );
    expect(roots.find((r) => r.label === 'git')!.active).toBe(true);
    expect(roots.find((r) => r.label === 'tmp')!.active).toBe(false);
  });

  it('renders an untracked session as its own row, under its own name', () => {
    // `untracked` — never `rows.length` — is what the renderer reads to draw
    // the single-row orphan (§3d). There is no directory here to draw a level
    // for, and a header would print the session name twice on adjacent rows.
    const [other] = groupSessionsIntoRoots([session('foreign-0', null, 100)], home);
    const [dir] = other!.directories;
    expect(dir!.untracked).toBe(true);
    expect(dir!.label).toBe('foreign-0');
    expect(dir!.rows).toHaveLength(1);
    expect(dir!.rows[0]!.nameHead + dir!.rows[0]!.nameTail).toBe('foreign-0');
  });

  it('never merges untracked sessions into one Untracked branch', () => {
    const [other] = groupSessionsIntoRoots(
      [session('foreign-0', null, 100), session('foreign-1', null, 200)],
      home,
    );
    expect(other!.directories.map((d) => d.label)).toEqual(['foreign-0', 'foreign-1']);
    expect(other!.directories.every((d) => d.rows.length === 1)).toBe(true);
  });

  it('files a session with no reported cwd under the root its NAME names', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 300),
        session('git-red-stamp-sound', null, 200),
      ],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git']);
    const recovered = roots[0]!.directories.find((d) => d.untracked)!;
    expect(recovered.label).toBe('git-red-stamp-sound');
    expect(recovered.inferredRoot).toBe(true);
  });

  it('leaves a name-recovered session as a direct child, inventing no directory', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 300),
        // Ambiguous between ~/git/dtc-website-import and ~/git/dtc-website/import.
        session('git-dtc-website-import', null, 200),
      ],
      home,
    );
    const recovered = roots[0]!.directories.find((d) => d.untracked)!;
    expect(recovered.path).toBe(UNTRACKED_PATH);
    expect(recovered.label).toBe('git-dtc-website-import');
  });

  it('still drops a no-cwd session into other when no root matches its name', () => {
    const roots = groupSessionsIntoRoots(
      [session('git-dataops', '/home/alexey/git/dataops', 300), session('weird-thing', null, 200)],
      home,
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
    expect(sessionNames(roots[1]!)).toEqual(['weird-thing']);
    expect(roots[1]!.directories[0]!.inferredRoot).toBe(false);
  });

  it('does not let a name-recovered session create the root it was filed under', () => {
    // `git` exists only in the NAME here, never in a real path, so nothing may
    // be filed into it — otherwise the heuristic invents the structure it is
    // supposed to be reading.
    const roots = groupSessionsIntoRoots([session('git-ghost', null, 200)], home);
    expect(roots.map((r) => r.label)).toEqual([OTHER_LABEL]);
  });

  it('grows colliding directory labels apart within a root, not across roots', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('a', '/home/alexey/git/foo', 400),
        session('b', '/home/alexey/git/nested/foo', 300),
        session('c', '/home/alexey/work/foo', 200),
      ],
      home,
    );
    const git = roots.find((r) => r.label === 'git')!;
    const work = roots.find((r) => r.label === 'work')!;
    expect(git.directories.map((d) => d.label).sort()).toEqual(['git/foo', 'nested/foo']);
    // Already separated by their headers, so `work` keeps the bare basename.
    expect(work.directories.map((d) => d.label)).toEqual(['foo']);
  });

  it('returns nothing for an empty session list', () => {
    expect(groupSessionsIntoRoots([], home)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * Registered roots — the configured top level (docs/SESSIONLIST.md §12)
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

describe('groupSessionsIntoRoots with registered roots', () => {
  const home = '/home/alexey';

  /** Every session under a root, in render order, across its directories. */
  function names(root: SessionRootFolder): string[] {
    return root.directories.flatMap((d) => d.rows.map((r) => r.session.name));
  }

  it('falls back to deriving roots from $HOME when none are registered', () => {
    // The default, and every existing install: nothing configured must NOT
    // mean an empty tree or one giant `other`. The phone does dump everything
    // into `Other folders` here; we deliberately do not.
    const roots = groupSessionsIntoRoots(
      [session('git-a', '/home/alexey/git/a', 200), session('tmp-b', '/home/alexey/tmp/b', 300)],
      home,
      [],
    );
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    expect(roots.every((r) => !r.configured)).toBe(true);
  });

  it('uses the registered roots when there are any, in registered order', () => {
    // Registered order, not recency: `git` is older than `tmp` here and still
    // renders first, because a declared list is itself an ordering and the
    // store's refresh timer must not be able to reshuffle the top level.
    const roots = groupSessionsIntoRoots(
      [session('git-a', '/home/alexey/git/a', 100), session('tmp-b', '/home/alexey/tmp/b', 900)],
      home,
      ['~/git', '~/tmp'],
    );
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    expect(roots.every((r) => r.configured)).toBe(true);
  });

  it('sends everything under no registered root to other, still pinned last', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', '/home/alexey/git/a', 100),
        // Under $HOME, but under no registered root — the new `other` case.
        session('work-b', '/home/alexey/work/b', 800),
        session('var-c', '/var/log', 900),
      ],
      home,
      ['~/git'],
    );
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
    expect(names(roots[1]!)).toEqual(['work-b', 'var-c']);
  });

  it('keeps a registered root that holds nothing, and marks it configured', () => {
    // A root the user registered is a statement of intent, not a fact derived
    // from the session list — including on a host where it does not exist.
    const roots = groupSessionsIntoRoots([session('git-a', '/home/alexey/git/a', 100)], home, [
      '~/git',
      '~/tmp',
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    const tmp = roots[1]!;
    expect(tmp.sessionCount).toBe(0);
    expect(tmp.directories).toEqual([]);
    expect(tmp.configured).toBe(true);
  });

  it('renders a root that is registered twice in two spellings exactly once', () => {
    const roots = groupSessionsIntoRoots([session('git-a', '/home/alexey/git/a', 100)], home, [
      '~/git',
      '/home/alexey/git/',
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git']);
    expect(roots[0]!.sessionCount).toBe(1);
  });

  it('files a session into the deepest registered root that claims it', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-work-x', '/home/alexey/git/work/x', 300),
        session('git-y', '/home/alexey/git/y', 200),
      ],
      home,
      ['~/git', '~/git/work'],
    );
    // Two roots, two labels — `work` is not grown, because nothing collides
    // with it. What matters is where each session landed.
    expect(roots.map((r) => r.label)).toEqual(['git', 'work']);
    expect(names(roots[0]!)).toEqual(['git-y']);
    expect(names(roots[1]!)).toEqual(['git-work-x']);
  });

  it('does not let a registered root claim a sibling with the same prefix', () => {
    const roots = groupSessionsIntoRoots([session('gitlab-a', '/home/alexey/gitlab/a', 100)], home, [
      '~/git',
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git', OTHER_LABEL]);
    expect(names(roots[1]!)).toEqual(['gitlab-a']);
  });

  it('still nests three levels under a registered root', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataops', '/home/alexey/git/dataops', 200),
        session('git-pocketshell', '/home/alexey/git/pocketshell', 300),
      ],
      home,
      ['~/git'],
    );
    expect(roots[0]!.directories.map((d) => [d.label, d.rows.length])).toEqual([
      ['dataops', 1],
      ['pocketshell', 1],
    ]);
  });

  it('lets a registered root receive a name-recovered session it holds nothing else of', () => {
    // §4.6, with configured roots: a root the USER declared is better evidence
    // than one we inferred, so the heuristic may file into an empty one.
    const roots = groupSessionsIntoRoots([session('tmp-scratch', null, 200)], home, ['~/tmp']);
    expect(roots.map((r) => r.label)).toEqual(['tmp']);
    expect(roots[0]!.directories[0]!.inferredRoot).toBe(true);
  });

  it('ignores a corrupt entry in the registered list instead of losing the tree', () => {
    const roots = groupSessionsIntoRoots([session('git-a', '/home/alexey/git/a', 100)], home, [
      'nonsense',
      '~/git',
    ]);
    expect(roots.map((r) => r.label)).toEqual(['git']);
  });
});

/**
 * What happens to a folder when its last session stops.
 *
 * Written because the user reported the opposite — "I stopped the last session
 * but it stayed" — and the first question was whether the projection was at
 * fault: does a directory that has lost every session still come out of here as
 * a row? These say no, and they say it at both levels, so the next person
 * reading that bug report does not have to re-derive it.
 *
 * The answer matters beyond this one report, because it is the reason the FIX
 * could be a plain re-read of the session list rather than any reconciliation
 * of the tree. `buildDirectories` builds a node BECAUSE a row landed in it —
 * there is no path through it that produces an empty one — so feeding it the
 * host's current truth is sufficient, and nothing has to remember what was on
 * screen a moment ago in order to take it away.
 *
 * The one thing that DOES survive with nothing in it is a registered root, and
 * that is deliberate and load-bearing: it is a statement of intent by the user
 * rather than a fact derived from the session list, and the panel says so in
 * words ("registered in Settings — nothing running here"). Anything that
 * removes rows for being empty has to leave that case alone.
 */
describe('groupSessionsIntoRoots — a folder whose sessions are gone', () => {
  const home = '/home/alexey';

  it('has nothing at all to render once the last session stops', () => {
    const live = groupSessionsIntoRoots([session('git-dataqna', `${home}/git/dataqna`, 100)], home);
    expect(live[0]!.directories.map((d) => d.label)).toEqual(['dataqna']);
    // The same call, one session poorer. Not "a root with an empty directory"
    // and not "a directory with no rows" — the whole branch is simply absent.
    expect(groupSessionsIntoRoots([], home)).toEqual([]);
  });

  it('drops the directory but keeps the root while a sibling folder is still live', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-dataqna', `${home}/git/dataqna`, 200),
        session('git-dataops', `${home}/git/dataops`, 300),
      ],
      home,
    );
    expect(roots[0]!.directories.map((d) => d.label)).toEqual(['dataqna', 'dataops']);

    const after = groupSessionsIntoRoots([session('git-dataops', `${home}/git/dataops`, 300)], home);
    expect(after.map((r) => r.label)).toEqual(['git']);
    expect(after[0]!.directories.map((d) => d.label)).toEqual(['dataops']);
    expect(after[0]!.sessionCount).toBe(1);
  });

  it('keeps a folder that has merely lost ONE of its sessions', () => {
    // The boundary the removal must not overshoot. Two sessions in a folder,
    // one stopped: the row stays, holding the survivor, and its count and its
    // dot both follow what is left rather than what was there.
    const after = groupSessionsIntoRoots(
      [session('git-dataqna', `${home}/git/dataqna`, 300, true)],
      home,
    );
    const [dir] = after[0]!.directories;
    expect(dir!.rows.map((r) => r.session.name)).toEqual(['git-dataqna']);
    expect(dir!.active).toBe(true);
  });

  it('never emits a directory with no rows in it, whatever it is fed', () => {
    // The property, rather than another example of it. `buildDirectories`
    // creates a node BECAUSE a row landed in it, and this is what stops a
    // future change from introducing a seeded-empty directory the way roots
    // are legitimately seeded empty one level up.
    const roots = groupSessionsIntoRoots(
      [
        session('git-a', `${home}/git/a`, 300),
        session('tmp-b', `${home}/tmp/b`, 200),
        session('elsewhere', '/srv/app', 150),
        session('nowhere', null, 100),
      ],
      home,
      ['~/git', '~/tmp', '~/never'],
    );
    for (const root of roots) {
      for (const dir of root.directories) expect(dir.rows.length).toBeGreaterThan(0);
    }
  });

  it('still renders a REGISTERED root that has emptied out, and says nothing runs there', () => {
    // The deliberate exception, and the reason "remove empty rows" cannot be a
    // blanket rule. `~/git` was registered in Settings; its last session
    // stopping does not un-register it, and a setting that silently shows
    // nothing reads as a broken setting.
    const roots = groupSessionsIntoRoots([], home, ['~/git']);
    expect(roots.map((r) => r.label)).toEqual(['git']);
    expect(roots[0]!.directories).toEqual([]);
    expect(roots[0]!.sessionCount).toBe(0);
    expect(roots[0]!.configured).toBe(true);
    expect(roots[0]!.active).toBe(false);
  });

  it('removes a DERIVED root entirely when the last session under it stops', () => {
    // The contrast that makes the exception above legible: nothing was
    // registered here, so `git` existed only because a session was in it. With
    // the session gone the root has no reason to be, and unlike a registered
    // one it has nothing to say about itself.
    expect(groupSessionsIntoRoots([session('git-a', `${home}/git/a`, 100)], home)).toHaveLength(1);
    expect(groupSessionsIntoRoots([], home)).toHaveLength(0);
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
