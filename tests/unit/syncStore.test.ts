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
  accountHosts: vi.fn(async () => null),
  applyHosts: vi.fn(async () => ({ added: [] })),
}));

const apiMock = vi.hoisted(() => ({
  ssh: {
    onState: vi.fn(() => () => {}),
    exec: vi.fn(),
    listConfigHosts: vi.fn(async (): Promise<unknown[]> => []),
    close: vi.fn(async () => true),
    connect: vi.fn(),
  },
  win: { setTitle: vi.fn() },
}));

vi.mock('@ui/app/ipc', () => ({
  api: { sync: syncApi, ...apiMock },
}));

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useConnectionStore } from '@ui/app/stores/connection';
import { useSettingsStore } from '@ui/app/stores/settings';
import { useSyncStore } from '@ui/app/stores/sync';
import AccountView from '@ui/app/views/AccountView.vue';
import { serializeSyncPayload } from '@pocketshell/core';
import type { HostEntry } from '@pocketshell/core';

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
  apiMock.ssh.listConfigHosts.mockResolvedValue([]);
  syncApi.accountHosts.mockResolvedValue(null);
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
  it('loads the account hosts for the account window', async () => {
    syncApi.pull.mockResolvedValue({
      kind: 'ok',
      version: 6,
      plaintext: serializeSyncPayload([host('local'), host('remote', 'remote.example')]),
    });
    const sync = await readyStore([host('local')]);

    await sync.loadAccount();

    expect(sync.accountHosts?.map((entry) => entry.name)).toEqual(['local', 'remote']);
    expect(sync.message?.text).toContain('2 synced hosts');
  });

  it('does not contact the account when no passphrase was entered', async () => {
    const sync = await readyStore([host('a')]);
    sync.passphrase = '';
    useSettingsStore().syncSelectedHosts = ['a'];

    await sync.syncNow();

    expect(syncApi.pull).not.toHaveBeenCalled();
    expect(syncApi.push).not.toHaveBeenCalled();
    expect(sync.message?.text).toBe('Enter your sync passphrase.');
  });

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
    await sync.loadAccount();
    sync.setSelected('dropped', false);
    await sync.syncNow();
    expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['kept']);
    // And the untick survived the pull's absorb pass.
    expect(useSettingsStore().syncSelectedHosts).toEqual(['kept']);
  });

  // pocketshell#3072, the reported desktop scenario: a host that is both in
  // ~/.ssh/config and in the account showed "In account · remove on sync"
  // after a pull, and pressing Sync now without touching anything deleted it
  // from the account for every device.
  describe('an untouched Sync now never removes an account host (#3072)', () => {
    const account = [host('hetzner'), host('fixture', 'fixture.other.machine')];

    function accountPull(): void {
      syncApi.pull.mockResolvedValue({ kind: 'ok', version: 3, plaintext: serializeSyncPayload(account) });
    }

    it('keeps a host that is in both ~/.ssh/config and the account, after Check account', async () => {
      accountPull();
      const sync = await readyStore([host('hetzner'), host('other')]);
      useSettingsStore().syncSelectedHosts = ['other'];

      await sync.loadAccount();
      await sync.syncNow();

      expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['other', 'hetzner', 'fixture']);
      expect(sync.message?.kind).toBe('ok');
    });

    it('keeps it on a first Sync now that runs before any Check account', async () => {
      accountPull();
      const sync = await readyStore([host('hetzner'), host('other')]);
      useSettingsStore().syncSelectedHosts = ['other'];

      await sync.syncNow();

      expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['other', 'hetzner', 'fixture']);
    });

    it('still removes it after an explicit untick', async () => {
      accountPull();
      const sync = await readyStore([host('hetzner'), host('other')]);
      useSettingsStore().syncSelectedHosts = ['other'];
      await sync.loadAccount();

      sync.setSelected('hetzner', false);
      await sync.syncNow();

      expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['other', 'fixture']);
    });

    it('an untick is one-shot: after it removed the host, a re-add by another device is kept', async () => {
      accountPull();
      const sync = await readyStore([host('hetzner'), host('other')]);
      useSettingsStore().syncSelectedHosts = ['other'];
      await sync.loadAccount();
      sync.setSelected('hetzner', false);
      await sync.syncNow();
      expect(pushedPayload(0).hosts.map((h) => h.name)).toEqual(['other', 'fixture']);

      // Another device re-adds hetzner; this one just presses Sync now.
      syncApi.pull.mockResolvedValue({
        kind: 'ok',
        version: 5,
        plaintext: serializeSyncPayload([host('other'), host('fixture'), host('hetzner', 'hetzner.new')]),
      });
      await sync.syncNow();

      expect(pushedPayload(1).hosts.map((h) => h.name)).toEqual(['other', 'fixture', 'hetzner']);
    });

    it('the Account window shows "In account", ticked, not "remove on sync"', async () => {
      accountPull();
      syncApi.accountHosts.mockResolvedValue(null);
      apiMock.ssh.listConfigHosts.mockResolvedValue([host('hetzner'), host('other')]);
      useSettingsStore().syncSelectedHosts = ['other'];
      const wrapper = mount(AccountView);
      await flushPromises();
      useSyncStore().passphrase = 'pw';

      await wrapper.findAll('button').find((b) => b.text() === 'Check account')!.trigger('click');
      await flushPromises();

      expect(wrapper.text()).not.toContain('remove on sync');
      const row = wrapper.findAll('.account-host-row').find((li) => li.find('.host-alias').text() === 'hetzner')!;
      expect(row.get('.status-chip').text()).toBe('In account');
      expect((row.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(true);
      wrapper.unmount();
    });
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
