// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import type { LaunchChoice } from '../../src/shared/agentLaunch';

/**
 * The folder workspace's `+` -> "New session…" -> Create session, tested for
 * the one property it lost and the one it never had.
 *
 * The bug: the host can answer a `unique` start with the name of a session this
 * bar is ALREADY showing (ProjectsService.startSession has the socket-blindness
 * that made it do so), and this view trusted the name it was handed. With
 * Session type = Shell that assigned `selected` the tab that was already
 * selected, so the dialog closed and nothing visibly happened. With an agent
 * chosen it armed the launch against a session whose PTY was already up and
 * registered, so the launch watcher fired immediately and typed
 * `pocketshell agent …` into the terminal the user was working in.
 *
 * So the two things asserted here are:
 *
 *   1. **a genuinely new name gets a genuinely new tab**, and an agent launch
 *      goes into THAT session's shell and no other;
 *   2. **a name that is already on the bar is refused out loud** — nothing is
 *      typed anywhere, nothing is re-selected, and `createError` renders.
 *
 * `LaunchSessionDialog` is stubbed down to two buttons on purpose. What is
 * under test is what the WORKSPACE does with a confirmed choice; the dialog's
 * own validation is pinned in LaunchSessionDialog.test.ts, and driving its real
 * controls from here would make this file fail whenever a label moved.
 */

