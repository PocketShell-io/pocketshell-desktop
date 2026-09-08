// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The preview iframe's sandbox, per open document.
 *
 * The frame itself is the security boundary (the empty sandbox's whole argument
 * lives beside the element in FilesView.vue and in HtmlPreviewService.ts), and
 * a template literal is the wrong place to keep a security argument — so this
 * file pins the one dynamic part of it: markdown gets exactly `allow-popups`
 * (raw-HTML `target="_blank"` badge links must reach main's window-open
 * handler, which allow-lists web URLs into the system browser, rather than die
 * silently inside a fully sandboxed frame), and every other previewable kind
 * gets the empty sandbox, verbatim.
 *
 * Nothing else about the frame is asserted here: the CSP, the containment
 * rules and the budgets are main's, covered in HtmlPreviewService.test.ts.
 */

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    // Present because constructing the stores subscribes to them, not
    // because these tests exercise them.
    ssh: { onState: vi.fn() },
    preview: { onStats: vi.fn(), release: vi.fn() },
    sftp: {},
  },
}));

vi.mock('../../src/renderer/components/FileTree.vue', () => ({
  default: { name: 'FileTree', template: '<div class="file-tree-stub" />' },
}));

vi.mock('../../src/renderer/components/CodeEditor.vue', () => ({
  default: {
    name: 'CodeEditor',
    props: ['modelValue', 'filename'],
    template: '<div class="code-editor-stub" />',
  },
}));

const FilesView = (await import('../../src/renderer/views/FilesView.vue')).default;
const { useFilesStore } = await import('../../src/renderer/stores/files');

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/**
 * Put the pane on an open previewable document whose preview is minted and on
 * screen, without any SFTP behind it: the frame's sandbox is a pure function
 * of `openMode`, which is what these tests vary.
 */
async function openPreview(mode: 'html' | 'markdown' | 'svg'): Promise<VueWrapper> {
  wrapper = mount(FilesView);
  const files = useFilesStore();
  files.openPath = `/home/u/site/page.${mode}`;
  files.openMode = mode;
  files.previewUrl = 'psview://abcd/home/u/site/page.html';
  files.docView = 'preview';
  await nextTick();
  return wrapper;
}

describe('FilesView preview sandbox', () => {
  it('gives a markdown frame exactly allow-popups', async () => {
    const w = await openPreview('markdown');
    expect(w.find('iframe.html-frame').attributes('sandbox')).toBe('allow-popups');
  });

  it('leaves HTML and SVG frames fully sandboxed', async () => {
    for (const mode of ['html', 'svg'] as const) {
      const w = await openPreview(mode);
      expect(w.find('iframe.html-frame').attributes('sandbox'), mode).toBe('');
    }
  });
});
