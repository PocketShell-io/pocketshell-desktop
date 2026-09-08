// @vitest-environment jsdom
//
// The Files tree's "make something here": the `+` and the right-click-on-empty
// ground both open one menu, the naming row is an inline list row rather than
// a dialog, and the store's verdicts decide whether the row closes (created)
// or stays open over the footer's message (refused). The store's side has its
// own suite in filesStore.test.ts; these pin the wiring a user can reach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { DirEntry } from '../../src/main/sftp/SftpService';

function entry(name: string, type: DirEntry['type'], size = 0): DirEntry {
  return { name, type, size, longname: name, modifyTime: 0, accessTime: 0, rights: { user: 'rwx', group: 'rwx', other: 'rwx' }, owner: 'testuser', group: 'testuser' } as unknown as DirEntry;
}

const createFile = vi.fn<(connectionId: string, path: string, content?: string) => Promise<boolean>>();
const mkdir = vi.fn<(connectionId: string, path: string) => Promise<boolean>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, not
    // because these tests exercise them.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {
      createFile: (connectionId: string, path: string, content?: string) =>
        createFile(connectionId, path, content),
      mkdir: (connectionId: string, path: string) => mkdir(connectionId, path),
    },
  },
}));

const FileTree = (await import('../../src/renderer/components/FileTree.vue')).default;
const { useFilesStore } = await import('../../src/renderer/stores/files');
const { useConnectionStore } = await import('../../src/renderer/stores/connection');

async function flush(wrapper: VueWrapper): Promise<void> {
  await nextTick();
  await wrapper.vm.$nextTick();
}

let attached: VueWrapper | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
  createFile.mockReset().mockResolvedValue(true);
  mkdir.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  // Mounted attached, because focus() only lands in-document.
  attached?.unmount();
  attached = undefined;
});

async function show(): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  const files = useFilesStore();
  files.cwd = '/proj';
  files.entries = [entry('src', 'dir'), entry('README.md', 'file', 120)];

  attached = mount(FileTree, {
    attachTo: document.body,
    // PopupMenu teleports to <body>, where wrapper.findAll cannot reach it.
    // The stub keeps its slot inline — the placement and dismissal it owns
    // are covered by its own tests; these are about the tree's wiring.
    global: { stubs: { PopupMenu: { template: '<div class="stub-menu"><slot /></div>' } } },
  });
  await flush(attached);
  return attached;
}

/** The tree's visible action buttons, by tooltip. */
function byTitle(wrapper: VueWrapper, title: string): DOMWrapper<Element> {
  const found = wrapper.findAll('button').find((b) => b.attributes('title') === title);
  if (!found) throw new Error(`no button titled ${title}`);
  return found;
}

function menuItems(wrapper: VueWrapper): string[] {
  return wrapper.findAll('button.menu-item').map((b) => b.text().trim());
}

