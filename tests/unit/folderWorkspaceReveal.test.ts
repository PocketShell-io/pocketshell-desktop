// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * Where a path clicked in the terminal lands, when it is not in this folder.
 *
 * The user clicked a generated image at
 * `~/.codex/generated_images/…/exec-….png` from a session running in a repo and
 * said: "also note that this image is outside of the current repo. I still want
 * to see it. we can open it in a separate new tab."
 *
 * Two facts about the old behaviour are worth stating, because only one of them
 * was broken. Nothing ever stopped the path OPENING — the files store browses
 * by absolute path over SFTP and knows nothing about a root, and `~/x` needs no
 * `$HOME` expansion because an SFTP session's relative root IS the login home.
 * What it did was reveal into the FOLDER's own Files tab, and since every Files
 * tab remembers its directory that tab then stayed
 * parked outside the repo. So this file asserts the split: inside the folder
 * reuses the tab that is already there, outside it gets one of its own and
 * leaves the first one alone.
 *
 * The workspace no longer SEEDS a Files tab (the user asked to see Files only
 * when it is needed), so most cases here start from a bar with no Files tab at
 * all — and the watcher's answer either way is that the click lands somewhere:
 * a tab is opened for it rather than dropped.
 *
 * FilesView is stubbed. What is under test is the TAB decision, which is the
 * workspace's; the reveal's own consumption is pinned in filesStore.test.ts and
 * the SFTP round trips would need a host.
 */

const route = ref({ params: { name: 'host', folder: '~/git/x' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

/**
 * What the host answers when asked for `$HOME`. Mutable because one case is a
 * host that never answers at all, and `ensureHome` is called on mount.
 */
let homeResult: unknown = { ok: true, home: '/home/me', error: null };

/** Same Proxy api as the other folder-workspace tests: unnamed channels no-op. */
const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': vi.fn().mockResolvedValue([]),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.home': (): Promise<unknown> => Promise.resolve(homeResult),
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
  // folder arrival asks of the pane in front; missing it would be a TypeError
  // at the call site, not a silent skip.
  TerminalView: { template: '<div class="stub-terminal" />', methods: { focus: () => undefined } },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div><slot /></div>' },
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

/** The visible tab labels, in bar order. */
function tabLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('nav.tabs button').map((b) => b.text().trim());
}

function activeLabel(wrapper: VueWrapper): string {
  return wrapper.find('nav.tabs button.active').text().trim();
}

/** Open a Files tab the way the user does, through the `+` menu. */
async function openFilesTab(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.tab.add').trigger('click');
  const item = wrapper.findAll('.menu-item').find((b) => b.text() === 'New Files tab');
  if (!item) throw new Error('no "New Files tab" item on the + menu');
  await item.trigger('click');
  await flush();
}

const IMAGE = '/home/me/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-1.png';

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  homeResult = { ok: true, home: '/home/me', error: null };
  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/me';
  useSessionsStore().sessions = [
    { name: 'git-x', created: 1, activity: 1, attached: false, path: '/home/me/git/x' },
  ] as never;
});

describe('a terminal path revealed from the folder workspace', () => {
  it('opens a path outside the folder in a Files tab of its own', async () => {
    const wrapper = await openWorkspace();
    // No Files tab is seeded: the bar starts with the session tab only.
    expect(tabLabels(wrapper)).toEqual(['git-x']);

    useFilesStore().requestReveal(IMAGE);
    await flush();

    // One Files tab, opened for the click, and it is the one in front.
    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
    expect(activeLabel(wrapper)).toBe('Files');
  });

  it('leaves the request parked for the new tab to take', async () => {
    const wrapper = await openWorkspace();
    useFilesStore().requestReveal(IMAGE);
    await flush();

    // Taken and re-parked, unchanged: `resolveRemotePath` returns an absolute
    // path untouched, so the round trip through the store cannot mangle it. The
    // FilesView that mounts into the new tab is what consumes it.
    expect(useFilesStore().reveal).toBe(IMAGE);
    expect(wrapper.exists()).toBe(true);
  });

  it('reuses the tab it already opened for a second image beside the first', async () => {
    const wrapper = await openWorkspace();
    useFilesStore().requestReveal(IMAGE);
    await flush();

    useFilesStore().requestReveal(IMAGE.replace('exec-1.png', 'exec-2.png'));
    await flush();

    // "a separate new tab", not one tab per image: the tab standing over that
    // directory serves the next click in it too.
    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
  });

  it('expands a home-relative target before deciding it is outside', async () => {
    const wrapper = await openWorkspace();
    // What `~/.codex/…` becomes on its way to SFTP: relative to the login home,
    // which is the only form the inside/outside comparison has to expand.
    useFilesStore().requestReveal('~/.codex/generated_images/uuid/exec-3.png');
    await flush();

    expect(useFilesStore().reveal).toBe('.codex/generated_images/uuid/exec-3.png');
    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
  });

  it('keeps a path INSIDE the folder in the Files tab that is already there', async () => {
    const wrapper = await openWorkspace();
    await openFilesTab(wrapper);

    useFilesStore().requestReveal('/home/me/git/x/src/main.ts');
    await flush();

    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
    expect(activeLabel(wrapper)).toBe('Files');
  });

  it('opens a Files tab for an inside path too, when none is standing', async () => {
    const wrapper = await openWorkspace();

    // The reuse rule above needs a tab to reuse. With none standing — the
    // ordinary state of a fresh workspace now — the click still lands: the
    // watcher opens one at the path's parent and hands it the reveal.
    useFilesStore().requestReveal('/home/me/git/x/src/main.ts');
    await flush();

    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
    expect(activeLabel(wrapper)).toBe('Files');
    expect(useFilesStore().reveal).toBe('/home/me/git/x/src/main.ts');
  });

  it('falls back to opening a tab when the host never reported a $HOME', async () => {
    homeResult = { ok: false, home: null, error: 'no $HOME' };
    useProjectsStore().home = null;
    const wrapper = await openWorkspace();

    // Without the home there is no absolute root to compare against, and not
    // knowing is not evidence that the two are apart. What "what it did before"
    // now means is opening: the seeded tab this fallback used to land in is
    // gone, and dropping the click would be the only worse answer.
    useFilesStore().requestReveal(IMAGE);
    await flush();

    expect(tabLabels(wrapper)).toEqual(['git-x', 'Files']);
    expect(activeLabel(wrapper)).toBe('Files');
  });
});
