// @vitest-environment jsdom
//
// The Files store's browsing half: open, cd, create, the remembered position,
// reveal, and the race guards. The open-file pipeline (type gating, the
// fileError channel, HTML/markdown/SVG previews) is filesStoreOpenFile.test.ts
// and the pure path helpers are filesStorePaths.test.ts. A DOM is required
// here, not a nicety: opening a markdown file mints a preview, which resolves
// the app's design tokens out of `getComputedStyle(document.documentElement)`
// — under `node` that call throws, `mintPreview` catches it, and the stash
// tests would silently exercise a store whose markdown is off. The ipc double
// is shared in helpers/filesApi, which also stubs the object URLs jsdom lacks
// (reveal opens an mp3, and the store mints a URL for it).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  createFile,
  list,
  mkdir,
  readBinary,
  realPath,
  resetFilesApi,
  stat,
} from './helpers/filesApi';

vi.mock('../../src/renderer/ipc', async () => ({
  api: (await import('./helpers/filesApi')).api,
}));

const { useFilesStore } = await import('../../src/renderer/stores/files');

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  resetFilesApi();
});

/**
 * The Files tab's opening behaviour.
 *
 * The rule these pin is "open where the session is running, not where the user
 * logs in". Two things used to break it, and both are state rules rather than
 * layout ones, so they are driven through the store:
 *
 *  - a session cwd that tmux reports as a literal, unexpanded `~/git/...`,
 *    which an SFTP channel cannot resolve because it has no shell to expand
 *    the tilde;
 *  - a resolve that rejects, which escaped `open()` entirely and left `cwd`
 *    empty — and since `refresh()` early-returns on an empty cwd, nothing ever
 *    populated `entries` OR set `error`. The pane rendered an empty directory
 *    and said nothing, which reads as "the session's folder is empty" rather
 *    than "we never got there".
 */

describe('files store open()', () => {
  it('opens the session directory, not the home directory', async () => {
    realPath.mockResolvedValue('/home/alexey/git/pocketshell');
    const files = useFilesStore();

    await files.open(CONN, '/home/alexey/git/pocketshell');

    expect(realPath).toHaveBeenCalledWith(CONN, '/home/alexey/git/pocketshell');
    expect(files.cwd).toBe('/home/alexey/git/pocketshell');
    expect(files.error).toBeNull();
  });

  it('resolves a tilde session cwd instead of failing on it', async () => {
    realPath.mockResolvedValue('/home/alexey/git');
    const files = useFilesStore();

    await files.open(CONN, '~/git');

    // The tilde never reaches SFTP.
    expect(realPath).toHaveBeenCalledWith(CONN, 'git');
    expect(files.cwd).toBe('/home/alexey/git');
    expect(files.error).toBeNull();
  });

  it('falls back to home AND says why when the session cwd will not resolve', async () => {
    realPath.mockRejectedValueOnce(new Error('No such file')).mockResolvedValueOnce('/home/alexey');
    const files = useFilesStore();

    await files.open(CONN, '/gone');

    expect(files.cwd).toBe('/home/alexey');
    // The note survives `refresh()`, which clears `error` on entry.
    expect(files.error).toContain('/gone');
    expect(files.error).toContain('No such file');
  });

  it('reports the failure rather than rendering a silent empty directory', async () => {
    realPath.mockRejectedValue(new Error('Channel closed'));
    const files = useFilesStore();

    await files.open(CONN, '~/git');

    expect(files.cwd).toBe('');
    expect(files.entries).toEqual([]);
    expect(files.error).toBe('Channel closed');
  });
});

/**
 * A folder click that the host refuses.
 *
 * `cd` used to let the realPath rejection escape, and nothing between the
 * tree and the window caught it — so a dead folder row surfaced as the global
 * diagnostics toast, raw IPC phrasing ("Error invoking remote method
 * 'sftp:realPath'") and all, while the tree itself looked untouched. Two
 * things are pinned here: the failure is a LISTING fact and lands in the
 * tree's footer channel with the path named; and a failed click re-lists
 * where the pane stands, because the ordinary cause is a readdir gone stale —
 * the row was rendered from a listing that has since stopped being true on
 * the host.
 */
