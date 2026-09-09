// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * `Ctrl+[` / `Ctrl+]` — the tab to the left, the tab to the right.
 *
 * First carried by `Ctrl+←`/`Ctrl+→`, moved onto brackets at the user's word
 * ("ctrl+left and right conflicts with jumping over words"), while
 * `Ctrl+↑`/`Ctrl+↓` still walks workspaces (`workspaceStepChord.test.ts`
 * holds that half). The pairing is the design — horizontal is the tab bar,
 * vertical is the panel down the side — so the two files pin one gesture
 * between them and the rules they share are asserted in both.
 *
 * What is pinned here:
 *
 *   1. **Direction**, and that it acts on the ACTIVE tab rather than the first.
 *   2. **It CLAMPS.** A step is a direction, not a cycle, and being thrown to
 *      the far end is not what "further left" asked for. This is the one
 *      property a future edit is most likely to "fix" by reaching for a
 *      wrap-around helper.
 *   3. **The keystroke is cancelled**, both ways — `preventDefault` so Chromium
 *      does not also act, `stopPropagation` so it never reaches xterm's
 *      textarea, where `Ctrl+[` IS Escape (C0 0x1B) and `Ctrl+]` is GS. One
 *      keystroke, two paths, is the defect that has landed in this app three
 *      times (bc86cf7, 3628090, and the Ctrl+V route after them).
 *   4. **A real text field stays navigation-free** — brackets have no editing
 *      role there any more, but prose being typed should not be interrupted —
 *      yet the TERMINAL is still treated as NOT one, even though xterm's input
 *      sink is literally a `<textarea>`. That exception is what lets the chord
 *      fire with focus in the pane.
 *   5. **The removed families stay removed.** `Ctrl+1`..`Ctrl+9`, the tab-move
 *      chords, and finally the whole cycle (`Ctrl+Tab` / `Ctrl+Shift+Tab`)
 *      were dropped at the user's request, and what proves it here is that the
 *      workspace no longer CANCELS them: the keys have to reach the pane, where
 *      they are C0 controls, xterm's scrollback, and completion/back-tab.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceRename.test.ts
 * exactly; see the reasoning there.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });
const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
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

vi.mock('../../src/renderer/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const FolderWorkspaceView = (await import('../../src/renderer/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSessionsStore } = await import('../../src/renderer/stores/sessions');

function row(name: string, created: number): unknown {
  return {
    name,
    created,
    activity: created,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
  };
}

/** Every `resyncDisplay()` the workspace asked for, by session name. */
const resynced: string[] = [];

const stubs = {
  // Exposes what the real pane exposes, so the menu item's call lands
  // somewhere: `defineExpose({ focus, resyncDisplay })` in TerminalView.
  TerminalView: {
    props: ['sessionKey'],
    template: '<div class="stub-terminal" />',
    methods: {
      focus(): void {},
      resyncDisplay(): void {
        resynced.push((this as unknown as { sessionKey: string }).sessionKey);
      },
    },
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

/**
 * Mount on a folder holding three sessions, so there is a tab to each side of
 * the middle one and a wall at each end.
 */
async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs }, attachTo: document.body });
  await flush();
  return wrapper;
}

/** The labels on the tab bar, in order. */
function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button.tab').map((b) => b.text().trim());
}

/** The label of the tab that is currently selected. */
function activeTab(wrapper: VueWrapper): string {
  return wrapper.find('nav.tabs button.tab.active').text().trim();
}

/**
 * Select a tab by its label, the way a user does.
 *
 * A click on the tab that is ALREADY active is deliberately skipped, because in
 * this app that gesture is not a selection — it opens the inline rename,
 * which swaps the button for a field and makes the chord handler stand down
 * (`renaming !== null`). Clicking it "just to be sure" would silently put every
 * test that did so into a state where nothing responds to the keyboard.
 */
async function clickTab(wrapper: VueWrapper, label: string): Promise<void> {
  if (activeTab(wrapper) === label) return;
  const tab = wrapper.findAll('nav.tabs button.tab').find((b) => b.text().trim() === label);
  if (!tab) throw new Error(`no tab labelled ${label} in: ${tabLabels(wrapper).join(', ')}`);
  await tab.trigger('click');
  await flush(2);
}

