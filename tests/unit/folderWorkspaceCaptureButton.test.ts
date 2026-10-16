// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The tab bar's capture button — the visible half of the pane-as-text
 * capture (terminalCapture.ts; the chords beside it in shortcutTable.ts).
 *
 * The chord alone was the whole feature for one day, and the user's report
 * was "I don't see how to do it" — they had gone looking through menus for a
 * button that did not exist. So the button exists now, at the bar's right
 * corner on the VS Code button's seat, and these tests pin the three things
 * it must get right:
 *
 *   - it acts on the PANE IN FRONT — the workspace routes the click through
 *     the terminal refs it already holds, passing the screen scope (the
 *     scrollback twin stays the chord's), and the clipboard receives what a
 *     real pane's capture returns;
 *   - its tooltip TEACHES the chord, read from the shortcut registry at
 *     draw time — a rebind must move the tooltip with it, or the button
 *     trains the user on a key that no longer fires;
 *   - it is ABSENT, not disabled, where no pane is in front (a Files tab) —
 *     the same absent-not-greyed rule the tab menu's Copy address follows.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceCopyAddress
 * .test.ts exactly; see the reasoning there. The click is driven the way a
 * user reaches it — the button in the bar.
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

const FolderWorkspaceView = (await import('@ui/app/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('@ui/app/stores/connection');
const { useSessionsStore } = await import('@ui/app/stores/sessions');
const { useProjectsStore } = await import('@ui/app/stores/projects');

/** The routed capture verb, as the stub pane receives it. */
const captureMock = vi.fn<(scope: string) => void>();

const stubs = {
  // `capture` rides the stub beside `focus` for the same reason focus does:
  // the view's handler calls it through the ref, and a missing method would
  // be a TypeError at the call site rather than a silent skip. The mock is
  // how the test observes the routing (the stub owns no clipboard).
  TerminalView: {
    template: '<div class="stub-terminal" />',
    methods: { focus: () => undefined, capture: captureMock },
  },
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

const mounted: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  sessionsList.mockReset();
  captureMock.mockReset();
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
});

/** A tmux session row, of the shape `helper.sessionsList` returns. */
function row(name: string): unknown {
  return {
    name,
    created: 1,
    activity: 1,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
  };
}

async function openWorkspace(): Promise<VueWrapper> {
  const sessionRow = row('main');
  sessionsList.mockResolvedValue([sessionRow]);
  useSessionsStore().sessions = [sessionRow] as never;
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  mounted.push(wrapper);
  await flush();
  return wrapper;
}

describe('the tab bar capture button', () => {
  it('sits in the bar while a session tab is in front and copies the front pane', async () => {
    const wrapper = await openWorkspace();

    const button = wrapper.find('button.capture-open');
    expect(button.exists()).toBe(true);
    // The screen scope, always — the scrollback stays the chord's.
    await button.trigger('click');
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('screen');
  });

  it('teaches the registry chord in its tooltip, not a hardcoded key', async () => {
    // The user asked for the button after hunting menus for a feature they
    // could not find; a tooltip naming a stale key would send the next
    // player down the same dead end. So the override is the subject: with
    // the chord moved in storage, the tooltip must move with it.
    localStorage.setItem(
      'pocketshell.settings.v1',
      JSON.stringify({ shortcutOverrides: { 'terminal.copyScreen': 'Ctrl+Shift+U' } }),
    );
    const wrapper = await openWorkspace();

    const title = wrapper.find('button.capture-open').attributes('title');
    expect(title).toContain('Copy the screen as text');
    expect(title).toContain('Ctrl+Shift+U');
    expect(title).not.toContain('Ctrl+Shift+Y');
  });

  it('is absent, not disabled, when a Files tab is in front', async () => {
    const wrapper = await openWorkspace();
    expect(wrapper.find('button.capture-open').exists()).toBe(true);

    // The Files tab is minted the way the user mints one, through the `+`
    // menu — no Files tab is seeded.
    await wrapper.find('.tab.add').trigger('click');
    const item = wrapper.findAll('.menu-item').find((b) => b.text() === 'New Files tab');
    if (!item) throw new Error('no "New Files tab" item on the + menu');
    await item.trigger('click');
    await flush();

    expect(
      wrapper.findAll('nav.tabs button.tab').some((b) => b.classes().includes('files')),
    ).toBe(true);
    expect(wrapper.find('button.capture-open').exists()).toBe(false);
  });
});
