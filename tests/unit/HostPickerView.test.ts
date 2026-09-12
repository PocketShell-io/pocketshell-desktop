// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { HostEntry } from '../../src/shared/types';
import { lastFolderKey } from '../../src/renderer/workspaceState';

/**
 * The picker's cancel affordance, tested for the promise its own header makes:
 * "CANCEL IS ALWAYS VISIBLE while dialling".
 *
 * That sentence used to be true only for the AUTO dial. A clicked row disabled
 * every row and showed nothing but the word "connecting…", and since
 * `SshService.connect` caps a dial at 30s, a typo'd Host or a sleeping box
 * locked the whole picker for half a minute with nothing to press. So the
 * properties pinned here are:
 *
 *   1. **A clicked dial shows the banner and its Cancel**, worded without the
 *      "(your default host)" tail that belongs to the auto case.
 *   2. **Cancel frees the picker instantly** — banner gone, rows re-enabled —
 *      and when the dial later lands anyway, the connection is HUNG UP rather
 *      than entered. A cancelled dial must never navigate.
 *   3. **The hang-up is guarded**: a cancelled dial landing late must not tear
 *      down a connection the user has started dialling since.
 *   4. **The auto dial lost nothing** — its wording and its cancel behave as
 *      they always did.
 *
 * The dial is a promise the tests resolve BY HAND, because every one of these
 * is a race: cancel against a connect that is still out.
 */

const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

const sshConnect = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sshClose = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const listConfigHosts = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const syncStatus = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const syncAccountHosts = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const openAccount = vi.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * The renderer api, as a Proxy — the same shape folderWorkspaceCreate.test.ts
 * uses and for the same reason: the stores this view constructs touch far more
 * channels than the three that carry the behaviour under test, and spelling
 * every one out would bury them. Anything not named answers
 * `Promise<undefined>`.
 */
const overrides: Record<string, unknown> = {
  'ssh.connect': (...a: unknown[]) => sshConnect(...a),
  'ssh.close': (...a: unknown[]) => sshClose(...a),
  'ssh.listConfigHosts': (...a: unknown[]) => listConfigHosts(...a),
  'sync.status': (...a: unknown[]) => syncStatus(...a),
  'sync.accountHosts': (...a: unknown[]) => syncAccountHosts(...a),
  'win.openAccount': (...a: unknown[]) => openAccount(...a),
};

function channel(group: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key: string) =>
        overrides[`${group}.${key}`] ?? ((): Promise<unknown> => Promise.resolve(undefined)),
    },
  );
}

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const HostPickerView = (await import('../../src/renderer/views/HostPickerView.vue')).default;
const { useSettingsStore } = await import('../../src/renderer/stores/settings');
const { resetAutoConnectLatch } = await import('../../src/renderer/autoConnect');

/** Terse HostEntry factory — only `name` matters to these tests. */
function host(name: string): HostEntry {
  return {
    name,
    hostname: `${name}.example`,
    port: 22,
    user: 'me',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

type ConnectResult = { ok: boolean; connectionId?: string; error?: string };

/**
 * Arm the NEXT `ssh.connect` call with a promise the test holds the resolver
 * to. Each call gets its own promise, so a test can have two dials out and
 * land them in either order.
 */
function pendingConnect(): { resolve: (r: ConnectResult) => void } {
  const out: { resolve: (r: ConnectResult) => void } = { resolve: () => {} };
  sshConnect.mockImplementationOnce(
    () =>
      new Promise((r) => {
        out.resolve = r;
      }),
  );
  return out;
}

/** Mount the picker over [hosts] and let the mounted host load settle. */
async function openPicker(hosts: HostEntry[]): Promise<VueWrapper> {
  listConfigHosts.mockResolvedValue(hosts);
  const wrapper = mount(HostPickerView, {
    // Neither renders until Settings is opened; stubbed so this file cannot
    // start failing when their internals move.
    global: { stubs: { OverlayPanel: true, SettingsView: true } },
  });
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  // The once-per-launch latch is module scope on purpose; a test file is one
  // long launch unless each test puts it back.
  resetAutoConnectLatch();
  sshClose.mockResolvedValue(undefined);
  syncStatus.mockResolvedValue({ loggedIn: false, email: null, keychainAvailable: true });
  syncAccountHosts.mockResolvedValue(null);
  openAccount.mockResolvedValue(undefined);
});

describe('HostPickerView — the header account action', () => {
  it('clearly invites signed-out users to sign in with Google', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    const account = wrapper.get('.account-action');

    expect(account.text()).toContain('Google');
    expect(account.text()).toContain('Sign in');
    expect(account.attributes('aria-label')).toBe('Open account and sync');

    await account.trigger('click');
    expect(openAccount).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('.header-actions > button').at(-1)?.element).toBe(account.element);
  });

  it('shows the signed-in account and opens the separate account window', async () => {
    syncStatus.mockResolvedValue({
      loggedIn: true,
      email: 'alexey@example.com',
      keychainAvailable: true,
    });
    const wrapper = await openPicker([host('hetzner')]);
    const account = wrapper.get('.account-action');

    expect(account.text()).toContain('Google');
    expect(account.text()).toContain('alexey@example.com');
    expect(account.attributes('aria-label')).toContain('Open account and sync');

    await account.trigger('click');
    expect(openAccount).toHaveBeenCalledTimes(1);
  });
});

