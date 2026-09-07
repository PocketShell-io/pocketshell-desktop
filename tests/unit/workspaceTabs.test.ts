import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceTabs,
  labelForRemainder,
  numberCollisions,
  applyTabOrder,
  canDropTabAt,
  nudgeTabOrder,
  pruneTabIds,
  pushMru,
  reorderTabs,
  renamedSessionName,
  stripSessionPrefix,
  tabAfterClose,
  MAIN_LABEL,
} from '../../src/shared/workspaceTabs';
import { sanitisePart, sessionBaseName } from '../../src/shared/sessionNameParts';

/**
 * The pure half of the tab model. These are the rules the user
 * described in the most detail, so they are the ones worth pinning.
 */

describe('stripSessionPrefix', () => {
  it('returns an empty remainder for an exact match', () => {
    expect(stripSessionPrefix('git-dtc-website', 'git-dtc-website')).toBe('');
  });

  it('strips the prefix and its separator', () => {
    expect(stripSessionPrefix('git-dtc-website-import', 'git-dtc-website')).toBe('import');
  });

  it('requires the `-` boundary, so a longer folder name is not claimed', () => {
    // `~/git/red-stamp` must not adopt `~/git/red-stampede`'s session just
    // because one name is a character-prefix of the other.
    expect(stripSessionPrefix('git-red-stampede', 'git-red-stamp')).toBeNull();
  });

  it('returns null for a name that is not derived from the folder', () => {
    expect(stripSessionPrefix('nightly-build', 'git-dtc-website')).toBeNull();
  });

  it('never strips against an empty prefix', () => {
    expect(stripSessionPrefix('anything', '')).toBeNull();
  });
});

describe('labelForRemainder', () => {
  it('labels the empty remainder `main`', () => {
    // The folder's default session — the unnumbered member of the family the
    // numbered tabs continue.
    expect(labelForRemainder('')).toBe('main');
    expect(MAIN_LABEL).toBe('main');
  });

  it('labels a purely numeric remainder `main <n>`', () => {
    // This is what `freeSessionNameCommand`'s `-2`/`-3` walk produces.
    expect(labelForRemainder('2')).toBe('main 2');
    expect(labelForRemainder('17')).toBe('main 17');
  });

  it('numbers the family with a SPACE, not the name\'s hyphen', () => {
    // The tmux names really are `git-dtc-website-2`, but this is a display
    // label and every other numbered label on the bar is spaced (`Files 2`).
    expect(labelForRemainder('2')).not.toBe('main-2');
    expect(labelForRemainder('')).toBe(MAIN_LABEL);
    expect(labelForRemainder('2')).toBe(`${MAIN_LABEL} 2`);
  });

  it('keeps a clear name clear', () => {
    expect(labelForRemainder('import')).toBe('import');
    // Not "just a number": a name that merely contains digits is a name.
    expect(labelForRemainder('v2')).toBe('v2');
    expect(labelForRemainder('2fa')).toBe('2fa');
    // A remainder that IS the word keeps it verbatim too — no rewrite fires,
    // and the collision counter (not this function) deals with the repeat.
    expect(labelForRemainder('main')).toBe('main');
  });
});

describe('numberCollisions', () => {
  it('leaves the first occurrence plain and numbers the rest', () => {
    const out = numberCollisions([{ label: 'a' }, { label: 'b' }, { label: 'a' }, { label: 'a' }]);
    expect(out.map((t) => t.label)).toEqual(['a', 'b', 'a 2', 'a 3']);
  });

  it('numbers by position, so an appended tab cannot renumber the bar', () => {
    const before = numberCollisions([{ label: 'Files' }, { label: 'Files' }]);
    expect(before.map((t) => t.label)).toEqual(['Files', 'Files 2']);
    const after = numberCollisions([{ label: 'Files' }, { label: 'Files' }, { label: 'Files' }]);
    expect(after.slice(0, 2).map((t) => t.label)).toEqual(['Files', 'Files 2']);
  });
});

