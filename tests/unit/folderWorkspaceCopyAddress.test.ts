// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The tab menu's "Copy address", tested for the two things it must get right:
 * WHAT lands on the clipboard and WHO the item serves.
 *
 * The payload is the session's aplexer UUID — the immutable id, not the
 * `workspace:tag` selector — because the whole point is pasting it into
 * ANOTHER session so the two can reach each other through `a`, and the id
 * survives the renames the menu's own "Rename…" performs while a selector
 * names the name being changed. The tests pin the exact string for that
 * reason: a selector that "mostly works" would break the day the user
 * renames the source session between copying and pasting.
 *
 * The item is ABSENT rather than disabled where the address cannot exist —
 * a tmux row addresses by its bare name and has nothing to copy, and an
 * aplexer row whose id has not landed would offer a half address. The
 * absent-not-greyed rule is the one Redraw's pairing with Files tabs set:
 * an item that greys out on half the tabs teaches the eye to skip the whole
 * menu.
 *
 * Mounting, stubbing and the ipc Proxy follow folderWorkspaceRename.test.ts
 * exactly; see the reasoning there. The copy is driven the way a user
 * reaches it — right-click the tab, "Copy address".
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const sessionsList = vi.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * The renderer api, as a Proxy — same shape as the rename test: anything not
 * named answers `Promise<undefined>`, and the named channels are the subject.
 */
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

/** An aplexer session's immutable id — what the copy must carry. */
const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

/**
 * A session row of the shape `helper.sessionsList` returns. [extra] turns it
 * into an aplexer row (backend, workspace, id) or leaves it tmux.
 */
function row(name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    name,
    created: 1,
    activity: 1,
    attached: false,
    path: '/home/me/git/x',
    agentKind: null,
    ...extra,
  };
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

/**
 * Every wrapper a test mounts, unmounted after each test — the reason is the
 * rename test's: a workspace left mounted keeps its tabs watcher and its poll
 * alive across the next test's `beforeEach`.
 */
const mounted: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  sessionsList.mockReset();
  writeText.mockReset();
  // jsdom ships no clipboard; the renderer's own copy paths
  // (`FileTree.copyPath`, the yank) go through `navigator.clipboard`, and so
  // does this feature.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
});

/** Mount the workspace on a folder holding the one seeded session. */
async function openWorkspace(sessionRow: unknown): Promise<VueWrapper> {
  sessionsList.mockResolvedValue([sessionRow]);
  useSessionsStore().sessions = [sessionRow] as never;
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  mounted.push(wrapper);
  await flush();
  return wrapper;
}

/** Right-click the session tab, leaving the menu open. */
async function openTabMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('nav.tabs button').trigger('contextmenu');
  await flush(2);
}

/** The menu item named [text], or null when the menu does not offer it. */
function menuItem(wrapper: VueWrapper, text: string):ReturnType<typeof wrapper.findAll>[number] | null {
  return wrapper.findAll('button').find((b) => b.text().trim() === text) ?? null;
}

describe('copying an aplexer session address from the tab menu', () => {
  it('offers Copy address and puts the immutable id on the clipboard', async () => {
    writeText.mockResolvedValue(undefined);
    const wrapper = await openWorkspace(
      row('relay', {
        backend: 'aplexer',
        workspace: '/home/me/git/x',
        tag: 'relay',
        aplexerId: UUID,
      }),
    );

    await openTabMenu(wrapper);
    const item = menuItem(wrapper, 'Copy address');
    expect(item).not.toBeNull();
    await item!.trigger('click');
    await flush(2);

    // The UUID, and only the UUID — not the `workspace:tag` selector, which a
    // rename between copy and paste would orphan.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(UUID);
    // The menu closes on acting, like every sibling item.
    expect(menuItem(wrapper, 'Copy address')).toBeNull();
  });

  it('keeps the menu openable again after a copy', async () => {
    writeText.mockResolvedValue(undefined);
    const wrapper = await openWorkspace(
      row('relay', {
        backend: 'aplexer',
        workspace: '/home/me/git/x',
        tag: 'relay',
        aplexerId: UUID,
      }),
    );

    await openTabMenu(wrapper);
    await menuItem(wrapper, 'Copy address')!.trigger('click');
    await flush(2);
    await openTabMenu(wrapper);
    expect(menuItem(wrapper, 'Copy address')).not.toBeNull();
  });
});

describe('where the address cannot exist, the item is absent, not greyed', () => {
  it('offers no Copy address for a tmux row', async () => {
    const wrapper = await openWorkspace(row('git-x'));

    await openTabMenu(wrapper);
    // The rest of the menu still stands — the absence is the item's, not the
    // menu's.
    expect(menuItem(wrapper, 'Rename…')).not.toBeNull();
    expect(menuItem(wrapper, 'Copy address')).toBeNull();
  });

  it('offers no Copy address for an aplexer row whose id has not landed', async () => {
    const wrapper = await openWorkspace(
      row('relay', { backend: 'aplexer', workspace: '/home/me/git/x', tag: 'relay' }),
    );

    await openTabMenu(wrapper);
    expect(menuItem(wrapper, 'Copy address')).toBeNull();
  });
});

describe('a clipboard the user has denied', () => {
  it('fails quietly — no error strip, no unhandled rejection', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const wrapper = await openWorkspace(
      row('relay', {
        backend: 'aplexer',
        workspace: '/home/me/git/x',
        tag: 'relay',
        aplexerId: UUID,
      }),
    );

    await openTabMenu(wrapper);
    await menuItem(wrapper, 'Copy address')!.trigger('click');
    await flush(2);

    // The same policy FileTree's copy-path keeps: a refused clipboard is not
    // a banner over a value the menu can hand out again on the next click.
    expect(wrapper.find('.bar-error').exists()).toBe(false);
  });
});
