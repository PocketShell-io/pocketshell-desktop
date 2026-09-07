// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * `NewSessionDialog`'s `startIn` prop — "open the picker AT this folder".
 *
 * It exists for the session panel's per-root `+`: the root is known, the
 * folder under it is not, so the dialog still opens and simply opens one level
 * in. What is tested here is only the seam that prop creates, because it has a
 * failure mode that is silent and expensive.
 *
 * **The browser's cwd lives in the projects STORE, not in this component.** It
 * therefore survives the dialog closing. Without clearing it first, a `startIn`
 * browse that FAILS — a registered root that is not on this host, which the
 * panel renders deliberately (a registered root is a statement of intent) —
 * would leave the picker pointed at whatever folder was browsed last time, with
 * `Start session` live and the preview naming a folder the user never chose.
 * The user would press `+` beside `tmp` and get a session in `~/git/dataops`.
 */

const home = vi.fn<() => Promise<{ ok: boolean; home?: string; error?: string }>>();
const realPath = vi.fn<(id: string, path: string) => Promise<string>>();
const list = vi.fn<(id: string, path: string) => Promise<{ name: string; type: string }[]>>();
const deriveName = vi.fn<() => Promise<string>>();
const startSession = vi.fn<(id: string, req: unknown) => Promise<unknown>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    projects: {
      home: () => home(),
      deriveName: () => deriveName(),
      reposList: vi.fn().mockResolvedValue({ repos: [] }),
      onCloneProgress: vi.fn(),
      startSession: (id: string, req: unknown) => startSession(id, req),
    },
    sftp: {
      realPath: (id: string, path: string) => realPath(id, path),
      list: (id: string, path: string) => list(id, path),
    },
    // The chained agent step mounts LaunchSessionDialog, which asks the host
    // for its profiles on mount. An empty list is the common real answer and
    // the one that needs no picker. `kinds` is the capability probe behind the
    // Grok option; the pinned 0.4.44 answer is the three baseline engines.
    agent: {
      profiles: vi.fn().mockResolvedValue([]),
      kinds: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode']),
    },
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
    helper: { usage: vi.fn().mockResolvedValue([]) },
  },
}));

const NewSessionDialog = (await import('../../src/renderer/components/NewSessionDialog.vue'))
  .default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useProjectsStore } = await import('../../src/renderer/stores/projects');
const { clearAgentLaunch, parkedAgentLaunch } = await import(
  '../../src/renderer/pendingAgentLaunch'
);

const HOME = '/home/alexey';

async function open(startIn: string | null, connectionId = 'conn-1'): Promise<VueWrapper> {
  useConnectionStore().connectionId = connectionId;
  const wrapper = mount(NewSessionDialog, {
    props: { startIn },
    global: { stubs: { OverlayPanel: { template: '<div><slot /></div>' } } },
  });
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  clearAgentLaunch();
  home.mockResolvedValue({ ok: true, home: HOME });
  deriveName.mockResolvedValue('git-dataops');
  realPath.mockImplementation(async (_id, path) => path);
  list.mockResolvedValue([{ name: 'dataops', type: 'dir' }]);
  startSession.mockResolvedValue({
    ok: true,
    sessionName: 'git-dataops-2',
    folder: `${HOME}/git`,
    via: 'helper',
  });
});

/** The button whose label starts with [label], out of the whole dialog. */
function button(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('button').find((b) => b.text().startsWith(label));
}

/**
 * The session names the dialog has emitted on `started`, lazily.
 *
 * The emit now carries the full optimistic row (`SessionSummary`, built by
 * `summaryFromStartResult`) rather than a bare name — the panel files it as a
 * pending session and navigates without a listing round trip — so the
 * assertions read the row's `name` out of each payload. A function, not a
 * value, so every read sees the emissions made up to that point.
 */
function startedNames(wrapper: VueWrapper) {
  return expect(
    (wrapper.emitted('started') ?? []).map((payload) => (payload[0] as { name: string }).name),
  );
}

