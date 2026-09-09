import { describe, expect, it } from 'vitest';
import {
  applyFolderOrder,
  canDropFolderAt,
  FOLDER_ORDER_MAX_HOSTS,
  FOLDER_ORDER_MAX_ROWS,
  normaliseFolderOrder,
  reorderFolders,
} from '../../src/renderer/folderOrder';
import { groupSessionsIntoRoots, type SessionRootFolder } from '../../src/renderer/sessionTree';
import type { SessionSummary } from '../../src/shared/types';

/**
 * The pure half of  — the panel's manual folder order.
 *
 * Modelled on workspaceTabs.test.ts, which pins the same rules one level down
 *: the ranking, the group clamp, and the shape of what
 * a drag writes. The two features share a design, so they share a test shape.
 *
 * The fixtures are built by `groupSessionsIntoRoots` rather than hand-rolled,
 * because the thing being ranked is a real `SessionDirectory.key` — the
 * home-relative spelling with tmux's two forms of one directory already folded
 * into it. A hand-written `{ key: 'a' }` would pass every assertion here and
 * prove nothing about the keys the panel actually holds.
 */

const HOME = '/home/alexey';

/** Terse SessionSummary factory — timestamps only feed the row's displayed age. */
function session(name: string, path: string | null, created: number): SessionSummary {
  return { name, created, activity: created, attached: false, path };
}

/**
 * `git/a`, `git/b`, `git/c` and `tmp/d`, LISTED in that order — so the derived
 * order is alphabetical too and a reordering is unmistakable in the assertion.
 */
function tree(): SessionRootFolder[] {
  return groupSessionsIntoRoots(
    [
      session('git-a', `${HOME}/git/a`, 100),
      session('git-b', `${HOME}/git/b`, 200),
      session('git-c', `${HOME}/git/c`, 300),
      session('tmp-d', `${HOME}/tmp/d`, 400),
    ],
    HOME,
  );
}

/** Every folder key in draw order — root by root, folders inside each. */
function drawn(roots: readonly SessionRootFolder[]): string[] {
  return roots.flatMap((root) => root.directories.map((dir) => dir.key));
}

describe('normaliseFolderOrder', () => {
  it('keeps a well-formed map as it is', () => {
    expect(normaliseFolderOrder({ hetzner: ['~/git/b', '~/git/a'] })).toEqual({
      hetzner: ['~/git/b', '~/git/a'],
    });
  });

  it('defaults to nothing arranged, which is what the panel wants', () => {
    expect(normaliseFolderOrder({})).toEqual({});
  });

  it('rejects a blob that is not an object at all', () => {
    // The one shape with no salvageable meaning — the settings store reads
    // `undefined` as "use the default".
    expect(normaliseFolderOrder([])).toBeUndefined();
    expect(normaliseFolderOrder(null)).toBeUndefined();
    expect(normaliseFolderOrder('~/git/a')).toBeUndefined();
  });

  it('degrades PER HOST, so one corrupt entry does not cost the others', () => {
    expect(
      normaliseFolderOrder({ good: ['~/git/a'], broken: 'not-a-list', alsoGood: ['~/tmp/d'] }),
    ).toEqual({ good: ['~/git/a'], alsoGood: ['~/tmp/d'] });
  });

  it('degrades PER KEY inside one host, dropping what is not a folder key', () => {
    expect(normaliseFolderOrder({ h: ['~/git/a', 7, null, '', '~/git/b'] })).toEqual({
      h: ['~/git/a', '~/git/b'],
    });
  });

  it('drops a repeated key, keeping the FIRST mention', () => {
    // A repeat would give one folder two ranks and `Map` would silently keep
    // the last, so the file would mean something other than it reads as. The
    // list is best-first, so the first mention is the one the user placed.
    expect(normaliseFolderOrder({ h: ['~/git/b', '~/git/a', '~/git/b'] })).toEqual({
      h: ['~/git/b', '~/git/a'],
    });
  });

  it('drops a host whose list survives as empty, rather than storing []', () => {
    // "This host is not arranged" and "there is no entry" are one state.
    expect(normaliseFolderOrder({ h: [1, 2, 3] })).toEqual({});
    expect(normaliseFolderOrder({ h: [] })).toEqual({});
    expect(normaliseFolderOrder({ '': ['~/git/a'] })).toEqual({});
  });

  it('caps a pathological blob rather than building a huge ranking map', () => {
    const hosts: Record<string, string[]> = {};
    for (let i = 0; i < FOLDER_ORDER_MAX_HOSTS + 10; i += 1) hosts[`h${i}`] = ['~/git/a'];
    expect(Object.keys(normaliseFolderOrder(hosts) ?? {})).toHaveLength(FOLDER_ORDER_MAX_HOSTS);

    const many = Array.from({ length: FOLDER_ORDER_MAX_ROWS + 10 }, (_, i) => `~/git/${i}`);
    expect(normaliseFolderOrder({ h: many })?.['h']).toHaveLength(FOLDER_ORDER_MAX_ROWS);
  });
});

