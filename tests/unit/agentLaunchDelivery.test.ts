// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';

/**
 * The launch line is delivered only when main actually took the write.
 *
 * The launch watcher used to treat "the registry answered with an id" as
 * "delivered": it consumed the pending launch and fired the line
 * fire-and-forget. An id that is dead by the time the write lands — a shell
 * that exited between the lookup and the write, a registry entry pointing at a
 * corpse — made main drop the bytes, the launch count as delivered, and the
 * session come up as a plain shell with no message and no retry. Now a failed
 * write leaves the launch armed: the next registration re-points the watcher,
 * the line goes to the live channel, and the 12-second deadline stays the
 * backstop for a session whose PTY never comes up at all.
 *
 * The harness follows folderWorkspaceSwitch.test.ts: a reactive route, the api
 * proxy with per-channel overrides, one aplexer row, and a hand-seeded shells
 * registry (TerminalView is stubbed, so the registry holds only what the test
 * registers).
 */

const route = reactive({ params: { name: 'host', folder: '~/git/a' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[] ) => sessionsList(...a),
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

function aplexerRow(): unknown {
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

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionsList.mockReset();
});

/** Mount the workspace with one live aplexer session, and let its tabs land. */
async function openWorkspace(): Promise<VueWrapper> {
  vi.resetModules();
  sessionsList.mockResolvedValue([aplexerRow()]);
  const { useConnectionStore } = await import('../../src/renderer/stores/connection');
  const { useSessionsStore } = await import('../../src/renderer/stores/sessions');
  const { useProjectsStore } = await import('../../src/renderer/stores/projects');
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [aplexerRow()] as never;
  const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
    .default;
  const wrapper = mount(FolderWorkspaceView, {
    global: { stubs },
    attachTo: document.body,
  });
  await flush();
  return wrapper;
}

describe('the agent launch is delivered against a live shell only', () => {
  it('retries on the next registration when the first write does not land', async () => {
    const input = vi.fn<(...args: unknown[]) => Promise<boolean>>();
    input.mockResolvedValueOnce(false).mockResolvedValue(true);
    overrides['shell.input'] = (...a: unknown[]) => input(...a);

    const wrapper = await openWorkspace();
    const { useShellsStore } = await import('../../src/renderer/stores/shells');
    const { parkAgentLaunch } = await import('../../src/renderer/pendingAgentLaunch');
    const shells = useShellsStore();

    // The trap: an id already standing under the launch's key when the launch
    // is armed. The watcher fires on it immediately, and main refuses the
    // write — the id tracks nothing live.
    shells.register('aplexer:~/git/a:main', 'shell-stale');
    parkAgentLaunch(
      'conn-1',
      'main',
      { kind: 'codex', dir: '~/git/a', skipPermissions: true, profile: null },
      Date.now(),
      '~/git/a',
    );
    await flush();

    expect(input).toHaveBeenCalledTimes(1);
    const [firstId, firstLine] = input.mock.calls[0] as [string, string];
    expect(firstId).toBe('shell-stale');
    expect(firstLine.startsWith('pocketshell agent codex')).toBe(true);

    // The launch survived the refusal: the re-join registers the live id, the
    // watcher re-points, and the line goes to the shell that exists.
    shells.register('aplexer:~/git/a:main', 'shell-live');
    await flush();

    expect(input).toHaveBeenCalledTimes(2);
    const [secondId, secondLine] = input.mock.calls[1] as [string, string];
    expect(secondId).toBe('shell-live');
    expect(secondLine.startsWith('pocketshell agent codex')).toBe(true);

    // Delivered means consumed: a later registration cannot fire the line
    // again.
    shells.register('aplexer:~/git/a:main', 'shell-after');
    await flush();
    expect(input).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });
});
