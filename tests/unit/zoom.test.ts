import { describe, expect, it } from 'vitest';
import {
  clampZoomPercent,
  formatZoomPercent,
  parseZoomPercent,
  stepZoomPercent,
  ZOOM_PERCENT_DEFAULT,
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
  ZOOM_STEPS,
  zoomFactor,
} from '@ui/app/zoom';
import { zoomCommandForInput, type ZoomKeyInput } from '../../src/shared/zoomKeys';

/**
 * The pure half of zoom: the ladder, the clamp, the formatting, and which
 * keystrokes mean what.
 *
 * The keystroke table is the interesting one. Its expectations are not
 * invented — they are the payloads Electron 33.3.1 actually reports on
 * `before-input-event`, read off a running window by feeding each chord in
 * through `sendInputEvent`. That is what settles the reported bug: pressing
 * the `+` key with Ctrl is a DIFFERENT event depending on Shift, and the
 * default menu's `CommandOrControl+Plus` only ever matched one of them.
 */

/** A keydown, with everything not under test held at its resting value. */
function press(over: Partial<ZoomKeyInput>): ZoomKeyInput {
  return {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    control: false,
    meta: false,
    alt: false,
    ...over,
  };
}

describe('clampZoomPercent', () => {
  it('keeps a legal value untouched', () => {
    expect(clampZoomPercent(100)).toBe(100);
    expect(clampZoomPercent(125)).toBe(125);
  });

  it('pulls anything unusable back inside the bounds', () => {
    // The brief's failure case: a zoom that can reach 10% or 1000% is not a
    // preference, it is a way to make the app unreachable.
    expect(clampZoomPercent(10)).toBe(ZOOM_PERCENT_MIN);
    expect(clampZoomPercent(1000)).toBe(ZOOM_PERCENT_MAX);
    expect(clampZoomPercent(-5)).toBe(ZOOM_PERCENT_MIN);
  });

  it('lands on a whole percent', () => {
    expect(clampZoomPercent(100.4)).toBe(100);
    expect(clampZoomPercent(124.6)).toBe(125);
  });
});

describe('parseZoomPercent', () => {
  it('accepts a number or a numeric string', () => {
    expect(parseZoomPercent(125)).toBe(125);
    expect(parseZoomPercent(' 125 ')).toBe(125);
  });

  it('clamps rather than rejecting an out-of-range number', () => {
    expect(parseZoomPercent(5000)).toBe(ZOOM_PERCENT_MAX);
  });

  it('rejects what carries no intent, which sends the store to its default', () => {
    expect(parseZoomPercent('big')).toBeUndefined();
    expect(parseZoomPercent(null)).toBeUndefined();
    expect(parseZoomPercent(undefined)).toBeUndefined();
    expect(parseZoomPercent(Number.NaN)).toBeUndefined();
    expect(parseZoomPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseZoomPercent({})).toBeUndefined();
  });
});

describe('stepZoomPercent', () => {
  it('walks the ladder one rung at a time', () => {
    expect(stepZoomPercent(100, 1)).toBe(110);
    expect(stepZoomPercent(110, 1)).toBe(125);
    expect(stepZoomPercent(100, -1)).toBe(90);
    expect(stepZoomPercent(90, -1)).toBe(80);
  });

  it('is reversible — in then out is exactly where you started', () => {
    // The reason the ladder is a fixed table rather than a multiplier. With
    // `x * 1.1` and `/ 1.1` this walk ends on 99.999…, and the percentage the
    // user is shown never returns to a round number again.
    for (const start of ZOOM_STEPS) {
      const up = stepZoomPercent(start, 1);
      if (up === start) continue; // already at the ceiling
      expect(stepZoomPercent(up, -1)).toBe(start);
    }
  });

  it('pins at the ends instead of wrapping', () => {
    expect(stepZoomPercent(ZOOM_PERCENT_MAX, 1)).toBe(ZOOM_PERCENT_MAX);
    expect(stepZoomPercent(ZOOM_PERCENT_MIN, -1)).toBe(ZOOM_PERCENT_MIN);
  });

  it('re-aligns a value that is not on the ladder, in one press', () => {
    expect(stepZoomPercent(103, 1)).toBe(110);
    expect(stepZoomPercent(103, -1)).toBe(100);
  });

  it('clamps an out-of-range starting point before stepping', () => {
    expect(stepZoomPercent(10_000, -1)).toBe(175);
    expect(stepZoomPercent(-40, 1)).toBe(67);
  });
});

