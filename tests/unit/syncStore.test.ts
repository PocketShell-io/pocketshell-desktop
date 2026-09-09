// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sync store's selection flow, against a scripted api: only ticked
 * hosts are pushed, pulled aliases auto-tick (so a sync never silently
 * drops another machine's hosts), a conflict re-base re-absorbs, and the
 * guard rails — wrong passphrase, nothing ticked — stop before any push.
 * The crypto and the API client have their own suites; this is the wiring
 * between the selection, the account and ~/.ssh/config.
 */

const syncApi = vi.hoisted(() => ({
  status: vi.fn(async () => ({ loggedIn: true, email: 'a@b.c', keychainAvailable: true })),
  login: vi.fn(),
  logout: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  applyHosts: vi.fn(async () => ({ added: [] })),
}));

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    sync: syncApi,
    ssh: {
      onState: vi.fn(() => () => {}),
      exec: vi.fn(),
      listConfigHosts: vi.fn(async () => []),
      close: vi.fn(async () => true),
      connect: vi.fn(),
    },
  },
}));

import { createPinia, setActivePinia } from 'pinia';
import { useConnectionStore } from '../../src/renderer/stores/connection';
import { useSettingsStore } from '../../src/renderer/stores/settings';
import { useSyncStore } from '../../src/renderer/stores/sync';
import { serializeSyncPayload } from '../../src/shared/syncMerge';
import type { HostEntry } from '../../src/shared/types';

function host(name: string, hostname = `${name}.example.com`): HostEntry {
  return {
    name,
    hostname,
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

function okPush(version: number): void {
  syncApi.push.mockResolvedValue({ kind: 'ok', version });
}

/** The payload JSON the [n]th push carried (the call's 2nd argument). */
function pushedPayload(n: number): { hosts: HostEntry[] } {
  const parsed: unknown = JSON.parse((syncApi.push.mock.calls[n] as unknown[])[1] as string);
  return parsed as { hosts: HostEntry[] };
}

/** The conflict base the [n]th push carried (the call's 4th argument). */
function pushedBase(n: number): unknown {
  return (syncApi.push.mock.calls[n] as unknown[])[3];
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  okPush(1);
  syncApi.pull.mockResolvedValue({ kind: 'absent' });
});

async function readyStore(local: HostEntry[]): Promise<ReturnType<typeof useSyncStore>> {
  const sync = useSyncStore();
  await sync.refreshStatus();
  sync.passphrase = 'pw';
  useConnectionStore().hosts = local;
  return sync;
}

describe('syncStore — the selection is the payload', () => {
  it('pushes ONLY the ticked hosts, on the pulled version', async () => {
    syncApi.pull.mockResolvedValue({
      kind: 'ok',
      version: 4,
      plaintext: serializeSyncPayload([host('a')]),
    });
    const sync = await readyStore([host('a'), host('b'), host('c')]);
    useSettingsStore().syncSelectedHosts = ['a', 'c'];

    await sync.syncNow();

    expect(syncApi.push).toHaveBeenCalledTimes(1);
    expect(pushedBase(0)).toBe(4);
    expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['a', 'c']);
    expect(sync.message?.kind).toBe('ok');
  });

  it('auto-ticks pulled aliases and syncs them via their account entry', async () => {
    // 'z' exists only in the account — another machine put it there.
    syncApi.pull.mockResolvedValue({
      kind: 'ok',
      version: 2,
      plaintext: serializeSyncPayload([host('z', 'z.other.machine')]),
    });
    const sync = await readyStore([host('a')]);
    useSettingsStore().syncSelectedHosts = ['a'];

    await sync.syncNow();

    // The account's alias joined the selection persistently…
    expect(useSettingsStore().syncSelectedHosts).toEqual(['a', 'z']);
    // …and its entry reached the push even though the config lacks it.
    const payload = pushedPayload(0);
    expect(payload.hosts.map((h) => h.name)).toEqual(['a', 'z']);
    expect(payload.hosts[1]!.hostname).toBe('z.other.machine');
  });

  it('does not push anything unticked even when the account holds it', async () => {
    syncApi.pull.mockResolvedValue({
      kind: 'ok',
      version: 7,
      plaintext: serializeSyncPayload([host('kept'), host('dropped')]),
    });
    const sync = await readyStore([host('kept'), host('dropped')]);
    // Both auto-tick from the pull, so untick one explicitly: the user's
    // untick after a pull is exactly the removal path.
    useSettingsStore().syncSelectedHosts = ['kept'];
    await sync.syncNow();
    expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['kept']);
    // And the untick survived the pull's absorb pass.
    expect(useSettingsStore().syncSelectedHosts).toEqual(['kept']);
  });

  it('re-bases on a 409, absorbing what the other device pushed', async () => {
    const sync = await readyStore([host('a')]);
    useSettingsStore().syncSelectedHosts = ['a'];
    syncApi.push
      .mockResolvedValueOnce({ kind: 'conflict', currentVersion: 9 })
      .mockResolvedValueOnce({ kind: 'ok', version: 10 });
    syncApi.pull
      .mockResolvedValueOnce({ kind: 'absent' }) // initial pull
      .mockResolvedValueOnce({
        kind: 'ok',
        version: 9,
        plaintext: serializeSyncPayload([host('q', 'q.laptop')]),
      });

    await sync.syncNow();

    expect(syncApi.push).toHaveBeenCalledTimes(2);
    // The retry is based on the version the re-pull returned…
    expect(pushedBase(1)).toBe(9);
    // …and carries the other device's host, auto-ticked, beside ours.
    expect(pushedPayload(1).hosts.map((h) => h.name)).toEqual(['a', 'q']);
  });

  it('refuses to sync with nothing ticked, before any push', async () => {
    const sync = await readyStore([host('a')]);
    useSettingsStore().syncSelectedHosts = [];

    await sync.syncNow();

    expect(syncApi.push).not.toHaveBeenCalled();
    expect(sync.message?.kind).toBe('error');
  });

  it('says so when the passphrase is wrong, and pushes nothing', async () => {
    syncApi.pull.mockRejectedValue(new Error('decryption failed — wrong passphrase or corrupted blob'));
    const sync = await readyStore([host('a')]);
    useSettingsStore().syncSelectedHosts = ['a'];

    await sync.syncNow();

    expect(syncApi.push).not.toHaveBeenCalled();
    expect(sync.message?.text).toContain('wrong passphrase');
  });

  it('setSelected keeps the list deduped and order stable', () => {
    const sync = useSyncStore();
    const settings = useSettingsStore();
    sync.setSelected('b', true);
    sync.setSelected('a', true);
    sync.setSelected('b', true);
    expect(settings.syncSelectedHosts).toEqual(['b', 'a']);
    sync.setSelected('b', false);
    expect(settings.syncSelectedHosts).toEqual(['a']);
  });
});
