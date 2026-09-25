import { describe, expect, it } from 'vitest';
import { filterFolderRoots } from '@ui/app/folderFilter';
import {
  groupSessionsIntoRoots,
  OTHER_LABEL,
  type SessionRootFolder,
} from '@ui/app/sessionTree';
import type { SessionSummary } from '@pocketshell/core';

/**
 * The session panel's quick search (`@ui/app/folderFilter.ts`, in
 * pocketshell-core).
 *
 * Same fixture discipline as folderSort.test.ts: real trees out of
 * `groupSessionsIntoRoots`, because the thing being cut is the panel's own
 * row list — keys, labels, tooltips and all. The `other` bucket appears in
 * most cases on purpose: its folders' keys do not contain the root's name, so
 * it is the one root where "matched the root" and "matched a path" can be
 * told apart in an assertion.
 */

const HOME = '/home/alexey';

function session(name: string, path: string | null, created = 100): SessionSummary {
  return { name, created, activity: created, attached: false, path };
}

/** `git`: wye, ate — plus one stray outside every root, in `other`. */
function tree(): SessionRootFolder[] {
  return groupSessionsIntoRoots(
    [
      session('git-wye', `${HOME}/git/wye`),
      session('git-ate', `${HOME}/git/ate`),
      session('www-site', '/var/www/site'),
    ],
    HOME,
  );
}

/** Every folder key in draw order — root by root, folders inside each. */
function keys(roots: SessionRootFolder[]): string[] {
  return roots.flatMap((root) => root.directories.map((dir) => dir.key));
}

describe('filterFolderRoots', () => {
  it('a blank query changes nothing, down to the objects', () => {
    const tree_ = tree();
    for (const query of ['', '   ']) {
      const out = filterFolderRoots(tree_, query);
      expect(out.map((root) => root.key)).toEqual(tree_.map((root) => root.key));
      expect(out[0]!.directories[0]).toBe(tree_[0]!.directories[0]);
    }
  });

  it('matches the folder label, case-insensitively', () => {
    expect(keys(filterFolderRoots(tree(), 'WYE'))).toEqual(['~/git/wye']);
  });

  it('matches the full path, not only the leaf label', () => {
    const roots = groupSessionsIntoRoots(
      [session('deep', `${HOME}/git/deep/child`)],
      HOME,
    );
    // `deep` appears in the key but the label is `child`.
    expect(keys(filterFolderRoots(roots, 'deep'))).toEqual(['~/git/deep/child']);
    expect(keys(filterFolderRoots(roots, 'child'))).toEqual(['~/git/deep/child']);
  });

  it('matches the names of the sessions inside, which the rows no longer show', () => {
    const roots = groupSessionsIntoRoots(
      [session('custom-name', `${HOME}/git/wye`)],
      HOME,
    );
    expect(keys(filterFolderRoots(roots, 'custom'))).toEqual(['~/git/wye']);
    // And the folder's own name is not what rescued it.
    expect(keys(filterFolderRoots(roots, 'nothing-like-the-folder'))).toEqual([]);
  });

  it('a query naming the `other` root keeps the root whole', () => {
    // The label, case-insensitively — and the bucket's folder does NOT match
    // it (`/var/www/site` carries neither the root's name nor the query), so
    // surviving at all is the keep-whole branch doing its job.
    const out = filterFolderRoots(tree(), OTHER_LABEL.toLowerCase());
    const other = out.find((root) => root.key !== '~/git');
    expect(other).toBeDefined();
    expect(other!.directories.map((dir) => dir.key)).toEqual(['/var/www/site']);
    // The `git` folders do not match and do not tag along.
    expect(out).toHaveLength(1);
  });

  it('folders and roots that match nothing disappear', () => {
    expect(keys(filterFolderRoots(tree(), 'zzz'))).toEqual([]);
    expect(filterFolderRoots(tree(), 'zzz')).toEqual([]);
  });

  it('a root with survivors keeps only the survivors', () => {
    const out = filterFolderRoots(tree(), 'ate');
    expect(out.map((root) => root.key)).toEqual(['~/git']);
    expect(keys(out)).toEqual(['~/git/ate']);
  });

  it('an empty registered root drops while a filter is up', () => {
    const roots = groupSessionsIntoRoots([], HOME, ['~/tmp']);
    expect(roots.map((root) => root.key)).toEqual(['~/tmp']);
    const filtered = filterFolderRoots(roots, 'tmp');
    expect(filtered).toEqual([]);
  });

  it('does not mutate the tree it is handed', () => {
    const tree_ = tree();
    filterFolderRoots(tree_, 'ate');
    expect(tree_.flatMap((root) => root.directories).map((dir) => dir.key)).toEqual([
      '~/git/wye',
      '~/git/ate',
      '/var/www/site',
    ]);
  });
});
