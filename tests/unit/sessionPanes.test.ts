import { describe, expect, it } from 'vitest';
import { prunePanes, upsertPane, type SessionPaneRecord } from '../../src/renderer/sessionPanes';

/**
 * The folder workspace's pane records, as pure rules (src/renderer/
 * sessionPanes.ts).
 *
 * The bug these pin: pane records used to dedupe and match on the BARE session
 * name, and under aplexer a tag repeats across workspaces — every workspace's
 * default session is `main`. The workspace view is one component instance
 * reused folder-to-folder, so navigating from a folder whose `main` had a
 * mounted pane into a folder with its own `main` found the leftover record and
 * reused it: the tab showed the PREVIOUS workspace's terminal, and the new
 * workspace's pane was never mounted. Every match now reads the
 * workspace-qualified identity, and these tests hold the two rules — upsert
 * and prune — to that.
 */

let seq = 0;
const mint = (): string => `pane-${++seq}`;

function pane(id: string, session: string, identity: string): SessionPaneRecord {
  return { id, session, identity };
}

describe('upsertPane mounts one pane per identity', () => {
  it('appends a record for an identity it has not seen, minting its id', () => {
    const next = upsertPane([], { session: 'main', identity: 'aplexer:~/git/a:main' }, mint);
    expect(next).toEqual([pane('pane-1', 'main', 'aplexer:~/git/a:main')]);
  });

  it('does not duplicate the identity on a second arrival — one PTY, one subscriber', () => {
    const first = upsertPane([], { session: 'main', identity: 'aplexer:~/git/a:main' }, mint);
    const second = upsertPane(first, { session: 'main', identity: 'aplexer:~/git/a:main' }, mint);
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  it('keeps same-named tags of DIFFERENT workspaces apart — the reported bug', () => {
    const inA = upsertPane([], { session: 'main', identity: 'aplexer:~/git/a:main' }, mint);
    const inB = upsertPane(inA, { session: 'main', identity: 'aplexer:~/git/b:main' }, mint);
    // The folder just left and the folder just arrived at are two panes; the
    // name-only dedupe merged them and mounted only the old one.
    expect(inB.map((p) => p.identity)).toEqual(['aplexer:~/git/a:main', 'aplexer:~/git/b:main']);
  });

  it('is append-only: earlier records and their ids are untouched', () => {
    const first = upsertPane([], { session: 'main', identity: 'aplexer:~/git/a:main' }, mint);
    const second = upsertPane(first, { session: 'dev', identity: 'aplexer:~/git/a:dev' }, mint);
    expect(second[0]).toBe(first[0]);
    expect(second).toHaveLength(2);
    expect(second[1]?.identity).toBe('aplexer:~/git/a:dev');
    // A fresh id for the new pane — ids are the v-for keys, never reused.
    expect(second[1]?.id).not.toBe(second[0]?.id);
  });
});

describe('prunePanes retires panes that are not on the bar', () => {
  it('drops a foreign identity — the previous workspace’s leftover', () => {
    const panes = [
      pane('pane-1', 'main', 'aplexer:~/git/a:main'),
      pane('pane-2', 'main', 'aplexer:~/git/b:main'),
    ];
    const kept = prunePanes(panes, new Set(['aplexer:~/git/b:main']));
    expect(kept.map((p) => p.identity)).toEqual(['aplexer:~/git/b:main']);
  });

  it('keeps a pane whose identity was rewritten by a rename', () => {
    // The record as the rename left it: `dev` became `main`, and the workspace
    // rewrote the record's identity in the same tick as the row — so by the
    // time the prune runs, the bar's live identity and the record's agree.
    const renamed = [pane('pane-1', 'main', 'aplexer:~/git/a:main')];
    const kept = prunePanes(renamed, new Set(['aplexer:~/git/a:main']));
    expect(kept).toHaveLength(1);
  });

  it('keeps the order of survivors and everything when all are live', () => {
    const panes = [
      pane('pane-1', 'main', 'aplexer:~/git/a:main'),
      pane('pane-2', 'dev', 'aplexer:~/git/a:dev'),
    ];
    const live = new Set(['aplexer:~/git/a:dev', 'aplexer:~/git/a:main', 'extra']);
    expect(prunePanes(panes, live)).toEqual(panes);
  });
});
