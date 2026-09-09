// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { HostEntry } from '../../src/shared/types';

/**
 * The lost-link banner in the host workspace.
 *
 * The defect these tests pin down: the connection store has always LEARNED
 * about a dropped transport — its `ssh.onState` subscription flips `state` to
 * 'lost' and its own comment promises "the state flag is enough for the UI to
 * say the link is gone and offer reconnect" — but no view ever rendered any of
 * it. The terminal froze, the file browser listed nothing, and the only
 * user-visible trace was a raw IPC rejection leaking into the session panel's
 * error line. The banner is the missing UI, so the properties held here are:
 *
 *   1. **Silence while the link is up.** A connected host shows no strip at
 *      all — the banner must not become an always-on fixture.
 *   2. **The drop is announced, with the one recovery action attached.** State
 *      'lost' raises the strip, names the host, says the on-screen surfaces
 *      are frozen, and offers Reconnect.
 *   3. **Pressing Reconnect goes through the store**, whose `reconnect()`
 *      already knows the last host and key — the button adds no dialling logic
 *      of its own.
 *   4. **The in-flight state is visible and un-pressable.** A re-dial is
 *      seconds long on a real host; a button that stays pressable would stack
 *      dials.
 *   5. **Success wakes the session panel** by refreshing the sessions store
 *      against the NEW connectionId — the old one is dead on the main side,
 *      and the panel's last poll against it is what wrote the raw rejection.
 *   6. **Failure keeps the banner up**, shows the store's error, and re-arms
 *      the button. This is the case a `state === 'lost'` gate alone cannot
 *      express: a failed connect lands the store on 'idle'.
 *
 * The session panel and the host overlays are stubbed. What is under test is
 * the workspace's own strip and its wiring into the two stores; SessionTree's
 * behaviour has its own file.
 */

const sshConnect =
  vi.fn<(opts: unknown) => Promise<{ ok: boolean; connectionId?: string; error?: string }>>();
const sshClose = vi.fn<(id: string) => Promise<void>>();
const sessionsList = vi.fn<(id: string, sort: string) => Promise<never[]>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    ssh: {
      // Constructing the connection store subscribes to onState; the tests
      // drive the store's refs directly instead of replaying the event.
      onState: vi.fn(),
      listConfigHosts: vi.fn().mockResolvedValue([]),
      connect: (opts: unknown) => sshConnect(opts),
      close: (id: string) => sshClose(id),
    },
    helper: {
      sessionsList: (id: string, sort: string) => sessionsList(id, sort),
      // `connect` fires bootstrap in the background and nothing here awaits
      // it; a resolved null keeps that promise chain quiet.
      bootstrap: vi.fn().mockResolvedValue(null),
    },
    // The workspace projects the host identity into the OS title on mount.
    win: { setTitle: vi.fn() },
    // The connection store subscribes to this at setup (the sleep/wake probe);
    // the event itself is never fired here.
    app: { onResumed: vi.fn() },
    // The Ports button's auto-forward indicator asks this on mount; the
    // default here is the ordinary OFF, and the indicator has its own file.
    // The count pill has the view also read `list` and `onStates`.
    forwards: {
      isAutoEnabled: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      onStates: vi.fn().mockReturnValue(() => {}),
    },
  },
}));

const HostWorkspaceView = (await import('../../src/renderer/views/HostWorkspaceView.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');

/** The host the workspace believes it is connected to. */
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

/**
 * A memory-history router shaped like the app's (src/renderer/router.ts), with
 * empty components: the view reads `route.params` and pushes routes, and the
 * inner `<router-view/>` needs a matched child to render into, but none of the
 * real destinations are under test here.
 */
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
 * Mount the workspace on a host whose link is in `state`. The heavy children —
 * the session panel and the three overlay bodies — are stubbed: they each have
 * their own mount-time fetches, and none of them participates in the banner.
 */
async function open(state: 'connected' | 'lost'): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.activeHost = HOST;
  connection.connectionId = 'conn-1';
  connection.state = state;
  if (state === 'lost') connection.error = 'Connection lost';

  const router = makeRouter();
  await router.push('/host/hetzner');
  await router.isReady();

  const wrapper = mount(HostWorkspaceView, {
    global: {
      plugins: [router],
      stubs: {
        SessionTree: true,
        OverlayPanel: true,
        PortPanelView: true,
        SettingsView: true,
        UsageView: true,
      },
    },
  });
  await flush(wrapper);
  return wrapper;
}

