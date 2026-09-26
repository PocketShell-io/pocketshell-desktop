// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The editor bar's Download… button.
 *
 * Downloading used to be reachable only from places that required finding
 * the file AGAIN: the tree's context menu (scroll to the row, right-click)
 * and the binary panel, which a text file never enters. A file already open
 * in the editor had no affordance at all, and with a few hundred entries in
 * the directory the hunt for the row was the whole cost of the action. The
 * button in the bar closes that: whatever is open is what downloads, named
 * in the bar beside it, from where the user's eyes already are.
 *
 * Pinned here:
 *
 *   1. the bar carries the button for the open file;
 *   2. clicking it saves THE OPEN FILE through `sftp.saveAs` — the same
 *      channel the store's `download()` and the tree's row action share —
 *      not a row the user would have to hunt for;
 *   3. files with no editor at all (an image) are covered by the same
 *      button, which is their only download affordance;
 *   4. over a dirty buffer the tooltip says the copy comes from the host's
 *      saved state — the same honesty the preview toolbar carries — and a
 *      clean one does not need the caveat.
 */

const { saveAs } = vi.hoisted(() => ({ saveAs: vi.fn() }));

vi.mock('@ui/app/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, not
    // because these tests exercise them: the files store registers a stats
    // listener at module scope, and the connection store subscribes to
    // ssh.onState the moment it is built.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: { saveAs },
  },
}));

vi.mock('@ui/app/components/FileTree.vue', () => ({
  default: { name: 'FileTree', template: '<div class="file-tree-stub" />' },
}));

vi.mock('@ui/app/components/CodeEditor.vue', () => ({
  default: {
    name: 'CodeEditor',
    props: ['modelValue', 'filename'],
    template: '<div class="code-editor-stub" />',
  },
}));

const FilesView = (await import('@ui/app/views/FilesView.vue')).default;
const { useFilesStore } = await import('@ui/app/stores/files');
const { useConnectionStore } = await import('@ui/app/stores/connection');

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  saveAs.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/**
 * Mounted with NO connection id, so `onMounted`'s `files.open()` is skipped
 * and no SFTP listing needs faking; the id is set on the connection store
 * directly, which is all `onDownload` reads at click time.
 */
function mountWithOpenFile(mode: 'text' | 'image'): { w: VueWrapper; openPath: string } {
  const w = mount(FilesView);
  const files = useFilesStore();
  const openPath = '/home/u/report.csv';
  files.openPath = openPath;
  files.openMode = mode;
  useConnectionStore().connectionId = 'conn-1';
  return { w, openPath };
}

describe('FilesView editor-bar download', () => {
  it('carries a Download button in the editor bar', async () => {
    wrapper = mountWithOpenFile('text').w;
    await nextTick();

    const btn = wrapper.find('.editor-bar .download-btn');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('Download');
  });

  it('saves the OPEN file through the native dialog, not a tree row', async () => {
    saveAs.mockResolvedValue('/home/u/Downloads/report.csv');
    const { w, openPath } = mountWithOpenFile('text');
    wrapper = w;
    await nextTick();

    // The channel is INVOKED synchronously by the handler — the store's
    // `download()` names it before its first await — so the assertion needs
    // no promise flushing, only the tick `trigger` already returns.
    await w.find('.editor-bar .download-btn').trigger('click');

    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(saveAs).toHaveBeenCalledWith({ connectionId: 'conn-1', remotePath: openPath });
  });

  it("covers files with no editor — an image's only download affordance", async () => {
    saveAs.mockResolvedValue('/home/u/Downloads/report.csv');
    const { w, openPath } = mountWithOpenFile('image');
    wrapper = w;
    await nextTick();

    await w.find('.editor-bar .download-btn').trigger('click');

    expect(saveAs).toHaveBeenCalledWith({ connectionId: 'conn-1', remotePath: openPath });
  });

  it('says over a dirty buffer that the copy is the saved one', async () => {
    const { w } = mountWithOpenFile('text');
    wrapper = w;
    useFilesStore().dirty = true;
    await nextTick();

    expect(w.find('.editor-bar .download-btn').attributes('title')).toContain(
      'unsaved edits are not included',
    );
  });

  it('needs no caveat on a clean buffer', async () => {
    const { w } = mountWithOpenFile('text');
    wrapper = w;
    await nextTick();

    expect(w.find('.editor-bar .download-btn').attributes('title')).not.toContain('unsaved');
  });
});
