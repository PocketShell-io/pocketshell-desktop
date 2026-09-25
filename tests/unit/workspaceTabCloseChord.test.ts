// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * `Ctrl+F4` — close the current tab, the `×`, on the keyboard.
 *
 * The one rule this file exists to pin is the TWO-KINDS rule the `×` itself
 * obeys, which a chord is always one refactor away from flattening:

 *
 *  - a FILES tab closes outright — its close is free and reversible (`+`
 *    re-opens one), so the chord does exactly what the `×` does;
 *  - a SESSION tab is only ever ARMED for stop — the same named, confirmed
 *    dialog the `×` and the tab menu open, never the kill. A keystroke gives
 *    the user no aim at a tab, so it cannot be the thing that destroys one;
 *    `projects.killSession` is spied to prove the chord alone destroys
 *    nothing.
 *
 * The rest is the chord plumbing every tab chord shares: the keystroke is
 * cancelled both ways (`preventDefault` for Chromium, `stopPropagation` for
 * xterm's textarea), a real text field is left alone, key repeat is refused
 * (a held chord would close Files tabs at the autorepeat rate), and the Cmd
 * spelling fires because Ctrl means Ctrl-or-Command everywhere.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceTabClose.test.ts
 * exactly; see the reasoning there.
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

vi.mock('@ui/app/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const FolderWorkspaceView = (await import('@ui/app/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('@ui/app/stores/connection');
const { useSessionsStore } = await import('@ui/app/stores/sessions');
const { useProjectsStore } = await import('@ui/app/stores/projects');

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
  // attachTo: a chord pressed on a DETACHED tree never propagates to the
  // window, and the handler is a window capture listener — this file cannot
  // mount detached the way the click-only tab-close test can.
  const wrapper = mount(FolderWorkspaceView, { global: { stubs }, attachTo: document.body });
  await flush();
  return wrapper;
}

function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

/**
 * Press a chord the way the browser delivers one: on `window`, in the capture
 * phase, from a target inside the page. The handler is a window capture
 * listener precisely so it runs before xterm, CodeMirror and the composer.
 */
async function press(
  wrapper: VueWrapper,
  key: string,
  mods: Partial<KeyboardEventInit> = {},
  target?: HTMLElement,
): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
    ...mods,
  });
  (target ?? (wrapper.element as HTMLElement)).dispatchEvent(e);
  await flush(2);
  return e;
}

/**
 * Open a Files tab the way the user does, through the `+` menu — no test may
 * assume a seeded Files tab, because the workspace ships none.
 */
async function openFilesTab(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.tab.add').trigger('click');
  const item = wrapper.findAll('.menu-item').find((b) => b.text() === 'New Files tab');
  if (!item) throw new Error('no "New Files tab" item on the + menu');
  await item.trigger('click');
  await flush();
}

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

describe('Ctrl+F4 closes the current tab', () => {
  it('ARMS the stop on a session tab — the named confirmation, killing nothing', async () => {
    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['git-x']);

    const e = await press(wrapper, 'F4');
    await flush();

    expect(e.defaultPrevented, 'the chord is cancelled').toBe(true);
    const confirm = wrapper.find('.stub-overlay');
    expect(confirm.exists(), 'the stop dialog opens').toBe(true);
    expect(confirm.text()).toContain('git-x');
    // The chord is a handle on the destructive action, never the action: the
    // kill stays behind the dialog's own Stop button, as it does for the `×`.
    expect(killSession).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('closes a Files tab outright, touching neither the stop dialog nor the kill', async () => {
    const wrapper = await openWorkspace();
    await openFilesTab(wrapper);
    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);

    await press(wrapper, 'F4');
    await flush();

    expect(tabLabels(wrapper)).toEqual(['git-x']);
    expect(wrapper.find('.stub-overlay').exists()).toBe(false);
    expect(killSession).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('takes the Cmd spelling, because Ctrl means Ctrl-or-Command everywhere', async () => {
    const wrapper = await openWorkspace();

    await press(wrapper, 'F4', { ctrlKey: false, metaKey: true });
    await flush();

    expect(wrapper.find('.stub-overlay').text()).toContain('git-x');
    wrapper.unmount();
  });
});

describe('where the close chord stands down', () => {
  it('leaves a real text field alone', async () => {
    const wrapper = await openWorkspace();

    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const e = await press(wrapper, 'F4', {}, field);

    expect(e.defaultPrevented).toBe(false);
    expect(wrapper.find('.stub-overlay').exists()).toBe(false);
    field.remove();
    wrapper.unmount();
  });

  it('refuses key repeat — a held chord must not close tabs at autorepeat rate', async () => {
    const wrapper = await openWorkspace();
    await openFilesTab(wrapper);

    const e = await press(wrapper, 'F4', { repeat: true });
    await flush();

    // Not cancelled either: a refused chord is the shell's/field's key again.
    expect(e.defaultPrevented).toBe(false);
    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
    wrapper.unmount();
  });
});