/** Let pending microtasks (the store's promise chains) and the DOM settle. */
async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

function banner(wrapper: VueWrapper) {
  return wrapper.find('.link-lost');
}

function reconnectButton(wrapper: VueWrapper) {
  return wrapper.get('.reconnect-btn');
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  sshClose.mockResolvedValue(undefined);
  sessionsList.mockResolvedValue([]);
});

describe('HostWorkspaceView — the lost-link banner', () => {
  it('shows nothing while the link is up', async () => {
    const wrapper = await open('connected');
    expect(banner(wrapper).exists()).toBe(false);
  });

  it('raises the strip when the link drops, naming the host and offering Reconnect', async () => {
    const wrapper = await open('lost');
    const strip = banner(wrapper);
    expect(strip.exists()).toBe(true);
    // The sentence answers the question a frozen pane actually poses: the LINK
    // died, not the sessions, and what is on screen has stopped updating.
    expect(strip.text()).toContain('Connection to hetzner was lost');
    expect(strip.text()).toContain('frozen');
    const button = reconnectButton(wrapper);
    expect(button.text()).toBe('Reconnect');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('appears in reaction to a drop, not only when mounted into one', async () => {
    // The realistic order: the workspace is up and connected, THEN the store's
    // onState subscription flips to 'lost'. The banner must track the store
    // live, not sample it once.
    const wrapper = await open('connected');
    const connection = useConnectionStore();
    connection.state = 'lost';
    connection.error = 'Connection lost';
    await wrapper.vm.$nextTick();
    expect(banner(wrapper).exists()).toBe(true);
  });

  it('pressing Reconnect goes through the store, which re-dials the same host', async () => {
    const wrapper = await open('lost');
    const connection = useConnectionStore();
    const reconnect = vi.spyOn(connection, 'reconnect');
    sshConnect.mockResolvedValue({ ok: true, connectionId: 'conn-2' });

    await reconnectButton(wrapper).trigger('click');
    await flush(wrapper);

    expect(reconnect).toHaveBeenCalledTimes(1);
    // The store dialled with what it remembered — the button supplied nothing.
    expect(sshConnect).toHaveBeenCalledWith(
      expect.objectContaining({ host: HOST.hostname, port: HOST.port, user: HOST.user }),
    );
  });

  it('says Reconnecting… and disarms the button while the re-dial is out', async () => {
    const wrapper = await open('lost');
    // Left pending, so the assertions land mid-dial.
    sshConnect.mockReturnValue(new Promise(() => {}));

    await reconnectButton(wrapper).trigger('click');
    await flush(wrapper);

    const button = reconnectButton(wrapper);
    expect(button.text()).toBe('Reconnecting…');
    expect(button.attributes('disabled')).toBeDefined();
    // The strip itself must not vanish just because the state left 'lost' —
    // mid-dial, the surfaces behind it are still frozen.
    expect(banner(wrapper).exists()).toBe(true);
  });

  it('on success, drops the banner and refreshes the sessions store against the NEW id', async () => {
    const wrapper = await open('lost');
    sshConnect.mockResolvedValue({ ok: true, connectionId: 'conn-2' });

    await reconnectButton(wrapper).trigger('click');
    await flush(wrapper);

    expect(banner(wrapper).exists()).toBe(false);
    // 'conn-2', not 'conn-1': the panel's last poll against the dead id is
    // what left the raw "Unknown connection" rejection on screen, and this
    // refresh is what replaces it.
    expect(sessionsList).toHaveBeenCalledWith('conn-2', expect.anything());
  });

  it('on failure, keeps the banner up with the error and re-arms the button', async () => {
    const wrapper = await open('lost');
    sshConnect.mockResolvedValue({ ok: false, error: 'auth failed' });

    await reconnectButton(wrapper).trigger('click');
    await flush(wrapper);

    // A failed connect lands the store on state 'idle' — the same value a
    // fresh app has — so this holds only if the banner outlives the bare
    // `state === 'lost'` gate.
    const strip = banner(wrapper);
    expect(strip.exists()).toBe(true);
    expect(strip.text()).toContain('auth failed');
    const button = reconnectButton(wrapper);
    expect(button.text()).toBe('Reconnect');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(sessionsList).not.toHaveBeenCalled();
  });
});
