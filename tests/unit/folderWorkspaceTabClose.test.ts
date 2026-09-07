// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The `×` on a tab.
 *
 * The user asked for "x here like in vscode", and the two rules this file pins
 * are what the ask changed and what it did NOT:
 *
 *  - every tab wears the control now — the old rule spared the first Files
 *    tab because closing it would strand the workspace, and what replaced that
 *    guarantee is pinned at the bottom: a link clicked with no Files tab
 *    standing opens one instead of landing nowhere. The workspace no longer
 *    SEEDS one either (the user asked to see Files only when it is needed), so
 *    where a test here needs a Files tab to act on, it opens one through the
 *    `+` menu;
 *  - a session tab's `×` cannot kill. It arms the same confirmed dialog the
 *    right-click menu does, says Stop rather than Close, and does not select
 *    the tab it sits on — the right-click rule, which a mis-aimed click on a
 *    background tab must not be able to violate.
 *
 * The kill ITSELF is `confirmStop` and is out of scope here: this file asserts
 * the arm and the cancel, with `projects.killSession` spied to prove the `×`
 * alone destroys nothing.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const killSession = vi.fn().mockResolvedValue({ ok: true });

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': vi.fn().mockResolvedValue([]),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.home': vi.fn().mockResolvedValue({ ok: true, home: '/home/me', error: null }),
  'projects.killSession': killSession,
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

const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');
const { useProjectsStore } = await import('../../src/renderer/stores/projects');
const { useFilesStore } = await import('../../src/renderer/stores/files');

const stubs = {
  // `focus` is part of the real TerminalView's exposed surface and is what a
  // tab close lands on through `focusActiveTab`; a bare div stub would leave
  // that call throwing as an unhandled rejection.
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

function activeLabel(wrapper: VueWrapper): string {
  return wrapper.find('nav.tabs button.active').text().trim();
}

/**
 * Open a Files tab the way the user does, through the `+` menu.
 *
 * No test here may assume a seeded Files tab — there is none — so this is the
 * one setup step every Files-tab case starts from.
 */
async function openFilesTab(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.tab.add').trigger('click');
  const item = wrapper.findAll('.menu-item').find((b) => b.text() === 'New Files tab');
  if (!item) throw new Error('no "New Files tab" item on the + menu');
  await item.trigger('click');
  await flush();
}

/** The `×` of the tab whose label is [label]. */
function closeOf(wrapper: VueWrapper, label: string): ReturnType<VueWrapper['find']> {
  const tab = wrapper
    .findAll('nav.tabs button')
    .find((b) => b.text().includes(label))
    ;
  if (!tab) throw new Error(`no tab labelled ${label}`);
  return tab.find('.tab-close');
}

const IMAGE = '/home/me/.codex/generated_images/uuid/exec-1.png';

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  killSession.mockClear();
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [
    { name: 'git-x', created: 1, activity: 1, attached: false, path: '/home/me/git/x' },
  ] as never;
});

describe('the close control on a workspace tab', () => {
  it('is on every tab, however the tab came to exist', async () => {
    const wrapper = await openWorkspace();
    // No Files tab is seeded: a workspace opens with its session tabs only.
    expect(tabLabels(wrapper)).toEqual(['main']);
    expect(closeOf(wrapper, 'main').exists(), 'main').toBe(true);

    await openFilesTab(wrapper);
    expect(tabLabels(wrapper)).toEqual(['main', 'Files']);
    expect(closeOf(wrapper, 'Files').exists(), 'Files').toBe(true);
  });

  it('says Stop on a session tab and opens the named confirmation, killing nothing', async () => {
    const wrapper = await openWorkspace();

    expect(closeOf(wrapper, 'main').attributes('title')).toBe('Stop this session');
    await closeOf(wrapper, 'main').trigger('click');
    await flush();

    const confirm = wrapper.find('.stub-overlay');
    expect(confirm.exists()).toBe(true);
    expect(confirm.text()).toContain('git-x');
    expect(killSession).not.toHaveBeenCalled();
  });

  it('does not move the user to a background tab whose × they clicked', async () => {
    const wrapper = await openWorkspace();
    // A second session, so the main tab has a background sibling to click
    // at. Without it the tab is the active one and the assertion is vacuous.
    useSessionsStore().sessions.push({
      name: 'git-x-2',
      created: 2,
      activity: 2,
      attached: false,
      path: '/home/me/git/x',
    });
    await flush();
    expect(activeLabel(wrapper)).toBe('main');

    await closeOf(wrapper, 'main 2').trigger('click');
    await flush();

    expect(activeLabel(wrapper)).toBe('main');
    expect(wrapper.find('.stub-overlay').text()).toContain('git-x-2');
  });

  it('closes a Files tab outright, touching neither the stop dialog nor the kill', async () => {
    const wrapper = await openWorkspace();
    await openFilesTab(wrapper);

    await closeOf(wrapper, 'Files').trigger('click');
    await flush();
    expect(tabLabels(wrapper)).toEqual(['main']);

    // The session tab's × was never touched, so no stop dialog may be showing
    // and the kill count is still zero — the Files close went through
    // `closeFilesTab`, which shares nothing with the stop path.
    expect(wrapper.find('.stub-overlay').exists()).toBe(false);
    expect(killSession).not.toHaveBeenCalled();
  });

  it('opens a Files tab for a link clicked when none is standing', async () => {
    const wrapper = await openWorkspace();

    // A fresh workspace ships no Files tab to close any more, so this is the
    // plain entry state, not a post-close one: the watcher still owes the click
    // a tab instead of dropping it.
    useFilesStore().requestReveal(IMAGE);
    await flush();

    expect(tabLabels(wrapper)).toEqual(['main', 'Files']);
    expect(activeLabel(wrapper)).toBe('Files');
    expect(useFilesStore().reveal).toBe(IMAGE);
  });
});