describe('files store cd() failures', () => {
  const openAt = async (cwd: string, deadRow: string) => {
    realPath.mockImplementation((_c, p) =>
      p === `${cwd}/${deadRow}` ? Promise.reject(new Error('No such file')) : Promise.resolve(p),
    );
    list.mockResolvedValue([{ name: deadRow, type: 'dir' }]);
    const files = useFilesStore();
    await files.open(CONN, cwd);
    return files;
  };

  it('reports a dead row in the tree footer and stays where it was', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');

    await files.cd(CONN, 'faq-opik');

    expect(files.cwd).toBe('/home/u/git');
    expect(files.error).toContain('/home/u/git/faq-opik');
    expect(files.error).toContain('No such file');
  });

  it('re-lists the current directory, which is what retires the stale row', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');
    list.mockClear();

    await files.cd(CONN, 'faq-opik');

    // The failed click cost one readdir of where we still are — the refresh
    // that replaces the row the click came from.
    expect(list).toHaveBeenCalledWith(CONN, '/home/u/git');
  });

  it('lets the refresh speak when the directory itself is gone too', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');
    list.mockRejectedValue(new Error('No such file'));

    await files.cd(CONN, 'faq-opik');

    // cwd stopped existing between the listing and the click: the refresh's
    // verdict is the more immediate one, and stacking the cd's message on top
    // of it would be noise.
    expect(files.error).toBe('No such file');
  });

  it('still navigates past one failure', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');
    await files.cd(CONN, 'faq-opik');
    expect(files.error).not.toBeNull();

    await files.cd(CONN, 'other');

    expect(files.cwd).toBe('/home/u/git/other');
    expect(files.error).toBeNull();
  });
});

/**
 * Creating a file or folder in the browsed directory.
 *
 * The store's side of the contract: the name is one segment of the browsed
 * directory (never a path that reaches past it), the create verb that refuses
 * to overwrite is the one used for files, a failure lands in the tree's
 * footer channel and returns false — so the naming row stays open over its
 * reason — and a created FILE opens in the editor, ready to be written,
 * while a created FOLDER is just listed.
 */
describe('files store createFile() / createFolder()', () => {
  const openIn = async (cwd: string) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    // A created file opens, so the read the open performs is stubbed to an
    // empty text buffer for every test in this suite.
    stat.mockResolvedValue({ size: 0 });
    readBinary.mockResolvedValue(new Uint8Array());
    const files = useFilesStore();
    await files.open(CONN, cwd);
    list.mockClear();
    return files;
  };

  it('creates a file at the browsed directory and opens it', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.createFile(CONN, 'notes.md')).toBe(true);

    expect(createFile).toHaveBeenCalledWith(CONN, '/home/u/git/notes.md', '');
    // Re-listed so the tree shows the new row, and opened ready to type into.
    expect(list).toHaveBeenCalledWith(CONN, '/home/u/git');
    expect(files.openPath).toBe('/home/u/git/notes.md');
    expect(files.openMode).toBe('markdown');
    expect(files.dirty).toBe(false);
  });

  it('keeps the naming row open over a refusal, with the reason in the footer', async () => {
    const files = await openIn('/home/u/git');
    createFile.mockRejectedValue(new Error('Already exists: /home/u/git/notes.md'));

    expect(await files.createFile(CONN, 'notes.md')).toBe(false);

    expect(files.error).toContain('Already exists');
    // Nothing opened — the buffer is not the failed file's.
    expect(files.openPath).toBeNull();
  });

  it('refuses a name that would reach past this directory', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.createFile(CONN, '../escape.txt')).toBe(false);
    expect(await files.createFile(CONN, 'a/b.txt')).toBe(false);

    expect(createFile).not.toHaveBeenCalled();
    expect(files.error).toContain('Not a usable name');
  });

  it('refuses the navigation-only names, which are not names', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.createFile(CONN, '.')).toBe(false);
    expect(await files.createFile(CONN, '..')).toBe(false);
    expect(createFile).not.toHaveBeenCalled();
  });

  it('trims an accidental surrounding whitespace but refuses what is left empty', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.createFile(CONN, '   ')).toBe(false);
    expect(createFile).not.toHaveBeenCalled();

    expect(await files.createFile(CONN, ' notes.md ')).toBe(true);
    expect(createFile).toHaveBeenCalledWith(CONN, '/home/u/git/notes.md', '');
  });

  it('creates a folder, which lists it but does not open anything', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.createFolder(CONN, 'experiments')).toBe(true);

    expect(mkdir).toHaveBeenCalledWith(CONN, '/home/u/git/experiments');
    expect(list).toHaveBeenCalledWith(CONN, '/home/u/git');
    expect(files.openPath).toBeNull();
  });

  it('reports a failed mkdir in the tree footer', async () => {
    const files = await openIn('/home/u/git');
    mkdir.mockRejectedValue(new Error('Failure'));

    expect(await files.createFolder(CONN, 'experiments')).toBe(false);

    expect(files.error).toBe('Failure');
  });
});

