import { computed, onUnmounted, ref, watch, type Ref } from 'vue';
import {
  fitPercent,
  formatImageZoom,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  overflowsPane,
  sliderToZoom,
  stepImageZoom,
  zoomToSlider,
} from './imageZoom';
import type { useFilesStore } from './stores/files';

export interface ImageViewerDeps {
  files: ReturnType<typeof useFilesStore>;
}

/**
 * The image viewer's state: zoom, pan, and the backdrop it is inspected on.
 *
 * Extracted from FilesView.vue; every decision record below travelled with
 * its code. The zoom is shared by the −/+ pair, the slider and the
 * Fit / 100% buttons through ONE number; the pan gesture and the pane
 * measurement close over the template ref the view binds.
 */
export function useImageViewer(deps: ImageViewerDeps): {
  imageNatural: Ref<{ w: number; h: number } | null>;
  imagePaneEl: Ref<HTMLElement | null>;
  imageZoom: Ref<number | null | undefined>;
  imageZoomLabel: Ref<string>;
  zoomSliderValue: Ref<number>;
  isFit: Ref<boolean>;
  isActualSize: Ref<boolean>;
  canZoomIn: Ref<boolean>;
  canZoomOut: Ref<boolean>;
  imageStyle: Ref<{ width: string } | undefined>;
  imageOverflows: Ref<boolean>;
  panning: Ref<boolean>;
  imageBgLight: Ref<boolean>;
  onImageLoad: (e: Event) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomActualSize: () => void;
  zoomFit: () => void;
  onZoomSlider: (e: Event) => void;
  onPanStart: (e: PointerEvent) => void;
  onPanMove: (e: PointerEvent) => void;
  onPanEnd: (e: PointerEvent) => void;
} {
  const { files } = deps;
  /**
   * The image viewer's zoom, shared by the −/+ pair, the slider and the
   * Fit / 100% buttons through ONE number: `zoomOverride` when the user has
   * named a percentage, otherwise the measured fit answer. Nothing stores Fit
   * — it is a function of the decoded size and the pane, so a stored value
   * would go stale the moment the tree splitter moved; it is recomputed and
   * the picture follows the pane.
   *
   * State lives HERE, not in the store, deliberately: it is inspection state
   * for the file on screen, not a preference and not browsing position. A new
   * `openUrl` (a different file, or close) resets to Fit, and so does leaving
   * the tab — the Files tab is behind a `v-if`, and what survives that is the
   * store's `RememberedPosition`, which is about WHERE you are, not how you
   * were looking.
   */
  /** Decoded size of the open image, from the `<img>` load event. */
  const imageNatural = ref<{ w: number; h: number } | null>(null);
  /** CSS size of the pane the image sits in, from a ResizeObserver. */
  const imagePane = ref<{ w: number; h: number } | null>(null);
  /** Manual zoom in percent of natural size; null = Fit mode. */
  const zoomOverride = ref<number | null>(null);

  const imageFit = computed(() => {
    const n = imageNatural.value;
    const p = imagePane.value;
    if (!n || !p) return null;
    return fitPercent(n.w, n.h, p.w, p.h);
  });
  const imageZoom = computed(() => zoomOverride.value ?? imageFit.value);
  const imageZoomLabel = computed(() =>
    imageZoom.value == null ? '' : formatImageZoom(imageZoom.value),
  );
  const zoomSliderValue = computed(() =>
    imageZoom.value == null ? 0 : zoomToSlider(imageZoom.value),
  );
  const isFit = computed(() => zoomOverride.value === null);
  const isActualSize = computed(() => zoomOverride.value === 100);
  const canZoomIn = computed(() => imageZoom.value != null && imageZoom.value < IMAGE_ZOOM_MAX);
  const canZoomOut = computed(() => imageZoom.value != null && imageZoom.value > IMAGE_ZOOM_MIN);

  /**
   * Explicit pixel width — the one style the image needs in every mode, which
   * is why the old `max-width`/`max-height` CSS is gone: a manual zoom has to
   * be allowed to EXCEED the pane (and scroll), and a constraint that only
   * shrinks cannot express that. Height follows the aspect ratio.
   */
  const imageStyle = computed(() => {
    const n = imageNatural.value;
    if (!n || imageZoom.value == null) return undefined;
    return { width: `${(n.w * imageZoom.value) / 100}px` };
  });

  function onImageLoad(e: Event): void {
    const img = e.target as HTMLImageElement;
    imageNatural.value = img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  }

  function zoomIn(): void {
    if (imageZoom.value != null) zoomOverride.value = stepImageZoom(imageZoom.value, 1);
  }
  function zoomOut(): void {
    if (imageZoom.value != null) zoomOverride.value = stepImageZoom(imageZoom.value, -1);
  }
  function zoomActualSize(): void {
    zoomOverride.value = 100;
  }
  function zoomFit(): void {
    zoomOverride.value = null;
  }
  function onZoomSlider(e: Event): void {
    zoomOverride.value = sliderToZoom(Number((e.target as HTMLInputElement).value));
  }

  // A new URL is a new file: the decoded size and the zoom are about the old
  // one. (Fit mode is the default, so resetting the override alone is not
  // enough — the stale natural size must not size the next image.)
  watch(
    () => files.openUrl,
    () => {
      zoomOverride.value = null;
      imageNatural.value = null;
    },
  );

  /**
   * Drag-to-pan. Once a manual zoom lets the picture exceed the pane, the
   * native scrollbars are joined by the gesture every image viewer shares:
   * the cursor becomes a hand, and a held drag moves the picture — scrollLeft/
   * scrollTop against the pointer delta, nothing more. The overflow test is
   * the pure `overflowsPane` (same measured inputs as Fit), so the hand
   * appears and disappears with the splitter and the zoom slider; at Fit it
   * never appears, because there the pane holds the whole picture and there
   * is nothing to pan into.
   *
   * The drag is pointer events with capture, not mouse events, so a drag that
   * leaves the pane keeps panning and a lost pointer (button up outside the
   * window, alt-tab) ends it through `pointercancel` rather than sticking.
   */
  const imageOverflows = computed(() => {
    const n = imageNatural.value;
    const p = imagePane.value;
    if (!n || !p || imageZoom.value == null) return false;
    return overflowsPane(n.w, n.h, imageZoom.value, p.w, p.h);
  });
  const panDrag = ref<{
    id: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);
  const panning = computed(() => panDrag.value != null);

  function onPanStart(e: PointerEvent): void {
    if (!imageOverflows.value || e.button !== 0) return;
    const el = imagePaneEl.value;
    if (!el) return;
    e.preventDefault();
    panDrag.value = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    el.setPointerCapture?.(e.pointerId);
  }
  function onPanMove(e: PointerEvent): void {
    const d = panDrag.value;
    const el = imagePaneEl.value;
    if (!d || !el || e.pointerId !== d.id) return;
    el.scrollLeft = d.left - (e.clientX - d.startX);
    el.scrollTop = d.top - (e.clientY - d.startY);
  }
  function onPanEnd(e: PointerEvent): void {
    if (panDrag.value?.id !== e.pointerId) return;
    panDrag.value = null;
  }

  /**
   * The ground the picture is inspected on: the terminal surface it has always
   * sat on, or white. A drawing authored against one reads wrongly on the
   * other — dark-stroked line art vanishes into the dark ground, white-backed
   * art haloes against white — and which ground is wrong is a fact about the
   * picture, so the viewer offers both.
   *
   * Component state like the zoom, and for the same reason: a fact about
   * LOOKING, not a preference to name in Settings. Unlike the zoom it is NOT
   * reset when a new file opens — the zoom is derived from the file and goes
   * stale, this says nothing about the file at all — so a run of pictures can
   * be checked against the same backdrop. It dies with the tab, as the zoom
   * does.
   */
  const imageBgLight = ref(false);

  /**
   * The pane is MEASURED, not assumed: `fitPercent` needs the scroll area's
   * CSS box, which changes under the splitter drag, a window resize and the
   * tree pane's own width. The observer is (re)bound by watching the template
   * ref — the element exists only while an image is open, and a watcher on a
   * ref fires exactly when Vue assigns it.
   *
   * The `typeof` guard is for jsdom, which has no ResizeObserver; the tests
   * stub one, but a bare import-time `new` would still be the wrong place —
   * the element can simply not be there yet.
   */
  const imagePaneEl = ref<HTMLElement | null>(null);
  let imagePaneObserver: ResizeObserver | null = null;
  watch(imagePaneEl, (el) => {
    imagePaneObserver?.disconnect();
    imagePaneObserver = null;
    imagePane.value = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    imagePaneObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) imagePane.value = { w: box.width, h: box.height };
    });
    imagePaneObserver.observe(el);
  });
  onUnmounted(() => imagePaneObserver?.disconnect());

  return {
    imageNatural,
    imagePaneEl,
    imageZoom,
    imageZoomLabel,
    zoomSliderValue,
    isFit,
    isActualSize,
    canZoomIn,
    canZoomOut,
    imageStyle,
    imageOverflows,
    panning,
    imageBgLight,
    onImageLoad,
    zoomIn,
    zoomOut,
    zoomActualSize,
    zoomFit,
    onZoomSlider,
    onPanStart,
    onPanMove,
    onPanEnd,
  };
}
