// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { HostEntry, SessionSummary } from '../../src/shared/types';

/**
 * `Ctrl+↑` / `Ctrl+↓` — the workspace above, the workspace below.
 *
 * The other half of the gesture `workspaceTabArrows.test.ts` holds: "up and
 * down - different workspaces", "left and right - tabs within workspace". The
 * two axes are the two lists on screen — the tab bar across the top, the folder
 * rows down the panel — so each arrow walks the thing that lies in its own
 * direction and nobody has to remember which is which.
 *
 * What is pinned here:
 *
 *   1. **It navigates**, by pushing the folder route the panel's own click
 *      pushes — the chord is a second door into `onSelectFolder`, not a second
 *      way of opening a workspace.
 *   2. **It walks the PANEL's order, flat across roots.** A root header is a
 *      label, not a stop: `Ctrl+↓` on the last folder of one root opens the
 *      first of the next.
 *   3. **It uses the panel's own KEYS.** This is the failure that would be
 *      hardest to see and worst to live with: `$HOME` decides whether a folder
 *      is keyed `~/git/foo` or `/home/me/git/foo`, and a chord navigating by a
 *      second derivation would open a workspace with no tabs and highlight no
 *      row. Both sides read `useFolderTree`, and the test asserts the pushed
 *      key against what the grouping produces.
 *   4. **It clamps** at both ends, like the tab arrows and unlike `Ctrl+Tab`.
 *   5. **Same standing-down rule as its horizontal twin** — a real text field
 *      keeps its arrows, the terminal is not a text field.
 *
 * The panel itself is stubbed: what is under test is the chord and the route it
 * pushes, and SessionTree's rendering has its own file.
 */

const sessionsList = vi.fn<(id: string, sort: string) => Promise<SessionSummary[]>>();
const projectsHome = vi.fn<() => Promise<{ ok: boolean; home?: string; error?: string }>>();

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
      usage: vi.fn().mockResolvedValue([]),
    },
    projects: { home: () => projectsHome(), onCloneProgress: vi.fn() },
    agent: { profiles: vi.fn().mockResolvedValue([]) },
    win: { setTitle: vi.fn() },
    // Asked once on mount by the Ports button's auto-forward indicator; the
    // count pill has the view also read `list` and `onStates`.
    forwards: {
      isAutoEnabled: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      onStates: vi.fn().mockReturnValue(() => {}),
    },
  },
}));

const HostWorkspaceView = (await import('../../src/renderer/views/HostWorkspaceView.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');

const HOME = '/home/alexey';

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

function session(name: string, path: string | null, activity = 100): SessionSummary {
  return { name, created: activity, activity, attached: false, path };
}

/**
 * Three folders under `git` and one under `tmp`, LISTED FIRST, so the walk has
 * an order to respect AND a root boundary to cross without stopping.
 *
 * In list order because the panel renders the host's order now
 * The chord reads `useFolderTree().folders`, which is
 * the panel's own list — that is the whole point of the shared derivation — so
 * a fixture written against any other order would silently be asserting that
 * the two disagree.
 */
const SESSIONS = [
  session('git-a', `${HOME}/git/a`, 100),
  session('git-b', `${HOME}/git/b`, 200),
  session('git-c', `${HOME}/git/c`, 300),
  session('tmp-d', `${HOME}/tmp/d`, 400),
];

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

let router: Router;

async function open(folder?: string): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.activeHost = HOST;
  connection.connectionId = 'conn-1';
  connection.state = 'connected';
  useSessionsStore().sessions = SESSIONS;

  router = makeRouter();
  await router.push(
    folder ? `/host/hetzner/folder/${encodeURIComponent(folder)}` : '/host/hetzner',
  );
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
    attachTo: document.body,
  });
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  await wrapper.vm.$nextTick();
}

async function press(
  wrapper: VueWrapper,
  key: string,
  mods: Partial<KeyboardEventInit> = {},
  target?: HTMLElement,
): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
    ...mods,
  });
  (target ?? (wrapper.element as HTMLElement)).dispatchEvent(e);
  await flush(wrapper);
  await router.isReady();
  return e;
}

/** The folder key the router is currently on, or null on the host route. */
function at(): string | null {
  return (router.currentRoute.value.params['folder'] as string | undefined) ?? null;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  sessionsList.mockResolvedValue(SESSIONS);
  projectsHome.mockResolvedValue({ ok: true, home: HOME });
});

