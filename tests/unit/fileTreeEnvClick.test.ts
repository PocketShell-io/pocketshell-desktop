// @vitest-environment jsdom
//
// Clicking a `.env`/`.envrc` row is the same ask as the strip's type button:
// edit this folder's env (FEATURES.md F16). Both names route to the tree's
// `openEnv` event — which FilesView answers with the DOCKED env editor — and
// never to the byte editor; every other file keeps opening as bytes. The
// routing lives in FileTree's `onEntry`, the one point the row click, the
// context menu's "Open in this tab", and the keyboard's Enter all share.
//
// What these tests pin:
//   1. a `.env` row click emits openEnv and NOT openFile;
//   2. the same for `.envrc` (the helper merges both; a direnv folder is
//      exactly as editable);
//   3. a non-env file is untouched — it still emits openFile;
//   4. the routes hold through the context menu and the strip button too —
//      the three doors into `onEntry`/`openEnv` must not diverge.
//
// Raw-text access to `.env` is NOT pinned here because this suite cannot see
// it: it lives in the reveal channel ("Open in a new tab" and terminal links
// ride it straight to `files.openFile`), which is a different seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import type { DirEntry } from '../../src/main/sftp/SftpService';

function entry(name: string, type: DirEntry['type'], size = 0): DirEntry {
  return { name, type, size, longname: name, modifyTime: 0, accessTime: 0, rights: { user: 'rwx', group: 'rwx', other: 'rwx' }, owner: 'testuser', group: 'testuser' } as unknown as DirEntry;
}

vi.mock('@ui/app/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, not
    // because these tests exercise them.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {},
  },
}));

const FileTree = (await import('@ui/app/components/FileTree.vue')).default;
const { useFilesStore } = await import('@ui/app/stores/files');
const { useConnectionStore } = await import('@ui/app/stores/connection');

async function flush(wrapper: VueWrapper): Promise<void> {
  await wrapper.vm.$nextTick();
}

let attached: VueWrapper | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  // Mounted attached, because the context menu teleports to <body>.
  attached?.unmount();
  attached = undefined;
});

async function show(): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  const files = useFilesStore();
  files.cwd = '/proj';
  files.entries = [entry('.env', 'file', 40), entry('.envrc', 'file', 12), entry('notes.txt', 'file', 120)];

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

/** The entry row for [name] — exact match on the row's title, since `.env` is
 *  a substring of `.envrc` and row text alone cannot tell them apart. */
function row(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const found = wrapper.findAll('li.entry').find((li) => li.find('.nm')?.attributes('title') === name);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

describe('FileTree env-file routing', () => {
  it('a .env row click opens the env editor, not the byte editor', async () => {
    const w = await show();
    await row(w, '.env').trigger('click');
    expect(w.emitted('openEnv')).toHaveLength(1);
    expect(w.emitted('openFile')).toBeUndefined();
  });

  it('the same for .envrc — the helper merges both files', async () => {
    const w = await show();
    await row(w, '.envrc').trigger('click');
    expect(w.emitted('openEnv')).toHaveLength(1);
    expect(w.emitted('openFile')).toBeUndefined();
  });

  it('a non-env file still opens as bytes', async () => {
    const w = await show();
    await row(w, 'notes.txt').trigger('click');
    expect(w.emitted('openFile')).toEqual([['notes.txt']]);
    expect(w.emitted('openEnv')).toBeUndefined();
  });

  it('the context menu routes the same way', async () => {
    const w = await show();
    await row(w, '.env').trigger('contextmenu');
    await flush(w);
    const item = w.findAll('button.menu-item').find((b) => b.text().includes('Open in this tab'));
    expect(item).toBeTruthy();
    await item!.trigger('click');
    expect(w.emitted('openEnv')).toHaveLength(1);
    expect(w.emitted('openFile')).toBeUndefined();
  });

  it('the strip button emits the same event it always did', async () => {
    const w = await show();
    await byTitle(w, 'Edit env for this folder').trigger('click');
    expect(w.emitted('openEnv')).toHaveLength(1);
  });
});
