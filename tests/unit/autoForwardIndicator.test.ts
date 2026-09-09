// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { HostEntry } from '../../src/shared/types';

/**
 * The Ports button's auto-forward indicator.
 *
 * The ask: "if auto-forward is on I want to see an indicator in the panel with
 * icons". The button is easy; the state behind it is the whole test surface,
 * because the forwards store's `autoOn` — the flag the ports panel itself
 * renders — is only fresh while that panel is MOUNTED: PortPanelView
 * subscribes on entry and the store `clear()`s on unmount, which would leave
 * the header saying OFF almost all of the time. So the workspace asks the
 * engine directly, and what is pinned here is:
 *
 *   1. **On mount the engine is asked**, and a host that was left with
 *      auto-forward on shows the indicator without the ports panel ever having
 *      been opened (the relaunch case: the panel opens for nobody).
 *   2. **OFF leaves the glyph plain** — the indicator must not become another
 *      always-on fixture.
 *   3. **A reconnect re-asks**: the new connectionId may be a different host's
 *      answer, and the late answer for the dead link must not win.
 *   4. **A toggle inside the ports panel reaches the header live**, through
 *      the store mirror, without closing and reopening anything.
 *
 * The second half pins the live COUNT (the button's pill): it rides the
 * engine's own states broadcast, so it is right with the panel closed, empties
 * when the engine reports none, and a dead connection's push does not win.
 */

const sessionsList = vi.fn<(id: string, sort: string) => Promise<never[]>>();
const isAutoEnabled = vi.fn<(connectionId: string) => Promise<boolean>>();
const listForwards = vi.fn<(connectionId: string) => Promise<unknown[]>>();
/**
 * The engine's states push, captured so a test can fire it the way a scan
 * pass, an engine stop, or a dropped link would.
 */
const statesPush: {
  cb: null | ((p: { connectionId: string; states: unknown[] }) => void);
} = { cb: null };

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    ssh: {
      onState: vi.fn(),
      listConfigHosts: vi.fn().mockResolvedValue([]),
      connect: vi.fn(),
      close: vi.fn(),
    },
    helper: {
      sessionsList: (id: string, sort: string) => sessionsList(id, sort),
      bootstrap: vi.fn().mockResolvedValue(null),
    },
    projects: { home: vi.fn().mockResolvedValue({ ok: false }), onCloneProgress: vi.fn() },
    agent: { profiles: vi.fn().mockResolvedValue([]) },
    win: { setTitle: vi.fn() },
    forwards: {
      isAutoEnabled: (id: string) => isAutoEnabled(id),
      list: (id: string) => listForwards(id),
      onStates: (cb: (p: { connectionId: string; states: unknown[] }) => void) => {
        statesPush.cb = cb;
        return () => {
          statesPush.cb = null;
        };
      },
    },
  },
}));

const HostWorkspaceView = (await import('../../src/renderer/views/HostWorkspaceView.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useForwardsStore } = await import('../../src/renderer/stores/forwards');

const HOST: HostEntry = {
  name: 'hetzner',
  hostname: '135.181.114.209',
  port: 22,
  user: 'alexey',
  identityFile: null,
  proxyJump: null,
  forwardAgent: false,
  localForwards: [],
  remoteForwards: [],
  fromConfig: true,
};

function makeRouter(): Router {
  const Empty = { template: '<div />' };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'hosts', component: Empty },
      {
        path: '/host/:name',
        component: Empty,
        children: [
          { path: '', name: 'host-sessions', component: Empty },
          { path: 'folder/:folder', name: 'folder', component: Empty },
        ],
      },
    ],
  });
}

/**
 * Mount the workspace for real — SessionTree included, because the indicator
 * lives on the buttons it renders. Only the overlay BODIES are stubbed: the
 * ports panel has its own mount-time engine calls, and the mirror test below
 * drives the store the way that panel would rather than mounting it. `auto`
 * is the engine's answer to the mount-time query.
 */
async function open(auto = false): Promise<VueWrapper> {
  sessionsList.mockResolvedValue([]);
  isAutoEnabled.mockResolvedValue(auto);
  const connection = useConnectionStore();
  connection.activeHost = HOST;
  connection.connectionId = 'conn-1';
  connection.state = 'connected';

  const router = makeRouter();
  await router.push('/host/hetzner');
  await router.isReady();

  const wrapper = mount(HostWorkspaceView, {
    global: {
      plugins: [router],
      stubs: { OverlayPanel: true, PortPanelView: true, SettingsView: true, UsageView: true },
    },
  });
  await flush(wrapper);
  return wrapper;
}

/** Let the mount-time fetches and the indicator's own query settle. */
async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

function portsButton(wrapper: VueWrapper) {
  return wrapper.find('[title="Port forwarding"]');
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  listForwards.mockResolvedValue([]);
});

