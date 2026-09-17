import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWarningsStore } from '../../src/renderer/stores/warnings';
import type { AplexerWarning } from '../../src/shared/aplexer';

const warningsApi = vi.fn<(connectionId: string) => Promise<AplexerWarning[]>>();
const ackWarningsApi = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    helper: {
      warnings: (connectionId: string) => warningsApi(connectionId),
      ackWarnings: (connectionId: string, target?: string) => ackWarningsApi(connectionId, target),
    },
  },
}));

function row(overrides: Partial<AplexerWarning> = {}): AplexerWarning {
  return {
    session: '0e0c1c64-3f58-4ae2-8f0e-6ff0cb1a16ea',
    workspace: '/home/alexey/git/aplexer',
    tag: 'review',
    engine: 'claude',
    kind: 'oom',
    detail: 'killed by the kernel OOM killer (exit 137).',
    created_at_ms: 1_787_738_302_000,
    ...overrides,
  };
}

/**
 * The crash warnings store: the strip's whole model. What matters here is
 * its total-ness — a failed read keeps the previous list (blanking the strip
 * on one bad round trip is how a crash stops being visible), a real ack
 * failure surfaces, and another client's ack is settled, not reported.
 */
describe('warningsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    warningsApi.mockReset();
    ackWarningsApi.mockReset();
  });

  it('replaces the list wholesale and keeps the old one when the read fails', async () => {
    const store = useWarningsStore();
    warningsApi.mockResolvedValueOnce([row()]);
    await store.refresh('c1');
    expect(store.warnings).toHaveLength(1);
    warningsApi.mockRejectedValueOnce(new Error('dropped'));
    await store.refresh('c1');
    expect(store.warnings).toHaveLength(1);
    warningsApi.mockResolvedValueOnce([]);
    await store.refresh('c1');
    expect(store.warnings).toEqual([]);
  });

  it('acks one by session UUID, then re-reads', async () => {
    const store = useWarningsStore();
    ackWarningsApi.mockResolvedValueOnce({ ok: true, notFound: false, error: null });
    warningsApi.mockResolvedValueOnce([]);
    await store.ack('c1', '0e0c1c64');
    expect(ackWarningsApi).toHaveBeenCalledWith('c1', '0e0c1c64');
    expect(store.warnings).toEqual([]);
    expect(store.ackError).toBeNull();
  });

  it("surfaces a real ack failure; another client's ack is not one", async () => {
    const store = useWarningsStore();
    ackWarningsApi.mockResolvedValueOnce({ ok: false, notFound: false, error: 'permission denied' });
    await store.ack('c1');
    expect(store.ackError).toBe('permission denied');
    ackWarningsApi.mockResolvedValueOnce({ ok: false, notFound: true, error: null });
    warningsApi.mockResolvedValueOnce([]);
    await store.ack('c1');
    expect(store.ackError).toBeNull();
    expect(store.warnings).toEqual([]);
  });
});