/**
 * Press a chord the way the browser delivers one: on `window`, in the capture
 * phase, from a target inside the page. The handler is a window capture
 * listener precisely so it runs before xterm, CodeMirror and the composer, and
 * dispatching anywhere else would test a listener the app does not have.
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

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  route.value = { params: { name: 'host', folder: '~/git/x' }, query: {} };
  sessionsList.mockResolvedValue([row('git-x', 3), row('git-x-2', 2), row('git-x-3', 1)]);
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  useSessionsStore().sessions = [] as never[];
});

describe('Ctrl+[ / Ctrl+] step one tab', () => {
  it('] moves forward, [ moves backward', async () => {
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    expect(labels.length).toBeGreaterThanOrEqual(3);

    await clickTab(wrapper, labels[1]!);
    expect(activeTab(wrapper)).toBe(labels[1]);

    await press(wrapper, ']');
    expect(activeTab(wrapper)).toBe(labels[2]);

    await press(wrapper, '[');
    expect(activeTab(wrapper)).toBe(labels[1]);
    wrapper.unmount();
  });

  it('STOPS at the wall instead of wrapping round', async () => {
    // An arrow is a direction: being thrown to the opposite end of the bar
    // loses the position the key exists to preserve. (The `Ctrl+Tab` cycle
    // this comment once guarded against reaching for is gone entirely.)
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);

    await clickTab(wrapper, labels[0]!);
    await press(wrapper, '[');
    expect(activeTab(wrapper)).toBe(labels[0]);

    await clickTab(wrapper, labels[labels.length - 1]!);
    await press(wrapper, ']');
    expect(activeTab(wrapper)).toBe(labels[labels.length - 1]);
    wrapper.unmount();
  });

  it('cancels the keystroke, so the shell never also receives it', async () => {
    // Through xterm, Ctrl+[ IS Escape (C0 0x1B — readline's meta-prefix, the
    // escape vim users live in) and Ctrl+] is GS. Without the cancel the chord
    // would move the tab AND send the byte — one keystroke, two paths.
    const wrapper = await openWorkspace();
    for (const key of ['[', ']']) {
      const e = await press(wrapper, key);
      expect(e.defaultPrevented, key).toBe(true);
    }
    wrapper.unmount();
  });

  it('takes the Cmd spelling, and leaves AltGr alone', async () => {
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    await press(wrapper, ']', { ctrlKey: false, metaKey: true });
    expect(activeTab(wrapper)).toBe(labels[1]);

    // Ctrl+Alt is AltGr on European layouts; [ and ] carry real characters
    // there, and none of it is this chord's.
    const e = await press(wrapper, ']', { altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(activeTab(wrapper)).toBe(labels[1]);
    wrapper.unmount();
  });
});

describe('where the tab step stands down', () => {
  it('leaves a real text field alone while prose is being typed', async () => {
    // Brackets carry no editing gesture in a field any more, but the rule
    // survived the move from the arrows on purpose: navigation does not
    // interrupt typing in a draft or a path box.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    const field = document.createElement('textarea');
    document.body.appendChild(field);
    const e = await press(wrapper, ']', {}, field);

    expect(e.defaultPrevented).toBe(false);
    expect(activeTab(wrapper)).toBe(labels[0]);
    field.remove();
    wrapper.unmount();
  });

  it('does NOT treat the terminal as a text field, though xterm’s sink is one', async () => {
    // THE EXCEPTION THE FEATURE RESTS ON. xterm's input sink is a real
    // `<textarea class="xterm-helper-textarea">`, focused whenever the pane has
    // the keyboard — so a plain editable check would exempt the terminal, and
    // the chord would appear to do nothing in the one place it is for.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    const pane = document.createElement('div');
    pane.className = 'xterm';
    const sink = document.createElement('textarea');
    sink.className = 'xterm-helper-textarea';
    pane.appendChild(sink);
    document.body.appendChild(pane);

    const e = await press(wrapper, ']', {}, sink);
    expect(e.defaultPrevented).toBe(true);
    expect(activeTab(wrapper)).toBe(labels[1]);
    pane.remove();
    wrapper.unmount();
  });
});

describe('Redraw, from the tab menu', () => {
  it('asks the pane of the tab it was opened on to resync', async () => {
    // The lever for the reported picture: tmux's status line drawn in the
    // middle of the pane with stale rows under it, which happens when another
    // tmux client shrinks the window and nothing on this side moves. The menu
    // item must reach the pane of the tab it was opened on — a redraw aimed at
    // the wrong session repaints something that was never wrong.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    // Visit the second tab, then leave it. A pane is mounted the first time its
    // tab is selected and kept mounted afterwards, so this is what gives the
    // background tab something to redraw — a tab never visited has no pane on
    // screen and nothing to put right.
    await clickTab(wrapper, labels[1]!);
    await clickTab(wrapper, labels[0]!);
    resynced.length = 0;

    // Right-click the SECOND tab, not the active one, so a handler that
    // reached for "the current pane" instead of the menu's target fails here.
    await wrapper.findAll('nav.tabs button.tab')[1]!.trigger('contextmenu');
    await flush(2);
    // The menu names the session it was opened on; that is the pane the item
    // must reach.
    const named = wrapper.find('.menu-head').text().trim();
    const item = wrapper.findAll('button').find((b) => b.text().trim() === 'Redraw');
    if (!item) throw new Error(`no Redraw item in: ${wrapper.text()}`);
    await item.trigger('click');
    await flush(2);

    expect(resynced).toEqual([named]);
    wrapper.unmount();
  });

  it('closes the menu when it is taken', async () => {
    const wrapper = await openWorkspace();
    await wrapper.findAll('nav.tabs button.tab')[1]!.trigger('contextmenu');
    await flush(2);
    await flush(2);
    const item = wrapper.findAll('button').find((b) => b.text().trim() === 'Redraw')!;
    await item.trigger('click');
    await flush(2);
    expect(wrapper.findAll('button').some((b) => b.text().trim() === 'Redraw')).toBe(false);
    wrapper.unmount();
  });
});

describe('the families that were removed stay removed', () => {
  it('lets Ctrl+1..Ctrl+9 through to the pane', async () => {
    // "remove ctrl 1 2 3 hotkey". The workspace must no longer cancel them:
    // Ctrl+3..Ctrl+7 are ESC, FS, GS, RS, US at a terminal and Ctrl+8 is DEL,
    // and a chord this app does not claim has to reach the program the user is
    // talking to.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[0]!);

    for (const digit of ['1', '2', '3', '9']) {
      const e = await press(wrapper, digit);
      expect(e.defaultPrevented, digit).toBe(false);
    }
    expect(activeTab(wrapper)).toBe(labels[0]);
    wrapper.unmount();
  });

  it('lets Ctrl+Shift+PageUp / PageDown through to xterm’s scrollback', async () => {
    // "Move the active tab left or right remove this too". The drag still
    // reorders; the keys belong to the pane again.
    const wrapper = await openWorkspace();
    const before = tabLabels(wrapper);

    for (const key of ['PageUp', 'PageDown']) {
      const e = await press(wrapper, key, { shiftKey: true });
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(tabLabels(wrapper)).toEqual(before);
    wrapper.unmount();
  });

  it('lets Ctrl+Tab and Ctrl+Shift+Tab through — the cycle was released', async () => {
    // "remove these hotkeys let's keep only ctrl left and ctrl right". The
    // workspace neither moves a tab nor cancels the key: at a prompt Ctrl+Tab
    // is completion (xterm ignores Ctrl on Tab) and Ctrl+Shift+Tab is back-tab,
    // and the keys have to reach the pane.
    const wrapper = await openWorkspace();
    const labels = tabLabels(wrapper);
    await clickTab(wrapper, labels[labels.length - 1]!);

    for (const mods of [{}, { shiftKey: true }]) {
      const e = await press(wrapper, 'Tab', mods);
      expect(e.defaultPrevented, JSON.stringify(mods)).toBe(false);
    }
    expect(activeTab(wrapper)).toBe(labels[labels.length - 1]);
    wrapper.unmount();
  });
});
