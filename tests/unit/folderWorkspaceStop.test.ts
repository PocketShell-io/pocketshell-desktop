// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * A confirmed Stop takes the tab and its pane down in the same tick as the
 * kill — not on the listing's.
 *
 * The stop used to end with a refresh and a prayer: the tab bar derives from
 * the host's session list, so a session the host had already killed stayed on
 * the bar until the listing caught up — and `a kill` answering ok is NOT the
 * listing catching up. The CLI answers once the worker accepts the stop; the
 * record leaves the snapshot only when the worker has finished terminating the
 * workload, and until then the bar held a dead session above a pane that
 * already said "[process exited]". On a real host that window was long enough
 * to file as a bug: stop, confirm, and the row looked unstopped.
 *
 * `confirmStop` now drops the row through `sessions.removeLocal` when the kill
 * resolves, and the ledger it files the identity into keeps the follow-up
 * refresh (which can still carry the corpse) from putting it back. These tests
 * hold both halves, from the tab and from the pane, for tmux rows and aplexer
 * rows.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceRename.test.ts
 * exactly; see the reasoning there.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const killSession = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[]) => sessionsList(...a),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.killSession': (...a: unknown[]) => killSession(...a),
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

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');
const { useProjectsStore } = await import('../../src/renderer/stores/projects');

import type { SessionSummary } from '../../src/shared/types';

/** A tmux-shaped row of the shape `helper.sessionsList` returns. */
function row(name: string, created = 1): SessionSummary {
  return { name, created, activity: created, attached: false, path: '/home/me/git/x' };
}

/** An aplexer-shaped row: the workspace and id a kill is addressed by. */
function aplexerRow(name: string): SessionSummary {
  return {
    ...row(name),
    backend: 'aplexer',
    workspace: '/home/me/git/x',
    tag: name,
    aplexerId: `uuid-${name}`,
    aplexerPhase: 'running',
  };
}

// The point of these assertions is the tab text reading as the session it
// belongs to — which under verbatim labels is true of every name, `alpha`
// included: what the tab says is what the host calls it.

/** What the host says when the kill landed. */
function killed(): unknown {
  return { ok: true, error: null, code: null };
}

const stubs = {
  TerminalView: { template: '<div class="stub-terminal" />', methods: { focus: () => undefined } },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div class="stub-launch" />' },
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount the workspace on a folder whose sessions are already in the store. */
async function openWorkspace(rows: SessionSummary[]): Promise<VueWrapper> {
  const store = useSessionsStore();
  store.sessions = rows;
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

/** Right-click the [at]-th session tab and take "Stop session…" from the menu. */
async function askStop(wrapper: VueWrapper, at = 0): Promise<void> {
  const tabs = wrapper.findAll('nav.tabs button.tab').filter((b) => !b.classes().includes('add'));
  const tab = tabs[at];
  if (!tab) throw new Error(`no session tab ${at} in: ${tabs.map((b) => b.text()).join(', ')}`);
  await tab.trigger('contextmenu');
  await flush(2);
  const item = wrapper.findAll('button').find((b) => b.text().trim() === 'Stop session…');
  if (!item) throw new Error(`no "Stop session…" item in: ${wrapper.text()}`);
  await item.trigger('click');
  await flush(2);
}

/** Confirm the dialog the ask opened. */
async function confirmStop(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('.stop-confirm .btn-danger').trigger('click');
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  killSession.mockReset();
  sessionsList.mockReset();
  sessionsList.mockResolvedValue([]);
  killSession.mockResolvedValue(killed());
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
});

describe('a confirmed stop takes the tab down without waiting for the listing', () => {
  it('drops the tab and the pane while the listing is still in flight', async () => {
    // Held forever: the only way the tab can leave the bar is the local
    // removal — the refresh confirmStop ends with never lands.
    sessionsList.mockReturnValue(new Promise(() => undefined));

    const wrapper = await openWorkspace([row('alpha')]);
    expect(wrapper.text()).toContain('alpha');

    await askStop(wrapper);
    await confirmStop(wrapper);

    // The kill went to the host addressed by bare name — the tmux spelling.
    expect(killSession).toHaveBeenCalledWith('conn-1', 'alpha', undefined);
    // And the bar lost the tab and its pane on the same tick, with no
    // listing to tell it so.
    expect(wrapper.text()).not.toContain('alpha');
    expect(wrapper.find('.stub-terminal').exists()).toBe(false);
  });

  it('keeps the follow-up listing from putting the corpse back', async () => {
    // The window the bug lived in: the kill answers ok while the host still
    // lists the session, because the worker is still terminating it. Every
    // refresh in this test returns the row; the ledger is what keeps it off
    // the bar.
    sessionsList.mockResolvedValue([aplexerRow('alpha')]);

    const wrapper = await openWorkspace([aplexerRow('alpha')]);
    await askStop(wrapper);
    await confirmStop(wrapper);

    // Addressed by the row's aplexer identity, not the bare name.
    expect(killSession).toHaveBeenCalledWith('conn-1', 'alpha', {
      backend: 'aplexer',
      workspace: '/home/me/git/x',
      aplexerId: 'uuid-alpha',
    });
    expect(wrapper.text()).not.toContain('alpha');
    expect(useSessionsStore().sessions).toEqual([]);
  });

  it('selects a surviving tab by the same rule a Files tab close uses', async () => {
    sessionsList.mockReturnValue(new Promise(() => undefined));

    const wrapper = await openWorkspace([row('alpha'), row('beta', 2)]);
    await askStop(wrapper, 0);
    await confirmStop(wrapper);

    const names = wrapper
      .findAll('nav.tabs button.tab')
      .filter((b) => !b.classes().includes('add'))
      .map((b) => b.text());
    expect(names).toEqual(['beta']);
  });

  it('leaves everything standing when the host refuses the kill', async () => {
    killSession.mockResolvedValue({ ok: false, error: 'tmux refused', code: 'kill-failed' });

    const wrapper = await openWorkspace([row('alpha')]);
    await askStop(wrapper);
    await confirmStop(wrapper);

    // The refusal is on screen, and nothing was taken down: the session is
    // still running, so the row, the tab and the pane all stay.
    expect(wrapper.text()).toContain('tmux refused');
    expect(wrapper.text()).toContain('alpha');
    expect(useSessionsStore().sessions.map((s) => s.name)).toEqual(['alpha']);
  });
});
