import { describe, expect, it } from 'vitest';
import {
  applyFolderSort,
  folderCreatedAt,
  FOLDER_SORT_DEFAULT,
  FOLDER_SORT_KEYS,
  FOLDER_SORT_LABELS,
  normaliseFolderSort,
} from '@ui/app/folderSort';
import { applyFolderOrder } from '@ui/app/folderOrder';
import { groupSessionsIntoRoots, type SessionRootFolder } from '@ui/app/sessionTree';
import type { SessionSummary } from '@pocketshell/core';

/**
 * The panel's folder sort (`@ui/app/folderSort.ts`, in pocketshell-core).
 *
 * Modelled on folderOrder.test.ts, which pins the manual arrangement one
 * projection over — the two features share a pipeline (`grouping -> sort ->
 * manual order`, folderTree.ts), so they share a fixture shape: real trees
 * from `groupSessionsIntoRoots`, because the thing being sorted is a real
 * `SessionDirectory` with the keys, labels and aggregates the panel actually
 * draws.
 *
 * The fixtures are tuned so every key produces a DIFFERENT order — a sort that
 * agreed with its neighbour on the fixture data would pass while permuting
 * nothing, and prove nothing.
 */

const HOME = '/home/alexey';

function session(
  name: string,
  path: string,
  created: number,
  activity: number,
): SessionSummary {
  return { name, created, activity, attached: false, path };
}

/**
 * `git`: wye, ate, zed — listed (host order) in that order — plus `tmp`: cue.
 * Each key permutes `git` its own way:
 *
 *   host:     wye  ate  zed   (the listing's order)
 *   name:     ate  wye  zed   (alphabetical)
 *   activity: zed  ate  wye   (3000, 2000, 1000 — newest first)
 *   created:  ate  zed  wye   (100, 200, 400 — oldest first)
 */
function tree(): SessionRootFolder[] {
  return groupSessionsIntoRoots(
    [
      session('git-wye', `${HOME}/git/wye`, 400, 1000),
      session('git-ate', `${HOME}/git/ate`, 100, 2000),
      session('git-zed', `${HOME}/git/zed`, 200, 3000),
      session('tmp-cue', `${HOME}/tmp/cue`, 300, 4000),
    ],
    HOME,
  );
}

/** Every folder label in draw order — root by root, folders inside each. */
function labels(roots: SessionRootFolder[]): string[] {
  return roots.flatMap((root) => root.directories.map((dir) => dir.label));
}

describe('folder sort keys', () => {
  it('defaults to the host order and lists a label for every key', () => {
    expect(FOLDER_SORT_DEFAULT).toBe('host');
    expect(FOLDER_SORT_KEYS).toEqual(['host', 'activity', 'name', 'created']);
    expect([...FOLDER_SORT_KEYS].sort()).toEqual(Object.keys(FOLDER_SORT_LABELS).sort());
  });

  it('normalises stored keys and refuses the rest', () => {
    for (const key of FOLDER_SORT_KEYS) expect(normaliseFolderSort(key)).toBe(key);
    expect(normaliseFolderSort('recency')).toBeUndefined();
    expect(normaliseFolderSort(42)).toBeUndefined();
    expect(normaliseFolderSort(null)).toBeUndefined();
  });

  it('host order copies through, untouched', () => {
    expect(labels(applyFolderSort(tree(), 'host'))).toEqual([
      'wye',
      'ate',
      'zed',
      'cue',
    ]);
  });

  it('each key orders the folders its own way', () => {
    const gitOrder = (key: Parameters<typeof applyFolderSort>[1]): string[] =>
      applyFolderSort(tree(), key)
        .find((root) => root.key === '~/git')!
        .directories.map((dir) => dir.label);
    expect(gitOrder('activity')).toEqual(['zed', 'ate', 'wye']);
    expect(gitOrder('name')).toEqual(['ate', 'wye', 'zed']);
    expect(gitOrder('created')).toEqual(['ate', 'zed', 'wye']);
  });

  it('sorts within roots and never reorders the roots themselves', () => {
    const sorted = applyFolderSort(tree(), 'activity');
    expect(sorted.map((root) => root.key)).toEqual(['~/git', '~/tmp']);
    expect(labels(sorted)).toEqual(['zed', 'ate', 'wye', 'cue']);
  });

  it('is stable: folders the key cannot tell apart keep their host order', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-b', `${HOME}/git/b`, 100, 500),
        session('git-a', `${HOME}/git/a`, 200, 500),
        session('git-c', `${HOME}/git/c`, 300, 500),
      ],
      HOME,
    );
    // Every folder ties on activity, so the listing's order must survive whole.
    expect(labels(applyFolderSort(roots, 'activity'))).toEqual(['b', 'a', 'c']);
  });

  it('compares names case-insensitively', () => {
    const roots = groupSessionsIntoRoots(
      [
        session('git-beta', `${HOME}/git/Beta`, 100, 100),
        session('git-alpha', `${HOME}/git/alpha`, 200, 200),
      ],
      HOME,
    );
    expect(labels(applyFolderSort(roots, 'name'))).toEqual(['alpha', 'Beta']);
  });

  it('does not mutate the tree it is handed', () => {
    const roots = tree();
    applyFolderSort(roots, 'name');
    expect(labels(roots)).toEqual(['wye', 'ate', 'zed', 'cue']);
  });
});

describe('folderCreatedAt', () => {
  it('is the folder’s oldest session', () => {
    const dir = applyFolderSort(
      groupSessionsIntoRoots(
        [
          session('git-new', `${HOME}/git/one`, 500, 500),
          session('git-old', `${HOME}/git/one`, 100, 900),
        ],
        HOME,
      ),
      'host',
    )[0]!.directories[0]!;
    expect(folderCreatedAt(dir)).toBe(100);
  });
});

describe('composition with the manual arrangement', () => {
  it('a dragged rank wins; unranked folders keep the chosen sort', () => {
    const sorted = applyFolderSort(tree(), 'name');
    // The drag emits the whole panel's keys in draw order (folderOrder.ts);
    // one key ranked, the rest of `git` unnamed.
    const arranged = applyFolderOrder(sorted, ['~/git/zed']);
    expect(labels(arranged)).toEqual(['zed', 'ate', 'wye', 'cue']);
  });
});