/**
 * Leaving the Files tab must not cost the user their place.
 *
 * The tab is behind a `v-if`, so switching to Terminal unmounts the view.
 * That unmount used to call `clear()`, which reset `cwd` — so coming back
 * re-ran `open()` and dropped the user at the session's start directory (or,
 * while the session cwd was missing, at the login home) no matter how deep
 * they had navigated. The position is now remembered per connection AND per
 * session, which is what stops one session's directory becoming another's.
 */
describe('files store remembers where each session was left', () => {
  it('returns to the directory the user navigated to, not the start path', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p === 'git/app' ? '/home/u/git/app' : p));
    const files = useFilesStore();

    await files.open(CONN, '~/git/app');
    await files.cd(CONN, '/home/u/git/app/src/deep');
    expect(files.cwd).toBe('/home/u/git/app/src/deep');

    // Terminal tab -> Files tab: the view unmounts and re-mounts, so `open`
    // runs again with the same start path.
    await files.open(CONN, '~/git/app');

    expect(files.cwd).toBe('/home/u/git/app/src/deep');
  });

  it('is NOT pinned to a home it merely fell back to', async () => {
    // The reported bug: "we should always open the files for that specific
    // folder and not in ~".
    //
    // A workspace whose session has no working directory yet opens its Files
    // tab with no start path, so the store resolves `.` and lands at the login
    // home. That is correct at the time. What was not correct is that the
    // landing was recorded as this tab's remembered position — under a key that
    // is the TAB ID and therefore never changes — so when the session's real
    // directory arrived and `FilesView` re-opened with it, the remembered home
    // outranked it and the tab stayed at `~` for good.
    //
    // The tab id is passed explicitly here because that is what the real caller
    // passes; keying on the start path (as an earlier version of this file did)
    // hides the bug by changing the key exactly when the path is recovered.
    realPath.mockImplementation((_c: unknown, p: string) =>
      Promise.resolve(p === '.' ? '/home/u' : `/home/u/${p}`),
    );
    const files = useFilesStore();
    const tab = '~/git/red-stamp::files:1';

    await files.open(CONN, undefined, tab);
    expect(files.cwd).toBe('/home/u');

    // The probe recovers the session's directory and the view re-opens.
    await files.open(CONN, '~/git/red-stamp', tab);

    expect(files.cwd).toBe('/home/u/git/red-stamp');
  });

  it('still prefers a directory the user actually navigated to', async () => {
    // The other half of the same rule: a REAL choice must still outrank the
    // start path, or the fix above would undo the memory this file exists for.
    realPath.mockImplementation((_c: unknown, p: string) =>
      Promise.resolve(p === '.' ? '/home/u' : p.startsWith('/') ? p : `/home/u/${p}`),
    );
    const files = useFilesStore();
    const tab = '~/git/red-stamp::files:1';

    await files.open(CONN, undefined, tab);
    await files.cd(CONN, '/home/u/notes');
    expect(files.cwd).toBe('/home/u/notes');

    await files.open(CONN, '~/git/red-stamp', tab);

    expect(files.cwd).toBe('/home/u/notes');
  });

  it('does not leak one session\u2019s directory into another\u2019s', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.cd(CONN, '/home/u/git/app/src');

    // A different session, with its own working directory.
    await files.open(CONN, '/home/u/git/other');
    expect(files.cwd).toBe('/home/u/git/other');

    // ...and going back to the first still lands where it was left.
    await files.open(CONN, '/home/u/git/app');
    expect(files.cwd).toBe('/home/u/git/app/src');
  });

  it('uses a newly recovered session path on the first visit after the fix', async () => {
    // Before the cwd bug was fixed this session had `path: null`, so the tab
    // opened at the login home. Once tmux's answer comes through, the FIRST
    // visit must honour it rather than a home remembered from before.
    realPath.mockImplementation((_c, p) => Promise.resolve(p === '.' ? '/home/u' : p));
    const files = useFilesStore();

    await files.open(CONN, undefined);
    expect(files.cwd).toBe('/home/u');

    await files.open(CONN, '/home/u/git/red-stamp-sound');

    expect(files.cwd).toBe('/home/u/git/red-stamp-sound');
  });

  it('keeps an unsaved edit across a tab switch instead of discarding it', async () => {
    // A clean buffer is a cache and is cheap to rebuild; an unsaved edit
    // exists nowhere else, so throwing it away silently would be worse than
    // the bug this whole mechanism fixes.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 12 });
    readBinary.mockResolvedValue(new TextEncoder().encode('hello world\n'));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.openFile(CONN, 'notes.md');
    files.setContent('edited, not saved');

    await files.open(CONN, '/home/u/git/other');
    expect(files.openPath).toBeNull();

    await files.open(CONN, '/home/u/git/app');
    expect(files.openContent).toBe('edited, not saved');
    expect(files.dirty).toBe(true);
  });

  it('forgets a connection on disconnect, which is what clear() is for', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.cd(CONN, '/home/u/git/app/src');
    files.clear(CONN);

    expect(files.cwd).toBe('');
    await files.open(CONN, '/home/u/git/app');
    expect(files.cwd).toBe('/home/u/git/app');
  });
});

