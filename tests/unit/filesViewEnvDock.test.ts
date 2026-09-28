// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { EnvVarRow } from '@pocketshell/core';

/**
 * The env editor's DOCK in the Files pane (FEATURES.md F16, docked).
 *
 * It used to be a modal OverlayPanel over the whole tab; the ask that moved it
 * was "open it on the side" — and the side is the editor area the pane already
 * had, which otherwise sits empty. What these tests pin is the model that made
 * docking safe, plus the seams a user can reach:
 *
 *   1. **Docked, not floating.** Asking for the env editor renders the panel
 *      INSIDE `.editor-area`, under a bar of its own, and no overlay backdrop
 *      exists anywhere in the document.
 *   2. **The folder is pinned at open.** The dock has none of the overlay's
 *      modal grab, so the tree stays live and `files.cwd` can move under an
 *      open panel; the panel keeps editing the folder it was asked for, and a
 *      second ask in a new folder re-pins (a remount — fresh keys, not stale
 *      rows under a new heading).
 *   3. **Close hands the area back** to whatever was open before — the env
 *      state never touches the store's open file.
 *   4. **Opening a file dismisses the dock** — the editor area is one detail
 *      surface, and the click asked for the file.
 *
 * EnvPanelView itself is mounted REAL (its behaviour has its own suite in
 * EnvPanelView.test.ts) so the wiring — one envList per open, the pinned dir
 * as its `dir` — is proven end to end. FileTree is stubbed at the event seam:
 * the routing from its rows has its own suite in fileTreeEnvClick.test.ts.
 */

const envList = vi.fn<(connectionId: string, dir: string) => Promise<EnvVarRow[]>>();
const envGet = vi.fn<
  (connectionId: string, dir: string, keys?: string[]) => Promise<Record<string, string>>
>();
const envSet = vi.fn<
  (connectionId: string, dir: string, values: Record<string, string>, file?: string) => Promise<void>
>();
const stat = vi.fn<(connectionId: string, path: string) => Promise<{ size: number; type: string }>>();
const readBinary = vi.fn<(connectionId: string, path: string, cap?: number) => Promise<Uint8Array>>();

vi.mock('@ui/app/ipc', () => ({
  api: {
    agent: {
      envList: (connectionId: string, dir: string) => envList(connectionId, dir),
      envGet: (connectionId: string, dir: string, keys?: string[]) => envGet(connectionId, dir, keys),
      envSet: (connectionId: string, dir: string, values: Record<string, string>, file?: string) =>
        envSet(connectionId, dir, values, file),
    },
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {
      stat: (connectionId: string, path: string) => stat(connectionId, path),
      readBinary: (connectionId: string, path: string, cap?: number) =>
        readBinary(connectionId, path, cap),
    },
  },
}));

vi.mock('@ui/app/components/FileTree.vue', () => ({
  default: {
    name: 'FileTree',
    emits: ['openFile', 'openEnv', 'openInNewTab'],
    // Two buttons the tests drive instead of `$emit` calls (which lint reads
    // as `any`): the stub fires exactly the two events the pane listens for,
    // the way the real tree fires them.
    template: `
      <div class="file-tree-stub">
        <button class="stub-ask-env" @click="$emit('openEnv')">env</button>
        <button class="stub-open-file" @click="$emit('openFile', 'notes.txt')">file</button>
      </div>`,
  },
}));

vi.mock('@ui/app/components/CodeEditor.vue', () => ({
  // `__esModule` is load-bearing: FilesView loads the editor through
  // `defineAsyncComponent`, whose interop check (`comp.__esModule`) reads the
  // resolved module directly. Without the marker Vue uses the mocked namespace
  // ITSELF as the component, and the first render of the editor branch dies in
  // test-utils' isTeleport probe.
  __esModule: true,
  default: {
    name: 'CodeEditor',
    props: ['modelValue', 'filename'],
    template: '<div class="code-editor-stub" />',
  },
}));

const FilesView = (await import('@ui/app/views/FilesView.vue')).default;
const { useFilesStore } = await import('@ui/app/stores/files');
const { useConnectionStore } = await import('@ui/app/stores/connection');

