// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * "Go to the workspace root" — one jump out of a deep tree, as the strip's
 * home button and as the `files.goRoot` chord (Ctrl+Shift+H).
 *
 * Pinned here:
 *
 *   1. the button routes through `files.revealPath` with the workspace's own
 *      path — resolution and error reporting are revealPath's, not this
 *      button's;
 *   2. a workspace path that arrives as a literal `~/git/x` (tmux reports
 *      them unexpanded) is handed on SFTP-relative, because an SFTP channel
 *      has no shell to expand a tilde — the same rule the path bar runs on;
 *   3. with no workspace path to name (an untracked pseudo-folder), the jump
 *      falls back to the login home, the tab's own seeding default;
 *   4. the chord fires from the Files pane's root handler and reaches the
 *      tree's exposed `goRoot` — the same route Ctrl+L takes to the path bar.
 *
 * FileTree is the real component in both describes: the chord test exists
 * precisely to prove the ref-and-ask seam between FilesView and FileTree,
 * which a stub would quietly hollow out.
 */

vi.mock('@ui/app/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, and because
    // FilesView's mount opens the tab: realPath resolves the start directory,
    // list fills it.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {
      realPath: vi.fn(async (_c: string, p: string) => (p === '.' ? '/home/u' : p)),
      list: vi.fn(async () => []),
    },
  },
}));

const FileTree = (await import('@ui/app/components/FileTree.vue')).default;
const FilesView = (await import('@ui/app/views/FilesView.vue')).default;
const { useFilesStore } = await import('@ui/app/stores/files');
const { useConnectionStore } = await import('@ui/app/stores/connection');

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function flush(): Promise<void> {
  await nextTick();
  await wrapper?.vm.$nextTick();
}

function homeButton(w: VueWrapper) {
  return w.find('button[title^="Go to the workspace root"]');
}

describe('FileTree home button', () => {
  it('reveals the workspace root, absolute paths passing through untouched', async () => {
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const files = useFilesStore();
    files.cwd = '/home/u/proj/node_modules/pkg/dist';
    const reveal = vi.spyOn(files, 'revealPath').mockResolvedValue(undefined);

    wrapper = mount(FileTree, { props: { rootPath: '/home/u/proj' } });
    await flush();

    expect(homeButton(wrapper).exists()).toBe(true);
    await homeButton(wrapper).trigger('click');

    expect(reveal).toHaveBeenCalledWith('conn-1', '/home/u/proj');
  });

  it('hands a literal `~/git/x` root on SFTP-relative', async () => {
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const files = useFilesStore();
    files.cwd = '/home/u';
    const reveal = vi.spyOn(files, 'revealPath').mockResolvedValue(undefined);

    wrapper = mount(FileTree, { props: { rootPath: '~/proj' } });
    await flush();
    await homeButton(wrapper).trigger('click');

    // An SFTP channel has no shell: `~/proj` would look for a DIRECTORY named
    // `~`. Relative resolution lands on the same folder in one round trip.
    expect(reveal).toHaveBeenCalledWith('conn-1', 'proj');
  });

  it('falls back to the login home when the workspace has no path', async () => {
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const files = useFilesStore();
    files.cwd = '/var/log/remote';
    const reveal = vi.spyOn(files, 'revealPath').mockResolvedValue(undefined);

    wrapper = mount(FileTree);
    await flush();
    await homeButton(wrapper).trigger('click');

    // `.` is the SFTP session's own root — the login home — which realPath
    // resolves; the spied revealPath keeps the assertion on the hand-off.
    expect(reveal).toHaveBeenCalledWith('conn-1', '.');
  });
});

describe('FilesView files.goRoot chord', () => {
  it('Ctrl+Shift+H jumps to the workspace root through the tree', async () => {
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const files = useFilesStore();
    const reveal = vi.spyOn(files, 'revealPath').mockResolvedValue(undefined);

    wrapper = mount(FilesView, {
      attachTo: document.body,
      props: { rootPath: '/home/u/proj' },
    });
    await flush();

    (wrapper.element as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'H',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(reveal).toHaveBeenCalledWith('conn-1', '/home/u/proj');
  });
});