describe('files store reveal', () => {
  it('parks the resolved path for the Files tab to take exactly once', () => {
    const files = useFilesStore();

    files.requestReveal('tmp/a.mp3', '~/git/foo');

    expect(files.reveal).toBe('git/foo/tmp/a.mp3');
    expect(files.takeReveal()).toBe('git/foo/tmp/a.mp3');
    expect(files.reveal).toBeNull();
    expect(files.takeReveal()).toBeNull();
  });

  it('opens a file and moves the listing to its directory', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 3, type: 'file' });
    readBinary.mockResolvedValue(new Uint8Array([0x49, 0x44, 0x33]));
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey/git/foo');

    await files.revealPath(CONN, '/home/alexey/git/foo/tmp/a.mp3');

    expect(files.cwd).toBe('/home/alexey/git/foo/tmp');
    expect(files.openPath).toBe('/home/alexey/git/foo/tmp/a.mp3');
    expect(files.openMode).toBe('audio');
    expect(files.error).toBeNull();
  });

  it('enters a directory rather than trying to open it as a file', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 0, type: 'dir' });
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');

    await files.revealPath(CONN, '/home/alexey/git');

    expect(files.cwd).toBe('/home/alexey/git');
    expect(files.openPath).toBeNull();
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('says so when the optimistically-linked path does not exist', async () => {
    // Terminal output is linkified without ever being stat'ed, so a dead link
    // is a NORMAL outcome and has to arrive as a message rather than silence.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockRejectedValue(new Error('No such file'));
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');
    const before = files.cwd;

    await files.revealPath(CONN, '/home/alexey/gone.mp3');

    expect(files.error).toContain('gone.mp3');
    expect(files.error).toContain('No such file');
    // And the user is left where they were, not somewhere half-navigated.
    expect(files.cwd).toBe(before);
    expect(files.openPath).toBeNull();
  });

  it('reports a path that will not even resolve', async () => {
    realPath.mockImplementation((_c, p) =>
      p === '/home/alexey' ? Promise.resolve(p) : Promise.reject(new Error('Permission denied')),
    );
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');

    await files.revealPath(CONN, '/root/secret.txt');

    expect(files.error).toContain('/root/secret.txt');
    expect(files.error).toContain('Permission denied');
  });
});

