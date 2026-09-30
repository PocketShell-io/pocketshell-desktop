// @vitest-environment jsdom
//
// The Files tree's delete: the row menu's one destructive item, the sheet
// that asks before acting, and the button wiring between them. The store's
// side — which entry goes, what the deleted bytes take with them — has its
// own suite in filesStoreDelete.test.ts; these pin what a user can reach:
// the item exists, nothing is removed without the confirm, and a refusal
// lands in the footer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { DirEntry } from '../../src/main/sftp/SftpService';

function entry(name: string, type: DirEntry['type'], size = 0): DirEntry {
  return { name, type, size, longname: name, modifyTime: 0, accessTime: 0, rights: { user: 'rwx', group: 'rwx', other: 'rwx' }, owner: 'testuser', group: 'testuser' } as unknown as DirEntry;
}

const deleteFile = vi.fn<(connectionId: string, path: string) => Promise<boolean>>();
const rmdir = vi.fn<(connectionId: string, path: string) => Promise<boolean>>();

vi.mock('@ui/app/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, not
    // because these tests exercise them. `list`/`realPath` because a
    // confirmed delete re-lists the browsed directory on success.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {
      list: vi.fn(() => Promise.resolve([])),
      realPath: vi.fn((_c: string, p: string) => Promise.resolve(p)),
      deleteFile: (connectionId: string, path: string) => deleteFile(connectionId, path),
      rmdir: (connectionId: string, path: string) => rmdir(connectionId, path),
    },
  },
}));

const FileTree = (await import('@ui/app/components/FileTree.vue')).default;
const { useFilesStore } = await import('@ui/app/stores/files');
const { useConnectionStore } = await import('@ui/app/stores/connection');

async function flush(wrapper: VueWrapper): Promise<void> {
  await nextTick();
  await wrapper.vm.$nextTick();
}

let attached: VueWrapper | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
  deleteFile.mockReset().mockResolvedValue(true);
  rmdir.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  // Mounted attached, because focus() only lands in-document.
  attached?.unmount();
  attached = undefined;
});

async function show(entryUnderTest: DirEntry): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  const files = useFilesStore();
  files.cwd = '/proj';
  files.entries = [entryUnderTest];

  attached = mount(FileTree, {
    attachTo: document.body,
    // PopupMenu teleports to <body>, where wrapper.findAll cannot reach it.
    // The stub keeps its slot inline — the placement and dismissal it owns
    // are covered by its own tests; these are about the tree's wiring.
    // OverlayPanel is left real: the sheet is this feature's subject.
    global: { stubs: { PopupMenu: { template: '<div class="stub-menu"><slot /></div>' } } },
  });
  await flush(attached);

  // Row 0 is the `..` navigation row, which carries no row menu of its own;
  // the entry under test is the first row after it (see fileTreeCreate).
  await attached.findAll('li.entry').at(1)!.trigger('contextmenu');
  await flush(attached);
  const item = attached
    .findAll('button.menu-item')
    .find((b) => b.text().trim().startsWith('Delete'));
  if (!item) throw new Error('no Delete item in the row menu');
  await item.trigger('click');
  await flush(attached);
  return attached;
}

/** The confirm sheet's buttons, by their text. */
function sheetButton(wrapper: VueWrapper, text: string): DOMWrapper<Element> {
  const found = wrapper.findAll('button').find((b) => b.text().trim() === text);
  if (!found) throw new Error(`no button reading ${text}`);
  return found;
}

describe('FileTree delete with confirmation', () => {
  it('offers Delete on a file row and asks before doing anything', async () => {
    const wrapper = await show(entry('notes.md', 'file', 12));

    // The question names the file and the api has NOT been called: the menu
    // item arms the question, it does not perform the removal.
    expect(wrapper.find('.delete-confirm code').text()).toBe('notes.md');
    expect(wrapper.find('.overlay-title').text()).toBe('Delete file');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('offers Delete on a folder row too, worded as a folder', async () => {
    const wrapper = await show(entry('src', 'dir'));

    expect(wrapper.find('.overlay-title').text()).toBe('Delete folder');
    // The one rule the host will enforce, stated BEFORE the confirm.
    expect(wrapper.find('.delete-confirm').text()).toContain('has to be empty');
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('Cancel closes the sheet without calling anything', async () => {
    const wrapper = await show(entry('notes.md', 'file'));

    await sheetButton(wrapper, 'Cancel').trigger('click');
    await flush(wrapper);

    expect(wrapper.find('.delete-confirm').exists()).toBe(false);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('confirming unlinks the file at the browsed directory and closes the sheet', async () => {
    const wrapper = await show(entry('notes.md', 'file'));

    await sheetButton(wrapper, 'Delete file').trigger('click');
    await flush(wrapper);
    await flush(wrapper);

    expect(deleteFile).toHaveBeenCalledWith('conn-1', '/proj/notes.md');
    expect(wrapper.find('.delete-confirm').exists()).toBe(false);
    expect(wrapper.find('p.error').exists()).toBe(false);
  });

  it('confirming on a folder rmdirs it', async () => {
    const wrapper = await show(entry('src', 'dir'));

    await sheetButton(wrapper, 'Delete folder').trigger('click');
    await flush(wrapper);
    await flush(wrapper);

    expect(rmdir).toHaveBeenCalledWith('conn-1', '/proj/src');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('a refusal lands in the tree footer, where the row lives', async () => {
    deleteFile.mockRejectedValue(new Error('Permission denied'));
    const wrapper = await show(entry('notes.md', 'file'));

    await sheetButton(wrapper, 'Delete file').trigger('click');
    await flush(wrapper);
    await flush(wrapper);

    // The sheet did its job and left; the verdict belongs to the tree, which
    // is where the deleted row would have been.
    expect(wrapper.find('.delete-confirm').exists()).toBe(false);
    expect(wrapper.find('p.error').text()).toContain('Permission denied');
  });
});