const ROWS: EnvVarRow[] = [
  { file: '.env', hasValue: true, key: 'API_KEY' },
  { file: '.env', hasValue: false, key: 'EMPTY_ONE' },
];

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  envList.mockReset().mockResolvedValue(ROWS);
  envGet.mockReset().mockResolvedValue({});
  envSet.mockReset().mockResolvedValue(undefined);
  stat.mockReset().mockRejectedValue(new Error('no stat in this suite'));
  readBinary.mockReset().mockResolvedValue(new TextEncoder().encode('hello'));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/**
 * Mounted with NO connectionId (the view's onMounted guard skips its initial
 * `files.open()`, so no listing traffic needs faking), then the connection and
 * the store's cwd are set by hand — the same direct-state pattern
 * filesViewFocus.test.ts uses. The tree is asked for the env editor through
 * its own event, exactly as the real FileTree emits it.
 */
async function mountView(): Promise<VueWrapper> {
  wrapper = mount(FilesView, { attachTo: document.body });
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  useFilesStore().cwd = '/proj';
  await nextTick();
  return wrapper;
}

async function askForEnv(): Promise<void> {
  await wrapper!.find('.stub-ask-env').trigger('click');
  await flush(wrapper!);
}

function envBar(): ReturnType<VueWrapper['find']> {
  return wrapper!.find('.editor-area .editor-bar');
}

describe('FilesView env dock', () => {
  it('opens the env editor INSIDE the editor area, not as an overlay', async () => {
    await mountView();
    await askForEnv();

    expect(envBar().exists()).toBe(true);
    expect(envBar().text()).toContain('/proj');
    // The panel is real and loaded the pinned folder's keys — exactly one
    // listing call, aimed at the pinned dir.
    expect(envList).toHaveBeenCalledTimes(1);
    expect(envList).toHaveBeenCalledWith('conn-1', '/proj');
    expect(wrapper!.find('.editor-area .env-panel').exists()).toBe(true);
    expect(wrapper!.text()).toContain('API_KEY');
    // The whole ask: docked means nothing floats over the tab.
    expect(document.querySelector('.overlay-backdrop')).toBeNull();
  });

  it('pins the folder at open — browsing on does not move the panel', async () => {
    await mountView();
    await askForEnv();

    useFilesStore().cwd = '/other';
    await nextTick();

    expect(envBar().text()).toContain('/proj');
    expect(envList).toHaveBeenCalledTimes(1);
  });

  it('a second ask in another folder re-pins with a fresh listing', async () => {
    await mountView();
    await askForEnv();

    useFilesStore().cwd = '/other';
    await nextTick();
    await askForEnv();

    expect(envList).toHaveBeenCalledTimes(2);
    expect(envList).toHaveBeenLastCalledWith('conn-1', '/other');
    expect(envBar().text()).toContain('/other');
    expect(wrapper!.text()).toContain('API_KEY');
  });

  it('Close hands the area back to the file that was open', async () => {
    await mountView();
    const files = useFilesStore();
    files.openPath = '/proj/notes.txt';
    files.openMode = 'text';
    files.dirty = false;
    await nextTick();

    await askForEnv();
    expect(envBar().text()).toContain('/proj');
    expect(wrapper!.find('.editor-area .editor-bar .path').text()).not.toContain('notes.txt');

    await wrapper!.find('.editor-area .editor-bar .close-btn').trigger('click');
    // The editor branch mounts the async CodeEditor chunk; let it resolve
    // while the tree is still mounted, not during teardown.
    await flush(wrapper!);

    expect(wrapper!.find('.editor-area .env-panel').exists()).toBe(false);
    expect(wrapper!.find('.editor-area .editor-bar .path').text()).toContain('notes.txt');
  });

  it('opening a file dismisses the dock', async () => {
    await mountView();
    await askForEnv();
    expect(wrapper!.find('.editor-area .env-panel').exists()).toBe(true);

    await wrapper!.find('.stub-open-file').trigger('click');
    await flush(wrapper!);

    expect(wrapper!.find('.editor-area .env-panel').exists()).toBe(false);
    // The file the click asked for is what the area shows now.
    expect(wrapper!.find('.editor-area .editor-bar .path').text()).toContain('/proj/notes.txt');
    expect(wrapper!.text()).not.toContain('API_KEY');
  });
});
