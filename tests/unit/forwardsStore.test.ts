// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The forwards store's happy paths, complementing forwardsStoreErrors.test.ts:
 * what `sync` puts in the panel's sources (engine annotations vs the raw-scan
 * fallback), the push subscription's per-connection filter, the restore-on-mount
 * behaviour of `init`, and the per-row `run` lifecycle (pending mark, re-read).
 */

const calls: Record<string, ReturnType<typeof vi.fn>> = {};
const subscribers: Record<string, ((payload: never) => void)[]> = {};

function channel(group: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key: string) => {
        const name = `${group}.${String(key)}`;
        if (String(key).startsWith('on')) {
          calls[name] ??= vi.fn((fn: (payload: never) => void) => {
            subscribers[name] ??= [];
            subscribers[name].push(fn);
            return () => {
              subscribers[name] = subscribers[name]!.filter((f) => f !== fn);
            };
          });
          return calls[name];
        }
        calls[name] ??= vi.fn().mockResolvedValue(undefined);
        return calls[name];
      },
    },
  );
}

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(String(key)) }),
}));

const { useForwardsStore } = await import('../../src/renderer/stores/forwards');

/** A discovered row as the annotated branch would deliver it. */
const ANNOTATED_PORT = {
  port: 3000,
  forwarded: true,
  localPort: 3000,
  intent: 'force-on',
  name: 'dev',
  eligible: true,
  lastError: null,
};

beforeEach(() => {
  setActivePinia(createPinia());
  // mockClear, not mockReset: the lazily-created on* mocks carry the
  // subscription implementation, and wiping it would silently unregister.
  for (const mock of Object.values(calls)) mock.mockClear();
  for (const key of Object.keys(subscribers)) delete subscribers[key];
  calls['forwards.list'] = vi.fn().mockResolvedValue([]);
  calls['forwards.discovered'] = vi.fn().mockResolvedValue([]);
  calls['forwards.status'] = vi.fn().mockResolvedValue(null);
  calls['forwards.isAutoEnabled'] = vi.fn().mockResolvedValue(false);
  calls['forwards.scan'] = vi.fn().mockResolvedValue([]);
  calls['serve.list'] = vi.fn().mockResolvedValue([]);
});

describe('forwards store — sync fills the panel sources', () => {
  it('marks engine output annotated when a forwarder is running', async () => {
    calls['forwards.discovered'] = vi.fn().mockResolvedValue([ANNOTATED_PORT]);
    calls['forwards.status'] = vi.fn().mockResolvedValue({ scanning: false, lastScanOk: true });
    const forwards = useForwardsStore();

    await forwards.sync('conn-1');

    expect(forwards.annotated).toBe(true);
    expect(forwards.discovered).toEqual([ANNOTATED_PORT]);
    expect(forwards.status).toMatchObject({ lastScanOk: true });
    expect(forwards.error).toBeNull();
  });

  it('falls back to a raw scan, unannotated, when no engine runs', async () => {
    calls['forwards.scan'] = vi.fn().mockResolvedValue([{ port: 5432 }]);
    const forwards = useForwardsStore();

    await forwards.sync('conn-1');

    expect(forwards.annotated).toBe(false);
    expect(forwards.discovered).toEqual([
      {
        port: 5432,
        forwarded: false,
        localPort: null,
        intent: null,
        name: null,
        eligible: false,
        lastError: null,
      },
    ]);
  });

  it('the engine push refreshes state and re-syncs, ignoring other connections', async () => {
    const forwards = useForwardsStore();
    forwards.subscribe('conn-1');

    const push = subscribers['forwards.onStates']![0]!;
    push({ connectionId: 'conn-OTHER', states: [{ key: 'x' }] } as never);
    expect(forwards.states).toEqual([]);
    expect(calls['forwards.list']).not.toHaveBeenCalled();

    push({ connectionId: 'conn-1', states: [{ key: 'L8080' }] } as never);
    await vi.waitFor(() => expect(calls['forwards.list']).toHaveBeenCalledWith('conn-1'));
    expect(forwards.states).toEqual([{ key: 'L8080' }]);
  });

  it('serve.onChanged updates the served folders for this connection only', () => {
    const forwards = useForwardsStore();
    forwards.subscribe('conn-1');

    const push = subscribers['serve.onChanged']![0]!;
    push({ connectionId: 'conn-2', served: [{ remotePort: 1 }] } as never);
    expect(forwards.served).toEqual([]);

    push({ connectionId: 'conn-1', served: [{ remotePort: 9 }] } as never);
    expect(forwards.served).toEqual([{ remotePort: 9 }]);
    expect(forwards.servedOn(9)).toEqual({ remotePort: 9 });
    expect(forwards.servedOn(10)).toBeNull();
  });
});

