/**
 * Image zoom for the Files viewer: one whole percentage of the image's
 * NATURAL size, the ladder the +/- controls step along, the mapping
 * between that percentage and the toolbar's slider, and the overflow
 * predicate that arms drag-to-pan.
 *
 * ---------------------------------------------------------------------------
 * 100% MEANS ONE IMAGE PIXEL PER CSS PIXEL
 * ---------------------------------------------------------------------------
 * Not "fits the window" — that is the Fit mode and it is a value of its own
 * (`fitPercent`), computed from the decoded size and the pane the image sits
 * in. The three states a user can name are all here:
 *
 *   - Fit: the whole image visible at once, never UPSCALED past 100% (the
 *     `max-width` behaviour the viewer shipped with, kept as the default so
 *     opening an image looks the same as it always did);
 *   - 100%: actual size, where a pixel of the file is a pixel on screen —
 *     the setting people mean by "reset";
 *   - everything else: a manual percentage, where the pane scrolls because
 *     the image is allowed to be bigger than it.
 *
 * Fit may land BELOW the minimum below — a 20000 px panorama in a 900 px
 * pane fits at 4.5% — and that is not a violation: the bounds bound the
 * CONTROLS (slider travel, +/- steps), not the honest answer to "what fits".
 *
 * Everything here is pure so the ladder, the clamp, the fit arithmetic and
 * the slider mapping can be tested without a window, exactly as `zoom.ts`
 * does for the app-wide zoom.
 */

/**
 * The zoom bounds, in percent of natural size.
 *
 * 5 at the bottom: at 4% of a 10000 px-wide image the pixels still land more
 * than a device pixel apart, so anything lower shows a blurrier picture for
 * no reachable inspection need — and a floor the fit answer can dip under
 * (see above) must not be so low that "zoom out" from fit feels broken.
 * 1600 at the top: 16x is where a 1 px feature fills a 128 px pane, which is
 * past any pixel-peeping a remote screenshot review needs; Chromium's own
 * image viewers stop in the same place.
 */
export const IMAGE_ZOOM_MIN = 5;
export const IMAGE_ZOOM_MAX = 1600;

/**
 * The +/- ladder. Strictly monotonic with 100 on it, and every entry its own
 * inverse's neighbour, so in-then-out lands exactly where you started — the
 * same contract `ZOOM_STEPS` in `zoom.ts` keeps for the app-wide zoom, for
 * the same reason: a multiplicative step (x1.25, /1.25) drifts to 99.9% and
 * the number the user is shown never returns to a round value.
 *
 * Roughly x1.4 per rung so a hold of the key sweeps the whole range in a
 * dozen presses; the exact neighbours are hand-picked round numbers.
 */
export const IMAGE_ZOOM_STEPS: readonly number[] = [
  5, 8, 12, 16, 25, 35, 50, 70, 100, 140, 200, 280, 400, 560, 800, 1100, 1600,
];

/** Pull `n` onto a whole percent inside [IMAGE_ZOOM_MIN, IMAGE_ZOOM_MAX]. */
export function clampImageZoom(n: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, Math.round(n)));
}

/**
 * The percentage that shows the whole image in a pane of the given CSS
 * pixels, capped at 100 — shrink-to-fit, never stretch-to-fill. This is the
 * viewer's default state and it must reproduce what `max-width: 100%` did,
 * which never enlarged a small image either.
 *
 * A dimension that is not positive (the pane has not been measured yet, a
 * broken image decoded to 0x0) returns 100: "no constraint" is the honest
 * reading of a measurement that does not exist, and the callers hand back
 * their loading state on the same condition anyway.
 */
export function fitPercent(
  naturalWidth: number,
  naturalHeight: number,
  paneWidth: number,
  paneHeight: number,
): number {
  if (naturalWidth <= 0 || naturalHeight <= 0 || paneWidth <= 0 || paneHeight <= 0) {
    return 100;
  }
  return Math.min(100, Math.min(paneWidth / naturalWidth, paneHeight / naturalHeight) * 100);
}

/**
 * Whether the picture AT THIS ZOOM exceeds the pane in either axis — the
 * condition for drag-to-pan, because panning is only meaningful when there
 * is picture outside the pane to bring in. Fit never satisfies this by
 * construction (`fitPercent` never returns a percentage that overflows), so
 * overflow is a manual-zoom state, and it must be COMPUTED rather than read
 * off the element's `scrollWidth`: the pane resizes under the splitter and
 * the window, and a DOM measurement in a computed goes stale exactly then,
 * while the measured refs this reads from are what `fitPercent` uses too.
 *
 * A missing measurement (no decode yet, pane unmeasured) is false — the same
 * honest reading `fitPercent` gives the same condition: no facts, no claim.
 */
export function overflowsPane(
  naturalWidth: number,
  naturalHeight: number,
  zoomPercent: number,
  paneWidth: number,
  paneHeight: number,
): boolean {
  if (naturalWidth <= 0 || naturalHeight <= 0 || paneWidth <= 0 || paneHeight <= 0) {
    return false;
  }
  return (
    (naturalWidth * zoomPercent) / 100 > paneWidth ||
    (naturalHeight * zoomPercent) / 100 > paneHeight
  );
}

/**
 * The next rung up (`direction` 1) or down (-1) from `current`, which need
 * not be on the ladder — the common off-ladder value is Fit, whose answer
 * depends on the pane size and so sits between rungs. Stepping from it
 * re-aligns to the nearest rung past it, one press doing both jobs.
 *
 * Pinned at the ends rather than wrapped: at the BOTTOM the pin is `current`
 * itself, not the minimum — Fit can legitimately sit below the minimum, and
 * returning the minimum there would move the picture the WRONG WAY (out
 * answering with a zoom in). Holding the key at an end doing nothing is what
 * a viewer does; jumping is what a bug looks like.
 */
export function stepImageZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return IMAGE_ZOOM_STEPS.find((step) => step > current) ?? IMAGE_ZOOM_MAX;
  }
  const below = IMAGE_ZOOM_STEPS.filter((step) => step < current);
  return below.length > 0 ? below[below.length - 1]! : current;
}

// ---------------------------------------------------------------------------
// The slider mapping
// ---------------------------------------------------------------------------
/**
 * The slider is LOG-scaled over [MIN, MAX] and reported as 0..100.
 *
 * Linear would spend its track badly: with the bounds above, the whole range
 * a photograph is actually viewed at (50%..200%) would occupy ten percent of
 * the travel and every drag would feel like a switch. The log scale gives
 * every doubling the same travel, which is how zoom feels even to people who
 * have never thought about it.
 *
 * Values outside the bounds pin to the ends of the track — that is how a Fit
 * below the minimum shows up (pinned left) without lying about the percent
 * label, which keeps the true number.
 */

/** Track position (0..100) for a zoom percentage, pinning out-of-range. */
export function zoomToSlider(percent: number): number {
  const z = Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, percent));
  const t = Math.log(z / IMAGE_ZOOM_MIN) / Math.log(IMAGE_ZOOM_MAX / IMAGE_ZOOM_MIN);
  return Math.round(t * 100);
}

/** The whole-percent zoom a track position (0..100) stands for. */
export function sliderToZoom(value: number): number {
  const t = Math.min(100, Math.max(0, value)) / 100;
  return clampImageZoom(IMAGE_ZOOM_MIN * Math.pow(IMAGE_ZOOM_MAX / IMAGE_ZOOM_MIN, t));
}

/** How the percentage is written wherever it is shown to a person. */
export function formatImageZoom(percent: number): string {
  return `${Math.round(percent)}%`;
}