describe('HostPickerView — cancel is always visible while dialling', () => {
  it('shows the banner, with Cancel, for a clicked dial — not only for auto-connect', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    expect(wrapper.find('.auto-banner').exists()).toBe(false);

    pendingConnect();
    await wrapper.get('.host-row').trigger('click');

    const banner = wrapper.get('.auto-banner');
    expect(banner.text()).toContain('Connecting to hetzner');
    // "(your default host)" is the auto dial's phrase. A click did this.
    expect(banner.text()).not.toContain('default host');
    expect(banner.get('button').text()).toBe('Cancel');
  });

  it('cancelling frees the picker at once, and a late success hangs up instead of navigating', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    const dial = pendingConnect();
    await wrapper.get('.host-row').trigger('click');
    expect(wrapper.get('.host-row').attributes('disabled')).toBeDefined();

    await wrapper.get('.auto-banner button').trigger('click');
    // The user's half is instant: banner gone, rows clickable again.
    expect(wrapper.find('.auto-banner').exists()).toBe(false);
    expect(wrapper.get('.host-row').attributes('disabled')).toBeUndefined();

    // The dial then lands anyway. Hung up, not entered.
    dial.resolve({ ok: true, connectionId: 'c1' });
    await flush(wrapper);
    expect(routerPush).not.toHaveBeenCalled();
    expect(sshClose).toHaveBeenCalledWith('c1');
  });

  it('a cancelled dial that then fails reports nothing — the user already left', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    const dial = pendingConnect();
    await wrapper.get('.host-row').trigger('click');
    await wrapper.get('.auto-banner button').trigger('click');

    dial.resolve({ ok: false, error: 'All configured authentication methods failed' });
    await flush(wrapper);
    expect(wrapper.find('.error').exists()).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('a cancelled dial landing late does not tear down a dial started since', async () => {
    const wrapper = await openPicker([host('alpha'), host('beta')]);
    const first = pendingConnect();
    await wrapper.findAll('.host-row')[0]!.trigger('click');
    await wrapper.get('.auto-banner button').trigger('click');

    // The user has already moved on to beta — which Cancel made possible.
    const second = pendingConnect();
    await wrapper.findAll('.host-row')[1]!.trigger('click');
    expect(wrapper.get('.auto-banner').text()).toContain('beta');

    // alpha's dial now lands. Its connection is not the one in hand any more,
    // so the hang-up must NOT fire: `connect()` claims `activeHost`
    // synchronously, and closing "the" connection here would close beta's.
    first.resolve({ ok: true, connectionId: 'c-alpha' });
    await flush(wrapper);
    expect(sshClose).not.toHaveBeenCalled();
    // beta's banner survived alpha's late resolution.
    expect(wrapper.get('.auto-banner').text()).toContain('beta');

    second.resolve({ ok: true, connectionId: 'c-beta' });
    await flush(wrapper);
    expect(routerPush).toHaveBeenCalledWith({ name: 'host-sessions', params: { name: 'beta' } });
  });

  it('an uncancelled clicked dial still enters the workspace', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    const dial = pendingConnect();
    await wrapper.get('.host-row').trigger('click');
    dial.resolve({ ok: true, connectionId: 'c1' });
    await flush(wrapper);
    expect(routerPush).toHaveBeenCalledWith({
      name: 'host-sessions',
      params: { name: 'hetzner' },
    });
    expect(sshClose).not.toHaveBeenCalled();
  });

  it('the auto dial keeps its wording, and its cancel still hangs up a late success', async () => {
    useSettingsStore().set('defaultHost', 'hetzner');
    // Armed before the mount: the auto dial starts from onMounted.
    const dial = pendingConnect();
    const wrapper = await openPicker([host('hetzner')]);

    const banner = wrapper.get('.auto-banner');
    expect(banner.text()).toContain('Connecting to hetzner');
    expect(banner.text()).toContain('(your default host)');

    await banner.get('button').trigger('click');
    dial.resolve({ ok: true, connectionId: 'c1' });
    await flush(wrapper);
    expect(routerPush).not.toHaveBeenCalled();
    expect(sshClose).toHaveBeenCalledWith('c1');
  });
});

