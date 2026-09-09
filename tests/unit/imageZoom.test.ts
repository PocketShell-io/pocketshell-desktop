import { describe, expect, it } from 'vitest';
import {
  clampImageZoom,
  fitPercent,
  formatImageZoom,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  IMAGE_ZOOM_STEPS,
  overflowsPane,
  sliderToZoom,
  stepImageZoom,
  zoomToSlider,
} from '../../src/renderer/imageZoom';

/**
 * The pure half of the image viewer's zoom: the clamp, the +/- ladder, the
 * fit arithmetic, the log-scaled slider mapping, and the overflow predicate
 * that arms drag-to-pan.
 *
 * The expectations that are not plain arithmetic are pinned to decisions
 * written in the module header:
 *
 *   - Fit never upscales (the `max-width: 100%` behaviour the viewer shipped
 *     with) but DOES dip below the control minimum for images far larger
 *     than the pane;
 *   - stepping is pinned, not wrapped, and pinned to `current` — not to the
 *     minimum — when stepping DOWN from below the ladder, because Fit can
 *     legitimately sit below it and returning the minimum there would move
 *     the picture the wrong way;
 *   - the slider is log-scaled, so the endpoints and the doubling rhythm are
 *     what is under test, not the raw numbers.
 */

describe('ladder invariants', () => {
  it('is strictly monotonic and holds 100', () => {
    for (let i = 1; i < IMAGE_ZOOM_STEPS.length; i++) {
      expect(IMAGE_ZOOM_STEPS[i]!).toBeGreaterThan(IMAGE_ZOOM_STEPS[i - 1]!);
    }
    expect(IMAGE_ZOOM_STEPS).toContain(100);
  });

  it('stays inside the clamp bounds', () => {
    expect(IMAGE_ZOOM_STEPS[0]).toBeGreaterThanOrEqual(IMAGE_ZOOM_MIN);
    expect(IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1]).toBeLessThanOrEqual(IMAGE_ZOOM_MAX);
  });
});

describe('clampImageZoom', () => {
  it('rounds to a whole percent', () => {
    expect(clampImageZoom(99.6)).toBe(100);
    expect(clampImageZoom(70.4)).toBe(70);
  });

  it('pins to the bounds', () => {
    expect(clampImageZoom(1)).toBe(IMAGE_ZOOM_MIN);
    expect(clampImageZoom(99999)).toBe(IMAGE_ZOOM_MAX);
  });
});

describe('stepImageZoom', () => {
  it('steps to the neighbouring rung, so in-then-out is reversible', () => {
    expect(stepImageZoom(100, 1)).toBe(140);
    expect(stepImageZoom(100, -1)).toBe(70);
    expect(stepImageZoom(stepImageZoom(100, 1), -1)).toBe(100);
    expect(stepImageZoom(stepImageZoom(100, -1), 1)).toBe(100);
  });

  it('re-aligns an off-ladder value in one press', () => {
    // Fit answers are pane-dependent and land between rungs; the first step
    // must land ON the ladder, not relative to where fit happened to be.
    expect(stepImageZoom(63, 1)).toBe(70);
    expect(stepImageZoom(63, -1)).toBe(50);
  });

  it('pins at the top and bottom rather than wrapping', () => {
    expect(stepImageZoom(IMAGE_ZOOM_MAX, 1)).toBe(IMAGE_ZOOM_MAX);
    expect(stepImageZoom(IMAGE_ZOOM_MIN, -1)).toBe(IMAGE_ZOOM_MIN);
  });

  it('pins to current, not to the minimum, below the ladder', () => {
    // Fit of a huge image can sit under IMAGE_ZOOM_MIN; zoom-out must not
    // answer with the minimum — that would zoom IN.
    expect(stepImageZoom(3, -1)).toBe(3);
    // ...while zoom-in still reaches the ladder.
    expect(stepImageZoom(3, 1)).toBe(IMAGE_ZOOM_MIN);
  });
});

