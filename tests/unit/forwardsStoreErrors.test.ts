// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The forwards store's error channel.
 *
 * Half the actions used to catch and half did not. The ones that did not were
 * exactly the ones a TEMPLATE calls — the Auto-forward toggle, the panel's
 * mount-time init, a row's remove — so a rejected invoke escaped as an
 * unhandled rejection: the diag banner got paged, and the panel itself sat
 * there making it look like the click had done nothing. These tests pin that
 * every entry point lands its failure in the store's `error` slot, the same
 * one the per-row `run` helper has always used.
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

vi.mock('@ui/app/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(String(key)) }),
}));

const { useForwardsStore } = await import('@ui/app/stores/forwards');

beforeEach(() => {
  setActivePinia(createPinia());
  for (const mock of Object.values(calls)) mock.mockReset();
});

describe('forwards store — rejections land in the error slot', () => {
  it('init reports a failed mount-time restore instead of rejecting into the void', async () => {
    calls['forwards.isAutoEnabled'] = vi.fn().mockRejectedValue(new Error('engine gone'));
    const forwards = useForwardsStore();

    await forwards.init('conn-1', []);

    expect(forwards.error).toBe('engine gone');
  });

  it('toggleAuto leaves the flag on the old side and says why nothing happened', async () => {
    calls['forwards.isAutoEnabled'] = vi.fn().mockResolvedValue(false);
    calls['forwards.stopAuto'] = vi.fn().mockRejectedValue(new Error('refused'));
    const forwards = useForwardsStore();
    await forwards.init('conn-1', []);
    forwards.autoOn = true;

    await forwards.toggleAuto('conn-1', []);

    expect(forwards.autoOn).toBe(true);
    expect(forwards.error).toBe('refused');
  });

  it('addManual answers false so the add form stays up over the error', async () => {
    calls['forwards.addManual'] = vi.fn().mockRejectedValue(new Error('port taken'));
    const forwards = useForwardsStore();

    const ok = await forwards.addManual('conn-1', {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 8080,
      destHost: 'localhost',
      destPort: 80,
    });

    expect(ok).toBe(false);
    expect(forwards.error).toBe('port taken');
  });

  it('remove reports instead of vanishing', async () => {
    calls['forwards.remove'] = vi.fn().mockRejectedValue(new Error('no such forward'));
    const forwards = useForwardsStore();

    await forwards.remove('conn-1', 'L8080');

    expect(forwards.error).toBe('no such forward');
  });
});
