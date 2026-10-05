// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The maintenance workspace — what "Host monitor" opens now: the hidden
 * `::maintenance::` root holding one bare pane running `htop` in `~`
 * (docs/MONITOR.md). The contracts pinned here are the ones the old sampled
 * panel used to own, in their new shape:
 *
 *  - the bar is the one tool tab — no Files tab, no `+`, no `×`;
 *  - the pane behind it is BARE: a `sessionKey`-keyed TerminalView with a
 *    command and NO session name, because reading the key as a session would
 *    ask main to join a session that does not exist;
 *  - the pane's lifetime is the workspace visit: navigating away retires it
 *    even when the host lists no sessions at all (the session-list guard that
 *    protects a loading bar must not become a place for htop to hide);
 *  - the hidden root never becomes the relaunch destination: `persist` may
 *    run as often as it likes here, `ps.lastFolder.<host>` stays unwritten.
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

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  // Deliberately EMPTY: the maintenance workspace must stand on its own
  // without a session list, and the prune edge below needs the guard's
  // exact weakness as the starting condition.
  useSessionsStore().sessions = [];
  route.params = { name: 'host', folder: '::maintenance::' };
});

describe('the maintenance workspace', () => {
  it('holds one tool tab and none of the folder chrome', async () => {
    const wrapper = await openWorkspace();

    expect(tabLabels(wrapper)).toEqual(['htop']);
    // No close control: the pane closes with the workspace, not with a `×`.
    expect(wrapper.find('nav.tabs button .tab-close').exists()).toBe(false);
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
    // Visible, not a mounted-but-hidden record: the identity the v-show reads
    // is the tool pane's.
    // A visible v-show pane carries no style attribute at all; only a hidden
    // one gets `display: none`.
    const style = terminal.attributes('style');
    expect(style === undefined || !style.includes('display: none')).toBe(true);
    expect(terminal.attributes('bare')).toBe('true');
    expect(terminal.attributes('command')).toBe('htop');
    expect(terminal.attributes('session-key')).toBe('tool:htop');
    expect(terminal.attributes('session-name')).toBeUndefined();
  });

  it('retires the pane when the user navigates away, with no session list to say so', async () => {
    const wrapper = await openWorkspace();
    expect(wrapper.find('.stub-terminal').exists()).toBe(true);

    route.params = { name: 'host', folder: '~/git/x' };
    await flush();

    expect(wrapper.find('.stub-terminal').exists()).toBe(false);
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
