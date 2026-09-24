// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { DirEntry } from '../../src/main/sftp/SftpService';

/**
 * The Files tree's keyboard navigation (FEATURES.md F18 — "the tree is fully
 * keyboard-navigable").
 *
 * The session panel's folder rows were already <button>s — Tab reaches them,
 * Enter opens them, Ctrl+↑/↓ walks workspaces — so the FILE tree was the one
 * tree a keyboard could not reach: its rows were `<li @click>`, invisible to
 * Tab and deaf to arrows. These tests pin the roving-tabindex contract:
 *
 *   1. exactly ONE row is a Tab stop before focus arrives (row 0);
 *   2. arrows move focus row by row and CLAMP at the ends — never wrap;
 *   3. Home and End jump to the ends;
 *   4. Enter opens the focused row — a file emits `openFile`, a directory
 *      calls `cd`;
 *   5. a directory change resets the walk, because the rows it named are gone.
 *
 * `..` is row 0 of the same walk when present — it is navigation too.
 */

function entry(name: string, type: DirEntry['type'], size = 0): DirEntry {
  return { name, type, size, longname: name, modifyTime: 0, accessTime: 0, rights: { user: 'rwx', group: 'rwx', other: 'rwx' }, owner: 'testuser', group: 'testuser' } as unknown as DirEntry;
}

const ROOT_ENTRIES: DirEntry[] = [
  entry('src', 'dir'),
  entry('README.md', 'file', 120),
  entry('notes.txt', 'file', 40),
];

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
  await nextTick();
  await wrapper.vm.$nextTick();
}

async function show(entries: DirEntry[] = ROOT_ENTRIES, cwd = '/proj'): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  const files = useFilesStore();
  files.cwd = cwd;
  files.entries = entries;

  attached = mount(FileTree, { attachTo: document.body });
  await flush(attached);
  return attached;
}

/** The rows that participate in the walk, in order. */
function rows(wrapper: VueWrapper): HTMLElement[] {
  return wrapper.findAll('[data-idx]').map((w) => w.element as HTMLElement);
}

function focusedIdx(): number {
  const el = document.activeElement as HTMLElement | null;
  return el?.dataset['idx'] != null ? Number(el.dataset['idx']) : -1;
}

function press(wrapper: VueWrapper, key: string): void {
  rows(wrapper)[focusedIdx()]?.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

let attached: VueWrapper | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  // The tree is mounted attached, because focus() only lands in-document.
  attached?.unmount();
  attached = undefined;
});

describe('FileTree keyboard navigation', () => {
  it('makes exactly one row a Tab stop before focus arrives', async () => {
    const wrapper = await show();
    const stops = rows(wrapper).filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    // The `..` row is present (cwd is not /), so it is row 0 and the stop.
    expect(stops[0]!.dataset['idx']).toBe('0');
  });

  it('arrows move focus and clamp at the ends without wrapping', async () => {
    const wrapper = await show();
    rows(wrapper)[0]!.focus();
    await flush(wrapper);

    press(wrapper, 'ArrowDown');
    await flush(wrapper);
    expect(focusedIdx()).toBe(1);
    press(wrapper, 'ArrowDown');
    await flush(wrapper);
    expect(focusedIdx()).toBe(2);
    press(wrapper, 'ArrowDown');
    await flush(wrapper);
    // Clamped on the last row — an arrow is a direction, not a cycle.
    expect(focusedIdx()).toBe(3);
    press(wrapper, 'ArrowUp');
    await flush(wrapper);
    expect(focusedIdx()).toBe(2);
  });

  it('Home and End jump to the ends', async () => {
    const wrapper = await show();
    rows(wrapper)[1]!.focus();
    await flush(wrapper);

    press(wrapper, 'End');
    await flush(wrapper);
    expect(focusedIdx()).toBe(3);
    press(wrapper, 'Home');
    await flush(wrapper);
    expect(focusedIdx()).toBe(0);
  });

  it('Enter opens the focused row — a file emits openFile', async () => {
    const wrapper = await show();
    rows(wrapper)[2]!.focus(); // README.md
    await flush(wrapper);

    press(wrapper, 'Enter');
    await flush(wrapper);

    expect(wrapper.emitted('openFile')).toEqual([['README.md']]);
  });

  it('Enter on the `..` row goes up a directory', async () => {
    const wrapper = await show();
    const files = useFilesStore();
    const cd = vi.spyOn(files, 'cd').mockResolvedValue(undefined);

    rows(wrapper)[0]!.focus(); // the `..` row
    await flush(wrapper);
    press(wrapper, 'Enter');
    await flush(wrapper);

    expect(cd).toHaveBeenCalledWith('conn-1', '..');
  });

  it('Enter on a directory row calls cd with its name', async () => {
    const wrapper = await show();
    const files = useFilesStore();
    const cd = vi.spyOn(files, 'cd').mockResolvedValue(undefined);

    rows(wrapper)[1]!.focus(); // src/
    await flush(wrapper);
    press(wrapper, 'Enter');
    await flush(wrapper);

    expect(cd).toHaveBeenCalledWith('conn-1', 'src');
  });

  it('a directory change resets the walk — nothing focused on fresh rows', async () => {
    const wrapper = await show();
    rows(wrapper)[2]!.focus();
    await flush(wrapper);

    const files = useFilesStore();
    files.cwd = '/proj/other';
    await flush(wrapper);

    expect(rows(wrapper).filter((r) => r.tabIndex === 0).map((r) => r.dataset['idx'])).toEqual([
      '0',
    ]);
  });
});