describe('the Ports button carries the auto-forward state', () => {
  it('asks the engine on mount and marks the button when the host was left ON', async () => {
    const wrapper = await open(true);

    // Asked about THIS connection, and asked without the ports panel ever
    // being opened — that is the case the store's own `autoOn` cannot serve.
    expect(isAutoEnabled).toHaveBeenCalledWith('conn-1');
    const marked = wrapper.find('[title="Port forwarding — auto-forward on"]');
    expect(marked.exists()).toBe(true);
    expect(marked.classes()).toContain('auto-on');
    expect(marked.find('.auto-dot').exists()).toBe(true);
  });

  it('leaves the glyph plain when the host is OFF', async () => {
    const wrapper = await open();
    expect(portsButton(wrapper).exists()).toBe(true);
    expect(wrapper.find('[title="Port forwarding — auto-forward on"]').exists()).toBe(false);
    expect(wrapper.find('.auto-dot').exists()).toBe(false);
  });

  it('re-asks on a reconnect, and the dead link’s late answer does not win', async () => {
    isAutoEnabled.mockResolvedValue(false);
    const wrapper = await open();

    // Reconnect: a new id, and the new host — same alias, fresh engine state —
    // answers ON. The first query's (false) resolution must not overwrite it.
    isAutoEnabled.mockResolvedValue(true);
    const connection = useConnectionStore();
    connection.connectionId = 'conn-2';
    await flush(wrapper);
    expect(isAutoEnabled).toHaveBeenCalledWith('conn-2');
    expect(wrapper.find('[title="Port forwarding — auto-forward on"]').exists()).toBe(true);
  });

  it('mirrors a toggle made inside the ports panel, live', async () => {
    const wrapper = await open();
    // Open the ports overlay (stubbed body — the panel's own behaviour is not
    // under test, only that the header hears about its flips), then flip the
    // store the way PortPanelView's toggle does.
    await portsButton(wrapper).trigger('click');
    const forwards = useForwardsStore();
    forwards.autoOn = true;
    await flush(wrapper);

    expect(wrapper.find('[title="Port forwarding — auto-forward on"]').exists()).toBe(true);
  });
});

describe('the Ports button carries the live forward count', () => {
  it('counts what the engine pushed, and the ring follows the lazy start', async () => {
    // Auto never persisted, but forwards appeared — a manual add or a forced
    // port started the engine outside the panel. The badge counts, and since
    // live forwards ARE the engine running, the ring lights with it.
    const wrapper = await open(false);
    statesPush.cb?.({ connectionId: 'conn-1', states: [{}, {}] });
    await flush(wrapper);

    const marked = wrapper.find('[title="Port forwarding — auto-forward on, 2 ports"]');
    expect(marked.exists()).toBe(true);
    expect(marked.classes()).toContain('auto-on');
    expect(marked.get('.auto-count').text().trim()).toBe('2');
    expect(marked.find('.auto-dot').exists()).toBe(false);
  });

  it('counts from the engine snapshot without waiting for a push', async () => {
    // The relaunch case for the count: the engine is already running from a
    // previous visit; the first push only arrives on the next scan beat.
    listForwards.mockResolvedValue([{}, {}, {}]);
    const wrapper = await open(true);

    expect(listForwards).toHaveBeenCalledWith('conn-1');
    const marked = wrapper.find('[title="Port forwarding — auto-forward on, 3 ports"]');
    expect(marked.exists()).toBe(true);
    expect(marked.get('.auto-count').text().trim()).toBe('3');
  });

  it('empties back to the dot when the engine reports nothing live', async () => {
    // stopAuto and a dropped link both push an empty array — the badge must
    // empty itself on the same beat, back to the plain on-register.
    const wrapper = await open(true);
    statesPush.cb?.({ connectionId: 'conn-1', states: [{}] });
    await flush(wrapper);
    expect(wrapper.find('.auto-count').exists()).toBe(true);

    statesPush.cb?.({ connectionId: 'conn-1', states: [] });
    await flush(wrapper);
    const marked = wrapper.find('[title="Port forwarding — auto-forward on"]');
    expect(marked.exists()).toBe(true);
    expect(marked.find('.auto-dot').exists()).toBe(true);
    expect(wrapper.find('.auto-count').exists()).toBe(false);
  });

  it('drops a dead connection’s push and counts the live one', async () => {
    const wrapper = await open(false);
    const connection = useConnectionStore();
    connection.connectionId = 'conn-2';
    await flush(wrapper);

    statesPush.cb?.({ connectionId: 'conn-1', states: [{}, {}] });
    await flush(wrapper);
    expect(wrapper.find('.auto-count').exists()).toBe(false);

    statesPush.cb?.({ connectionId: 'conn-2', states: [{}] });
    await flush(wrapper);
    expect(
      wrapper.find('[title="Port forwarding — auto-forward on, 1 port"]').exists(),
    ).toBe(true);
  });
});