describe('HostPickerView — a relaunch lands in the folder the host was last open on', () => {
  /**
   * The workspace's tab state persists across a relaunch
   *, and this handoff is the half that makes it
   * reachable: whatever else restores faithfully, a relaunch that stops at the
   * bare session list has not "shown the same tabs". Both entries into the
   * workspace go through `enterWorkspace` — the auto-connect below and the
   * clicked dial — so one assertion covers the pair; the memory of WHICH
   * folder belongs to the workspace's own `persist()`, pinned in
   * folderWorkspaceRestore.test.ts.
   */
  it('enters the remembered folder instead of the bare session list', async () => {
    localStorage.setItem(lastFolderKey('hetzner'), '~/git/dtc-website');
    const wrapper = await openPicker([host('hetzner')]);
    const dial = pendingConnect();
    await wrapper.get('.host-row').trigger('click');
    dial.resolve({ ok: true, connectionId: 'c1' });
    await flush(wrapper);

    expect(routerPush).toHaveBeenCalledWith({
      name: 'folder',
      params: { name: 'hetzner', folder: '~/git/dtc-website' },
    });
  });

  it('a host with no remembered folder keeps the session-list landing', async () => {
    // Another host's folder must not leak onto this one: the memory is per host.
    localStorage.setItem(lastFolderKey('other'), '~/git/x');
    const wrapper = await openPicker([host('hetzner')]);
    const dial = pendingConnect();
    await wrapper.get('.host-row').trigger('click');
    dial.resolve({ ok: true, connectionId: 'c1' });
    await flush(wrapper);

    expect(routerPush).toHaveBeenCalledWith({ name: 'host-sessions', params: { name: 'hetzner' } });
  });
});

describe('HostPickerView — reloads SSH config on demand', () => {
  it('shows loading feedback until the config read finishes', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    let resolveReload!: (hosts: HostEntry[]) => void;
    const pendingReload = new Promise<HostEntry[]>((resolve) => {
      resolveReload = resolve;
    });
    listConfigHosts.mockReturnValueOnce(pendingReload);

    const reloadButton = wrapper.get('[aria-label="Reload hosts"]');
    const reload = reloadButton.trigger('click');
    await wrapper.vm.$nextTick();

    expect(reloadButton.attributes('disabled')).toBeDefined();
    expect(reloadButton.attributes('aria-busy')).toBe('true');
    expect(reloadButton.get('.app-icon').classes()).toContain('spin');

    resolveReload([host('pocketshell-local')]);
    await reload;
    await flush(wrapper);

    expect(reloadButton.attributes('disabled')).toBeUndefined();
    expect(reloadButton.attributes('aria-busy')).not.toBe('true');
    expect(reloadButton.get('.app-icon').classes()).not.toContain('spin');
  });

  it('re-reads the host list without restarting or reconnecting', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    listConfigHosts.mockResolvedValue([host('hetzner'), host('pocketshell-local')]);

    await wrapper.get('[title="Reload hosts"]').trigger('click');
    await flush(wrapper);

    expect(listConfigHosts).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('.host-name').map((item) => item.text())).toEqual([
      'hetzner',
      'pocketshell-local',
    ]);
    expect(sshConnect).not.toHaveBeenCalled();
  });

  it('keeps the existing list and reports a config-read failure', async () => {
    const wrapper = await openPicker([host('hetzner')]);
    listConfigHosts.mockRejectedValue(new Error('permission denied'));

    await wrapper.get('[title="Reload hosts"]').trigger('click');
    await flush(wrapper);

    expect(wrapper.findAll('.host-name').map((item) => item.text())).toEqual(['hetzner']);
    expect(wrapper.get('.error').text()).toContain('Could not reload ~/.ssh/config: permission denied');
  });

  it('a mount-time config failure reports itself instead of reading as "no hosts"', async () => {
    // The same rejection used to abort `onMounted` before the auto-connect
    // decision ran, and the picker fell through to its "No hosts found" empty
    // state — a load failure dressed up as an empty config file.
    listConfigHosts.mockRejectedValue(new Error('permission denied'));
    const wrapper = mount(HostPickerView, {
      global: { stubs: { OverlayPanel: true, SettingsView: true } },
    });
    await flush(wrapper);

    expect(wrapper.get('.error').text()).toContain('Could not read ~/.ssh/config');
    expect(wrapper.text()).not.toContain('No hosts found');
    // The decision still ran (on an empty list): nothing was dialled.
    expect(sshConnect).not.toHaveBeenCalled();
  });
});

