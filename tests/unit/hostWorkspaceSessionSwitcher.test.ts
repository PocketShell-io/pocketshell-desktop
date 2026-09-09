// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { SessionSummary } from '../../src/shared/types';

/**
 * The collapsed rail's session switcher.
 *
 * With the panel hidden, the tab bar covers only the OPEN folder's sessions;
 * before the switcher, every other workspace cost "show panel → click its row
 * → hide it again". The switcher is the panel's list folded into a menu, and
 * the properties guarded here are the ones that make that safe:
 *
 *   1. **It reads the SAME derivation the panel draws from** — one row per
 *      folder, root-grouped, in panel order — so it cannot show a workspace
 *      the panel would not, or spell a key the navigation would miss
 *      (folderTree.ts's argument; `Ctrl+↑`/`Ctrl+↓` already stand on it).
 *   2. **A click is a panel row click** — a different folder navigates, the
 *      open folder asks for the workspace focus and navigates nowhere.
 *   3. **The trigger toggles**, so the menu the button opened is a menu the
 *      button can close.
 *
 * SessionTree and PopupMenu are stubbed — the tree to reach the collapse
 * toggle without rendering the panel, the menu because the real one teleports
 * to `<body>` and would take its items out of every `wrapper.find` (the same
 * harness SessionTree.test.ts uses). Placement and dismissal are PopupMenu's
 * own; popupPlacement.test.ts holds those.
 */

const SessionTreeStub = { template: '<div class="stub-tree" />' };
const FakeWorkspace = { template: '<div class="fake-workspace" />' };
const SessionPlaceholder = { template: '<div class="fake-placeholder" />' };

const sessionsList = vi.fn<() => Promise<SessionSummary[]>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    ssh: {
      onState: vi.fn(),
      listConfigHosts: vi.fn().mockResolvedValue([]),
      connect: vi.fn(),
      close: vi.fn(),
    },
    helper: {
      sessionsList: () => sessionsList(),
      bootstrap: vi.fn().mockResolvedValue(null),
    },
    win: { setTitle: vi.fn() },
    app: { onResumed: vi.fn() },
    forwards: {
      isAutoEnabled: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      onStates: vi.fn().mockReturnValue(() => {}),
    },
  },
}));

const HostWorkspaceView = (await import('../../src/renderer/views/HostWorkspaceView.vue')).default;
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');
const {
  registerWorkspaceFocus,
  unregisterWorkspaceFocus,
} = await import('../../src/renderer/workspaceFocus');

/** Focus requests the host view made through the registration. */
const focusCalls: string[] = [];

/** Terse SessionSummary factory — only the fields grouping reads. */
function session(name: string, path: string, activity: number, attached = false): SessionSummary {
  return { name, created: activity, activity, attached, path };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** The router the current test mounted against; recreated per test. */
let router: Router;

/**
 * Mount at the `~/git/x` workspace with two folders on the host — `~/git/x`
 * holding two sessions (one attached), `~/git/y` holding one — with the panel
 * collapsed. The collapsed rail is the switcher's only home, so the collapse
 * emit from the SessionTree stub is part of the arrangement, not setup noise.
 */
async function mountCollapsed(): Promise<VueWrapper> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/host/:name',
        component: HostWorkspaceView,
        children: [
          { path: '', component: SessionPlaceholder },
          { path: 'folder/:folder', name: 'folder', component: FakeWorkspace },
        ],
      },
    ],
  });
  await router.push({ name: 'folder', params: { name: 'hetzner', folder: '~/git/x' } });
  await router.isReady();

  const wrapper = mount(HostWorkspaceView, {
    global: {
      plugins: [router],
      stubs: {
        SessionTree: SessionTreeStub,
        PopupMenu: {
          props: ['anchor', 'label', 'ignore'],
          template: '<div class="menu-stub" :aria-label="label"><slot /></div>',
        },
      },
    },
  });
  await flush();
  tree(wrapper).vm.$emit('collapse');
  await flush();
  return wrapper;
}

