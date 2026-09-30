// @vitest-environment jsdom
//
// The Files store's delete half: the row menu's verb behind its confirmation.
// The wiring a user can reach (menu item, sheet, buttons) is
// fileTreeDelete.test.ts; this suite pins the store's side of the same
// feature — which entry goes, which channel reports a refusal, and the two
// pieces of state the deleted bytes take with them: the open file and the
// directory being browsed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  deleteFile,
  list,
  readBinary,
  realPath,
  resetFilesApi,
  rmdir,
  stat,
} from './helpers/filesApi';

vi.mock('@ui/app/ipc', async () => ({
  api: (await import('./helpers/filesApi')).api,
}));

const { useFilesStore } = await import('@ui/app/stores/files');

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  resetFilesApi();
});

describe('files store deleteEntry()', () => {
  /** The store, opened at `cwd` with the listing pipeline stubbed quiet. */
  const openIn = async (cwd: string) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 0 });
    readBinary.mockResolvedValue(new Uint8Array());
    const files = useFilesStore();
    await files.open(CONN, cwd);
    list.mockClear();
    return files;
  };

  it('unlinks a file at the browsed directory and re-lists', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.deleteEntry(CONN, 'notes.md', 'file')).toBe(true);

    expect(deleteFile).toHaveBeenCalledWith(CONN, '/home/u/git/notes.md');
    expect(list).toHaveBeenCalledWith(CONN, '/home/u/git');
    expect(files.error).toBeNull();
  });

  it('unlinks a symlink rather than rmdir-ing it', async () => {
    // A link to a directory must not become an rmdir of the TARGET: the row
    // is the thing the user asked to remove.
    const files = await openIn('/home/u/git');

    expect(await files.deleteEntry(CONN, 'latest', 'symlink')).toBe(true);

    expect(deleteFile).toHaveBeenCalledWith(CONN, '/home/u/git/latest');
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('rmdirs a directory', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.deleteEntry(CONN, 'src', 'dir')).toBe(true);

    expect(rmdir).toHaveBeenCalledWith(CONN, '/home/u/git/src');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('reports a refusal in the tree footer and leaves the listing alone', async () => {
    const files = await openIn('/home/u/git');
    deleteFile.mockRejectedValue(new Error('Permission denied'));

    expect(await files.deleteEntry(CONN, 'notes.md', 'file')).toBe(false);

    expect(files.error).toBe('Permission denied');
    // No re-list on a refused delete: the listing still describes the
    // directory, and rewiping `error` with a refresh would erase the reason.
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses names that reach past this directory or are not names', async () => {
    const files = await openIn('/home/u/git');

    expect(await files.deleteEntry(CONN, '../escape.txt', 'file')).toBe(false);
    expect(await files.deleteEntry(CONN, 'a/b.txt', 'file')).toBe(false);
    expect(await files.deleteEntry(CONN, '..', 'dir')).toBe(false);

    expect(deleteFile).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
    expect(files.error).toContain('Not a usable name');
  });

  it('closes the open file when it is the deleted one', async () => {
    const files = await openIn('/home/u/git');
    await files.openFile(CONN, '/home/u/git/notes.md');
    expect(files.openPath).toBe('/home/u/git/notes.md');

    await files.deleteEntry(CONN, 'notes.md', 'file');

    expect(files.openPath).toBeNull();
  });

  it('closes an open file that lived under a deleted directory', async () => {
    const files = await openIn('/home/u/git');
    await files.openFile(CONN, '/home/u/git/src/a.ts');

    await files.deleteEntry(CONN, 'src', 'dir');

    expect(files.openPath).toBeNull();
  });

  it('keeps an open file whose path merely shares a prefix with the deleted entry', async () => {
    const files = await openIn('/home/u/git');
    await files.openFile(CONN, '/home/u/git/notes.md.backup');

    await files.deleteEntry(CONN, 'notes.md', 'file');

    expect(files.openPath).toBe('/home/u/git/notes.md.backup');
  });

  it('re-lists in place after a directory delete, like after a file delete', async () => {
    // The verb takes a name in the LISTING, so the pane is never standing in
    // what it deletes — there is no move-up to do, only the re-list.
    const files = await openIn('/home/u/git');

    await files.deleteEntry(CONN, 'src', 'dir');

    expect(files.cwd).toBe('/home/u/git');
    expect(list).toHaveBeenCalledWith(CONN, '/home/u/git');
  });
});
