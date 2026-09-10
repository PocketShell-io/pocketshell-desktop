// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';

/**
 * Moving from one folder workspace to another, in the one component instance
 * the router keeps for both.
 *
 * vue-router reuses FolderWorkspaceView when only the `:folder` param changes,
 * and the pane records used to dedupe and match on the BARE session name. So
 * navigating from a folder whose `main` had a mounted pane into a folder with
 * its own `main` — the ordinary case now, an aplexer tag being unique only
 * within its workspace and `main` being every workspace's default — found the
 * leftover record, reused it, and put the PREVIOUS workspace's terminal under
 * the new workspace's tab. The new workspace's pane was never mounted at all:
 * TerminalView re-points on a session-key change, and the key had not changed.
 *
 * These tests pin the fix: pane records carry the workspace-qualified identity,
 * a foreign identity can never answer for this workspace's tab, and the switch
 * prunes the folder just left. The route mutation is the real mechanism — the
 * same navigation a panel row click performs.
 *
 * The harness follows folderWorkspaceRename.test.ts; the per-test
 * `vi.resetModules()` re-import follows folderWorkspaceRestore.test.ts, because
 * the workspace's memory map is module-scoped and one test's tabs must not
 * leak into the next.
 */

/**
 * A REACTIVE route object, and navigation by property mutation. The component
 * captures the object `useRoute()` returns once at setup, so replacing a ref's
 * value would navigate nothing — the same object must change underneath the
 * component, the way vue-router's real route object does.
 */
const route = reactive({ params: { name: 'host', folder: '~/git/a' }, query: {} });

function navigate(folder: string): void {
  route.params.folder = folder;
}

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
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div class="stub-launch" />' },
};

/**
 * An aplexer row: `tag` is the session name and repeats across workspaces;
 * `workspace` is what makes the two rows' identities differ.
 */
function aplexerRow(workspace: string, created: number): unknown {
  return {
    name: 'main',
    created,
    activity: created,
    attached: false,
    path: `/home/me/git/${workspace.slice(6)}`,
    agentKind: null,
    backend: 'aplexer',
    workspace,
    tag: 'main',
    aplexerId: `apx-${workspace.slice(6)}`,
    aplexerPhase: 'running',
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** One cold window: fresh module (fresh memory map), the given rows live. */
async function openWorkspace(live: unknown[], folder: string): Promise<VueWrapper> {
  vi.resetModules();
  sessionsList.mockResolvedValue(live);
  const { useConnectionStore } = await import('../../src/renderer/stores/connection');
  const { useSessionsStore } = await import('../../src/renderer/stores/sessions');
  const { useProjectsStore } = await import('../../src/renderer/stores/projects');
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = live as never;
  navigate(folder);
  const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
    .default;
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

function terminalSlots(wrapper: VueWrapper): ReturnType<VueWrapper['findAll']> {
  return wrapper.findAll('.terminal-slot');
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  sessionsList.mockReset();
});

describe('moving between two workspaces whose sessions share a tag', () => {
  it('mounts the arrived-at workspace’s own pane — the old one never answers for it', async () => {
    const wrapper = await openWorkspace([aplexerRow('~/git/a', 1)], '~/git/a');
    // The first workspace's `main` is mounted, joined under its own identity.
    expect(terminalSlots(wrapper)).toHaveLength(1);
    expect(wrapper.find('.stub-terminal').attributes('session-key')).toBe('aplexer:~/git/a:main');

    // Click the second folder's row in the panel: same component, new `:folder`.
    navigate('~/git/b');
    await import('../../src/renderer/stores/sessions').then(({ useSessionsStore }) => {
      useSessionsStore().sessions = [aplexerRow('~/git/b', 2)] as never;
    });
    await flush();

    // One pane, and it is workspace B's: the old record did not dedupe the new
    // one away, and the foreign pane did not survive the switch.
    const slots = terminalSlots(wrapper);
    expect(slots).toHaveLength(1);
    expect(wrapper.find('.stub-terminal').attributes('session-key')).toBe('aplexer:~/git/b:main');
    expect(wrapper.find('.stub-terminal').attributes('session-name')).toBe('main');
    expect(slots[0]?.attributes('style') ?? '').not.toContain('none');
  });

  it('prunes the folder just left, even before the new folder’s rows have loaded', async () => {
    const wrapper = await openWorkspace([aplexerRow('~/git/a', 1)], '~/git/a');
    expect(terminalSlots(wrapper)).toHaveLength(1);

    // Arriving at a folder whose listing has not landed yet (a deep link, a
    // restore): the bar is empty, and a pane of the folder just left is not
    // this workspace's pane however same-named it looks.
    navigate('~/git/b');
    await flush();

    expect(terminalSlots(wrapper)).toHaveLength(0);

    // And when B's rows arrive, B gets its own pane under its own identity.
    await import('../../src/renderer/stores/sessions').then(({ useSessionsStore }) => {
      useSessionsStore().sessions = [aplexerRow('~/git/b', 2)] as never;
    });
    await flush();

    expect(terminalSlots(wrapper)).toHaveLength(1);
    expect(wrapper.find('.stub-terminal').attributes('session-key')).toBe('aplexer:~/git/b:main');
  });

  it('seeds a Files tab opened during the arrival window at THIS folder, not the one left', async () => {
    const wrapper = await openWorkspace([aplexerRow('~/git/a', 1)], '~/git/a');

    // Deep-link to B while the session store still holds only A's rows: the
    // summary lookup has no B row to find, and it used to fall back to the
    // host-wide list — A's `main`, lending A's path as the Files seed.
    navigate('~/git/b');
    await flush();

    await wrapper.find('button.tab.add').trigger('click');
    await flush(2);
    const item = wrapper.findAll('button').find((b) => b.text().trim() === 'New Files tab');
    if (!item) throw new Error(`no "New Files tab" item in: ${wrapper.text()}`);
    await item.trigger('click');
    await flush();

    const files = wrapper.find('.stub-files');
    expect(files.exists()).toBe(true);
    expect(files.attributes('start-path')).toBe('~/git/b');
  });
});
