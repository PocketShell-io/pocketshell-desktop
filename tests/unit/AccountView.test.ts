// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import type { HostEntry } from '../../src/shared/types';
import { serializeSyncPayload } from '../../src/shared/syncMerge';

const syncApi = vi.hoisted(() => ({
  status: vi.fn(async () => ({ loggedIn: true, email: 'alexey@example.com', keychainAvailable: true })),
  login: vi.fn(async () => 'alexey@example.com'),
  logout: vi.fn(async () => undefined),
  pull: vi.fn(),
  push: vi.fn(async () => ({ kind: 'ok', version: 1 })),
  applyHosts: vi.fn(async () => ({ added: [] })),
}));

const listConfigHosts = vi.hoisted(() => vi.fn());

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    win: { setTitle: vi.fn() },
    sync: syncApi,
    ssh: {
      onState: vi.fn(() => () => {}),
      listConfigHosts,
      close: vi.fn(async () => true),
      connect: vi.fn(),
      exec: vi.fn(),
    },
  },
}));

import AccountView from '../../src/renderer/views/AccountView.vue';

function host(name: string, hostname = name + '.example'): HostEntry {
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  listConfigHosts.mockResolvedValue([host('local')]);
  syncApi.status.mockResolvedValue({
    loggedIn: true,
    email: 'alexey@example.com',
    keychainAvailable: true,
  });
  syncApi.pull.mockResolvedValue({
    kind: 'ok',
    version: 2,
    plaintext: serializeSyncPayload([host('local'), host('remote', 'other.example')]),
  });
});

describe('AccountView', () => {
  it('shows account membership separately from local selection', async () => {
    const wrapper = mount(AccountView);
    await flush();

    await wrapper.get('input[type="password"]').setValue('pw');
    await wrapper.get('.host-heading .btn-ghost').trigger('click');
    await flush();

    expect(wrapper.text()).toContain('In account');
    expect(wrapper.text()).toContain('In account · not on this machine');
    expect(wrapper.text()).toContain('local');
    expect(wrapper.text()).toContain('remote');
  });

  it('keeps sign out in the account window', async () => {
    const wrapper = mount(AccountView);
    await flush();

    await wrapper.get('.account-identity .btn-ghost').trigger('click');

    expect(syncApi.logout).toHaveBeenCalledTimes(1);
  });
});