describe('NewSessionDialog startIn', () => {
  it('lands the browser on the given folder rather than on $HOME', async () => {
    await open(`${HOME}/git`);
    expect(useProjectsStore().cwd).toBe('/home/alexey/git');
    // `$HOME` is still resolved — every displayed path and the name preview are
    // written relative to it — it is just not where the browse lands.
    expect(useProjectsStore().home).toBe(HOME);
  });

  it('keeps landing on $HOME when nothing is given', async () => {
    await open(null);
    expect(useProjectsStore().cwd).toBe(HOME);
  });

  it('leaves NO target when the folder is not on the host', async () => {
    // The stale-cwd trap. A previous open left the browser somewhere real; the
    // root this open asks for does not exist.
    const projects = useProjectsStore();
    projects.cwd = `${HOME}/git/dataops`;
    realPath.mockRejectedValue(new Error('No such file'));

    const wrapper = await open(`${HOME}/tmp`);

    expect(projects.cwd).toBe('');
    expect(projects.browseError).toContain('No such file');
    // Start is dead: with no cwd there is no folder to create a session in, so
    // the failure costs the user a message rather than a session in the wrong
    // place.
    const start = wrapper.findAll('button').find((b) => b.text().includes('Start session'));
    expect(start?.attributes('disabled')).toBeDefined();
  });

  it('does not inherit a folder left over from a previous open', async () => {
    // Same guard, in the case where the browse SUCCEEDS: the cwd that shows is
    // the one asked for, never the one that happened to be there.
    const projects = useProjectsStore();
    projects.cwd = `${HOME}/git/dataops`;
    await open(`${HOME}/tmp`);
    expect(projects.cwd).toBe('/home/alexey/tmp');
  });

  it('re-resolves home and lists the new host after switching connections', async () => {
    // The projects store is shared by the session panel and this dialog. Before
    // it was connection-scoped, the second open saw `/home/alexey` and a
    // non-empty cwd from Hetzner, skipped projects.home(), and asked SFTP on the
    // Docker host to list a path that does not exist there.
    home
      .mockResolvedValueOnce({ ok: true, home: HOME })
      .mockResolvedValueOnce({ ok: true, home: '/home/testuser' });
    list.mockImplementation(async (_id, path) =>
      path === '/home/testuser'
        ? [
            { name: 'git', type: 'dir' },
            { name: 'tmp', type: 'dir' },
          ]
        : [{ name: 'old-host-only', type: 'dir' }],
    );

    const hetzner = await open(null, 'conn-hetzner');
    expect(useProjectsStore().home).toBe(HOME);
    expect(useProjectsStore().cwd).toBe(HOME);
    hetzner.unmount();

    const local = await open(null, 'conn-pocketshell-local');

    expect(home).toHaveBeenCalledTimes(2);
    expect(useProjectsStore().home).toBe('/home/testuser');
    expect(useProjectsStore().cwd).toBe('/home/testuser');
    expect(useProjectsStore().browseError).toBeNull();
    expect(realPath).toHaveBeenLastCalledWith('conn-pocketshell-local', '/home/testuser');
    expect(list).toHaveBeenLastCalledWith('conn-pocketshell-local', '/home/testuser');
    expect(useProjectsStore().dirs.map((entry) => entry.name)).toEqual(['git', 'tmp']);
    local.unmount();
  });

  it('passes absolute paths to SFTP after resolving a tilde home', async () => {
    const wrapper = await open(null, 'conn-pocketshell-local');

    expect(realPath).toHaveBeenCalledWith('conn-pocketshell-local', HOME);
    expect(realPath).not.toHaveBeenCalledWith('conn-pocketshell-local', '~');
    wrapper.unmount();
  });
});

/**
 * The folder -> agent chain (docs/SESSIONLIST.md §13, superseded).
 *
 * §13 refused this chain on ONE load-bearing ground: `NewSessionDialog` used
 * to create at Start, while `LaunchSessionDialog` was built so that cancelling
 * costs nothing — so chaining agent AFTER the create would strand a session on
 * the host. The chain now exists, and these are the tests that say the
 * objection was answered rather than ignored: the agent step runs on a
 * PREDICTED folder and the commit path is deferred behind it, so every abandon
 * route leaves the host exactly as it was.
 */
