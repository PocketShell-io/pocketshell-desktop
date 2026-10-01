// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, reactive, type PropType } from 'vue';

/**
 * The shared FolderWorkspaceView's `terminal.dock` slot (@ui/app/extensions):
 * a platform's dock renders under the active session pane, told which session
 * it serves and able to type into that pane. Nothing contributed renders
 * nothing — the desktop's own layout. Harness follows
 * folderWorkspaceSwitch.test.ts.
 */

const route = reactive({ params: { name: 'host', folder: '~/git/a' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route,
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
    { get: (_t, key: string) => overrides[`${group}.${key}`] ?? ((): Promise<unknown> => Promise.resolve(undefined)) },
  );
}

vi.mock('@ui/app/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const typed: string[] = [];
const stubs = {
  TerminalView: {
    template: '<div class="stub-terminal" />',
    methods: { focus: () => undefined, resyncDisplay: () => undefined, sendInput: (d: string) => typed.push(d) },
  },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div class="stub-launch" />' },
};

function row(): unknown {
  return {
    name: 'main',
    created: 1,
    activity: 1,
    attached: false,
    path: '/home/me/git/a',
    agentKind: null,
    backend: 'aplexer',
    workspace: '~/git/a',
    tag: 'main',
    aplexerId: 'apx-a',
    aplexerPhase: 'running',
  };
}

type Ctx = import('@ui/app/extensions').TerminalDockContext;
const Keys = defineComponent({
  props: { context: { type: Object as PropType<Ctx>, required: true } },
  setup: (props) => () =>
    h('button', { class: 'fast-key', onClick: () => props.context.sendInput('\x1b[A') }, props.context.sessionName),
});

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

let wrapper: VueWrapper | null = null;

/** A cold window; `withDock` contributes the dock into the fresh module's registry. */
async function openWorkspace(withDock = false): Promise<VueWrapper> {
  vi.resetModules();
  if (withDock) {
    const { provideExtensions } = await import('@ui/app/extensions');
    provideExtensions({ 'terminal.dock': [{ id: 'fast-keys', component: Keys }] });
  }
  sessionsList.mockResolvedValue([row()]);
  const { useConnectionStore } = await import('@ui/app/stores/connection');
  const { useSessionsStore } = await import('@ui/app/stores/sessions');
  const { useProjectsStore } = await import('@ui/app/stores/projects');
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [row()] as never;
  const FolderWorkspaceView = (await import('@ui/app/views/FolderWorkspaceView.vue')).default;
  wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  sessionsList.mockReset();
  typed.length = 0;
});

afterEach(async () => {
  wrapper?.unmount();
  wrapper = null;
  const { provideExtensions } = await import('@ui/app/extensions');
  provideExtensions({});
});

describe('FolderWorkspaceView terminal.dock slot', () => {
  it('renders nothing under the terminal when no dock is contributed', async () => {
    const w = await openWorkspace();
    expect(w.findAll('.terminal-slot')).toHaveLength(1);
    expect(w.find('.ps-extension-slot').exists()).toBe(false);
    // The pane is the only element child of the terminal area.
    expect(w.get('.terminal-area').element.children).toHaveLength(1);
  });

  it('renders a contributed dock under the active pane, typing into that pane', async () => {
    const w = await openWorkspace(true);
    const area = w.get('.terminal-area').element;
    const dock = w.get('[data-extension-slot="terminal.dock"]');
    // Under the pane: the dock follows the slot inside the (column) area.
    expect(area.lastElementChild).toBe(dock.element);
    expect(dock.get('.fast-key').text()).toBe('main');
    await dock.get('.fast-key').trigger('click');
    expect(typed).toEqual(['\x1b[A']);
  });
});
