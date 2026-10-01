// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { effect } from 'vue';
import { tabOrderFor, writeTabOrderFor } from '@ui/app/tabOrders';

/**
 * The manual tab order's one store (src/renderer of the app tree:
 * packages/ui/src/app/tabOrders.ts).
 *
 * What is worth pinning is the contract both of its readers lean on:
 *
 *  - the workspace writes the arrangement the drag produced, and the next
 *    window restores it (the same key `useWorkspaceMemory` has always keyed —
 *    `ps.tabOrder.<host alias>.<folder>`, spelled in the store's header);
 *  - the session panel's folder rows read the SAME entry reactively, so a
 *    drag lands in the tree without any relay — the property the feature was
 *    asked for ("the icons on the side panel are still in the old order");
 *  - a disk entry is validated rather than trusted (user-writable JSON), and
 *    an empty order removes its key rather than storing `[]`.
 *
 * Every test uses its OWN host/folder key: the store's caches are module
 * state that lives for the whole file, and the tests must not order each
 * other's answers.
 */

function keyFor(host: string, folder: string): string {
  return `ps.tabOrder.${host}.${folder}`;
}

beforeEach(() => {
  localStorage.clear();
});

describe('tabOrders', () => {
  it('writes through to the aliased key and reads the entry back', () => {
    writeTabOrderFor('write-host', '~/git/x', ['b', 'a']);
    expect(JSON.parse(localStorage.getItem(keyFor('write-host', '~/git/x')) ?? 'null')).toEqual([
      'b',
      'a',
    ]);
    expect(tabOrderFor('write-host', '~/git/x')).toEqual(['b', 'a']);
  });

  it('reads a ranking a previous window persisted, straight from the disk', () => {
    localStorage.setItem(keyFor('seed-host', '~/git/x'), JSON.stringify(['git-x-2', 'git-x']));
    expect(tabOrderFor('seed-host', '~/git/x')).toEqual(['git-x-2', 'git-x']);
  });

  it('validates a disk entry rather than trusting it', () => {
    localStorage.setItem(keyFor('corrupt-host', '~/git/x'), '{not json');
    expect(tabOrderFor('corrupt-host', '~/git/x')).toEqual([]);

    localStorage.setItem(keyFor('corrupt-host', '~/git/y'), JSON.stringify(['b', 7, { x: 1 }, 'a']));
    expect(tabOrderFor('corrupt-host', '~/git/y')).toEqual(['b', 'a']);
  });

  it('an empty write removes the key, and still answers [] from memory', () => {
    writeTabOrderFor('empty-host', '~/git/x', ['a']);
    writeTabOrderFor('empty-host', '~/git/x', []);
    expect(localStorage.getItem(keyFor('empty-host', '~/git/x'))).toBeNull();
    expect(tabOrderFor('empty-host', '~/git/x')).toEqual([]);
  });

  it('a write wins over what the disk had, and folders and hosts do not bleed', () => {
    localStorage.setItem(keyFor('keyed-host', '~/git/x'), JSON.stringify(['a']));
    writeTabOrderFor('keyed-host', '~/git/x', ['b', 'a']);
    writeTabOrderFor('keyed-host', '~/git/y', ['z']);
    writeTabOrderFor('other-host', '~/git/x', ['q']);

    expect(tabOrderFor('keyed-host', '~/git/x')).toEqual(['b', 'a']);
    expect(tabOrderFor('keyed-host', '~/git/y')).toEqual(['z']);
    expect(tabOrderFor('other-host', '~/git/x')).toEqual(['q']);
    expect(tabOrderFor('unrelated-host', '~/git/x')).toEqual([]);
  });

  it('a write re-renders the readers of that folder, and only those', () => {
    // The reactive half of the contract: the tree's rows read tabOrderFor in
    // their render, so a write must invalidate exactly the readers of the key
    // that was written — that is what carries a tab drag into the panel with
    // no relay between the two components.
    let xRuns = 0;
    let yRuns = 0;
    const stopX = effect(() => {
      tabOrderFor('reactive-host', '~/git/x');
      xRuns += 1;
    });
    const stopY = effect(() => {
      tabOrderFor('reactive-host', '~/git/y');
      yRuns += 1;
    });
    expect(xRuns).toBe(1);
    expect(yRuns).toBe(1);

    writeTabOrderFor('reactive-host', '~/git/x', ['b', 'a']);
    expect(xRuns).toBe(2);
    expect(yRuns).toBe(1);
    expect(tabOrderFor('reactive-host', '~/git/x')).toEqual(['b', 'a']);

    stopX();
    stopY();
  });
});
