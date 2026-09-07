// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The inline tab rename, tested for the one thing it did not do: say WHY it
 * failed where the user can see it.
 *
 * The bug: `renameError` surfaced only as a hover tooltip on the field and a
 * 1px border tint. A user who pressed Enter and got a host-side refusal saw a
 * field that just stayed, subtly red, with no sentence anywhere — and on the
 * commit-on-blur path the field was not even focused, so there was nothing to
 * hover either. A refused CREATE has always rendered as a sentence in the
 * `.bar-error` strip; a refused rename now renders in the same strip, and
 * these tests pin that.
 *
 * They also pin the strip's new dismiss button, which is the other half of the
 * same audit finding: the strip used to persist until the next action or a
 * folder switch, with no way to take a long message down by hand.
 *
 * The third block pins what a SUCCESSFUL commit does, or rather what it must
 * not do: a tab's id is the session name, so a rename that waited for the
 * session listing used to keep the old name on the bar for a whole round trip
 * and then remount the pane (new v-for key), closing its shell and paying a
 * full re-join — a relabel that visibly reconnects. The commit now renames the
 * local row and the pane record in one tick, and these tests hold it to that.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceCreate.test.ts
 * exactly; see the reasoning there. The rename is driven the way a user
 * reaches it — right-click the tab, "Rename…" — because click-to-rename has no
 * other discoverable entry.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const renameSession = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * The renderer api, as a Proxy — same shape as the create test: anything not
 * named answers `Promise<undefined>`, and the named channels are the subject.
 */
const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': (...a: unknown[]) => sessionsList(...a),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.renameSession': (...a: unknown[]) => renameSession(...a),
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

/** A session row of the shape `helper.sessionsList` returns. */
function row(name: string, created = 1): unknown {
  return {
    name,
    created,
    activity: created,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
  };
}

/** What the host says when it refuses to rename. */
function refused(error: string): unknown {
  return { ok: false, sessionName: null, error, code: 'rename-failed' };
}

const stubs = {
  // `focus` is part of the real TerminalView's exposed surface and is what a
  // folder arrival asks of the pane in front; missing it would be a TypeError
  // at the call site, not a silent skip.
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

/** Mount the workspace on a folder that already holds one session, `git-x`. */
async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

/** Right-click the session tab -> "Rename…", leaving the field open. */
async function beginRename(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('nav.tabs button').trigger('contextmenu');
  await flush(2);
  const item = wrapper.findAll('button').find((b) => b.text().trim() === 'Rename…');
  if (!item) throw new Error(`no "Rename…" item in: ${wrapper.text()}`);
  await item.trigger('click');
  await flush(2);
}

/** Type [text] into the open rename field and press Enter. */
async function typeAndCommit(wrapper: VueWrapper, text: string): Promise<void> {
  const input = wrapper.find('input.rename-input');
  await input.setValue(text);
  await input.trigger('keydown.enter');
  await flush(6);
}

/** The error line under the tab strip, or null when there is none. */
function barError(wrapper: VueWrapper): string | null {
  const el = wrapper.find('.bar-error');
  return el.exists() ? el.text() : null;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  renameSession.mockReset();
  sessionsList.mockReset();
  sessionsList.mockResolvedValue([row('git-x')]);
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [row('git-x')] as never;
});