describe('applyFolderOrder', () => {
  it('leaves creation order alone when nothing has been arranged', () => {
    expect(drawn(applyFolderOrder(tree(), []))).toEqual([
      '~/git/a',
      '~/git/b',
      '~/git/c',
      '~/tmp/d',
    ]);
  });

  it('sorts a root by the stored ranking', () => {
    expect(drawn(applyFolderOrder(tree(), ['~/git/c', '~/git/a', '~/git/b']))).toEqual([
      '~/git/c',
      '~/git/a',
      '~/git/b',
      '~/tmp/d',
    ]);
  });

  it('sinks an UNRANKED folder to the bottom of its root, keeping list order there', () => {
    // A folder the user has never dragged lands after every ranked one, and
    // the unranked ones keep the host's relative order, so arranging one root
    // does not scramble the rest.
    expect(drawn(applyFolderOrder(tree(), ['~/git/c']))).toEqual([
      '~/git/c',
      '~/git/a',
      '~/git/b',
      '~/tmp/d',
    ]);
  });

  it('ignores a key that names no live folder', () => {
    // A folder whose sessions were all killed, or one from another host. It
    // ranks nothing and must not be able to pin anything.
    expect(drawn(applyFolderOrder(tree(), ['~/git/gone', '~/git/b']))).toEqual([
      '~/git/b',
      '~/git/a',
      '~/git/c',
      '~/tmp/d',
    ]);
  });

  it('never lets a rank move a row between roots', () => {
    // `tmp/d` is ranked first in the flat list and still renders under `tmp`.
    // The ranking is applied WITHIN a root, so keys in two roots are never
    // compared — a row cannot claim to live somewhere it does not.
    const roots = applyFolderOrder(tree(), ['~/tmp/d', '~/git/c']);
    expect(roots.map((r) => r.label)).toEqual(['git', 'tmp']);
    expect(roots[0]!.directories.map((d) => d.key)).toEqual(['~/git/c', '~/git/a', '~/git/b']);
    expect(roots[1]!.directories.map((d) => d.key)).toEqual(['~/tmp/d']);
  });

  it('does not reorder the ROOTS themselves', () => {
    expect(applyFolderOrder(tree(), ['~/tmp/d']).map((r) => r.label)).toEqual(['git', 'tmp']);
  });

  it('does not mutate the roots it was handed', () => {
    // The input is a Vue computed's value; sorting it in place would be a write
    // during a read.
    const roots = tree();
    applyFolderOrder(roots, ['~/git/c', '~/git/b', '~/git/a']);
    expect(drawn(roots)).toEqual(['~/git/a', '~/git/b', '~/git/c', '~/tmp/d']);
  });

  it('survives the poll: the same ranking on a refreshed list gives the same order', () => {
    // The property the whole design turns on. `applyFolderOrder` is a pure
    // projection re-applied on every refresh, so a list that has gained a
    // folder and lost one still renders the arrangement — the new folder at
    // the bottom, the dead one simply absent.
    const order = ['~/git/c', '~/git/a', '~/git/b'];
    const refreshed = groupSessionsIntoRoots(
      [
        session('git-a', `${HOME}/git/a`, 100),
        session('git-c', `${HOME}/git/c`, 300),
        session('git-e', `${HOME}/git/e`, 500),
      ],
      HOME,
    );
    expect(drawn(applyFolderOrder(refreshed, order))).toEqual(['~/git/c', '~/git/a', '~/git/e']);
  });
});