// Reactive and mutated in place, the way vue-router's own current-route object
// behaves: the view captures `useRoute()`'s return at setup, so a test that
// swapped a fresh object in could never simulate a query-only navigation —
// the real router updates the SAME object the component is holding.
const route = reactive({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const startSession = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const shellInput = vi.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * The renderer api, as a Proxy.
 *
 * This view constructs seven stores between them touching a dozen channels,
 * most of which only need to exist. Spelling every one out would bury the four
 * that carry the behaviour, so anything not named here answers
 * `Promise<undefined>` and the named ones are the test's subject.
 */
const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[]) => sessionsList(...a),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.startSession': (...a: unknown[]) => startSession(...a),
  'projects.home': vi.fn().mockResolvedValue({ ok: true, home: '/home/me', error: null }),
  'shell.input': (...a: unknown[]) => shellInput(...a),
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
const { useShellsStore } = await import('../../src/renderer/stores/shells');

const CHOICE: LaunchChoice = {
  kind: 'claude',
  dir: '~/git/x',
  skipPermissions: true,
  profile: null,
};

/** A session row of the shape `helper.sessionsList` returns. */
function row(name: string, created = 1): Record<string, unknown> {
  return {
    name,
    created,
    activity: created,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
  };
}

/** What the host says when it created [name]. */
function started(name: string, reused = false): unknown {
  return {
    ok: true,
    sessionName: name,
    folder: '/home/me/git/x',
    reused,
    via: 'helper',
    error: null,
    code: null,
  };
}

/**
 * The dialog, reduced to "confirm a shell" and "confirm an agent".
 *
 * `v-if="launching"` in the view means these buttons exist only once the `+`
 * menu's "New session…" has been clicked, which is exactly the gate the real
 * dialog sits behind.
 */
const LaunchStub = {
  emits: ['confirm', 'close'],
  setup: () => ({ choice: CHOICE }),
  template:
    '<div class="stub-launch">' +
    '<button class="confirm-shell" @click="$emit(\'confirm\', null)">shell</button>' +
    '<button class="confirm-agent" @click="$emit(\'confirm\', choice)">agent</button>' +
    '</div>',
};

/**
 * Focus requests the workspace makes against its panes, by session name.
 *
 * The one thing a stubbed terminal can still be honest about is whether
 * `focus()` was asked for and on whose behalf; the real TerminalView turns that
 * into an xterm focus, which jsdom could not observe anyway.
 */
const terminalFocusCalls: string[] = [];

const TerminalStub = {
  props: { sessionKey: { type: String, default: null } },
  // Both methods the workspace calls through the ref map; missing either would
  // be a TypeError at the call site, not a silent skip.
  setup(props: { sessionKey?: string | null }) {
    return {
      focus: (): void => {
        terminalFocusCalls.push(props.sessionKey ?? '?');
      },
      resyncDisplay: (): void => {},
    };
  },
  template: '<div class="stub-terminal" />',
};

const stubs = {
  TerminalView: TerminalStub,
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: LaunchStub,
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount the workspace on a folder that already holds one session, `git-x`. */
// Every wrapper this file mounts. A view left mounted across tests is not
// inert: it stays registered for focus requests (workspaceFocus.ts) and its
// folderKey/query watchers fire on the next test's route and store resets,
// splattering focus calls into that test's assertions.
const mounted: VueWrapper[] = [];

async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  mounted.push(wrapper);
  await flush();
  return wrapper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

/** `+` -> "New session…" -> the stub's [what] button. */
async function createVia(wrapper: VueWrapper, what: 'shell' | 'agent'): Promise<void> {
  await wrapper.find('button.add').trigger('click');
  await flush(2);
  const item = wrapper.findAll('button').find((b) => b.text().trim() === 'New session…');
  if (!item) throw new Error(`no "New session…" item in: ${wrapper.text()}`);
  await item.trigger('click');
  await flush(2);
  await wrapper.find(`button.confirm-${what}`).trigger('click');
  await flush(8);
}

/** The visible tab labels, in bar order. */
function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

/** The error line under the tab strip, or null when there is none. */
function barError(wrapper: VueWrapper): string | null {
  const el = wrapper.find('.bar-error');
  return el.exists() ? el.text() : null;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  startSession.mockReset();
  sessionsList.mockReset();
  shellInput.mockReset();
  terminalFocusCalls.length = 0;
  route.params = { name: 'host', folder: '~/git/x' };
  route.query = {};
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [row('git-x')] as never;
});

describe('the folder workspace + menu creates a session', () => {
  it('opens a tab for a genuinely new session', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    startSession.mockResolvedValue(started('git-x-2'));

    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['git-x']);

    await createVia(wrapper, 'shell');

    expect(startSession).toHaveBeenCalledWith('conn-1', {
      folder: '~/git/x',
      namePolicy: 'unique',
    });
    expect(tabLabels(wrapper)).toEqual(['git-x', 'git-x-2']);
    expect(wrapper.find('nav.tabs button.active').text().trim()).toBe('git-x-2');
    expect(barError(wrapper)).toBeNull();
    // The keyboard follows the tab: the create ends in the new pane, not back
    // on the `+` button the dialog restored focus to. The first entry is the
    // mount's own arrival focus on the tab that was in front.
    expect(terminalFocusCalls).toEqual(['git-x', 'git-x-2']);
  });

  it('launches the agent in the NEW session, not in the one that was in front', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    startSession.mockResolvedValue(started('git-x-2'));
    const shells = useShellsStore();
    // The session the user is looking at already has a live PTY. This is the
    // registration the bug wrote into.
    shells.register('git-x', 'shell-1');

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'agent');

    // Nothing is typed until the NEW pane comes up: the launch is waiting on a
    // shell that does not exist yet.
    expect(shellInput).not.toHaveBeenCalled();
    // The keyboard is already in the new pane; the launch typing is server-side
    // and does not depend on it, but the user is looking at the session they
    // asked for either way. First entry is the mount's arrival focus.
    expect(terminalFocusCalls).toEqual(['git-x', 'git-x-2']);

    // The new tab's TerminalView joins and publishes its shell.
    shells.register('git-x-2', 'shell-2');
    await flush(4);

    expect(shellInput).toHaveBeenCalledTimes(1);
    expect(shellInput).toHaveBeenCalledWith(
      'shell-2',
      "pocketshell agent claude --dir $HOME/'git/x'\r",
    );
  });

  /**
   * The reported bug, from the outside. The host answers with the name of the
   * session that is already open — which is what a socket-blind free-name walk
   * produces — and the only acceptable outcome is a sentence.
   */
  it('refuses, out loud, when the host answers with a session already on the bar', async () => {
    sessionsList.mockResolvedValue([row('git-x')]);
    startSession.mockResolvedValue(started('git-x'));
    const shells = useShellsStore();
    shells.register('git-x', 'shell-1');

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'agent');
    await flush(4);

    // The whole point: not a byte into the terminal the user was working in.
    expect(shellInput).not.toHaveBeenCalled();
    // Nothing was created, so the only focus ever asked for is the mount's
    // own arrival focus on the tab that was already in front.
    expect(terminalFocusCalls).toEqual(['git-x']);
    expect(barError(wrapper)).toContain('git-x');
    expect(barError(wrapper)).toContain('already open');
    expect(tabLabels(wrapper)).toEqual(['git-x']);
  });

  it('says so when the host answers `reused`, even under a fresh name', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-y', 2)]);
    startSession.mockResolvedValue(started('git-y', true));

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'shell');

    expect(barError(wrapper)).toContain('git-y');
  });

  it('shows the host’s own refusal rather than closing on nothing', async () => {
    startSession.mockResolvedValue({
      ok: false,
      sessionName: null,
      folder: '/home/me/git/x',
      reused: false,
      via: null,
      error: 'Could not ask the host for a free session name, so nothing was created.',
      code: 'name-unavailable',
    });

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'shell');

    expect(barError(wrapper)).toContain('free session name');
    expect(shellInput).not.toHaveBeenCalled();
  });

  it('says so when the created session does not land in this folder', async () => {
    // The create succeeded on the host, but the folder it names is not the
    // folder this workspace is keyed on — the usual cause is a session whose
    // working directory groups elsewhere — so there is no tab here and no
    // pane for a launch to wait on. The pending row trusts the result's
    // folder, which is exactly what files it under the OTHER folder and off
    // this bar.
    sessionsList.mockResolvedValue([row('git-x')]);
    startSession.mockResolvedValue({
      ok: true,
      sessionName: 'git-elsewhere',
      folder: '/home/me/elsewhere',
      reused: false,
      via: 'helper',
      error: null,
      code: null,
    });

    const wrapper = await openWorkspace();
    await createVia(wrapper, 'agent');
    await flush(4);

    expect(shellInput).not.toHaveBeenCalled();
    expect(barError(wrapper)).toContain('git-elsewhere');
    expect(tabLabels(wrapper)).toEqual(['git-x']);
  });

  /**
   * The session panel's create hand-off for a PLAIN shell, arriving at a folder
   * that is already open: only the route query changes, so neither `onMounted`
   * nor the `folderKey` watch runs, and before the query watcher existed the
   * new tab was not even selected. The panel refreshed the session list before
   * navigating, which is why the store here already holds the new row.
   */
  it('selects and focuses the queried tab when the open folder is handed a new session', async () => {
    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['git-x']);
    expect(terminalFocusCalls).toEqual(['git-x']);

    useSessionsStore().sessions = [row('git-x'), row('git-x-2', 2)] as never;
    route.params = { name: 'host', folder: '~/git/x' };
    route.query = { tab: 'git-x-2' };
    await flush();

    expect(tabLabels(wrapper)).toEqual(['git-x', 'git-x-2']);
    expect(wrapper.find('nav.tabs button.active').text().trim()).toBe('git-x-2');
    expect(terminalFocusCalls).toEqual(['git-x', 'git-x-2']);
  });

  /**
   * The same hand-off arriving at a folder that was NOT open: a mount, so
   * `loadFolderState` does the selecting from `?tab=` and — the half this pins —
   * the focusing. The panel refreshed the session list before navigating, so
   * the bar already shows the queried tab at load time and the arrival focus
   * lands on it, not on the first-tab fallback.
   */
  it('focuses the queried tab on a cold arrival when the bar already shows it', async () => {
    useSessionsStore().sessions = [row('git-x'), row('git-x-2', 2)] as never;
    route.params = { name: 'host', folder: '~/git/x' };
    route.query = { tab: 'git-x-2' };

    const wrapper = await openWorkspace();

    expect(tabLabels(wrapper)).toEqual(['git-x', 'git-x-2']);
    expect(wrapper.find('nav.tabs button.active').text().trim()).toBe('git-x-2');
    expect(terminalFocusCalls).toEqual(['git-x-2']);
  });

  /**
   * A panel row click for a folder that is NOT open: the `folderKey` watch
   * reloads the workspace, and the arrival focus is what lands the keyboard in
   * the new folder's pane instead of leaving it wherever the previous folder
   * had put it.
   */
  it('puts the keyboard in the pane when the panel opens a different folder', async () => {
    useSessionsStore().sessions = [
      row('git-x'),
      { ...row('git-y', 2), path: '/home/me/git/y' },
    ] as never;

    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['git-x']);
    expect(terminalFocusCalls).toEqual(['git-x']);

    route.params = { name: 'host', folder: '~/git/y' };
    await flush();

    // The arrived folder's tab reads the session's own name — for a derived
    // name that is the folder's, and the label spells it out either way.
    expect(tabLabels(wrapper)).toEqual(['git-y']);
    expect(wrapper.find('nav.tabs button.active').text().trim()).toBe('git-y');
    expect(terminalFocusCalls).toEqual(['git-x', 'git-y']);
  });

  /**
   * The registration behind the panel's already-open row re-click: the mounted
   * workspace advertises its focus (workspaceFocus.ts), a request lands in the
   * pane in front, and unmounting the workspace revokes the slot so a stale
   * registration can never focus a dead component tree.
   */
  it('answers a focus request while mounted and stops answering after unmount', async () => {
    const { requestWorkspaceFocus } = await import('../../src/renderer/workspaceFocus');
    const wrapper = await openWorkspace();
    expect(terminalFocusCalls).toEqual(['git-x']);

    requestWorkspaceFocus();
    await flush(2);
    expect(terminalFocusCalls).toEqual(['git-x', 'git-x']);

    wrapper.unmount();
    requestWorkspaceFocus();
    await flush(2);
    expect(terminalFocusCalls).toEqual(['git-x', 'git-x']);
  });
});

