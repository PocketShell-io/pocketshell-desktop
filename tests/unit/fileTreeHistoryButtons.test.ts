// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The strip's Back and Forward buttons — the browsing trail's face in the
 * tree (the trail itself is filesStoreHistory.test.ts's subject).
 *
 * Pinned here:
 *
 *   1. both buttons render from the store's `canGoBack`/`canGoForward`,
 *      disabled — not hidden — at either end of the trail;
 *   2. a click walks the real store: Back lands on the previous directory of
 *      the trail and Forward re-enters the one it stepped out of. The real
 *      store, because the button's whole job is one store call, and a spy
 *      would prove nothing but its own wiring.
 */

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {
      realPath: vi.fn(async (_c: string, p: string) => p),
      list: vi.fn(async () => []),
    },
  },
}));

const FileTree = (await import('@ui/app/components/FileTree.vue')).default;
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

function backButton(w: VueWrapper) {
  return w.find('button[title="Back to the previous folder"]');
}
function forwardButton(w: VueWrapper) {
  return w.find('button[title="Forward to the next folder"]');
}

describe('FileTree back / forward buttons', () => {
  it('render disabled while the trail has nowhere to go', async () => {
    useConnectionStore().connectionId = 'conn-1';
    const files = useFilesStore();
    files.cwd = '/home/u/a';

    wrapper = mount(FileTree);
    await flush();

    expect(backButton(wrapper).exists()).toBe(true);
    expect(forwardButton(wrapper).exists()).toBe(true);
    expect(backButton(wrapper).attributes('disabled')).toBeDefined();
    expect(forwardButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('walk the store’s trail: back to the previous folder, forward again', async () => {
    useConnectionStore().connectionId = 'conn-1';
    const files = useFilesStore();
    await files.open('conn-1', '/home/u/a');
    await files.cd('conn-1', '/home/u/a/b');
    await files.cd('conn-1', '/home/u/a/b/c');

    wrapper = mount(FileTree);
    await flush();

    expect(backButton(wrapper).attributes('disabled')).toBeUndefined();
    await backButton(wrapper).trigger('click');
    await flush();
    expect(files.cwd).toBe('/home/u/a/b');

    expect(forwardButton(wrapper).attributes('disabled')).toBeUndefined();
    await forwardButton(wrapper).trigger('click');
    await flush();
    expect(files.cwd).toBe('/home/u/a/b/c');

    // One step back puts Forward back in business; the walk itself never does.
    await backButton(wrapper).trigger('click');
    await flush();
    expect(files.cwd).toBe('/home/u/a/b');
    expect(forwardButton(wrapper).attributes('disabled')).toBeUndefined();
    await backButton(wrapper).trigger('click');
    await flush();
    expect(files.cwd).toBe('/home/u/a');
    expect(forwardButton(wrapper).attributes('disabled')).toBeUndefined();

    // From the trail's first directory Back has nothing to offer.
    expect(backButton(wrapper).attributes('disabled')).toBeDefined();
  });
});