describe('Ctrl+Up / Ctrl+Down step one workspace', () => {
  it('opens the row below, then the row above', async () => {
    const wrapper = await open('~/git/a');
    expect(at()).toBe('~/git/a');

    await press(wrapper, 'ArrowDown');
    expect(at()).toBe('~/git/b');

    await press(wrapper, 'ArrowUp');
    expect(at()).toBe('~/git/a');
    wrapper.unmount();
  });

  it('crosses a root boundary without stopping at the header', async () => {
    // `git` holds three folders and `tmp` holds one. The user is stepping down
    // the PANEL, and the root row between them is a label with nothing to open.
    const wrapper = await open('~/git/c');
    await press(wrapper, 'ArrowDown');
    expect(at()).toBe('~/tmp/d');
    wrapper.unmount();
  });

  it('navigates by the PANEL’s own key, home-relative and all', async () => {
    // The failure this rules out is invisible until it happens and miserable
    // then: `$HOME` decides whether the folder is keyed `~/git/b` or
    // `/home/alexey/git/b`, and a chord that spelled it the other way would
    // open a workspace with no tabs in it and highlight no row. Both sides read
    // one derivation (`folderTree.ts`); this asserts the spelling that reaches
    // the route.
    const wrapper = await open('~/git/a');
    await press(wrapper, 'ArrowDown');
    expect(at()).toBe('~/git/b');
    expect(at()).not.toContain('/home/alexey');
    wrapper.unmount();
  });

  it('STOPS at the top and at the bottom', async () => {
    const wrapper = await open('~/git/a');
    await press(wrapper, 'ArrowUp');
    expect(at()).toBe('~/git/a');
    wrapper.unmount();

    const bottom = await open('~/tmp/d');
    await press(bottom, 'ArrowDown');
    expect(at()).toBe('~/tmp/d');
    bottom.unmount();
  });

  it('opens the FIRST row when no folder is open yet', async () => {
    // The host route, before any navigation. Both directions mean the same
    // thing when there is no position to move from, and doing nothing would
    // make the chord look broken exactly when it is being reached for to get
    // started.
    const wrapper = await open();
    expect(at()).toBeNull();
    await press(wrapper, 'ArrowDown');
    expect(at()).toBe('~/git/a');
    wrapper.unmount();
  });

  it('cancels the keystroke so the pane never also sees it', async () => {
    const wrapper = await open('~/git/a');
    for (const key of ['ArrowUp', 'ArrowDown']) {
      const e = await press(wrapper, key);
      expect(e.defaultPrevented, key).toBe(true);
    }
    wrapper.unmount();
  });
});

describe('where the workspace chord stands down', () => {
  it('leaves a real text field alone', async () => {
    const wrapper = await open('~/git/a');
    const field = document.createElement('input');
    document.body.appendChild(field);

    const e = await press(wrapper, 'ArrowDown', {}, field);
    expect(e.defaultPrevented).toBe(false);
    expect(at()).toBe('~/git/a');

    field.remove();
    wrapper.unmount();
  });

  it('does NOT treat the terminal as a text field', async () => {
    // Same exception as the tab arrows, and it must stay in step: xterm's input
    // sink is a real `<textarea>`, so a plain editable test would exempt the
    // one surface these chords are for. Two axes of one gesture cannot behave
    // differently in the same place.
    const wrapper = await open('~/git/a');
    const pane = document.createElement('div');
    pane.className = 'xterm';
    const sink = document.createElement('textarea');
    sink.className = 'xterm-helper-textarea';
    pane.appendChild(sink);
    document.body.appendChild(pane);

    const e = await press(wrapper, 'ArrowDown', {}, sink);
    expect(e.defaultPrevented).toBe(true);
    expect(at()).toBe('~/git/b');

    pane.remove();
    wrapper.unmount();
  });

  it('ignores the shifted and AltGr spellings', async () => {
    const wrapper = await open('~/git/a');
    for (const mods of [{ shiftKey: true }, { altKey: true }]) {
      const e = await press(wrapper, 'ArrowDown', mods);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(at()).toBe('~/git/a');
    wrapper.unmount();
  });
});