/**
 * `Ctrl+N` — the quick half of the creation pair: a plain shell in THIS
 * folder, one press, no dialog. `Ctrl+Shift+N` is the picker and stays with
 * SessionTree's tests; what is pinned here is that the quick chord runs the
 * SAME create the launch dialog confirms into, and the guards that keep a
 * keyboard chord from doing host work by accident:
 *
 *   1. **one press, one session, in this folder** — `projects.startSession`
 *      with the `unique` policy, the new tab selected, the keyboard in it.
 *   2. **the keystroke is cancelled** — `preventDefault` and
 *      `stopPropagation`, so the event never reaches xterm's textarea, where
 *      Ctrl+N is ^N and readline would answer it with next-history. Asserted
 *      through `dispatchEvent`'s return, which is `defaultPrevented` made
 *      observable.
 *   3. **it stands down in a text field** — prose being typed must not mint
 *      sessions (the terminal is deliberately not in that set; that is what
 *      makes the chord fire with focus in the pane).
 *   4. **key repeat is refused** — a held chord would otherwise mint a
 *      session per repeat, each one a real create on the host.
 *   5. **a rename keeps the keyboard** — the tab's rename field owns
 *      Enter/Escape, and Ctrl+N must not create a folder underneath an edit
 *      that is still open.
 */