describe('a failed tab rename is a sentence, and the sentence can be dismissed', () => {
  it('renders the host’s refusal as visible text under the tab strip', async () => {
    renameSession.mockResolvedValue(
      refused('a session named "git-x-import" already exists on this host'),
    );

    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    await typeAndCommit(wrapper, 'import');

    // `git-x` is the folder-derived name, so the field edits the REMAINDER and
    // the committed name is prefix + what was typed (workspaceTabs §4.3). The
    // fourth argument is the aplexer ref — undefined for a tmux row, which
    // addresses by bare name.
    expect(renameSession).toHaveBeenCalledWith('conn-1', 'git-x', 'git-x-import', undefined);
    // The point of the fix: the reason is ON SCREEN, not in a tooltip.
    expect(barError(wrapper)).toContain('already exists');
    // The field stays open and keeps its tint — the strip says why, the border
    // says which field.
    const input = wrapper.find('input.rename-input');
    expect(input.exists()).toBe(true);
    expect(input.classes()).toContain('invalid');
  });

  it('renders the local refusal — a name that sanitises to nothing — the same way', async () => {
    // A session whose name is NOT derived from the folder: its rename edits
    // the WHOLE name (remainder null), which is the only path where an empty
    // field cannot fall back to the prefix and has to be refused outright.
    sessionsList.mockResolvedValue([row('scratch')]);
    useSessionsStore().sessions = [row('scratch')] as never;

    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    await typeAndCommit(wrapper, '');

    // Refused before the host is even asked.
    expect(renameSession).not.toHaveBeenCalled();
    expect(barError(wrapper)).toContain('nothing a session can be called');
  });

  it('is just as loud when the failing commit came from blur, where there is no tooltip', async () => {
    renameSession.mockResolvedValue(refused('rename refused by the host'));

    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    const input = wrapper.find('input.rename-input');
    await input.setValue('git-y');
    await input.trigger('blur');
    await flush(6);

    expect(barError(wrapper)).toContain('rename refused by the host');
  });

  it('clears the sentence when the dismiss button is clicked, without abandoning the edit', async () => {
    renameSession.mockResolvedValue(refused('rename refused by the host'));

    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    await typeAndCommit(wrapper, 'git-y');
    expect(barError(wrapper)).not.toBeNull();

    await wrapper.find('button.bar-error-dismiss').trigger('click');
    await flush(2);

    // The strip is gone; the field is still open for the user to fix the name.
    expect(barError(wrapper)).toBeNull();
    expect(wrapper.find('input.rename-input').exists()).toBe(true);
  });

  it('takes the sentence down with the edit on Escape', async () => {
    renameSession.mockResolvedValue(refused('rename refused by the host'));

    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    await typeAndCommit(wrapper, 'git-y');
    expect(barError(wrapper)).not.toBeNull();

    await wrapper.find('input.rename-input').trigger('keydown.esc');
    await flush(2);

    // `cancelRename` nulls the error, so the strip cannot outlive the field it
    // was explaining.
    expect(barError(wrapper)).toBeNull();
    expect(wrapper.find('input.rename-input').exists()).toBe(false);
  });
});

