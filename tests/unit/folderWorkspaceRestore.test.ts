// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import {
  readLastFolder,
  readWorkspaceMemory,
  workspaceMemoryKey,
} from '../../src/renderer/workspaceState';

/**
 * The workspace's tab state surviving a relaunch
 * (src/renderer/workspaceState.ts).
 *
 * Three properties, each mapped to the sentence the feature was asked for:
 *
 *  1. "close it and open again, it should show the same tabs" — a cold mount
 *     over a persisted record opens the same Files tabs, in the same manual
 *     arrangement, with the same tab in front (the `?tab=` query is absent on
 *     a relaunch, so the restored `activeTab` is what resolves);
 *  2. "if some sessions are no longer present, just remove them" — the bar is
 *     derived from the host's live list, so a session killed while the app was
 *     closed produces no tab; the stored ids pointing at it (MRU, manual
 *     order) are pruned rather than left to re-pin a recycled name;
 *  3. the picker's handoff — the last folder is remembered per host, which is
 *     what lets a relaunched app navigate into the workspace at all (pinned in
 *     HostPickerView.test.ts).
 *
 * Each `openColdWorkspace` call re-imports the view after `vi.resetModules()`:
 * the in-memory half of the state is a module-scoped `Map`, so a fresh import
 * is the only honest way to be a "next window". The stores are untouched by
 * that — Pinia keys them on the active pinia, which `beforeEach` replaces,
 * not on the module registry. Sessions arrive AFTER the workspace mounts in
 * every case, as they do on a real relaunch: the store starts empty and the
 * view's own mount refresh fills it.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[]) => sessionsList(...a),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.home': vi.fn().mockResolvedValue({ ok: true, home: '/home/me', error: null }),
  'preview.onStats': () => () => undefined,
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

const stubs = {
  TerminalView: { template: '<div class="stub-terminal" />', methods: { focus: () => undefined } },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div class="stub-overlay"><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div />' },
};

function session(name: string, created: number): unknown {
  return { name, created, activity: created, attached: false, path: '/home/me/git/x' };
}

/** One cold window: fresh module (fresh memory map), sessions arriving late. */
async function openColdWorkspace(live: string[]): Promise<VueWrapper> {
  vi.resetModules();
  sessionsList.mockResolvedValue(live.map((name) => session(name, live.indexOf(name) + 1)));
  const { useSessionsStore } = await import('../../src/renderer/stores/sessions');
  useSessionsStore().sessions = [];
  const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
    .default;
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

function activeLabel(wrapper: VueWrapper): string {
  return wrapper.find('nav.tabs button.active').text().trim();
}

async function openFilesTab(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.tab.add').trigger('click');
  const item = wrapper.findAll('.menu-item').find((b) => b.text() === 'New Files tab');
  if (!item) throw new Error('no "New Files tab" item on the + menu');
  await item.trigger('click');
  await flush();
}

async function clickTab(wrapper: VueWrapper, label: string): Promise<void> {
  const tab = wrapper.findAll('nav.tabs button').find((b) => b.text().includes(label));
  if (!tab) throw new Error(`no tab labelled ${label}`);
  await tab.trigger('click');
  await flush();
}

const KEY = workspaceMemoryKey('host', '~/git/x');
const ORDER_KEY = 'ps.tabOrder.host.~/git/x';
const FILES_ID = '~/git/x::files:9';

/** The record a previous window is assumed to have closed with. */
function seedWindow(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      filesTabs: [{ id: FILES_ID, path: '/home/me/git/x/docs' }],
      activeTab: 'git-x-2',
      mru: ['git-x', 'git-x-2'],
    }),
  );
  localStorage.setItem(ORDER_KEY, JSON.stringify(['git-x-2', 'git-x']));
}

beforeEach(async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  sessionsList.mockReset();
  const { useConnectionStore } = await import('../../src/renderer/stores/connection');
  const { useProjectsStore } = await import('../../src/renderer/stores/projects');
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
});

describe('a folder workspace across a relaunch', () => {
  it('opens with the tabs the last window closed with, same one in front', async () => {
    seedWindow();
    const wrapper = await openColdWorkspace(['git-x', 'git-x-2']);

    // The manual order survived (`git-x-2` had been dragged first), and so did
    // the Files tab and the selection: no `?tab=` on a cold route, so the
    // restored `activeTab` is what the bar resolves.
    expect(tabLabels(wrapper)).toEqual(['git-x-2', 'git-x', 'Files']);
    expect(activeLabel(wrapper)).toBe('git-x-2');
  });

  it('shows no tab for a session killed while the app was closed, and prunes its stored ids', async () => {
    seedWindow();
    // `git-x-2` died between the last window and this one.
    const wrapper = await openColdWorkspace(['git-x']);

    // No resurrection: the bar is derived from the host's live list, so the
    // dead session is simply not on it, and the selection falls back.
    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
    expect(activeLabel(wrapper)).toBe('git-x');

    // The stored ids pointing at the dead session go with it — out of the MRU
    // (which keeps the Files tab the bar does hold) and out of the manual
    // order — so a session re-created under the recycled name cannot inherit
    // the dead one's rank or place in the close stack.
    expect(readWorkspaceMemory(KEY)).toEqual({
      filesTabs: [{ id: FILES_ID, path: '/home/me/git/x/docs' }],
      activeTab: 'git-x-2',
      mru: [FILES_ID, 'git-x'],
    });
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]')).toEqual(['git-x']);
    // The stored SELECTION is a preference, not a tab: it is resolved against
    // the live bar on every read (the fallback above) rather than eagerly
    // nulled, because the create flow legitimately points it at a session half
    // a second before the list carrying it arrives. Pinned so that resolution
    // at read time stays the only mechanism.
    expect(readWorkspaceMemory(KEY)?.activeTab).toBe('git-x-2');
  });

  it('persists what this window does, and the next window restores it', async () => {
    const first = await openColdWorkspace(['git-x', 'git-x-2']);
    expect(tabLabels(first)).toEqual(['git-x', 'git-x-2']);

    await clickTab(first, 'git-x-2');
    await openFilesTab(first);
    // Leave Terminal 2 in front, the way the window actually closed.
    await clickTab(first, 'git-x-2');
    first.unmount();

    // What the first window left behind: the folder itself, for the picker's
    // handoff, and the tab state beside it.
    expect(readLastFolder('host')).toBe('~/git/x');
    const record = readWorkspaceMemory(KEY);
    expect(record?.activeTab).toBe('git-x-2');
    expect(record?.filesTabs).toHaveLength(1);
    expect(record?.filesTabs[0]?.path).toBe('/home/me/git/x');

    // A second cold mount — the relaunch. Same tabs, same one in front, Files
    // tab still standing (a Files tab is not a session; nothing can have
    // killed it while the app was shut).
    const second = await openColdWorkspace(['git-x', 'git-x-2']);
    expect(tabLabels(second)).toEqual(['git-x', 'git-x-2', 'Files']);
    expect(activeLabel(second)).toBe('git-x-2');
  });

  it('a first-ever visit on a fresh machine persists nothing worth restoring', async () => {
    const wrapper = await openColdWorkspace(['git-x']);
    expect(tabLabels(wrapper)).toEqual(['git-x']);
    expect(activeLabel(wrapper)).toBe('git-x');
    expect(readWorkspaceMemory(KEY)).toEqual({ filesTabs: [], activeTab: null, mru: ['git-x'] });
    expect(readLastFolder('host')).toBe('~/git/x');
  });
});
