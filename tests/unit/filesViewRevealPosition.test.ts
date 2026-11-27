// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * The reveal POSITION's wiring, in the mounted view — the mounted-view proof,
 * because every half of this feature has a suite of its own and not one of
 * them can see the seam: the store parks `{line, column}` beside the reveal
 * (filesStore.test.ts), the link hands the detector's `:12` numbers over
 * (terminalLinks.test.ts), the editor clamps and jumps (CodeEditor.test.ts).
 * What none of them pin is the pane: applyReveal must take the position WITH
 * the reveal, wait out the editor's late mount (async chunk, the loading
 * sentence), and aim it at the file the reveal just opened. A dropped or
 * never-delivered position fails this file with an empty call list — the same
 * class of silent-wiring failure the at-rest tint had.
 *
 * FileTree and CodeEditor are stubbed at the module seam, the way
 * filesViewFocus.test.ts does it; the stub editor records gotoPosition calls,
 * which is the assertion.
 */

const realPath = vi.fn<(connectionId: string, path: string) => Promise<string>>();
const list = vi.fn<(connectionId: string, path: string) => Promise<unknown[]>>();
const stat = vi.fn<(connectionId: string, path: string) => Promise<{ size: number; type: string }>>();
const readBinary = vi.fn<(connectionId: string, path: string, cap?: number) => Promise<Uint8Array>>();

const gotoCalls: Array<[number, number | undefined]> = [];

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {
      realPath: (connectionId: string, path: string) => realPath(connectionId, path),
      list: (connectionId: string, path: string) => list(connectionId, path),
      stat: (connectionId: string, path: string) => stat(connectionId, path),
      readBinary: (connectionId: string, path: string, cap?: number) =>
        readBinary(connectionId, path, cap),
    },
  },
}));

vi.mock('@ui/app/components/FileTree.vue', () => ({
  default: { name: 'FileTree', template: '<div class="file-tree-stub" />' },
}));

vi.mock('@ui/app/components/CodeEditor.vue', () => ({
  // `__esModule` is load-bearing under `defineAsyncComponent` — see
  // filesViewEnvDock.test.ts for the interop failure without it.
  __esModule: true,
  default: {
    name: 'CodeEditor',
    props: ['modelValue', 'filename', 'readOnly'],
    template: '<div class="code-editor-stub" />',
    methods: {
      gotoPosition(line: number, column?: number): void {
        gotoCalls.push([line, column]);
      },
    },
  },
}));

const FilesView = (await import('@ui/app/views/FilesView.vue')).default;
const { useFilesStore } = await import('@ui/app/stores/files');
const { useConnectionStore } = await import('@ui/app/stores/connection');

const CONN = 'conn-1' as never;

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  gotoCalls.length = 0;
  realPath.mockReset().mockImplementation((_c, p) => Promise.resolve(p));
  list.mockReset().mockResolvedValue([]);
  stat.mockReset().mockResolvedValue({ size: 5, type: 'file' });
  readBinary
    .mockReset()
    .mockResolvedValue(new TextEncoder().encode('line one\nline two\nline three\n'));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/**
 * Mounted with the connection already live, because applyReveal refuses a
 * connectionless pane — the click would strand its reveal there. The open
 * traffic `onMounted` then generates is mocked above: identity realpath, an
 * empty listing, and a small text file for the reveal to open.
 */
async function mountView(): Promise<VueWrapper> {
  useConnectionStore().connectionId = CONN;
  wrapper = mount(FilesView, {
    attachTo: document.body,
    props: { startPath: '/home/u/git' },
  });
  // The applyReveal hand-off waits in 50 ms steps for the editor to appear;
  // two of those steps cover the stub's immediate mount with room to spare.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return wrapper;
}

describe('FilesView delivers a reveal position to the editor', () => {
  it('a :12:5 suffix lands on the editor as (12, 5)', async () => {
    const files = useFilesStore();
    files.requestReveal('/home/u/notes.txt', null, { line: 12, column: 5 });

    await mountView();

    expect(gotoCalls).toEqual([[12, 5]]);
    // Taken with the reveal: a leftover position would jump a LATER file.
    expect(files.reveal).toBeNull();
    expect(files.revealPosition).toBeNull();
  });

  it('a plain reveal opens the file and aims at nothing', async () => {
    const files = useFilesStore();
    files.requestReveal('/home/u/notes.txt', null);

    await mountView();

    expect(gotoCalls).toEqual([]);
    expect(files.reveal).toBeNull();
    expect(files.revealPosition).toBeNull();
  });
});