describe('canDropFolderAt', () => {
  const roots = tree();
  const git = roots[0]!;
  const tmp = roots[1]!;

  it('accepts every gap inside the row own root, including the ends', () => {
    for (const gap of [0, 1, 2, 3]) expect(canDropFolderAt(git, '~/git/b', gap)).toBe(true);
  });

  it('refuses a gap outside the root list', () => {
    expect(canDropFolderAt(git, '~/git/b', -1)).toBe(false);
    expect(canDropFolderAt(git, '~/git/b', 4)).toBe(false);
  });

  it('REFUSES a row from another root, which is what stops a cross-root drag', () => {
    // The panel calls this with the root the pointer is over. A `git` row is
    // not one of `tmp`'s, so no gap in `tmp` will accept it — and the refusal
    // is visible while the drag is still in the air rather than a snap-back.
    for (const gap of [0, 1]) expect(canDropFolderAt(tmp, '~/git/b', gap)).toBe(false);
  });

  it('refuses a key that names no row at all', () => {
    expect(canDropFolderAt(git, '~/git/gone', 0)).toBe(false);
  });
});

describe('reorderFolders', () => {
  it('returns the WHOLE panel draw order, not just the root that moved', () => {
    // A total ranking is what makes "unranked sorts last" mean "folders I have
    // never touched go at the bottom"; a delta would leave every other row
    // unranked and one drag would have moved everything.
    expect(reorderFolders(tree(), '~/git/c', 0)).toEqual([
      '~/git/c',
      '~/git/a',
      '~/git/b',
      '~/tmp/d',
    ]);
  });

  it('moves a row down, accounting for the gap it vacates', () => {
    expect(reorderFolders(tree(), '~/git/a', 3)).toEqual([
      '~/git/b',
      '~/git/c',
      '~/git/a',
      '~/tmp/d',
    ]);
  });

  it('returns null for a drag that ended where it started', () => {
    // Both spellings of "no move": the gap above the row, and the gap below it.
    expect(reorderFolders(tree(), '~/git/b', 1)).toBeNull();
    expect(reorderFolders(tree(), '~/git/b', 2)).toBeNull();
  });

  it('clamps an overshoot instead of refusing it', () => {
    // "Put this as far up as it goes" must not need a pixel-accurate drop.
    expect(reorderFolders(tree(), '~/git/c', -5)).toEqual([
      '~/git/c',
      '~/git/a',
      '~/git/b',
      '~/tmp/d',
    ]);
    expect(reorderFolders(tree(), '~/git/a', 99)).toEqual([
      '~/git/b',
      '~/git/c',
      '~/git/a',
      '~/tmp/d',
    ]);
  });

  it('clamps to the row own root, so an overshoot cannot leave it', () => {
    // `~/git/c` is the last row of `git` and `~/tmp/d` is drawn below it. A
    // drag that overshoots past the boundary lands hard against it — it does
    // not fall into `tmp`.
    expect(reorderFolders(tree(), '~/git/a', 99)?.slice(-1)).toEqual(['~/tmp/d']);
  });

  it('leaves the other roots arrangement untouched in what it writes', () => {
    const arranged = applyFolderOrder(tree(), ['~/git/c', '~/git/b', '~/git/a']);
    // Reordering `tmp` (a no-op here — one row) is refused, so move within git
    // and check the emitted list carries the arrangement it was handed.
    expect(reorderFolders(arranged, '~/git/a', 0)).toEqual([
      '~/git/a',
      '~/git/c',
      '~/git/b',
      '~/tmp/d',
    ]);
  });

  it('returns null for a key that names no row', () => {
    expect(reorderFolders(tree(), '~/git/gone', 0)).toBeNull();
    expect(reorderFolders([], '~/git/a', 0)).toBeNull();
  });
});