describe('HostPickerView — signed in: two host groups', () => {
  function signedIn(): void {
    syncStatus.mockResolvedValue({
      loggedIn: true,
      email: 'alexey@example.com',
      keychainAvailable: true,
    });
  }

  it('lists the account hosts as their own group, without duplicating what the config lists', async () => {
    signedIn();
    // hetzner is in BOTH sources: it is connectable from the config group
    // already, so the account group carries only what the config lacks.
    syncAccountHosts.mockResolvedValue([host('hetzner'), host('cloudbox')]);
    const wrapper = await openPicker([host('hetzner')]);

    expect(wrapper.findAll('.group-label').map((h) => h.text())).toEqual([
      'From your account',
      'From ~/.ssh/config',
    ]);
    expect(wrapper.findAll('.host-name').map((h) => h.text())).toEqual(['cloudbox', 'hetzner']);
  });

  it('dials an account host straight from its synced entry', async () => {
    signedIn();
    syncAccountHosts.mockResolvedValue([host('cloudbox')]);
    const wrapper = await openPicker([host('hetzner')]);
    const dial = pendingConnect();
    // The account group renders first, so the first row is its own.
    await wrapper.get('.host-list .host-row').trigger('click');
    dial.resolve({ ok: true, connectionId: 'c1' });
    await flush(wrapper);

    const payload = sshConnect.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual(
      expect.objectContaining({ host: 'cloudbox.example', user: 'me', port: 22 }),
    );
    expect(routerPush).toHaveBeenCalledWith({ name: 'host-sessions', params: { name: 'cloudbox' } });
  });

  it('an account-only row carries no default-host star', async () => {
    signedIn();
    syncAccountHosts.mockResolvedValue([host('cloudbox')]);
    const wrapper = await openPicker([host('hetzner')]);

    // A default host must survive a relaunch, and auto-connect reads
    // ~/.ssh/config — an account-only host is not in it yet.
    expect(wrapper.findAll('.star')).toHaveLength(1);
  });

  it('signed in but the account copy is still locked: says how to reveal it instead of reading as empty', async () => {
    signedIn();
    syncAccountHosts.mockResolvedValue(null);
    const wrapper = await openPicker([host('hetzner')]);

    expect(wrapper.get('.locked-note').text()).toContain('Account & sync');
    expect(wrapper.findAll('.group-label').map((h) => h.text())).toEqual(['From ~/.ssh/config']);
    expect(wrapper.findAll('.host-name').map((h) => h.text())).toEqual(['hetzner']);
  });

  it('signed out: one plain config list again — no labels, no note', async () => {
    const wrapper = await openPicker([host('hetzner')]);

    expect(wrapper.find('.group-label').exists()).toBe(false);
    expect(wrapper.find('.locked-note').exists()).toBe(false);
    expect(wrapper.findAll('.host-name').map((h) => h.text())).toEqual(['hetzner']);
  });
});
