// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import type { HostEntry } from '../../src/shared/types';
import type { ForwardState } from '../../src/main/portfwd/Forwarder';
import type { DiscoveredPort } from '../../src/main/portfwd/AutoForwarder';

/**
 * The Ports panel's one-click open.
 *
 * The ask: "for port forwarding I want to open the port in the browser with
 * one click — like I do it with ssh-auto-forward or in the Android app". The
 * click is trivial (`window.open`, which main allow-lists into
 * `shell.openExternal`); what is worth pinning is WHERE the button appears and
 * where it must NOT, because a forwarded port is a URL only when a LOCAL
 * tunnel for it exists:
 *
 *   1. **A live local forward gets the button, at its own URL** — the tunnel's
 *      listen port, not the remote port (they differ whenever a pin or an
 *      allocation moved it).
 *   2. **A `-R` forward does not.** Its listener is on the HOST; a browser on
 *      this machine reaches nothing.
 *   3. **A discovered-but-not-forwarded port does not.** There is no tunnel;
 *      the button would open an error page and teach the user it lies.
 *   4. **A wide listen host still opens.** `0.0.0.0` in an address bar is not
 *      a URL anyone can reason about; the loopback is what the tunnel binds.
 */

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    // Present because constructing the connection store subscribes to it.
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
    // Everything the store's mount-time `init`/`sync` touches. The tests seed
    // the store's refs directly afterwards, so the answers can all be empty.
    forwards: {
      onStates: vi.fn(() => vi.fn()),
      list: vi.fn().mockResolvedValue([]),
      discovered: vi.fn().mockResolvedValue([]),
      status: vi.fn().mockResolvedValue(null),
      isAutoEnabled: vi.fn().mockResolvedValue(false),
      startAuto: vi.fn(),
      stopAuto: vi.fn(),
      refresh: vi.fn(),
      scan: vi.fn().mockResolvedValue([]),
      addManual: vi.fn().mockResolvedValue(true),
    },
  },
}));

const PortPanelView = (await import('../../src/renderer/views/PortPanelView.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useForwardsStore } = await import('../../src/renderer/stores/forwards');

/** A live local forward, 8080 here -> 3000 on the host, overridable. */
function fwd(over: Partial<ForwardState> = {}): ForwardState {
  return {
    key: 'local:8080->127.0.0.1:3000',
    kind: 'local',
    listenHost: '127.0.0.1',
    listenPort: 8080,
    destHost: '127.0.0.1',
    destPort: 3000,
    origin: 'auto',
    active: true,
    bytesIn: 0,
    bytesOut: 0,
    rateIn: 0,
    rateOut: 0,
    name: null,
    process: null,
    cwd: null,
    remapped: false,
    ...over,
  };
}

function disco(over: Partial<DiscoveredPort> = {}): DiscoveredPort {
  return {
    port: 3000,
    process: 'node',
    pid: 42,
    cwd: '/srv/app',
    forwarded: false,
    localPort: null,
    intent: null,
    name: null,
    eligible: true,
    lastError: null,
    ...over,
  };
}

async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

/** Mount the panel (store empty — the mount-time sync reads the mocks), then seed it. */
async function open(seed: { states?: ForwardState[]; disco?: DiscoveredPort[] } = {}): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  connection.activeHost = { name: 'hetzner' } as HostEntry;
  connection.state = 'connected';

  const wrapper = mount(PortPanelView);
  await flush(wrapper);

  const forwards = useForwardsStore();
  forwards.states = seed.states ?? [];
  forwards.discovered = seed.disco ?? [];
  await wrapper.vm.$nextTick();
  return wrapper;
}

/** The one-click open button, if the row has one. */
function openButton(wrapper: VueWrapper) {
  return wrapper.find('button[title^="Open http"]');
}

/** `window.open`, watched through a local mock — asserting on the method
 * itself trips the unbound-method rule, and the indirection costs nothing. */
const windowOpen = vi.fn();

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  window.open = windowOpen;
});