describe('buildWorkspaceTabs', () => {
  const prefix = sessionBaseName('~/git/dtc-website', '/home/alexey');

  it('derives the prefix the same way the host names the folder', () => {
    expect(prefix).toBe('git-dtc-website');
  });

  it('labels the brief\'s worked example', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-import', created: 200 },
        { name: 'git-dtc-website', created: 100 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['main', 'import']);
  });

  it('renames the LABEL only — the id, the session and the remainder stand', () => {
    // `main` is what the tab reads. What it joins, what the route keys off
    // and what a rename edits are all still the tmux name and the stripped
    // remainder, so nothing downstream can be keyed off the display word.
    const tabs = buildWorkspaceTabs([{ name: 'git-dtc-website', created: 100 }], prefix);
    expect(tabs[0]).toEqual({
      kind: 'session',
      id: 'git-dtc-website',
      session: 'git-dtc-website',
      label: 'main',
      remainder: '',
      created: 100,
    });
  });

  it('orders session tabs oldest first, then Files tabs', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-3', created: 300 },
        { name: 'git-dtc-website', created: 100 },
        { name: 'git-dtc-website-2', created: 200 },
      ],
      prefix,
      [{ id: 'f1' }, { id: 'f2' }],
    );
    expect(tabs.map((t) => t.kind)).toEqual([
      'session',
      'session',
      'session',
      'files',
      'files',
    ]);
    // One family, in creation order: the folder's default, then its `-2` and
    // `-3`, and the numbering reads as a list rather than as an exception.
    expect(tabs.map((t) => t.label)).toEqual([
      'main',
      'main 2',
      'main 3',
      'Files',
      'Files 2',
    ]);
  });

  it('breaks a creation-time tie on the name, so the order is total', () => {
    // Every row has the same timestamp on a host with no enrichment, because
    // `parseSessionsList` sets activity === created.
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-zeta', created: 100 },
        { name: 'git-dtc-website-alpha', created: 100 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['alpha', 'zeta']);
  });

  it('keeps a non-derived session name in full', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website', created: 100 },
        { name: 'nightly-build', created: 200 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['main', 'nightly-build']);
    expect(tabs[1]).toMatchObject({ remainder: null });
  });

  it('numbers a stripped remainder that collides with a foreign session name', () => {
    const tabs = buildWorkspaceTabs(
      [
        { name: 'git-dtc-website-import', created: 100 },
        { name: 'import', created: 200 },
      ],
      prefix,
    );
    expect(tabs.map((t) => t.label)).toEqual(['import', 'import 2']);
  });

  it('numbers across kinds — a session called Files does not get a free pass', () => {
    const tabs = buildWorkspaceTabs([{ name: 'Files', created: 100 }], prefix, [{ id: 'f1' }]);
    expect(tabs.map((t) => t.label)).toEqual(['Files', 'Files 2']);
  });

  it('is a bar of Files tabs alone when the folder has no sessions', () => {
    const tabs = buildWorkspaceTabs([], prefix, [{ id: 'f1', path: '~/git/dtc-website' }]);
    expect(tabs).toEqual([
      { kind: 'files', id: 'f1', label: 'Files', path: '~/git/dtc-website' },
    ]);
  });
});

describe('renamedSessionName', () => {
  const prefix = 'git-dtc-website';

  it('re-applies the prefix, so a rename cannot detach a session from its folder', () => {
    expect(renamedSessionName('staging', prefix, 'import', sanitisePart)).toBe(
      'git-dtc-website-staging',
    );
  });

  it('promotes a session to the folder default when the field is cleared', () => {
    expect(renamedSessionName('   ', prefix, 'import', sanitisePart)).toBe('git-dtc-website');
  });

  it('commits the raw name for a tab whose label IS the session name', () => {
    expect(renamedSessionName('release', prefix, null, sanitisePart)).toBe('release');
  });

  it('sanitises to the alphabet `tmuxctl <name>` can still join', () => {
    // `.` and `:` collapse to `_`, everything else illegal collapses to `-`.
    expect(renamedSessionName('my.branch', prefix, 'import', sanitisePart)).toBe(
      'git-dtc-website-my_branch',
    );
    expect(renamedSessionName('feat/x', prefix, 'import', sanitisePart)).toBe(
      'git-dtc-website-feat-x',
    );
  });

  it('refuses a name with nothing alphanumeric left, rather than inventing one', () => {
    expect(renamedSessionName(':::', '', null, sanitisePart)).toBeNull();
    expect(renamedSessionName('', '---', 'import', sanitisePart)).toBeNull();
  });
});