describe('FileTree new file / new folder', () => {
  it('the strip `+` opens the creation menu with both actions', async () => {
    const wrapper = await show();

    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);

    expect(menuItems(wrapper)).toEqual(expect.arrayContaining(['New file', 'New folder']));
  });

  it("toggling the `+` shut works instead of freezing the menu open", async () => {
    // The reason PopupMenu gets the `+` in its `ignore` list: without it the
    // outside-press dismissal closes the menu and the button's own handler
    // immediately re-opens it.
    const wrapper = await show();

    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    expect(wrapper.findAll('button.menu-item')).toHaveLength(2);

    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    expect(wrapper.findAll('button.menu-item')).toHaveLength(0);
  });

  it('a right-click on the listing\u2019s empty ground opens the creation menu', async () => {
    const wrapper = await show();

    const list = wrapper.find('ul.entries');
    list.element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    await flush(wrapper);

    expect(menuItems(wrapper)).toEqual(expect.arrayContaining(['New file', 'New folder']));
  });

  it('a right-click on a row keeps the row\u2019s menu, not the creation one', async () => {
    // The row handler and the list handler both see the same event; the
    // `.entry` guard is what keeps the second from clobbering the first.
    const wrapper = await show();

    await wrapper.findAll('li.entry').at(1)!.trigger('contextmenu');
    await flush(wrapper);

    // The row menu announces its subject; the creation menu does not.
    expect(wrapper.find('.menu-head').text()).toBe('src');
    expect(menuItems(wrapper)).not.toContain('New file');
  });

  it('New file opens an inline naming row that focuses itself', async () => {
    const wrapper = await show();

    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    await wrapper.findAll('button.menu-item').find((b) => b.text().includes('New file'))!.trigger('click');
    await flush(wrapper);

    const input = wrapper.find('input.create-input');
    expect(input.exists()).toBe(true);
    expect(document.activeElement).toBe(input.element);
  });

  it('Enter commits the name to the store\u2019s createFile and closes the row', async () => {
    const wrapper = await show();
    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    await wrapper.findAll('button.menu-item').find((b) => b.text().includes('New file'))!.trigger('click');
    await flush(wrapper);

    const input = wrapper.find('input.create-input');
    await input.setValue('notes.md');
    await input.trigger('keydown', { key: 'Enter' });
    await flush(wrapper);
    await flush(wrapper);

    // The typed name reaches the API joined onto the browsed directory, with
    // the default empty content — the full pipeline the click sets off.
    expect(createFile).toHaveBeenCalledWith('conn-1', '/proj/notes.md', '');
    expect(wrapper.find('input.create-input').exists()).toBe(false);
  });

  it('Enter on an empty field just dismisses the row', async () => {
    // The path bar's ruling: an empty submit is do-nothing, not an error.
    const wrapper = await show();
    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    await wrapper.findAll('button.menu-item').find((b) => b.text().includes('New file'))!.trigger('click');
    await flush(wrapper);

    await wrapper.find('input.create-input').trigger('keydown', { key: 'Enter' });
    await flush(wrapper);

    expect(createFile).not.toHaveBeenCalled();
    expect(wrapper.find('input.create-input').exists()).toBe(false);
  });

  it('Escape cancels without calling anything', async () => {
    const wrapper = await show();
    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    await wrapper.findAll('button.menu-item').find((b) => b.text().includes('New file'))!.trigger('click');
    await flush(wrapper);

    await wrapper.find('input.create-input').trigger('keydown', { key: 'Escape' });
    await flush(wrapper);

    expect(createFile).not.toHaveBeenCalled();
    expect(wrapper.find('input.create-input').exists()).toBe(false);
  });

  it('a refusal keeps the row open so the name can be fixed', async () => {
    createFile.mockRejectedValue(new Error('Already exists: /proj/notes.md'));
    const wrapper = await show();
    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    await wrapper.findAll('button.menu-item').find((b) => b.text().includes('New file'))!.trigger('click');
    await flush(wrapper);

    const input = wrapper.find('input.create-input');
    await input.setValue('notes.md');
    await input.trigger('keydown', { key: 'Enter' });
    await flush(wrapper);
    await flush(wrapper);

    expect(wrapper.find('input.create-input').exists()).toBe(true);
    // And the reason is in the tree's footer, where the row is open.
    expect(wrapper.find('p.error').text()).toContain('Already exists');
  });

  it('New folder commits through the store\u2019s createFolder', async () => {
    const wrapper = await show();
    await byTitle(wrapper, 'New file or folder').trigger('click');
    await flush(wrapper);
    await wrapper.findAll('button.menu-item').find((b) => b.text().includes('New folder'))!.trigger('click');
    await flush(wrapper);

    const input = wrapper.find('input.create-input');
    await input.setValue('experiments');
    await input.trigger('keydown', { key: 'Enter' });
    await flush(wrapper);
    await flush(wrapper);

    expect(mkdir).toHaveBeenCalledWith('conn-1', '/proj/experiments');
    expect(createFile).not.toHaveBeenCalled();
    expect(wrapper.find('input.create-input').exists()).toBe(false);
  });
});