describe('forwards store — init, the toggle, and the Scan button', () => {
  it('init restarts a left-on engine with the ssh-config forwards', async () => {
    calls['forwards.isAutoEnabled'] = vi.fn().mockResolvedValue(true);
    const forwards = useForwardsStore();
    const configForwards = [{ kind: 'local', listenPort: 1, destPort: 2, destHost: 'h' } as never];

    await forwards.init('conn-1', configForwards);

    expect(calls['forwards.startAuto']).toHaveBeenCalledWith('conn-1', configForwards);
    expect(forwards.autoOn).toBe(true);
  });

  it('toggleAuto turns a running engine off', async () => {
    calls['forwards.isAutoEnabled'] = vi.fn().mockResolvedValue(false);
    const forwards = useForwardsStore();
    forwards.autoOn = true;

    await forwards.toggleAuto('conn-1', []);

    expect(calls['forwards.stopAuto']).toHaveBeenCalledWith('conn-1');
    expect(forwards.autoOn).toBe(false);
  });

  it('toggleAuto turns a stopped engine on', async () => {
    // sync re-reads the flag from main: the engine now really is on.
    calls['forwards.isAutoEnabled'] = vi.fn().mockResolvedValue(true);
    const forwards = useForwardsStore();
    forwards.autoOn = false;

    await forwards.toggleAuto('conn-1', []);

    expect(calls['forwards.startAuto']).toHaveBeenCalledWith('conn-1', []);
    expect(forwards.autoOn).toBe(true);
  });

  it('the Scan button runs a policy-applying refresh, not a plain scan', async () => {
    const forwards = useForwardsStore();

    await forwards.scan('conn-1');

    expect(calls['forwards.refresh']).toHaveBeenCalledWith('conn-1');
    expect(forwards.loading).toBe(false);
  });
});

describe('forwards store — per-row run lifecycle', () => {
  it('marks the row pending, applies, and re-reads quietly', async () => {
    const forwards = useForwardsStore();
    const listCalls = vi.mocked(calls['forwards.list']!);

    await forwards.setIntent('conn-1', 3000, 'force-on');

    expect(calls['forwards.setIntent']).toHaveBeenCalledWith('conn-1', 3000, 'force-on');
    expect(forwards.pending).toBeNull();
    expect(listCalls.mock.calls.length).toBeGreaterThan(0);
  });

  it('a failing row action clears pending and reports the error', async () => {
    const forwards = useForwardsStore();
    calls['forwards.setName'] = vi.fn().mockRejectedValue(new Error('read-only'));

    await forwards.rename('conn-1', 3000, 'api');

    expect(forwards.pending).toBeNull();
    expect(forwards.error).toBe('read-only');
  });

  it('remap and clearRemap ride the same run lifecycle', async () => {
    const forwards = useForwardsStore();

    await forwards.remap('conn-1', 3000, 3001);
    expect(calls['forwards.setRemap']).toHaveBeenCalledWith('conn-1', 3000, 3001);

    await forwards.clearRemap('conn-1', 3000);
    expect(calls['forwards.clearRemap']).toHaveBeenCalledWith('conn-1', 3000);

    expect(forwards.pending).toBeNull();
  });

  it('rename trims whitespace and sends null for a blank name', async () => {
    const forwards = useForwardsStore();

    await forwards.rename('conn-1', 3000, '  api  ');
    expect(calls['forwards.setName']).toHaveBeenCalledWith('conn-1', 3000, 'api');

    await forwards.rename('conn-1', 3000, '   ');
    expect(calls['forwards.setName']).toHaveBeenLastCalledWith('conn-1', 3000, null);
  });

  it('stopServe kills the server first and the tunnel after', async () => {
    const forwards = useForwardsStore();

    await forwards.stopServe('conn-1', 8123);

    expect(calls['serve.stop']).toHaveBeenCalledWith('conn-1', 8123);
    expect(calls['forwards.remove']).toBeUndefined();
  });
});

describe('forwards store — clear', () => {
  it('drops the panel view and detaches the subscriptions', async () => {
    calls['forwards.discovered'] = vi.fn().mockResolvedValue([ANNOTATED_PORT]);
    const forwards = useForwardsStore();
    forwards.subscribe('conn-1');
    await forwards.sync('conn-1');
    expect(subscribers['forwards.onStates']).toHaveLength(1);

    forwards.clear();
    forwards.clear(); // idempotent: unsub is already null

    expect(forwards.states).toEqual([]);
    expect(forwards.discovered).toEqual([]);
    expect(forwards.served).toEqual([]);
    expect(forwards.status).toBeNull();
    expect(forwards.autoOn).toBe(false);
    expect(forwards.error).toBeNull();

    // Re-subscribing after clear must not stack handlers.
    forwards.subscribe('conn-1');
    expect(subscribers['forwards.onStates']).toHaveLength(1);
    expect(subscribers['serve.onChanged']).toHaveLength(1);
  });
});
