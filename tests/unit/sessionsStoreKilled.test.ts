// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { SessionSummary } from '../../src/shared/types';

/**
 * The kill ledger: a confirmed stop takes the row down NOW and keeps it down
 * against the listing.
 *
 * The bug this pins played out on a real host: right-click a folder row,
 * Stop, confirm — the kill landed (the pane's attach printed its goodbye and
 * exited), and yet the row stayed on the bar with its "[process exited]" pane
 * mounted underneath. The reason is a window the host owns: `a kill` answers
 * ok once the worker ACCEPTS the stop, and the record leaves the snapshot only
 * when the worker has finished terminating the workload — seconds later, and
 * past `a kill`'s own bounded wait, potentially on the next poll tick or never
 * for a wedged worker. A stop that trusted the follow-up listing showed a dead
 * session as live for as long as that window lasted.
 *
 * `removeLocal` is the fix's half that this file pins at store level: the row
 * leaves the list the moment the kill resolves, any pending create row for the
 * identity is withdrawn, every refresh drops fetched rows carrying the
 * identity inside the TTL — and the grave lifts, both on expiry (a row the
 * host genuinely still lists is a row to show) and on a fresh create reusing
 * the folder-derived name.
 */

const sessionsList = vi.fn<(...args: unknown[]) => Promise<SessionSummary[]>>();

function channel(group: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key: string) =>
        `${group}.${String(key)}` === 'helper.sessionsList'
          ? (...a: unknown[]) => sessionsList(...a)
          : (): Promise<undefined> => Promise.resolve(undefined),
    },
  );
}

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(String(key)) }),
}));

const { useSessionsStore } = await import('../../src/renderer/stores/sessions');

/** Terse row factory — only the fields the store and tree read. */
function row(name: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { name, created: 100, activity: 100, attached: false, path: null, ...extra };
}

function aplexerRow(name: string, workspace: string): SessionSummary {
  return row(name, {
    backend: 'aplexer',
    workspace,
    tag: name,
    aplexerId: `uuid-${name}`,
    aplexerPhase: 'running',
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionsList.mockReset();
  sessionsList.mockResolvedValue([]);
});

describe('sessions store — removeLocal takes the row down the moment the kill lands', () => {
  it('drops the killed row and nothing else, not even a same-named tag in another folder', () => {
    const store = useSessionsStore();
    store.sessions = [
      aplexerRow('git-x', '/home/me/git/x'),
      aplexerRow('git-x', '/home/me/git/y'),
      row('tmux-x'),
    ];

    store.removeLocal('git-x', '/home/me/git/x');

    expect(store.sessions.map((s) => s.workspace ?? s.name)).toEqual([
      '/home/me/git/y',
      'tmux-x',
    ]);
  });

  it('drops the row immediately, so the tree and the tab bar re-derive this tick', () => {
    // The tmux spelling: no workspace, matching only rows that have none —
    // the shape the tmux kill path passes.
    const store = useSessionsStore();
    store.sessions = [row('git-x')];

    store.removeLocal('git-x');

    expect(store.sessions).toEqual([]);
  });

  it('withdraws a pending create row for the killed identity', async () => {
    // A kill racing the create's optimism must not leave the optimistic row
    // sitting on the bar until its TTL runs out.
    const store = useSessionsStore();
    store.addPending(aplexerRow('git-x', '/home/me/git/x'));
    expect(store.sessions.map((s) => s.name)).toEqual(['git-x']);

    store.removeLocal('git-x', '/home/me/git/x');
    expect(store.sessions).toEqual([]);

    // The pending ledger, too: the next refresh must not resurrect the row
    // from it, whichever way the host now lists.
    sessionsList.mockResolvedValue([]);
    await store.refresh('conn-1');
    expect(store.sessions).toEqual([]);
  });
});

describe('sessions store — the kill ledger keeps the corpse off the bar', () => {
  it('keeps a listed-but-killed row hidden across refreshes inside the TTL', async () => {
    const store = useSessionsStore();
    store.removeLocal('git-x', '/home/me/git/x');

    // The listing the stop's follow-up (and every poll tick) reads can still
    // carry the record the worker has not finished deleting. It comes back
    // from the host every time; the ledger takes it out every time.
    sessionsList.mockResolvedValue([aplexerRow('git-x', '/home/me/git/x'), row('git-y')]);
    await store.refresh('conn-1');
    await store.refresh('conn-1');

    expect(store.sessions.map((s) => s.name)).toEqual(['git-y']);
  });

  it('brings a genuinely still-listed row back once the TTL lapses', async () => {
    // A worker wedged in finalization keeps its record in the snapshot, and
    // past the TTL that is a fact to show rather than to keep contradicting —
    // the same rule that prunes an unconfirmed pending row.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const store = useSessionsStore();
      store.removeLocal('git-x', '/home/me/git/x');

      sessionsList.mockResolvedValue([aplexerRow('git-x', '/home/me/git/x')]);
      vi.setSystemTime(1_000_000 + 31_000);
      await store.refresh('conn-1');

      expect(store.sessions.map((s) => s.name)).toEqual(['git-x']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lifts the grave when a new create reuses the name', async () => {
    // The folder-derived names make reuse likely, not hypothetical: a
    // stop-then-create in the same folder must not sit the fresh session
    // under the old one's tombstone.
    const store = useSessionsStore();
    store.removeLocal('git-x', '/home/me/git/x');

    store.addPending(aplexerRow('git-x', '/home/me/git/x'));
    sessionsList.mockResolvedValue([aplexerRow('git-x', '/home/me/git/x')]);
    await store.refresh('conn-1');

    expect(store.sessions.map((s) => s.name)).toEqual(['git-x']);
  });
});
