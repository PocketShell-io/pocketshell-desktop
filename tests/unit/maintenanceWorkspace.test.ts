// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The maintenance workspace — what "Host monitor" opens: the `::maintenance::`
 * root holding one tab per open tool, `htop` first of all (docs/MONITOR.md).
 * The contracts pinned here:
 *
 *  - the bar is the host's open tools — no Files tab, no `+`, and the tool's
 *    × reads Close, never Stop;
 *  - the pane behind it is BARE: a sessionKey-keyed TerminalView with a
 *    command and NO session name, because reading the key as a session would
 *    ask main to join a session that does not exist;
 *  - the pane outlives folder navigation on its own host — mounted but
 *    hidden, so coming back is the same htop; only closing the tool ends it;
 *  - closing the last tool while standing in the workspace is an exit: the
 *    route cannot answer an empty bar under a key that names no directory;
 *  - the hidden root never becomes the relaunch destination.
 */

// Reactive, because this file NAVIGATES: the view's computeds must see the
// params change the way vue-router's real route object delivers it.
const route = reactive<{
  params: { name: string; folder: string };
  query: Record<string, unknown>;
}>({
  params: { name: 'host', folder: '::maintenance::' },
  query: {},
});

const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
}));

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': vi.fn().mockResolvedValue([]),
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

vi.mock('@ui/app/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const FolderWorkspaceView = (await import('@ui/app/views/FolderWorkspaceView.vue')).default;
const { useConnectionStore } = await import('@ui/app/stores/connection');
const { useSessionsStore } = await import('@ui/app/stores/sessions');
const { useProjectsStore } = await import('@ui/app/stores/projects');
const { openMaintenanceTool, closeMaintenanceTool } = await import('@ui/app/maintenance');

const stubs = {
  // Attrs fall through to the root div, which is how the bare pane's props
  // are read back — the real TerminalView's join behaviour is pinned in
  // terminalBarePane.test.ts; this file pins what the workspace HANDS it.
  TerminalView: { template: '<div class="stub-terminal" />', methods: { focus: () => undefined } },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div class="stub-overlay"><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div />' },
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button:not(.add)').map((b) => b.text().trim());
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  // Deliberately EMPTY: the maintenance workspace must stand on its own
  // without a session list — the tool list is the only authority there.
  useSessionsStore().sessions = [];
  route.params = { name: 'host', folder: '::maintenance::' };
  route.query = {};
  routerPush.mockClear();
  // Every case here starts from the tool the Host monitor button opens.
  openMaintenanceTool('host');
  return () => closeMaintenanceTool('host', 'htop');
});

describe('the maintenance workspace', () => {
  it('holds one tab per open tool, with a Close × and none of the folder chrome', async () => {
    const wrapper = await openWorkspace();

    expect(tabLabels(wrapper)).toEqual(['htop']);
    expect(wrapper.find('nav.tabs button .tab-close').attributes('title')).toBe('Close this tool');
    // No `+`: neither item of that menu makes sense under a root that names
    // no directory.
    expect(wrapper.find('.tab.add').exists()).toBe(false);
    // No composer: there is no session to compose into.
    expect(wrapper.find('.stub-composer').exists()).toBe(false);
  });

  it('mounts the pane bare — a key, a command, and no session to join', async () => {
    const wrapper = await openWorkspace();

    const terminal = wrapper.find('.stub-terminal');
    expect(terminal.exists()).toBe(true);
    // A visible v-show pane carries no style attribute at all; only a hidden
    // one gets `display: none`.
    const style = terminal.attributes('style');
    expect(style === undefined || !style.includes('display: none')).toBe(true);
    expect(terminal.attributes('bare')).toBe('true');
    expect(terminal.attributes('command')).toBe('htop');
    expect(terminal.attributes('session-key')).toBe('tool:host:htop');
    expect(terminal.attributes('session-name')).toBeUndefined();
  });

  it('keeps the pane mounted-but-hidden when the user navigates away, on the same host', async () => {
    const wrapper = await openWorkspace();
    expect(wrapper.find('.stub-terminal').exists()).toBe(true);

    route.params = { name: 'host', folder: '~/git/x' };
    await flush();

    // The tool is still open, so the pane rides along — mounted, hidden, the
    // same htop the user will come back to. Coming off the host is what ends
    // it (the identity is host-scoped), not this navigation.
    expect(wrapper.find('.stub-terminal').exists()).toBe(true);
    const area = wrapper.find('.terminal-area');
    expect(area.attributes('style')).toContain('display: none');
  });

  it('closing the tool from its × ends the pane — and exits the empty workspace', async () => {
    const wrapper = await openWorkspace();
    expect(wrapper.find('.stub-terminal').exists()).toBe(true);

    await wrapper.get('nav.tabs button .tab-close').trigger('click');
    await flush();

    expect(tabLabels(wrapper)).toEqual([]);
    expect(wrapper.find('.stub-terminal').exists()).toBe(false);
    // The last close is an exit: nothing honest is left to draw under a
    // route that names no directory.
    expect(routerPush).toHaveBeenCalledWith({ name: 'host-sessions', params: { name: 'host' } });
  });

  it('never writes the last-folder pointer, so a relaunch cannot auto-open htop', async () => {
    await openWorkspace();
    // loadFolderState persists on every arrival; the guard must swallow the
    // write for this key.
    expect(localStorage.getItem('ps.lastFolder.host')).toBeNull();

    // The positive control: an ordinary folder persists exactly as before.
    route.params = { name: 'host', folder: '~/git/x' };
    await flush();
    expect(localStorage.getItem('ps.lastFolder.host')).toBe('~/git/x');
  });
});