describe('the double-click is the rename gesture', () => {
  it('opens the field when a session tab is double-clicked', async () => {
    const wrapper = await openWorkspace();
    await wrapper.find('nav.tabs button.tab').trigger('dblclick');
    await flush(2);

    // The field is open and holds the editable part — the remainder, since
    // `git-x` is derived from the folder.
    const input = wrapper.find('input.rename-input');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  it('opens the field straight from a background tab, selecting it on the way', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    useSessionsStore().sessions = [row('git-x'), row('git-x-2', 2)] as never;

    const wrapper = await openWorkspace();
    const tabs = wrapper.findAll('nav.tabs button.tab');
    const background = tabs[1];
    if (!background) throw new Error('no background session tab to double-click');
    await background.trigger('dblclick');
    await flush(2);

    expect(wrapper.find('input.rename-input').exists()).toBe(true);
  });

  it('does NOT open the field on a single click, active tab included', async () => {
    // The retired gesture: clicking the already-current tab used to start a
    // rename. A double-click fires a click first, so the two gestures cannot
    // coexist — and a click that opens an editor is a click that surprises.
    const wrapper = await openWorkspace();
    await wrapper.find('nav.tabs button.tab').trigger('click');
    await flush(2);
    expect(wrapper.find('input.rename-input').exists()).toBe(false);
  });

  it('leaves a Files tab alone', async () => {
    // Files tabs have no name on the host, so there is nothing a rename could
    // commit to. The tab is opened the way the user opens one, through the
    // `+` menu — no Files tab is seeded.
    const wrapper = await openWorkspace();
    await wrapper.find('.tab.add').trigger('click');
    const item = wrapper.findAll('.menu-item').find((b) => b.text() === 'New Files tab');
    if (!item) throw new Error('no "New Files tab" item on the + menu');
    await item.trigger('click');
    await flush();

    const filesTab = wrapper
      .findAll('nav.tabs button.tab')
      .find((b) => b.classes().includes('files'));
    expect(filesTab).toBeDefined();
    await filesTab!.trigger('dblclick');
    await flush(2);
    expect(wrapper.find('input.rename-input').exists()).toBe(false);
  });
});

describe('a committed rename is a relabel, not a reconnect', () => {
  /** What the host says when a rename lands. */
  function accepted(sessionName: string): unknown {
    return { ok: true, sessionName, error: null, code: null };
  }

  /**
   * The host accepts the rename, and a later listing reports the new name —
   * which is what makes the commit's fire-and-forget confirmation safe to let
   * land in a test: it must agree with the optimistic row, not clobber it.
   */
  function hostAccepts(sessionName: string, rows: unknown[]): void {
    renameSession.mockImplementation(() => {
      sessionsList.mockResolvedValue(rows);
      return Promise.resolve(accepted(sessionName));
    });
  }

  it('re-labels the tab and renames the row WITHOUT waiting for the listing', async () => {
    // The listing is the slowest call in the app; hold it forever, so the only
    // way the new name can reach the bar is the local rewrite.
    sessionsList.mockReturnValue(new Promise(() => undefined));
    renameSession.mockResolvedValue(accepted('git-x-import'));

    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    await typeAndCommit(wrapper, 'import');

    // The commit still went to the host under the derived name...
    expect(renameSession).toHaveBeenCalledWith('conn-1', 'git-x', 'git-x-import', undefined);
    // ...and the bar moved anyway, with the listing still in flight.
    expect(wrapper.find('nav.tabs button.tab').text()).toContain('import');
    expect(useSessionsStore().sessions.map((s) => s.name)).toEqual(['git-x-import']);
    // The listing was still asked for once — confirmation, not revelation.
    expect(sessionsList).toHaveBeenCalledTimes(1);
  });

  it('keeps the same terminal pane mounted — a rename does not re-join', async () => {
    hostAccepts('git-x-import', [row('git-x-import')]);

    const wrapper = await openWorkspace();
    const paneBefore = wrapper.find('.stub-terminal').element;
    await beginRename(wrapper);
    await typeAndCommit(wrapper, 'import');

    // The old flow changed the v-for key (the tab id IS the session name), so
    // Vue replaced the pane — closing its shell and re-joining. Same DOM node
    // across the commit is the proof the instance survived.
    expect(wrapper.find('.stub-terminal').element).toBe(paneBefore);
  });

  it('keeps a manual tab position across the rename', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    useSessionsStore().sessions = [row('git-x'), row('git-x-2', 2)] as never;
    // The user dragged `git-x-2` to the front at some point; the ranking is
    // stored under tab ids, which are session names — so under this ranking
    // the tab the rename helper reaches (the first) is `git-x-2`.
    localStorage.setItem('ps.tabOrder.host.~/git/x', JSON.stringify(['git-x-2', 'git-x']));

    // The host renames that tab, and its listing now reports the new name in
    // its place — same created stamp, same position in the bar.
    hostAccepts('git-x-import', [row('git-x'), row('git-x-import', 2)]);
    const wrapper = await openWorkspace();
    await beginRename(wrapper);
    await typeAndCommit(wrapper, 'import');

    // The renamed id is remapped in the stored ranking, not pruned as a dead
    // tab — otherwise a rename would silently drop the tab's manual position.
    expect(JSON.parse(localStorage.getItem('ps.tabOrder.host.~/git/x') ?? '[]')).toEqual([
      'git-x-import',
      'git-x',
    ]);
    const labels = wrapper.findAll('nav.tabs button.tab').map((b) => b.text());
    expect(labels[0]).toContain('import');
    expect(labels[1]).toContain('main');
  });

  it('renaming a background tab leaves the selection alone', async () => {
    sessionsList.mockResolvedValue([row('git-x'), row('git-x-2', 2)]);
    useSessionsStore().sessions = [row('git-x'), row('git-x-2', 2)] as never;
    hostAccepts('git-x-staging', [row('git-x'), row('git-x-staging', 2)]);

    const wrapper = await openWorkspace();
    const tabs = wrapper.findAll('nav.tabs button.tab');
    const background = tabs[1];
    if (!background) throw new Error('no background session tab to rename');
    await background.trigger('contextmenu');
    await flush(2);
    const item = wrapper.findAll('button').find((b) => b.text().trim() === 'Rename…');
    if (!item) throw new Error(`no "Rename…" item in: ${wrapper.text()}`);
    await item.trigger('click');
    await flush(2);
    await typeAndCommit(wrapper, 'staging');

    // Committing a label is not a request to be moved: the first tab stays
    // active, and the renamed one shows its new name in place.
    expect(wrapper.find('nav.tabs button.tab.active').text()).toContain('main');
    const labels = wrapper.findAll('nav.tabs button.tab').map((b) => b.text());
    expect(labels[1]).toContain('staging');
    expect(useSessionsStore().sessions.map((s) => s.name)).toEqual([
      'git-x',
      'git-x-staging',
    ]);
  });
});