describe('NewSessionDialog agent chain', () => {
  it('creates NOTHING when the agent step is raised', async () => {
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start session')!.trigger('click');
    await flush(wrapper);

    // The agent step is up …
    expect(wrapper.text()).toContain('Session type');
    // … and the host has not been asked for anything.
    expect(startSession).not.toHaveBeenCalled();
    expect(parkedAgentLaunch.value).toBeNull();
  });

  it('creates NOTHING when the agent step is cancelled', async () => {
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start session')!.trigger('click');
    await flush(wrapper);
    await button(wrapper, 'Cancel')!.trigger('click');
    await flush(wrapper);

    expect(startSession).not.toHaveBeenCalled();
    // And the browse survived the round trip, so cancelling is a step back
    // rather than a restart.
    expect(useProjectsStore().cwd).toBe(`${HOME}/git`);
    expect(wrapper.text()).toContain('Existing folder');
  });

  it('creates once the agent is confirmed, and parks the launch', async () => {
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start session')!.trigger('click');
    await flush(wrapper);
    await button(wrapper, 'Create session')!.trigger('click');
    await flush(wrapper);

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0]![1]).toMatchObject({
      folder: `${HOME}/git`,
      namePolicy: 'unique',
    });
    // The panel cannot type into a PTY it does not have, so the launch is
    // parked for the workspace to collect. Against the session the HOST named.
    expect(parkedAgentLaunch.value).toMatchObject({
      connectionId: 'conn-1',
      session: 'git-dataops-2',
      choice: { kind: 'claude', dir: `${HOME}/git` },
    });
  });

  it('parks the launch at the folder the HOST resolved, not the predicted one', async () => {
    // The clone route predicts a leaf under the clone root; the host can hand
    // back somewhere else entirely (a repo already on disk). `--dir` at a
    // directory that is not there is the failure agentLaunch.ts exists to stop.
    startSession.mockResolvedValue({
      ok: true,
      sessionName: 'git-dataops-2',
      folder: '/srv/checkouts/dataops',
      via: 'helper',
    });
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start session')!.trigger('click');
    await flush(wrapper);
    await button(wrapper, 'Create session')!.trigger('click');
    await flush(wrapper);

    expect(parkedAgentLaunch.value?.choice.dir).toBe('/srv/checkouts/dataops');
  });

  it('still starts a plain shell in one click, with no launch parked', async () => {
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start shell')!.trigger('click');
    await flush(wrapper);

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(parkedAgentLaunch.value).toBeNull();
  });

  it('parks the launch BEFORE it asks to be navigated', async () => {
    // Order, not merely presence: `FolderWorkspaceView` reads the slot as it
    // mounts and `started` is what mounts it, so a park that landed after the
    // emit would be a park nobody collects — the user picks Claude and gets a
    // shell.
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start session')!.trigger('click');
    await flush(wrapper);
    await button(wrapper, 'Create session')!.trigger('click');
    await flush(wrapper);

    startedNames(wrapper).toEqual(['git-dataops-2']);
    expect(parkedAgentLaunch.value?.session).toBe('git-dataops-2');
  });
});

/**
 * What a create ANSWERS with.
 *
 * There used to be a green "Started `git-dataops-2`" banner with an `Open
 * session` button under it, and the user had to press it. Success is not news —
 * it is what was asked for — so the ordinary create now emits `started` the
 * moment the host names the session and the panel navigates. What is left of
 * the outcome panel is the answers that are not simply "yes".
 */
