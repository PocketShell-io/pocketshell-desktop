import { describe, expect, it } from 'vitest';
import { applyRootOrder, canDropRootAt, reorderRoots } from '@ui/app/rootOrder';
import { groupSessionsIntoRoots, type SessionRootFolder } from '@ui/app/sessionTree';
import { OTHER_ROOT } from '@ui/app/sessionRoots';
import type { SessionSummary } from '@pocketshell/core';

/**
 * The pure half of the panel's manual ROOT order — the headers one level up
 * from `folderOrder.test.ts`'s folder rows.
 *
 * The two features share a design, so they share a test shape: the fixtures
 * are built by `groupSessionsIntoRoots` rather than hand-rolled, because the
 * thing being ranked is a real `SessionRootFolder.key`, and the assertions pin
 * the ranking, the pinned `other` bucket, and the shape of what a drag writes.
 * The one rule this level adds over the folder order — the bucket is pinned,
 * not placed — gets the refusal tests its folder counterpart spends on the
 * cross-root rule.
 */

const HOME = '/home/alexey';

/** Terse SessionSummary factory — timestamps only feed the row's displayed age. */
function session(name: string, path: string | null, created: number): SessionSummary {
  return { name, created, activity: created, attached: false, path };
}

/**
 * `git` and `tmp` with a session each, plus one untracked stray — so the
 * derived order is `git`, `tmp`, `other`, and a reordering is unmistakable in
 * the assertion. The stray is what puts the PINNED bucket in the list, which
 * is the one participant this level has and the folder order does not.
 */
function tree(): SessionRootFolder[] {
  return groupSessionsIntoRoots(
    [
      session('git-a', `${HOME}/git/a`, 100),
      session('tmp-d', `${HOME}/tmp/d`, 200),
      session('stray-x', null, 300),
    ],
    HOME,
  );
}

/** The same tree with no stray, so no bucket — the ends behave differently. */
function treeWithoutBucket(): SessionRootFolder[] {
  return groupSessionsIntoRoots(
    [session('git-a', `${HOME}/git/a`, 100), session('tmp-d', `${HOME}/tmp/d`, 200)],
    HOME,
  );
}

/** Every root key in draw order. */
function drawn(roots: readonly SessionRootFolder[]): string[] {
  return roots.map((root) => root.key);
}

describe('applyRootOrder', () => {
  it('leaves the grouped order alone when nothing has been arranged', () => {
    expect(drawn(applyRootOrder(tree(), []))).toEqual(['~/git', '~/tmp', OTHER_ROOT]);
  });

  it('re-orders the roots by the stored ranking', () => {
    expect(drawn(applyRootOrder(tree(), ['~/tmp', '~/git']))).toEqual([
      '~/tmp',
      '~/git',
      OTHER_ROOT,
    ]);
  });

  it('sinks an UNRANKED root below the ranked ones, keeping grouped order there', () => {
    // A root the user has never dragged lands after every ranked one, and the
    // unranked ones keep their relative order, so arranging one root does not
    // scramble the rest.
    expect(drawn(applyRootOrder(tree(), ['~/tmp']))).toEqual(['~/tmp', '~/git', OTHER_ROOT]);
  });

  it('keeps `other` pinned last whatever it ranked', () => {
    // The pin is the grouping's declared output (`groupSessionsIntoRoots`):
    // the bucket is a bucket, not a place, and a stored rank must not be able
    // to float it above a real root.
    expect(drawn(applyRootOrder(tree(), [OTHER_ROOT, '~/git']))).toEqual([
      '~/git',
      '~/tmp',
      OTHER_ROOT,
    ]);
  });

  it('ignores a key that names no live root', () => {
    // A root whose sessions all went away (derived mode), or one from another
    // host's blob. It ranks nothing and must not be able to pin anything.
    expect(drawn(applyRootOrder(tree(), ['~/gone', '~/tmp']))).toEqual([
      '~/tmp',
      '~/git',
      OTHER_ROOT,
    ]);
  });

  it('overrides the REGISTERED order without moving a folder between roots', () => {
    // Registered roots render in registered order; the arrangement is applied
    // on top of that projection (folderTree.ts), and it re-orders the
    // SECTIONS only — the folders under each keep their own order.
    const registered = groupSessionsIntoRoots(
      [session('tmp-d', `${HOME}/tmp/d`, 100), session('git-a', `${HOME}/git/a`, 200)],
      HOME,
      ['~/git', '~/tmp'],
    );
    const arranged = applyRootOrder(registered, ['~/tmp']);
    expect(arranged.map((root) => root.label)).toEqual(['tmp', 'git']);
    expect(arranged[0]!.directories.map((d) => d.key)).toEqual(['~/tmp/d']);
    expect(arranged[1]!.directories.map((d) => d.key)).toEqual(['~/git/a']);
  });

  it('does not mutate the roots it was handed', () => {
    // The input is a Vue computed's value; sorting it in place would be a
    // write during a read.
    const roots = tree();
    applyRootOrder(roots, ['~/tmp', '~/git']);
    expect(drawn(roots)).toEqual(['~/git', '~/tmp', OTHER_ROOT]);
  });

  it('survives the poll: the same ranking on a refreshed list gives the same order', () => {
    // The property the whole design turns on. `applyRootOrder` is a pure
    // projection re-applied on every refresh, so a list that has gained a root
    // and lost one still renders the arrangement — the new root after the
    // ranked ones, the dead one simply absent.
    const order = ['~/tmp', '~/git'];
    const refreshed = groupSessionsIntoRoots(
      [
        session('tmp-d', `${HOME}/tmp/d`, 100),
        session('git-a', `${HOME}/git/a`, 200),
        session('work-e', `${HOME}/work/e`, 300),
      ],
      HOME,
    );
    expect(drawn(applyRootOrder(refreshed, order))).toEqual(['~/tmp', '~/git', '~/work']);
  });
});

