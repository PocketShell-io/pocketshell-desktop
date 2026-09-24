// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The Files pane's half of the workspace's focus handoff, and the placement
 * of the open file's error line.
 *
 * FolderWorkspaceView.focusActiveTab() calls `filesRef.value?.focus?.()` when
 * a Files tab is selected, and types the ref optionally because the call is
 * an ASK the pane may decline. Before the fix the ask reached nothing at all:
 * FilesView exposed no `focus`, so after a click or a Ctrl+Tab the keyboard
 * stayed on the tab button and the pane's own chords (Ctrl+S / Ctrl+L /
 * Ctrl+F, bound via @keydown on the root) were dead until the user clicked
 * inside the pane. These tests pin the contract from this side of the seam:
 *
 *   1. the root is focusable — but at `tabindex="-1"`, so a keyboard user
 *      walking the page never lands on a container that is not a control;
 *   2. `focus()` puts the keyboard on the pane when nothing unsaved is open;
 *   3. `focus()` DECLINES — does nothing, not blur — while an editor holds
 *      unsaved content, which is the workspace comment's own words: moving
 *      the caret out of a dirty buffer to a tree the user did not ask for
 *      would be worse than doing nothing.
 *
 * The fourth case is the other Files defect fixed alongside: a failed save's
 * reason renders in the EDITOR area, beside the bar the user is watching,
 * rather than in the tree footer of the other pane. The store split is pinned
 * in filesStore.test.ts; what belongs here is that the view actually renders
 * the new channel where the eyes are.
 *
 * FileTree and CodeEditor are stubbed at the module seam: the tree's own
 * behaviour has its own suites, and CodeMirror is ~680 KB of machinery this
 * file would load only to ignore.
 */

vi.mock('@ui/app/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, not
    // because these tests exercise them: the files store registers a stats
    // listener at module scope, and the connection store subscribes to
    // ssh.onState the moment it is built.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {},
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

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/**
 * Mounted ATTACHED, or focus is theatre: an element outside the document
 * accepts `.focus()` silently and `document.activeElement` never moves, so
 * every assertion below would pass against a broken implementation.
 *
 * The connection store is left without a connectionId on purpose — the view's
 * onMounted guards its `files.open(...)` on one, so no SFTP traffic needs
 * mocking and the pane mounts straight to its placeholder state.
 */
function mountView(): VueWrapper {
  wrapper = mount(FilesView, { attachTo: document.body });
  return wrapper;
}

describe('FilesView focus handoff', () => {
  it('is focusable without entering the tab order', () => {
    const w = mountView();
    // -1, not 0: the workspace reaches the pane through the exposed focus(),
    // and a bare container must never be a Tab stop of its own.
    expect(w.attributes('tabindex')).toBe('-1');
  });

  it('takes the keyboard when nothing unsaved is open', async () => {
    const w = mountView();
    expect(document.activeElement).not.toBe(w.element);

    (w.vm as unknown as { focus: () => void }).focus();

    // The root itself holds focus, which is what makes the @keydown chords
    // live without a click inside the pane.
    expect(document.activeElement).toBe(w.element);
  });

  it('still takes it over a CLEAN open editor', async () => {
    // Dirty is the refusal, not "an editor exists": a clean buffer is a cache
    // of what is on the host, and stealing focus from it costs nothing.
    const w = mountView();
    const files = useFilesStore();
    files.openPath = '/home/u/notes.txt';
    files.openMode = 'text';
    files.dirty = false;
    await nextTick();

    (w.vm as unknown as { focus: () => void }).focus();

    expect(document.activeElement).toBe(w.element);
  });

  it('declines while an editor holds unsaved content', async () => {
    const w = mountView();
    const files = useFilesStore();
    files.openPath = '/home/u/notes.txt';
    files.openMode = 'text';
    files.dirty = true;
    await nextTick();

    (w.vm as unknown as { focus: () => void }).focus();

    // Declining means DOING NOTHING: focus stays exactly where it was, it is
    // not blurred to the body and not pulled onto the pane.
    expect(document.activeElement).not.toBe(w.element);
  });
});

describe('FilesView open-file error placement', () => {
  it('renders a failed save beside the editor bar, in the editor area', async () => {
    mountView();
    const files = useFilesStore();
    files.openPath = '/home/u/notes.txt';
    files.openMode = 'text';
    files.fileError = 'Permission denied';
    await nextTick();

    // In the RIGHT pane, where the Save button the user is watching lives —
    // not in the tree footer, which is the listing channel's surface.
    const line = wrapper!.find('.editor-area .error');
    expect(line.exists()).toBe(true);
    expect(line.text()).toBe('Permission denied');
  });

  it('shows nothing when the channel is empty', async () => {
    mountView();
    const files = useFilesStore();
    files.openPath = '/home/u/notes.txt';
    files.openMode = 'text';
    await nextTick();

    expect(wrapper!.find('.editor-area .error').exists()).toBe(false);
  });
});
