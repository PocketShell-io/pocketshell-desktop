// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { formatImageZoom, sliderToZoom } from '../../src/renderer/imageZoom';

/**
 * The image viewer's toolbar in FilesView: that its controls actually drive
 * what the pane shows, and that file-derived state resets when the file
 * does.
 *
 * The zoom arithmetic is pinned in imageZoom.test.ts; what belongs here is
 * the WIRING, which is where a viewer breaks in ways the pure module cannot
 * see:
 *
 *   - the default is Fit, computed from a `load` event (decoded size) and a
 *     ResizeObserver callback (pane size) — neither of which exists in
 *     jsdom, so both are faked at their seams: the observer via a stubbed
 *     global with a manual `emit`, the decode via `naturalWidth`/`Height`
 *     defined onto the img element before the load event is triggered;
 *   - each control (−, +, slider, Fit, 100%) lands the image on the width
 *     the pure model says;
 *   - a new `openUrl` is a new file: the override and the stale decode are
 *     dropped, and the next fit is computed from the NEXT image;
 *   - the backdrop toggle repaints the canvas and is deliberately NOT
 *     among the reset — it is not about the file.
 *
 * FileTree and CodeEditor are stubbed at the module seam, exactly as in
 * filesViewFocus.test.ts.
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

/**
 * jsdom has no ResizeObserver; the component guards on `typeof` and would
 * silently never measure without this stub. `emit()` is the test's hand on
 * the seam — it stands in for the pane being laid out.
 */
class ResizeObserverStub {
  static last: ResizeObserverStub | null = null;
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    ResizeObserverStub.last = this;
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  emit(w: number, h: number): void {
    this.cb([{ contentRect: { width: w, height: h } } as ResizeObserverEntry], this);
  }
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const FilesView = (await import('../../src/renderer/views/FilesView.vue')).default;
const { useFilesStore } = await import('../../src/renderer/stores/files');

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  ResizeObserverStub.last = null;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** Open the viewer on an image and tell it the pane is 500x400 CSS px. */
async function mountImage(url: string): Promise<VueWrapper> {
  wrapper = mount(FilesView);
  const files = useFilesStore();
  files.openPath = `/home/u/${url}`;
  files.openMode = 'image';
  files.openUrl = url;
  await nextTick();
  ResizeObserverStub.last!.emit(500, 400);
  return wrapper;
}

/** Decode the image at the given size, as a real browser would report it. */
async function decode(w: number, h: number): Promise<void> {
  const img = wrapper!.find('img');
  // `configurable` because Vue reuses the same <img> element across a URL
  // change, and the default own property from an earlier decode is not
  // redefinable.
  Object.defineProperty(img.element, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(img.element, 'naturalHeight', { value: h, configurable: true });
  await img.trigger('load');
  await nextTick();
}

function imageWidthPx(): string | undefined {
  return wrapper!.find('img').attributes('style')?.match(/width: ([^;]+);/)?.[1];
}

describe('FilesView image zoom', () => {
  it('fits by default, from the decode and the pane measurement', async () => {
    await mountImage('blob:x');
    await decode(1000, 500);
    // min(500/1000, 400/500) = 50% -> 500 CSS px, and Fit is the active half
    // of the Fit/100% pair.
    expect(imageWidthPx()).toBe('500px');
    expect(wrapper!.find('.zoom-label').text()).toBe('50%');
    expect(wrapper!.find('.bar-end button.active').text()).toBe('Fit');
  });

  it('steps along the ladder with the + control', async () => {
    await mountImage('blob:x');
    await decode(1000, 500);
    await wrapper!.findAll('.seg')[0]!.findAll('button')[1]!.trigger('click');
    await nextTick();
    // Fit was 50%; the next rung up is 70% of 1000px — and neither half of
    // the Fit/100% pair is active at a manual percentage.
    expect(imageWidthPx()).toBe('700px');
    expect(wrapper!.find('.bar-end button.active').exists()).toBe(false);
  });

  it('snaps to actual size from the 100% button and back from Fit', async () => {
    await mountImage('blob:x');
    await decode(1000, 500);
    await wrapper!.find('.bar-end button:last-child').trigger('click');
    await nextTick();
    expect(imageWidthPx()).toBe('1000px');
    expect(wrapper!.find('.bar-end button.active').text()).toBe('100%');

    await wrapper!.find('.bar-end button:first-child').trigger('click');
    await nextTick();
    expect(imageWidthPx()).toBe('500px');
  });

  it('writes manual percentages from the slider', async () => {
    await mountImage('blob:x');
    await decode(1000, 500);
    const slider = wrapper!.find('input[type="range"]');
    (slider.element as HTMLInputElement).value = '45';
    await slider.trigger('input');
    await nextTick();
    // The slider's mapping is the pure module's job; the bar's job is that
    // an input event becomes that percentage, in the label and the width.
    const z = sliderToZoom(45);
    expect(wrapper!.find('.zoom-label').text()).toBe(formatImageZoom(z));
    expect(imageWidthPx()).toBe(`${(1000 * z) / 100}px`);
  });

  it('starts over when a different image is opened', async () => {
    await mountImage('blob:x');
    await decode(1000, 500);
    await wrapper!.find('.bar-end button:last-child').trigger('click'); // 100%
    await nextTick();
    expect(imageWidthPx()).toBe('1000px');

    const files = useFilesStore();
    files.openPath = '/home/u/other.png';
    files.openUrl = 'blob:y';
    await nextTick();
    // The override was about the OLD file: the new one opens at Fit, whose
    // answer waits for the new decode (width is unset until then).
    expect(imageWidthPx()).toBeUndefined();

    await decode(2000, 1000);
    expect(imageWidthPx()).toBe('500px');
    expect(wrapper!.find('.zoom-label').text()).toBe('25%');
  });

  it('refits when the pane is resized under it', async () => {
    await mountImage('blob:x');
    await decode(1000, 500);
    expect(imageWidthPx()).toBe('500px');
    // The tree splitter dragged: same file, new measurement, new fit.
    ResizeObserverStub.last!.emit(250, 400);
    await nextTick();
    expect(imageWidthPx()).toBe('250px');
  });
});

describe('FilesView image backdrop', () => {
  it('paints the canvas dark by default and light from the toggle', async () => {
    await mountImage('blob:x');
    const backdrop = wrapper!.find('[aria-label="Backdrop"]');
    expect(wrapper!.find('.image-scroll').classes()).not.toContain('on-light');
    expect(backdrop.find('button.active').text()).toBe('Dark');

    await backdrop.findAll('button')[1]!.trigger('click');
    await nextTick();
    expect(wrapper!.find('.image-scroll').classes()).toContain('on-light');
    expect(backdrop.find('button.active').text()).toBe('Light');

    await backdrop.findAll('button')[0]!.trigger('click');
    await nextTick();
    expect(wrapper!.find('.image-scroll').classes()).not.toContain('on-light');
  });

  it('keeps the backdrop across files — it is not about the file', async () => {
    await mountImage('blob:x');
    await wrapper!.find('[aria-label="Backdrop"]').findAll('button')[1]!.trigger('click');
    await nextTick();

    const files = useFilesStore();
    files.openPath = '/home/u/other.png';
    files.openUrl = 'blob:y';
    await nextTick();
    expect(wrapper!.find('.image-scroll').classes()).toContain('on-light');
  });
});