describe('the Ctrl+N quick create (sessions.newInFolder)', () => {
  /** A Ctrl+N keydown on [target], reported through `dispatchEvent`. */
  function pressQuickCreate(target: EventTarget = window): boolean {
    // Cancelable, like every real keydown — it is what makes the
    // `defaultPrevented` half of the contract observable at all.
    return target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, cancelable: true, bubbles: true }),
    );
  }

  it('starts a shell in this folder and lands in the new tab', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    startSession.mockResolvedValue(started('git-x-2'));

    const wrapper = await openWorkspace();
    expect(tabLabels(wrapper)).toEqual(['git-x']);

    pressQuickCreate();
    await flush(8);

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith('conn-1', {
      folder: '~/git/x',
      namePolicy: 'unique',
    });
    expect(tabLabels(wrapper)).toEqual(['git-x', 'git-x-2']);
    expect(wrapper.find('nav.tabs button.active').text().trim()).toBe('git-x-2');
    expect(barError(wrapper)).toBeNull();
    // The keyboard follows the create, exactly as the dialog path's does.
    expect(terminalFocusCalls).toEqual(['git-x', 'git-x-2']);
  });

  it('cancels the keystroke so it never reaches the pane', async () => {
    sessionsList.mockResolvedValue([row('git-x')]);
    startSession.mockResolvedValue(started('git-x-2'));

    await openWorkspace();
    // `false` is jsdom's answer when the event was defaultPrevented.
    expect(pressQuickCreate()).toBe(false);
    await flush(4);
  });

  it('stands down while the user is typing in a field', async () => {
    sessionsList.mockResolvedValue([row('git-x')]);
    await openWorkspace();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    pressQuickCreate(input);
    await flush(4);
    expect(startSession).not.toHaveBeenCalled();
    input.remove();
  });

  it('refuses key repeat', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    startSession.mockResolvedValue(started('git-x-2'));

    const wrapper = await openWorkspace();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, repeat: true, bubbles: true }),
    );
    await flush(8);

    expect(startSession).not.toHaveBeenCalled();
    expect(tabLabels(wrapper)).toEqual(['git-x']);
  });

  it('stands down while a tab rename is open', async () => {
    sessionsList.mockResolvedValue([row('git-x')]);
    const wrapper = await openWorkspace();
    await wrapper.find('nav.tabs button').trigger('dblclick');
    expect(wrapper.find('input.rename-input').exists()).toBe(true);

    // Fired on `window` rather than on the field, so this exercises the
    // rename guard and not merely the text-field one.
    pressQuickCreate();
    await flush(4);

    expect(startSession).not.toHaveBeenCalled();
    expect(wrapper.find('input.rename-input').exists()).toBe(true);
  });
});
