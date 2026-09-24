// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

/**
 * What a click on a panel FOLDER row does when that row is the folder already
 * on screen.
 *
 * Before the focus work, the row click was answered by `onSelectFolder`'s
 * early return: same folder, no session named, nothing to do. But the click
 * still means "take me to this workspace", and every OTHER way of arriving —
 * a different folder, a create hand-off, a tab click — lands the keyboard in
 * the pane in front. A re-click that left focus on the row button repeated
 * the exact defect the arrivals were fixed for. So the three shapes here:
 *
 *   1. **Re-click of the open row asks for the workspace focus** — no
 *      navigation, because there is nothing to navigate to. The ask goes
 *      through the `workspaceFocus` registration the mounted workspace made,
 *      stubbed here; that the real workspace answers it with a real terminal
 *      focus is pinned in folderWorkspaceCreate.test.ts.
 *   2. **The create hand-off still re-navigates** even on the open folder —
 *      the point of that navigation is to move to the new tab, and focusing
 *      is the workspace's own arrival job, not this view's.
 *   3. **A different folder still navigates**, and this view keeps its hands
 *      off focus: arrival focus belongs to the workspace that mounts.
 *
 * SessionTree is stubbed to a bare emitter and the routed children to stubs —
 * the panel's tree and the workspace's internals have their own files.
 */

const SessionTreeStub = { template: '<div class="stub-tree" />' };
const FakeWorkspace = { template: '<div class="fake-workspace" />' };
const SessionPlaceholder = { template: '<div class="fake-placeholder" />' };

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: {
      onState: vi.fn(),
      listConfigHosts: vi.fn().mockResolvedValue([]),
      connect: vi.fn(),
      close: vi.fn(),
    },
    helper: {
      sessionsList: vi.fn().mockResolvedValue([]),
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

const HostWorkspaceView = (await import('@ui/app/views/HostWorkspaceView.vue')).default;
const {
  registerWorkspaceFocus,
  unregisterWorkspaceFocus,
} = await import('@ui/app/workspaceFocus');

/** Focus requests the host view made through the registration. */
const focusCalls: string[] = [];

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** The router the current test mounted against; recreated per test. */
let router: Router;

/**
 * A router shaped like the app's (src/renderer/router.ts), with stub children.
 */
async function mountAtOpenFolder(): Promise<VueWrapper> {
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
      stubs: { SessionTree: SessionTreeStub },
    },
  });
  await flush();
  return wrapper;
}

/** The mounted SessionTree stub, to emit `select` the way a row click would. */
function tree(wrapper: VueWrapper): VueWrapper {
  // Annotated so the return is the wrapper type and not the `any`-shaped
  // result findComponent hands back for a stub.
  const stub: VueWrapper = wrapper.findComponent(SessionTreeStub);
  if (!stub.exists()) throw new Error('no SessionTree stub mounted');
  return stub;
}

/** A panel folder row's payload — only the key drives `onSelectFolder`. */
function dir(key: string): { key: string } {
  return { key };
}

beforeEach(() => {
  setActivePinia(createPinia());
  focusCalls.length = 0;
  // Stand in for the real FolderWorkspaceView's mount-time registration.
  registerWorkspaceFocus(() => focusCalls.push('focus'));
});

afterEach(() => {
  // The module slot is plain module state; a stale registration would leak
  // into the next test's assertions.
  unregisterWorkspaceFocus(() => focusCalls.push('focus'));
});

describe('a click on a panel folder row', () => {
  it('re-clicking the open row asks the workspace to focus, without navigating', async () => {
    const wrapper = await mountAtOpenFolder();
    expect(router.currentRoute.value.params['folder']).toBe('~/git/x');

    tree(wrapper).vm.$emit('select', dir('~/git/x'));
    await flush();

    expect(focusCalls).toEqual(['focus']);
    expect(router.currentRoute.value.params['folder']).toBe('~/git/x');
    expect(router.currentRoute.value.query['tab']).toBeUndefined();
  });

  it('the create hand-off re-navigates even on the open folder', async () => {
    const wrapper = await mountAtOpenFolder();

    tree(wrapper).vm.$emit('select', dir('~/git/x'), 'git-x-2');
    await flush();

    expect(router.currentRoute.value.query['tab']).toBe('git-x-2');
    // The workspace owns arrival focus (its ?tab= machinery); this view asked
    // for none, because it navigated instead.
    expect(focusCalls).toEqual([]);
  });

  it('a different folder navigates, and focus stays the workspace job', async () => {
    const wrapper = await mountAtOpenFolder();

    tree(wrapper).vm.$emit('select', dir('~/git/y'));
    await flush();

    expect(router.currentRoute.value.params['folder']).toBe('~/git/y');
    expect(focusCalls).toEqual([]);
  });
});
