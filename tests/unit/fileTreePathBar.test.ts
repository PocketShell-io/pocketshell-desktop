// @vitest-environment jsdom
//
// The Files tree's path bar lost its pencil button: the strip itself is the
// way in now, opened by double-clicking it (Ctrl+L is still routed by
// FilesView to the same field). These pin the gesture wiring — a double-click
// on the strip's text opens the field, a double-click on one of the strip's
// own controls does not, and the pencil is really gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

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

let attached: VueWrapper | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
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

  attached = mount(FileTree, { attachTo: document.body });
  await flush(attached);
  return attached;
}

describe('FileTree path bar gesture', () => {
  it('double-clicking the current folder opens the path field, focused and seeded', async () => {
    const wrapper = await show();

    await wrapper.find('.crumbs .here').trigger('dblclick');
    await flush(wrapper);

    const input = wrapper.find('input.path-input');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('/proj');
    expect(document.activeElement).toBe(input.element);
  });

  it('double-clicking a crumb link keeps the link\u2019s gesture, not the editor', async () => {
    // The ancestor link and the `…` navigate or open a menu on click; the
    // strip's dblclick guard leaves them alone so one gesture never bleeds
    // into the other.
    const wrapper = await show();

    await wrapper.find('.crumbs a').trigger('dblclick');
    await flush(wrapper);

    expect(wrapper.find('input.path-input').exists()).toBe(false);
  });

  it('the strip carries the editing hint on its title and no pencil button', async () => {
    // With the button gone, the tooltip is the only place the gesture
    // advertises itself.
    const wrapper = await show();

    expect(wrapper.find('.crumbs').attributes('title')).toBe('/proj (double-click to edit)');
    expect(
      wrapper.findAll('button').some((b) => b.attributes('title') === 'Go to path (Ctrl+L)'),
    ).toBe(false);
  });
});
