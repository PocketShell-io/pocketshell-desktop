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