describe('fitPercent', () => {
  it('picks the tighter axis', () => {
    // 1000x500 in 500x400: width ratio 0.5, height ratio 0.8 -> 50%.
    expect(fitPercent(1000, 500, 500, 400)).toBe(50);
    // Same image, tall pane: height ratio 0.4 wins.
    expect(fitPercent(1000, 500, 800, 200)).toBe(40);
  });

  it('never upscales a small image past 100%', () => {
    // 200x100 in a 900x600 pane: the old max-width viewer showed it at
    // natural size, and fit must reproduce that, not fill the pane.
    expect(fitPercent(200, 100, 900, 600)).toBe(100);
  });

  it('dips below the control minimum for images far larger than the pane', () => {
    expect(fitPercent(20000, 10000, 900, 450)).toBe(4.5);
  });

  it('answers 100 for measurements that do not exist', () => {
    expect(fitPercent(0, 100, 500, 400)).toBe(100);
    expect(fitPercent(1000, 500, 0, 400)).toBe(100);
    expect(fitPercent(1000, 500, 0, 0)).toBe(100);
  });
});

describe('overflowsPane', () => {
  it('is true only when an axis exceeds the pane at the given zoom', () => {
    // 1000x500 at 70% is 700x350: wide of a 500x400 pane, not tall of it.
    expect(overflowsPane(1000, 500, 70, 500, 400)).toBe(true);
    // 1000x500 at 50% is 500x350: exactly the pane's width is NOT overflow —
    // the exact-fit border is where panning has nothing to bring in.
    expect(overflowsPane(1000, 500, 50, 500, 400)).toBe(false);
    expect(overflowsPane(1000, 500, 40, 500, 400)).toBe(false);
    // Taller than the pane while narrower: the other axis alone suffices.
    expect(overflowsPane(1000, 500, 70, 800, 300)).toBe(true);
  });

  it('is false for measurements that do not exist', () => {
    expect(overflowsPane(0, 100, 100, 500, 400)).toBe(false);
    expect(overflowsPane(1000, 500, 100, 0, 400)).toBe(false);
  });
});

describe('slider mapping', () => {
  it('pins the bounds to the ends of the track', () => {
    expect(zoomToSlider(IMAGE_ZOOM_MIN)).toBe(0);
    expect(zoomToSlider(IMAGE_ZOOM_MAX)).toBe(100);
    expect(sliderToZoom(0)).toBe(IMAGE_ZOOM_MIN);
    expect(sliderToZoom(100)).toBe(IMAGE_ZOOM_MAX);
  });

  it('pins out-of-range values to the track ends without moving the label', () => {
    // A fit below the minimum is real (huge image, small pane); the slider
    // shows it at the left end. The LABEL keeps the true number — that is
    // formatImageZoom's job — but the mapping must not invent a position.
    expect(zoomToSlider(3)).toBe(0);
    expect(zoomToSlider(99999)).toBe(100);
  });

  it('is monotonic in both directions', () => {
    let lastSlider = -1;
    let lastZoom = 0;
    for (let z = IMAGE_ZOOM_MIN; z <= IMAGE_ZOOM_MAX; z += 5) {
      const s = zoomToSlider(z);
      expect(s).toBeGreaterThanOrEqual(lastSlider);
      lastSlider = s;
      const back = sliderToZoom(s);
      expect(back).toBeGreaterThanOrEqual(lastZoom);
      lastZoom = back;
    }
  });

  it('round-trips a mid-track value to within rounding', () => {
    for (const z of [50, 70, 100, 200, 400, 800]) {
      expect(Math.abs(sliderToZoom(zoomToSlider(z)) - z)).toBeLessThanOrEqual(2);
    }
  });
});

describe('formatImageZoom', () => {
  it('shows a whole percent, including fit answers below the minimum', () => {
    expect(formatImageZoom(100)).toBe('100%');
    expect(formatImageZoom(4.5)).toBe('5%');
  });
});