describe('NewSessionDialog outcome', () => {
  it('opens the session immediately, with no banner in between', async () => {
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start shell')!.trigger('click');
    await flush(wrapper);

    startedNames(wrapper).toEqual(['git-dataops-2']);
    // Not merely dismissed quickly — never rendered at all.
    expect(wrapper.find('.result-banner').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Started');
  });

  it('holds the panel for a raw-tmux create, because that one has a caveat', async () => {
    // `tmux-fallback` means the helper was unusable, so the session was made
    // with raw `tmux` and carries NO memory cap. That is true for as long as it
    // lives and is visible nowhere else, and navigating away the instant it is
    // created is exactly how a warning goes unread.
    startSession.mockResolvedValue({
      ok: true,
      sessionName: 'git-dataops-2',
      folder: `${HOME}/git`,
      via: 'tmux-fallback',
    });
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start shell')!.trigger('click');
    await flush(wrapper);

    expect(wrapper.emitted('started')).toBeUndefined();
    expect(wrapper.text()).toContain('no memory cap');

    // And the session is still one click away — the button is the only reason
    // holding here is acceptable.
    await button(wrapper, 'Open session')!.trigger('click');
    startedNames(wrapper).toEqual(['git-dataops-2']);
  });

  it('holds the panel on a failure, and navigates nowhere', async () => {
    startSession.mockResolvedValue({
      ok: false,
      sessionName: null,
      folder: null,
      reused: false,
      via: null,
      error: 'Start folder does not exist on the host: /home/alexey/git',
      code: 'folder-missing',
    });
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start shell')!.trigger('click');
    await flush(wrapper);

    expect(wrapper.emitted('started')).toBeUndefined();
    expect(wrapper.text()).toContain('That folder is not on the host');
    // `Start another` is the way back to the picker that keeps the browse.
    await button(wrapper, 'Start another')!.trigger('click');
    await flush(wrapper);
    expect(wrapper.find('.result-banner').exists()).toBe(false);
    expect(wrapper.text()).toContain('Existing folder');
  });
});

/**
 * The busy mark belongs to the button that was pressed.
 *
 * It used to be a loose icon in the gap between `Cancel` and `Start shell`,
 * attached to neither — "the loader here seems strange … in that place it's
 * super weird". Both commit buttons now carry their own, and both reserve the
 * space for it always, so the bar has one width whether or not it is working.
 */
describe('NewSessionDialog busy mark', () => {
  it('spins in the button doing the work, and nowhere else', async () => {
    let finish!: (result: unknown) => void;
    startSession.mockReturnValue(
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = await open(`${HOME}/git`);
    await button(wrapper, 'Start shell')!.trigger('click');
    await flush(wrapper);

    expect(button(wrapper, 'Start shell')!.find('.spin').exists()).toBe(true);
    // The other commit button keeps its reserved, hidden mark: it is not the
    // one being waited on, and it must not change width while this runs.
    const other = button(wrapper, 'Start session')!;
    expect(other.find('.spin').exists()).toBe(false);
    expect(other.find('.idle-mark').exists()).toBe(true);
    // Both stay disabled for the duration.
    expect(button(wrapper, 'Start shell')!.attributes('disabled')).toBeDefined();
    expect(other.attributes('disabled')).toBeDefined();

    finish({ ok: true, sessionName: 'git-dataops-2', folder: `${HOME}/git`, via: 'helper' });
    await flush(wrapper);
    startedNames(wrapper).toEqual(['git-dataops-2']);
  });

  it('reserves the space for the mark when nothing is running', async () => {
    const wrapper = await open(`${HOME}/git`);
    expect(button(wrapper, 'Start shell')!.find('.idle-mark').exists()).toBe(true);
    expect(button(wrapper, 'Start session')!.find('.idle-mark').exists()).toBe(true);
    expect(wrapper.findAll('.spin')).toHaveLength(0);
  });
});

/**
 * The folder search box.
 *
 * The property that matters is the one `fileListView.ts` was written around
 * and the reason this reuses it rather than re-implementing `.includes()`: the
 * filter runs over the WHOLE listing, so a folder past the render cap is
 * findable. A filter over the rendered rows would only search what the user
 * had already scrolled to.
 */
describe('NewSessionDialog folder search', () => {
  const many = Array.from({ length: 140 }, (_, i) => ({
    name: `proj-${String(i).padStart(3, '0')}`,
    type: 'dir',
  }));

  async function search(wrapper: VueWrapper, text: string): Promise<void> {
    const box = wrapper.get('input[aria-label="Search folders in this directory"]');
    await box.setValue(text);
    await flush(wrapper);
  }

  function rows(wrapper: VueWrapper): string[] {
    return wrapper.findAll('.folder-name').map((n) => n.text());
  }

  it('finds a folder that sits past the render cap', async () => {
    list.mockResolvedValue(many);
    const wrapper = await open(`${HOME}/git`);
    // Row 132 is not rendered before the search …
    expect(rows(wrapper)).toHaveLength(100);
    expect(rows(wrapper)).not.toContain('proj-132');

    await search(wrapper, 'proj-132');
    expect(rows(wrapper)).toEqual(['proj-132']);
  });

  it('says so when nothing matches, rather than looking like an empty folder', async () => {
    list.mockResolvedValue(many);
    const wrapper = await open(`${HOME}/git`);
    await search(wrapper, 'nothing-like-this');
    expect(rows(wrapper)).toEqual([]);
    expect(wrapper.text()).toContain('nothing matches');
  });

  it('matches case-insensitively', async () => {
    list.mockResolvedValue([{ name: 'DataOps', type: 'dir' }]);
    const wrapper = await open(`${HOME}/git`);
    await search(wrapper, 'dataops');
    expect(rows(wrapper)).toEqual(['DataOps']);
  });

  it('clears the query on a `cd`, so the next folder is not rendered as empty', async () => {
    list.mockResolvedValue(many);
    const wrapper = await open(`${HOME}/git`);
    await search(wrapper, 'proj-132');

    list.mockResolvedValue([{ name: 'src', type: 'dir' }]);
    await wrapper.get('.folder-row').trigger('click');
    await flush(wrapper);

    expect(rows(wrapper)).toEqual(['src']);
    expect(
      (wrapper.get('input[aria-label="Search folders in this directory"]').element as HTMLInputElement)
        .value,
    ).toBe('');
  });

  it('leaves the navigation affordances alone — they are not content', async () => {
    list.mockResolvedValue(many);
    const wrapper = await open(`${HOME}/git`);
    await search(wrapper, 'nothing-like-this');
    // Home, Up and the breadcrumbs live outside the list and survive a filter
    // that matches no row at all.
    expect(wrapper.find('button[title="Up one folder"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Home folder"]').exists()).toBe(true);
    expect(wrapper.findAll('.crumb').length).toBeGreaterThan(0);
  });

  it('shows the rest on demand, filtered listing and all', async () => {
    list.mockResolvedValue(many);
    const wrapper = await open(`${HOME}/git`);
    expect(rows(wrapper)).toHaveLength(100);
    await button(wrapper, 'Show more')!.trigger('click');
    await flush(wrapper);
    expect(rows(wrapper)).toHaveLength(140);
  });

  it('lists dot-prefixed directories like any other folder', async () => {
    // The user's report: their `.agents` repo was invisible to this picker —
    // a desktop "hidden file" convention applied to a remote host where a
    // leading dot is an ordinary name — and the search box swore nothing
    // matched a folder the host demonstrably has.
    list.mockResolvedValue([
      { name: 'dataops', type: 'dir' },
      { name: '.agents', type: 'dir' },
      { name: '.cache', type: 'dir' },
      { name: 'notes.txt', type: 'file' },
    ]);
    const wrapper = await open(`${HOME}/git`);
    // Sorted with the rest; the file row is still not offered.
    expect(rows(wrapper)).toEqual(['.agents', '.cache', 'dataops']);
    await search(wrapper, 'agents');
    expect(rows(wrapper)).toEqual(['.agents']);
  });
});

describe('NewSessionDialog keyboard flow', () => {
  const three = [
    { name: 'gamma', type: 'dir' },
    { name: 'alpha', type: 'dir' },
    { name: 'beta', type: 'dir' },
  ];
  const press = (wrapper: VueWrapper, key: string, opts: Record<string, unknown> = {}) =>
    wrapper
      .get('input[aria-label="Search folders in this directory"]')
      .trigger('keydown', { key, ...opts });

  const search = async (wrapper: VueWrapper, text: string): Promise<void> => {
    await wrapper.get('input[aria-label="Search folders in this directory"]').setValue(text);
    await flush(wrapper);
  };

  it('starts a session in the first match, on Enter alone', async () => {
    // The workflow the chord exists for: Ctrl+Shift+N, type, Enter. Enter acts
    // on the top hit without a preliminary ArrowDown.
    const wrapper = await open(`${HOME}/git`);
    await search(wrapper, 'dataops');
    await press(wrapper, 'Enter');
    await flush(wrapper);

    expect(startSession).toHaveBeenCalledTimes(1);
    // The picker opened at `~/git`, the match descended into it, and the
    // session targets the folder the row named.
    expect(startSession.mock.calls[0]![1]).toMatchObject({ folder: `${HOME}/git/dataops` });
  });

  it('does nothing on Enter with a blank query and no highlight', async () => {
    // With no filter and no arrow key there is no chosen folder - Enter would
    // otherwise start a session in whichever folder sorts first.
    const wrapper = await open(`${HOME}/git`);
    await press(wrapper, 'Enter');
    await flush(wrapper);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('highlights with the arrow keys and starts the highlighted row', async () => {
    list.mockResolvedValue(three);
    const wrapper = await open(`${HOME}/git`);
    // Browse sorts; the rows render alpha, beta, gamma.
    await press(wrapper, 'ArrowDown');
    await press(wrapper, 'ArrowDown');
    await flush(wrapper);
    expect(wrapper.findAll('.folder-row')[1]!.classes()).toContain('active');

    await press(wrapper, 'Enter');
    await flush(wrapper);
    expect(startSession.mock.calls[0]![1]).toMatchObject({ folder: `${HOME}/git/beta` });
  });

  it('descends without starting on Ctrl+Enter', async () => {
    // The keyboard's way to browse INTO a nested folder on the way to a
    // deeper match - the plain Enter starts, so it cannot also be the descent.
    list.mockResolvedValue(three);
    const wrapper = await open(`${HOME}/git`);
    await search(wrapper, 'beta');
    await press(wrapper, 'Enter', { ctrlKey: true });
    await flush(wrapper);

    expect(useProjectsStore().cwd).toBe(`${HOME}/git/beta`);
    expect(startSession).not.toHaveBeenCalled();
  });
});

describe('NewSessionDialog search focus', () => {
  // jsdom focuses only elements that are in the document, and `open` mounts
  // detached, so these tests attach — and unmount, so the dialog does not
  // outlive the test holding the focus it just claimed.
  async function openAttached(startIn: string | null): Promise<VueWrapper> {
    useConnectionStore().connectionId = 'conn-1';
    const wrapper = mount(NewSessionDialog, {
      props: { startIn },
      attachTo: document.body,
      global: { stubs: { OverlayPanel: { template: '<div><slot /></div>' } } },
    });
    await flush(wrapper);
    return wrapper;
  }

  const searchInput = (wrapper: VueWrapper) =>
    wrapper.get('input[aria-label="Search folders in this directory"]').element as HTMLInputElement;

  it('opens with the caret in the filter, ready to type', async () => {
    const wrapper = await openAttached(null);
    expect(document.activeElement).toBe(searchInput(wrapper));
    wrapper.unmount();
  });

  it('still lands there when the open browse disabled the input first', async () => {
    // The `startIn` landing disables the filter while it lists the directory,
    // and a disabled element cannot take focus — the mount-time attempt is
    // swallowed. Focus arrives with the listing instead, so the flow the `+`
    // begins (click, type, click) does not depend on which open path ran.
    const wrapper = await openAttached(`${HOME}/git`);
    expect(document.activeElement).toBe(searchInput(wrapper));
    wrapper.unmount();
  });

  it('keeps the caret in the filter after descending a folder', async () => {
    const wrapper = await openAttached(null);
    await wrapper.get('.folder-row').trigger('click');
    await flush(wrapper);
    expect(document.activeElement).toBe(searchInput(wrapper));
    wrapper.unmount();
  });
});

describe('NewSessionDialog roots menu', () => {
  // The real PopupMenu teleports to <body>, which is right in the app and
  // invisible to `wrapper.find` here — flattened, the menu is what these tests
  // read, and its teleport is PopupMenu's own to prove.
  const MenuStub = {
    props: ['anchor', 'label'],
    template: '<div class="menu-stub" :aria-label="label"><slot /></div>',
  };

  const ROOTS = [
    { label: '~/git', path: '/home/alexey/git' },
    { label: '~/work', path: '/home/alexey/work' },
  ];

  async function openWithRoots(): Promise<VueWrapper> {
    useConnectionStore().connectionId = 'conn-1';
    const wrapper = mount(NewSessionDialog, {
      props: { startIn: null, roots: ROOTS },
      attachTo: document.body,
      global: {
        stubs: {
          OverlayPanel: { template: '<div><slot /></div>' },
          PopupMenu: MenuStub,
        },
      },
    });
    await flush(wrapper);
    return wrapper;
  }

  it('offers the roots as a dropdown off the crumb bar', async () => {
    const wrapper = await openWithRoots();
    const trigger = wrapper.find('button[title="Project roots"]');
    expect(trigger.exists()).toBe(true);
    expect(wrapper.find('.menu-stub').exists()).toBe(false);

    await trigger.trigger('click');
    const items = wrapper.findAll('.menu-stub .menu-item');
    expect(items.map((i) => i.text().trim())).toEqual(['~/git', '~/work']);
    wrapper.unmount();
  });

  it('jumps the browser to the chosen root and closes', async () => {
    const wrapper = await openWithRoots();
    await wrapper.find('button[title="Project roots"]').trigger('click');
    await wrapper.findAll('.menu-stub .menu-item')[1]!.trigger('click');
    await flush(wrapper);

    expect(useProjectsStore().cwd).toBe('/home/alexey/work');
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders no trigger when the panel knows no root', async () => {
    useConnectionStore().connectionId = 'conn-1';
    const wrapper = mount(NewSessionDialog, {
      props: { startIn: null, roots: [] },
      attachTo: document.body,
      global: {
        stubs: {
          OverlayPanel: { template: '<div><slot /></div>' },
          PopupMenu: MenuStub,
        },
      },
    });
    await flush(wrapper);
    expect(wrapper.find('button[title="Project roots"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