describe('the bar order the arrows walk', () => {
  const prefix = 'git-dtc-website';

  // A real bar, built the way the view builds it, pinned against DISPLAY
  // order: two session tabs, then two Files tabs. The `Ctrl+Tab` cycle that
  // first wanted this assertion is gone; the arrows clamp along the same
  // order, and a future change to buildWorkspaceTabs must keep ids aligned
  // with labels however they are produced.
  const bar = buildWorkspaceTabs(
    [
      { name: 'git-dtc-website', created: 100 },
      { name: 'git-dtc-website-2', created: 200 },
    ],
    prefix,
    [{ id: 'f1' }, { id: 'f2' }],
  );

  it('is built in the order it will be traversed', () => {
    expect(bar.map((t) => t.id)).toEqual(['git-dtc-website', 'git-dtc-website-2', 'f1', 'f2']);
    expect(bar.map((t) => t.label)).toEqual(['main', 'main 2', 'Files', 'Files 2']);
  });
});

/**
 * The MRU stack and what a close selects.
 *
 * The user asked for "closing a tab selects the previously active one, not the
 * first", with one condition attached that is really the whole design: the
 * stack must never be able to name a tab that is gone. A session tab's id IS
 * its tmux session name and `sessions create` derives that name from the
 * folder, so a resurrected entry would not point at nothing — it would point at
 * a DIFFERENT session wearing the dead one's name.
 */

/** A bar of four: three sessions then a Files tab, in display order. */
const closeBar = buildWorkspaceTabs(
  [
    { name: 'git-red-stamp', created: 100 },
    { name: 'git-red-stamp-import', created: 200 },
    { name: 'git-red-stamp-2', created: 300 },
  ],
  'git-red-stamp',
  [{ id: 'f1' }],
);
const [T1, T2, T3, F1] = closeBar.map((t) => t.id) as [string, string, string, string];