describe('formatZoomPercent / zoomFactor', () => {
  it('writes the percentage the way a person reads it', () => {
    expect(formatZoomPercent(100)).toBe('100%');
    expect(formatZoomPercent(67)).toBe('67%');
  });

  it('formats through the clamp, so no display can show an illegal value', () => {
    expect(formatZoomPercent(9000)).toBe(`${ZOOM_PERCENT_MAX}%`);
  });

  it('converts to the multiplier Chromium takes, 1 being unzoomed', () => {
    expect(zoomFactor(ZOOM_PERCENT_DEFAULT)).toBe(1);
    expect(zoomFactor(150)).toBe(1.5);
    expect(zoomFactor(50)).toBe(0.5);
  });

  it('clamps on the way out too — the one call that moves the window', () => {
    expect(zoomFactor(9000)).toBe(ZOOM_PERCENT_MAX / 100);
    expect(zoomFactor(1)).toBe(ZOOM_PERCENT_MIN / 100);
  });
});

describe('zoomCommandForInput', () => {
  it('matches every spelling of zoom IN a user might produce', () => {
    // Ctrl+= — the one the default menu missed, and the reported bug.
    expect(zoomCommandForInput(press({ control: true, key: '=', code: 'Equal' }))).toBe('in');
    // Ctrl+Shift+= — what `CommandOrControl+Plus` actually means.
    expect(zoomCommandForInput(press({ control: true, key: '+', code: 'Equal' }))).toBe('in');
    // The numeric keypad's +, which reports its own code.
    expect(zoomCommandForInput(press({ control: true, key: '+', code: 'NumpadAdd' }))).toBe('in');
    // A layout with a dedicated + key: matched on the character, not the code.
    expect(zoomCommandForInput(press({ control: true, key: '+', code: 'BracketRight' }))).toBe('in');
  });

  it('matches zoom out and reset, from the main row and the keypad', () => {
    expect(zoomCommandForInput(press({ control: true, key: '-', code: 'Minus' }))).toBe('out');
    expect(zoomCommandForInput(press({ control: true, key: '-', code: 'NumpadSubtract' }))).toBe(
      'out',
    );
    expect(zoomCommandForInput(press({ control: true, key: '0', code: 'Digit0' }))).toBe('reset');
    expect(zoomCommandForInput(press({ control: true, key: '0', code: 'Numpad0' }))).toBe('reset');
  });

  it('takes Cmd on macOS as well as Ctrl', () => {
    expect(zoomCommandForInput(press({ meta: true, key: '=', code: 'Equal' }))).toBe('in');
  });

  it('leaves Ctrl+_ alone — readline binds it to undo', () => {
    // Ctrl+Shift+- on a US layout. Swallowing it would break a chord INSIDE
    // the terminal to buy a fourth spelling of a key that already has three.
    expect(zoomCommandForInput(press({ control: true, key: '_', code: 'Minus' }))).toBeNull();
  });

  it('ignores an unmodified key, so typing = into the terminal still types =', () => {
    expect(zoomCommandForInput(press({ key: '=', code: 'Equal' }))).toBeNull();
    expect(zoomCommandForInput(press({ key: '-', code: 'Minus' }))).toBeNull();
  });

  it('ignores Alt, which layouts use as AltGr to produce characters', () => {
    expect(zoomCommandForInput(press({ control: true, alt: true, key: '+' }))).toBeNull();
  });

  it('acts on keyDown only, so one press is one step', () => {
    expect(zoomCommandForInput(press({ type: 'keyUp', control: true, key: '=' }))).toBeNull();
    expect(zoomCommandForInput(press({ type: 'char', control: true, key: '=' }))).toBeNull();
  });

  it('passes every other chord through untouched', () => {
    for (const key of ['c', 'v', 'a', '1', '9', 'Enter', 'Tab']) {
      expect(zoomCommandForInput(press({ control: true, key }))).toBeNull();
    }
  });
});