describe('canDropRootAt', () => {
  it('accepts every gap above and between the roots', () => {
    const roots = tree();
    for (const gap of [0, 1, 2]) expect(canDropRootAt(roots, '~/tmp', gap)).toBe(true);
  });

  it('accepts the gap below the LAST root when there is no bucket', () => {
    const roots = treeWithoutBucket();
    expect(canDropRootAt(roots, '~/git', 2)).toBe(true);
  });

  it('refuses a gap outside the root list', () => {
    const roots = treeWithoutBucket();
    expect(canDropRootAt(roots, '~/git', -1)).toBe(false);
    expect(canDropRootAt(roots, '~/git', 3)).toBe(false);
  });

  it('refuses the gap BELOW the pinned bucket', () => {
    // Ranking a root after `other` is a placement `applyRootOrder` would
    // silently undo. An accepted drop that snaps back reads as a bug; the
    // refusal has to be visible while the drag is still in the air.
    const roots = tree();
    expect(canDropRootAt(roots, '~/git', 3)).toBe(false);
  });

  it('REFUSES to carry the bucket itself', () => {
    const roots = tree();
    for (const gap of [0, 1, 2]) expect(canDropRootAt(roots, OTHER_ROOT, gap)).toBe(false);
  });

  it('refuses a key that names no root at all', () => {
    expect(canDropRootAt(tree(), '~/gone', 0)).toBe(false);
  });
});

describe('reorderRoots', () => {
  it('returns the WHOLE panel draw order, not just the root that moved', () => {
    // A total ranking is what makes "unranked sorts last" mean "roots I have
    // never touched keep their grouped order"; a delta would leave every other
    // root unranked and one drag would have moved everything.
    expect(reorderRoots(tree(), '~/tmp', 0)).toEqual(['~/tmp', '~/git', OTHER_ROOT]);
  });

  it('moves a root down, accounting for the gap it vacates', () => {
    expect(reorderRoots(tree(), '~/git', 2)).toEqual(['~/tmp', '~/git', OTHER_ROOT]);
  });

  it('returns null for a drag that ended where it started', () => {
    // Both spellings of "no move": the gap above the header, and the gap below
    // it.
    expect(reorderRoots(tree(), '~/git', 0)).toBeNull();
    expect(reorderRoots(tree(), '~/git', 1)).toBeNull();
  });

  it('returns null for a key that names no root', () => {
    expect(reorderRoots(tree(), '~/gone', 0)).toBeNull();
  });

  it('clamps an overshoot instead of refusing it', () => {
    // "Put this as far up as it goes" must not need a pixel-accurate drop.
    expect(reorderRoots(tree(), '~/tmp', -5)).toEqual(['~/tmp', '~/git', OTHER_ROOT]);
  });

  it('composes with applyRootOrder: the drop lands where the drag was aimed', () => {
    // The round trip the panel performs on every drag — commit, then re-render
    // through the pipeline — must agree with the place the indicator drew.
    const roots = tree();
    const next = reorderRoots(roots, '~/git', 2);
    expect(next).not.toBeNull();
    expect(drawn(applyRootOrder(roots, next as string[]))).toEqual([
      '~/tmp',
      '~/git',
      OTHER_ROOT,
    ]);
  });
});