describe('pushMru', () => {
  it('puts the newest on top', () => {
    expect(pushMru(pushMru([], 'a'), 'b')).toEqual(['a', 'b']);
  });

  it('moves an existing entry rather than repeating it', () => {
    // Cycling between two tabs a dozen times must not build a stack a dozen
    // deep whose entries are all the same two tabs — popping the top would then
    // land on the tab that was just closed's neighbour by accident rather than
    // on the one before it.
    expect(pushMru(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
    expect(pushMru(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const before = ['a'];
    pushMru(before, 'b');
    expect(before).toEqual(['a']);
  });
});

describe('pruneTabIds', () => {
  it('drops entries the bar no longer has', () => {
    expect(pruneTabIds([T1, 'git-red-stamp-gone', F1], closeBar)).toEqual([T1, F1]);
  });

  it('keeps the order of what survives', () => {
    expect(pruneTabIds([F1, T3, T1], closeBar)).toEqual([F1, T3, T1]);
  });

  it('empties against an empty bar', () => {
    expect(pruneTabIds([T1, T2], [])).toEqual([]);
  });
});

describe('tabAfterClose', () => {
  it('leaves the selection alone when the closed tab is not the active one', () => {
    // Middle-clicking a background tab, or stopping a session from another
    // tab's context menu, is not a request to go anywhere.
    expect(tabAfterClose(closeBar, T3, T1, [T2, T1])).toBe(T1);
    expect(tabAfterClose(closeBar, F1, T2, [])).toBe(T2);
  });

  it('selects the previously active tab, not the first', () => {
    // THE REQUEST. The user was on T3 having come from T2; closing T3 goes
    // back to T2, not to T1.
    expect(tabAfterClose(closeBar, T3, T3, [T1, T2, T3])).toBe(T2);
  });

  it('walks down the stack past tabs that are no longer on the bar', () => {
    // Belt and braces against `pruneMru`: this function must not be able to
    // name a dead tab whatever it was handed.
    expect(tabAfterClose(closeBar, T3, T3, [T1, 'git-red-stamp-gone', T3])).toBe(T1);
  });

  it('never names the tab being closed, even when it is on top', () => {
    expect(tabAfterClose(closeBar, T2, T2, [T1, T2])).toBe(T1);
  });

  it('falls back to the tab on the RIGHT when the stack is empty', () => {
    // Right, so the selection INDEX stays put: closing tab 2 of 4 leaves you on
    // the tab that is now tab 2. That is what a browser and VS Code do, and it
    // is the direction Ctrl+Tab travels, so the two gestures agree about which
    // way the bar runs.
    expect(tabAfterClose(closeBar, T2, T2, [])).toBe(T3);
    expect(tabAfterClose(closeBar, T1, T1, [])).toBe(T2);
  });

  it('falls back to the left only when the closed tab was last', () => {
    // Not a second rule — the same rule finding nothing on the right.
    expect(tabAfterClose(closeBar, F1, F1, [])).toBe(T3);
  });

  it('crosses the session/files boundary in both directions', () => {
    // The bar is one ring of targets, so adjacency does not stop at the kind
    // change any more than the cycling chord does.
    expect(tabAfterClose(closeBar, T3, T3, [])).toBe(F1);
    expect(tabAfterClose(closeBar, F1, F1, [T3])).toBe(T3);
  });

  it('has nothing to select when the closed tab was the only one', () => {
    const one = buildWorkspaceTabs([{ name: 'git-red-stamp', created: 100 }], 'git-red-stamp');
    expect(tabAfterClose(one, 'git-red-stamp', 'git-red-stamp', [])).toBeNull();
  });

  it('answers with the first remaining tab for a tab the bar never had', () => {
    expect(tabAfterClose(closeBar, 'never-existed', 'never-existed', [])).toBe(T1);
  });

  it('treats a null active id as "the closing tab was active"', () => {
    // `activeTab` resolves null only on an empty bar, but the MRU path is the
    // honest answer for a caller that has not resolved a selection yet.
    expect(tabAfterClose(closeBar, T2, null, [T3])).toBe(T3);
  });
});

/**
 * Manual tab order.
 *
 * "I also want to be able to rearrange tabs like drag and drop them around",
 * against an earlier "the tabs are always ordered: first agent sessions, then
 * files". The resolution pinned here: the derived order is the DEFAULT, a
 * manual position wins once set, and the two GROUPS stay separate.
 *
 * The tab set changes underneath the order — sessions arrive on a refresh timer
 * and vanish when they are killed — so these cases are the point of the whole
 * design, not edge cases around it.
 */
describe('applyTabOrder', () => {
  it('leaves the derived order alone when nothing has been arranged', () => {
    expect(applyTabOrder(closeBar, []).map((t) => t.id)).toEqual([T1, T2, T3, F1]);
  });

  it('applies a stored order', () => {
    expect(applyTabOrder(closeBar, [T3, T1, T2, F1]).map((t) => t.id)).toEqual([T3, T1, T2, F1]);
  });

  it('puts a NEW tab at the end of its own group', () => {
    // A session created since the order was stored has no rank. It must not
    // land at the front, and it must not disturb the ranked tabs.
    const withNew = buildWorkspaceTabs(
      [
        { name: 'git-red-stamp', created: 100 },
        { name: 'git-red-stamp-import', created: 200 },
        { name: 'git-red-stamp-2', created: 300 },
        { name: 'git-red-stamp-fresh', created: 400 },
      ],
      'git-red-stamp',
      [{ id: 'f1' }, { id: 'f2' }],
    );
    expect(applyTabOrder(withNew, [T3, T1, T2, F1]).map((t) => t.id)).toEqual([
      T3,
      T1,
      T2,
      'git-red-stamp-fresh',
      F1,
      'f2',
    ]);
  });

  it('leaves no hole when a ranked tab is gone', () => {
    const gone = closeBar.filter((t) => t.id !== T1);
    expect(applyTabOrder(gone, [T3, T1, T2, F1]).map((t) => t.id)).toEqual([T3, T2, F1]);
  });

  it('is inert for ids that name no tab', () => {
    // A stale entry ranks nothing. It is pruned as well (pruneTabIds), but this
    // function must not depend on that having happened.
    expect(applyTabOrder(closeBar, ['who?', T2, 'nope']).map((t) => t.id)).toEqual([
      T2,
      T1,
      T3,
      F1,
    ]);
  });

  it('re-establishes the groups even if the stored order interleaves them', () => {
    // Hand-edited localStorage, or an order written by a build with a different
    // rule. The kinds are grouped after the sort rather than trusted through it.
    expect(applyTabOrder(closeBar, [F1, T2, T1, T3]).map((t) => t.id)).toEqual([T2, T1, T3, F1]);
  });

  it('keeps two unranked tabs in their derived relative order', () => {
    expect(applyTabOrder(closeBar, [T3]).map((t) => t.id)).toEqual([T3, T1, T2, F1]);
  });
});

describe('canDropTabAt', () => {
  it('accepts every gap inside the dragged tab’s own group', () => {
    for (const gap of [0, 1, 2, 3]) expect(canDropTabAt(closeBar, T1, gap)).toBe(true);
  });

  it('refuses a session tab dropped past the first Files tab', () => {
    // Gap 4 is after the Files tab. Refused VISIBLY by the caller — no drop
    // indicator — rather than accepted and snapped back.
    expect(canDropTabAt(closeBar, T1, 4)).toBe(false);
  });

  it('refuses a Files tab dropped among the sessions', () => {
    expect(canDropTabAt(closeBar, F1, 0)).toBe(false);
    expect(canDropTabAt(closeBar, F1, 2)).toBe(false);
    // Its own two gaps stay legal.
    expect(canDropTabAt(closeBar, F1, 3)).toBe(true);
    expect(canDropTabAt(closeBar, F1, 4)).toBe(true);
  });

  it('refuses a tab the bar does not have', () => {
    expect(canDropTabAt(closeBar, 'ghost', 0)).toBe(false);
  });
});

describe('reorderTabs', () => {
  it('returns the WHOLE bar, so every tab ends up ranked', () => {
    // A delta would leave every other tab unranked, and "unranked sorts last"
    // would then make one drag move everything.
    expect(reorderTabs(closeBar, T3, 0)).toEqual([T3, T1, T2, F1]);
  });

  it('accounts for the tab it removed when moving right', () => {
    // Gap 3 with the tab lifted from index 0 is array index 2 — the classic
    // off-by-one in every reorder.
    expect(reorderTabs(closeBar, T1, 3)).toEqual([T2, T3, T1, F1]);
  });

  it('clamps an overshoot to the group edge rather than refusing it', () => {
    // "Put this as far right as it goes" must land, or the last position in a
    // group would need a pixel-accurate drop.
    expect(reorderTabs(closeBar, T1, 99)).toEqual([T2, T3, T1, F1]);
    expect(reorderTabs(closeBar, F1, 0)).toBeNull(); // already at its group edge
  });

  it('is null for a no-op, so a cancelled drag persists nothing', () => {
    expect(reorderTabs(closeBar, T2, 1)).toBeNull();
    expect(reorderTabs(closeBar, T2, 2)).toBeNull();
  });

  it('is null for a tab the bar does not have', () => {
    expect(reorderTabs(closeBar, 'ghost', 1)).toBeNull();
  });
});

describe('nudgeTabOrder', () => {
  it('moves one place in each direction', () => {
    expect(nudgeTabOrder(closeBar, T2, -1)).toEqual([T2, T1, T3, F1]);
    expect(nudgeTabOrder(closeBar, T2, 1)).toEqual([T1, T3, T2, F1]);
  });

  it('stops at the edge of the group instead of jumping the boundary', () => {
    expect(nudgeTabOrder(closeBar, T1, -1)).toBeNull();
    expect(nudgeTabOrder(closeBar, T3, 1)).toBeNull();
    expect(nudgeTabOrder(closeBar, F1, -1)).toBeNull();
  });

  it('goes through the same clamp the drag does', () => {
    // Written on top of reorderTabs so there is one definition of the group
    // rule; this is the assertion that keeps it that way.
    expect(nudgeTabOrder(closeBar, T3, -1)).toEqual(reorderTabs(closeBar, T3, 1));
  });
});