/**
 * The race guards.
 *
 * cwd/entries and openPath/openContent are single slots shared by every
 * navigation and every open. Two rapid actions used to race, and whichever
 * transfer resolved LAST won — file A's bytes under file B's path, or the
 * listing of a directory the pane had already left. The store now tickets each
 * pipeline (the same shape as the projects store's `browseRequest`), and a
 * superseded call commits nothing.
 *
 * Each test holds one transfer in flight on a manually-resolved promise,
 * completes a newer one, then lets the stale transfer land and pins that it
 * changed nothing.
 */
describe('files store race guards', () => {
  /** A promise the test resolves by hand, to park one store call in flight. */
  const parked = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('a slow openFile cannot paint its file over a newer one', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 16 });
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    const staleRead = parked<Uint8Array>();
    readBinary.mockImplementation((_c, path) =>
      path === '/home/u/site/a.txt'
        ? staleRead.promise
        : Promise.resolve(new TextEncoder().encode('B')),
    );

    const stale = files.openFile(CONN, 'a.txt');
    await files.openFile(CONN, 'b.txt');
    expect(files.openPath).toBe('/home/u/site/b.txt');
    expect(files.openContent).toBe('B');

    staleRead.resolve(new TextEncoder().encode('A'));
    await stale;
    expect(files.openPath).toBe('/home/u/site/b.txt');
    expect(files.openContent).toBe('B');
    // The stale open must not park or clear the spinner out from under the
    // current one.
    expect(files.opening).toBe(false);
  });

  it('a slow cd cannot move cwd after a newer navigation', async () => {
    const staleResolve = parked<string>();
    realPath.mockImplementation((_c, p) =>
      p === '/home/u/slow' ? staleResolve.promise : Promise.resolve(p),
    );
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    const stale = files.cd(CONN, '/home/u/slow');
    await files.cd(CONN, '/home/u/fast');
    expect(files.cwd).toBe('/home/u/fast');

    staleResolve.resolve('/home/u/slow');
    await stale;
    expect(files.cwd).toBe('/home/u/fast');
    expect(files.error).toBeNull();
  });

  it('a superseded refresh cannot overwrite the newer listing', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    const staleList = parked<unknown[]>();
    let call = 0;
    list.mockImplementation(() => {
      call += 1;
      return call === 1
        ? staleList.promise
        : Promise.resolve([{ name: 'fresh.txt', type: 'file' }]);
    });

    const stale = files.refresh(CONN);
    await files.refresh(CONN);
    expect(files.entries).toEqual([{ name: 'fresh.txt', type: 'file' }]);

    staleList.resolve([{ name: 'stale.txt', type: 'file' }]);
    await stale;
    expect(files.entries).toEqual([{ name: 'fresh.txt', type: 'file' }]);
    expect(files.loading).toBe(false);
  });
});