/** The mounted SessionTree stub, to emit `collapse` the way the hide button would. */
function tree(wrapper: VueWrapper): VueWrapper {
  // Annotated so the return is the wrapper type and not the `any`-shaped
  // result findComponent hands back for a stub.
  const stub: VueWrapper = wrapper.findComponent(SessionTreeStub);
  if (!stub.exists()) throw new Error('no SessionTree stub mounted');
  return stub;
}

/** The rail's switcher trigger, found by the word its tooltip carries. */
function switcherButton(wrapper: VueWrapper): DOMWrapper<Element> {
  const btn = wrapper.find('.collapsed-rail button[title="Sessions — 3"]');
  if (!btn.exists()) throw new Error('no switcher button on the collapsed rail');
  return btn;
}

beforeEach(() => {
  setActivePinia(createPinia());
  focusCalls.length = 0;
  sessionsList.mockResolvedValue([
    session('git-x-1', '/home/alexey/git/x', 500),
    session('git-x-2', '/home/alexey/git/x', 400),
    session('git-y-1', '/home/alexey/git/y', 300, true),
  ]);
  // Stock the store directly: the panel (stubbed) is what normally refreshes
  // on mount, and the switcher reads the same store the panel would have
  // filled — which is the property under test.
  void useSessionsStore().refresh('conn-1');
  // Stand in for the real FolderWorkspaceView's mount-time registration.
  registerWorkspaceFocus(() => focusCalls.push('focus'));
});

afterEach(() => {
  unregisterWorkspaceFocus(() => focusCalls.push('focus'));
});

describe('the collapsed rail session switcher', () => {
  it('opens a menu that mirrors the panel: root head, one item per folder, current marked', async () => {
    const wrapper = await mountCollapsed();

    await switcherButton(wrapper).trigger('click');

    const items = wrapper.findAll('.menu-stub .switch-item');
    // The count renders from 2 up (the panel's rule), so `x` shows its 2 and
    // `y`, holding one session, shows only its label.
    expect(items.map((i) => i.text())).toEqual(['x2', 'y']);
    // The root groups the two rows, spelled as the panel spells it.
    expect(wrapper.find('.menu-stub .switch-root').text()).toBe('~/git');
    // The open folder carries the current marks; the other does not.
    expect(items[0]!.classes()).toContain('current');
    expect(items[0]!.find('.current-check').exists()).toBe(true);
    expect(items[1]!.classes()).not.toContain('current');
    // The attached folder's dot is live, the quiet one's is not.
    expect(items[0]!.find('.dot.active').exists()).toBe(false);
    expect(items[1]!.find('.dot.active').exists()).toBe(true);
  });

  it('picking another folder navigates to its workspace and closes the menu', async () => {
    const wrapper = await mountCollapsed();
    await switcherButton(wrapper).trigger('click');

    await wrapper.findAll('.menu-stub .switch-item')[1]!.trigger('click');
    await flush();

    expect(router.currentRoute.value.params['folder']).toBe('~/git/y');
    // Arrival focus is the workspace's own job; this view navigated.
    expect(focusCalls).toEqual([]);
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
  });

  it('re-picking the open folder is the panel row re-click: focus, no navigation', async () => {
    const wrapper = await mountCollapsed();
    await switcherButton(wrapper).trigger('click');

    await wrapper.findAll('.menu-stub .switch-item')[0]!.trigger('click');
    await flush();

    expect(router.currentRoute.value.params['folder']).toBe('~/git/x');
    expect(router.currentRoute.value.query['tab']).toBeUndefined();
    expect(focusCalls).toEqual(['focus']);
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
  });

  it('the trigger toggles: a second click closes the menu', async () => {
    const wrapper = await mountCollapsed();
    const btn = switcherButton(wrapper);

    await btn.trigger('click');
    expect(wrapper.find('.menu-stub').exists()).toBe(true);

    await btn.trigger('click');
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
  });
});
