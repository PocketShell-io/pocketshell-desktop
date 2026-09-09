import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The update banner's store, and the ports panel's per-row actions.
 *
 * Both were half-covered: the update store's three checker verdicts
 * (available / up-to-date / failed, plus the bridge-throw escape) and the
 * forwards store's per-row commands (rename/remap/intent/toggle) are the
 * paths a user's click actually takes, and the error routing tests only
 * pinned their rejections.
 */

const calls: Record<string, ReturnType<typeof vi.fn>> = {};

function channel(group: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key: string) => {
        const name = `${group}.${String(key)}`;
        calls[name] ??= vi.fn().mockResolvedValue(undefined);
        return calls[name];
      },
    },
  );
}

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(String(key)) }),
}));

const { useUpdateStore } = await import('../../src/renderer/stores/update');
const { useForwardsStore } = await import('../../src/renderer/stores/forwards');

const CHECKER = 'update.check';

beforeEach(() => {
  setActivePinia(createPinia());
  for (const mock of Object.values(calls)) mock.mockReset();
});

describe('update store — the three checker verdicts', () => {
  it('holds the download when a release is available', async () => {
    calls[CHECKER] = vi.fn().mockResolvedValue({
      status: 'available',
      currentVersion: '0.1.2',
      tagName: 'v0.1.3',
      downloadUrl: 'https://example/x.exe',
      notesUrl: 'https://example/notes',
    });
    const store = useUpdateStore();

    await store.check();

    expect(store.status).toBe('available');
    expect(store.tagName).toBe('v0.1.3');
    expect(store.downloadUrl).toContain('x.exe');
    expect(store.reason).toBeNull();
  });

  it('clears the banner fields when up to date', async () => {
    calls[CHECKER] = vi.fn().mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '0.1.3',
      tagName: null,
      downloadUrl: null,
      notesUrl: null,
    });
    const store = useUpdateStore();

    await store.check();

    expect(store.status).toBe('up-to-date');
    expect(store.tagName).toBeNull();
    expect(store.currentVersion).toBe('0.1.3');
  });

  it('keeps the failure reason readable instead of dangling in checking', async () => {
    calls[CHECKER] = vi.fn().mockResolvedValue({ status: 'failed', reason: 'rate limited' });
    const store = useUpdateStore();

    await store.check();

    expect(store.status).toBe('failed');
    expect(store.reason).toBe('rate limited');
  });

  it('a bridge-level throw lands in failed too, never stuck in checking', async () => {
    calls[CHECKER] = vi.fn().mockRejectedValue(new Error('channel closed'));
    const store = useUpdateStore();

    await store.check();

    expect(store.status).toBe('failed');
    expect(store.reason).toBe('channel closed');
  });
});

describe('forwards store — the per-row commands', () => {
  const CONN = 'conn-1' as never;

  it('rename trims and forwards, blank deletes', async () => {
    calls['forwards.setName'] = vi.fn().mockResolvedValue(undefined);
    const forwards = useForwardsStore();

    await forwards.rename(CONN, 8080, '  grafana  ');
    expect(calls['forwards.setName']).toHaveBeenCalledWith(CONN, 8080, 'grafana');

    await forwards.rename(CONN, 8080, '   ');
    expect(calls['forwards.setName']).toHaveBeenLastCalledWith(CONN, 8080, null);
  });

  it('setIntent forwards the intent verbatim, null clears it', async () => {
    calls['forwards.setIntent'] = vi.fn().mockResolvedValue(undefined);
    const forwards = useForwardsStore();

    await forwards.setIntent(CONN, 3000, 'force-off');
    expect(calls['forwards.setIntent']).toHaveBeenCalledWith(CONN, 3000, 'force-off');

    await forwards.setIntent(CONN, 3000, null);
    expect(calls['forwards.setIntent']).toHaveBeenLastCalledWith(CONN, 3000, null);
  });

  it('togglePort flips the row through the engine', async () => {
    calls['forwards.togglePort'] = vi.fn().mockResolvedValue(undefined);
    const forwards = useForwardsStore();

    await forwards.togglePort(CONN, 5173);
    expect(calls['forwards.togglePort']).toHaveBeenCalledWith(CONN, 5173);
  });
});