describe('PortPanelView — one-click open in the browser', () => {
  it('offers the open on a live local forward, at the tunnel’s own URL', async () => {
    // Listen 8080, remote 3000: the URL must name the LOCAL end — that is
    // what the browser on this machine can reach.
    const wrapper = await open({ states: [fwd()] });
    const button = openButton(wrapper);
    expect(button.exists()).toBe(true);
    expect(button.attributes('title')).toBe('Open http://127.0.0.1:8080/ in your browser');

    await button.trigger('click');
    expect(windowOpen).toHaveBeenCalledWith('http://127.0.0.1:8080/', '_blank', 'noopener,noreferrer');
  });

  it('passes a specific non-loopback listen host through verbatim', async () => {
    // An ssh-config forward may bind one interface on purpose; the URL then
    // names what the forward actually bound, not an assumption.
    const wrapper = await open({ states: [fwd({ listenHost: '192.168.1.10' })] });
    expect(openButton(wrapper).attributes('title')).toBe('Open http://192.168.1.10:8080/ in your browser');
  });

  it('opens the loopback when the forward bound every interface', async () => {
    // `0.0.0.0` in an address bar is noise; the loopback is included in
    // "every interface" and is what a reader can reason about.
    const wrapper = await open({ states: [fwd({ listenHost: '0.0.0.0' })] });
    expect(openButton(wrapper).attributes('title')).toBe('Open http://127.0.0.1:8080/ in your browser');
  });

  it('offers nothing on a -R forward, whose listener is on the host', async () => {
    const wrapper = await open({
      states: [fwd({ key: 'remote:6080->127.0.0.1:6080', kind: 'remote', listenPort: 6080, destPort: 6080 })],
    });
    expect(openButton(wrapper).exists()).toBe(false);
  });

  it('offers nothing on a port that is listening but not forwarded', async () => {
    // No tunnel, no URL — a button here would open the browser at an error
    // page and teach the user that this button lies.
    const wrapper = await open({ disco: [disco()] });
    expect(openButton(wrapper).exists()).toBe(false);
  });
});

/**
 * v-show's hidden state, read off the inline style. `isVisible()` cannot be
 * used here: jsdom's computed-style cache does not invalidate when Vue clears
 * a display:none by REMOVING the property (the detached tree never re-resolves
 * it), so a re-shown element would report invisible forever.
 */
function folded(wrapper: DOMWrapper<Element>): boolean {
  return (wrapper.attributes('style') ?? '').includes('none');
}

describe('PortPanelView — the panel is arranged live-first', () => {
  it('leads with the forwarded rows and folds the listening tail under a count', async () => {
    // One live forward (3000) and two bare listeners (22, 631): the forward
    // is shown, the listeners are folded, and the fold row says how many.
    const wrapper = await open({
      states: [fwd()],
      disco: [disco({ forwarded: true }), disco({ port: 22 }), disco({ port: 631 })],
    });

    const dataRows = wrapper.findAll('tbody tr:not(.more-row):not(.empty)');
    expect(dataRows.filter((r) => !folded(r)).length).toBe(1);
    const fold = wrapper.get('.more-btn');
    expect(fold.text()).toContain('2 not forwarded');

    // Expanding reveals the tail without changing the live rows.
    await fold.trigger('click');
    expect(fold.text()).toContain('2 not forwarded');
    expect(dataRows.filter((r) => !folded(r)).length).toBe(3);

    // Collapsing again folds it back.
    await fold.trigger('click');
    expect(dataRows.filter((r) => !folded(r)).length).toBe(1);
  });

  it('carries no Scan button and holds the add form behind its expander', async () => {
    // Scan moved to the overlay header (HostWorkspaceView's #actions, the
    // seat Usage's refresh occupies); the add form must not open by default.
    const wrapper = await open();
    expect(wrapper.find('.scan').exists()).toBe(false);
    expect(folded(wrapper.find('.add-form'))).toBe(true);

    await wrapper.get('.add-toggle').trigger('click');
    expect(folded(wrapper.find('.add-form'))).toBe(false);
  });

  it('folds the add form away once a forward is actually made', async () => {
    // A made forward appears in the live table, so the form's job is done.
    // A failed add (the action answers false) would leave it open.
    const wrapper = await open();
    await wrapper.get('.add-toggle').trigger('click');
    expect(folded(wrapper.find('.add-form'))).toBe(false);
    await wrapper.get('.add-btn').trigger('click');
    await flush(wrapper);
    expect(folded(wrapper.find('.add-form'))).toBe(true);
  });

  it('spares keyed rows the redundant remove and the local badge', async () => {
    // On a keyed row remove was the same verb as toggle-off (engine remove =
    // stop + force-off), so the toggle is the one mark — and `local` is the
    // table's whole furniture, a badge naming the default.
    const wrapper = await open({ states: [fwd()], disco: [disco({ forwarded: true })] });
    expect(wrapper.find('button[title="Remove forward"]').exists()).toBe(false);
    expect(wrapper.find('.kind.local').exists()).toBe(false);
    // The toggle itself stays, of course.
    expect(wrapper.find('.actions .icon-btn.on').exists()).toBe(true);
  });

  it('keeps remove — and the remote badge — on a -R row, whose toggle cannot act', async () => {
    // A `-R` forward has no remote port: the toggle is disabled, so remove is
    // not redundant there but the only action. Its badge is information, not
    // furniture, and stays.
    const wrapper = await open({
      states: [fwd({ key: 'remote:6080->127.0.0.1:6080', kind: 'remote', listenPort: 6080, destPort: 6080 })],
    });
    expect(wrapper.find('button[title="Remove forward"]').exists()).toBe(true);
    expect(wrapper.get('.kind.remote').text()).toBe('remote');
  });
});
