// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * The session tab wears the engine's mark beside its name.
 *
 * The mark itself is `agentMark`'s (src/shared/agentBadge.ts — the vendors'
 * own logos at the bar's muted grey), resolved per tab from the folder's own
 * row; what is pinned here is that a session row carrying an agent KIND
 * arrives at the bar as a visible mark, and a plain shell arrives as none.
 * The kind's SOURCES are pinned in the aplexer tests (the snapshot's live
 * `agent` field, the declared engine, `@ps_agent_kind` on the tmux path);
 * this file is the last hop, data to DOM.
 */

const route = reactive({ params: { name: 'host', folder: '~/git/x' }, query: {} });

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

/** A session row of the shape `helper.sessionsList` returns. */
function row(name: string, agentKind: string | null): Record<string, unknown> {
  return {
    name,
    created: 1,
    activity: 1,
    attached: false,
    path: '/home/me/git/x',
    agentKind,
  };
}

const stubs = {
  TerminalView: {
    // Both methods the workspace calls through the ref map (focusActiveTab);
    // missing either is a TypeError on the focus path, not a silent skip.
    setup: () => ({ focus: (): void => {}, resyncDisplay: (): void => {} }),
    template: '<div class="stub-terminal" />',
  },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const mounted: VueWrapper[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  sessionsList.mockReset();
  route.params = { name: 'host', folder: '~/git/x' };
  route.query = {};
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
});

describe('the workspace tab bar wears the engine mark', () => {
  it('marks the engine tab and leaves the shell tab bare', async () => {
    sessionsList.mockResolvedValue([row('git-codex', 'codex'), row('git-shell', 'shell')]);
    useSessionsStore().sessions = [row('git-codex', 'codex'), row('git-shell', 'shell')] as never;

    const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
    mounted.push(wrapper);
    await flush();

    const tabs = wrapper.findAll('nav.tabs button');
    // The mark's svg `<title>` joins `.text()`, so the engine tab reads
    // "Codex git-codex" and the bare shell tab reads alone — the contrast IS
    // the assertion.
    expect(tabs.map((b) => b.text().trim())).toEqual(['Codex git-codex', 'git-shell']);
    const mark = tabs[0]!.find('.tab-agent');
    expect(mark.exists()).toBe(true);
    // The mark's own svg `<title>` names the product — the mark is 12px and
    // that hover text is where a user learns which engine it is
    // (AppIcon.vue renders the prop as a `<title>` child).
    expect(mark.text()).toBe('Codex');
    expect(tabs[1]!.find('.tab-agent').exists()).toBe(false);
  });
});
