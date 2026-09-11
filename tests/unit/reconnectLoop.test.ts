//
// The reconnect loop's scheduling machinery, directly — the connection store
// suite (connectionAutoReconnect.test.ts) already drives the FSM through the
// mocked bridge end to end; these pin the loop's own contract: the curve,
// the countdown, the generation guard, and what a cancellation orphans.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectLoop } from '../../src/renderer/reconnectLoop';

/**
 * The owner contract the store implements: `dial` reports success/failure,
 * and a SUCCESSFUL owner dial calls `succeeded()` before returning (the
 * store's `reconnect()` does this in its success branch).
 */
function makeLoop(dialOk: () => boolean = () => false) {
  const calls = { dials: 0, failed: 0, gaveUp: 0 };
  const loop = new ReconnectLoop({
    hasTarget: () => true,
    dial: async () => {
      calls.dials += 1;
      const ok = dialOk();
      if (ok) loop.succeeded();
      return ok;
    },
    onDialFailed: () => {
      calls.failed += 1;
    },
    onGiveUp: () => {
      calls.gaveUp += 1;
    },
  });
  return { loop, calls };
}

/** The curve the shared backoff produces: 5, 10, 20, 40, then 60s steps. */
const CURVE_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000];
const CURVE_FIRST_MS = 5_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReconnectLoop', () => {
  it('begin() schedules the first retry in 5s and starts the countdown', async () => {
    const { loop, calls } = makeLoop();
    loop.begin();
    expect(loop.recovering.value).toBe(true);
    expect(loop.autoRetry.value?.attempt).toBe(1);
    expect(loop.retryIn.value).toBe(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.retryIn.value).toBe(4);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls.dials).toBe(1);
    // The dial came back false, so the next step is already scheduled and
    // its own countdown is running: the 10s rung reads 10.
    expect(loop.autoRetry.value?.attempt).toBe(2);
    expect(loop.retryIn.value).toBe(10);
  });

  it('a failed dial reports the failure and steps up the curve', async () => {
    const { loop, calls } = makeLoop();
    loop.begin();
    await vi.advanceTimersByTimeAsync(CURVE_FIRST_MS);
    expect(calls.failed).toBe(1);
    expect(loop.autoRetry.value?.attempt).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.dials).toBe(2);
    expect(loop.autoRetry.value?.attempt).toBe(3);
  });

  it('a successful owner dial stops the schedule', async () => {
    const { loop, calls } = makeLoop(() => true);
    loop.begin();
    await vi.advanceTimersByTimeAsync(CURVE_FIRST_MS);
    expect(calls.dials).toBe(1);
    expect(loop.running).toBe(false);
    expect(loop.recovering.value).toBe(false);
    expect(loop.autoRetry.value).toBeNull();
    // No further steps fire.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.dials).toBe(1);
  });

  it('gives up after the budget is spent and leaves the state to the owner', async () => {
    const { loop, calls } = makeLoop();
    loop.begin();
    for (const delay of CURVE_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(calls.dials).toBe(CURVE_MS.length);
    expect(calls.gaveUp).toBe(1);
    expect(loop.running).toBe(false);
    expect(loop.recovering.value).toBe(false);
    expect(loop.autoRetry.value).toBeNull();
    // Spent is spent: no more dials.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls.dials).toBe(CURVE_MS.length);
  });

  it('begin() is idempotent while a curve is already running', async () => {
    const { loop, calls } = makeLoop();
    loop.begin();
    loop.begin();
    await vi.advanceTimersByTimeAsync(CURVE_FIRST_MS);
    expect(calls.dials).toBe(1);
  });

  it('begin() refuses to start with nothing to re-dial', () => {
    const loop = new ReconnectLoop({
      hasTarget: () => false,
      dial: async () => true,
      onDialFailed: () => undefined,
      onGiveUp: () => undefined,
    });
    loop.begin();
    expect(loop.running).toBe(false);
    expect(loop.recovering.value).toBe(false);
    expect(loop.autoRetry.value).toBeNull();
  });

  it('skipWait() dials now and keeps the budget position', async () => {
    const { loop, calls } = makeLoop();
    loop.begin();
    await vi.advanceTimersByTimeAsync(2_000);
    await loop.skipWait();
    expect(calls.dials).toBe(1);
    // The pending attempt was consumed by the skip, not by its timer: the
    // next step is attempt 2 on the 10s rung, not a restarted 5s one.
    expect(loop.autoRetry.value?.attempt).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.dials).toBe(2);
  });

  it('clearPendingStep() retires the timer but leaves the curve armed', async () => {
    const { loop, calls } = makeLoop();
    loop.begin();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.clearPendingStep();
    expect(loop.autoRetry.value).toBeNull();
    expect(loop.retryIn.value).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.dials).toBe(0);
    // The curve itself survives a manual dial that supersedes the step.
    expect(loop.running).toBe(true);
  });

  it('cancel() orphanes a dial already on the wire', async () => {
    const failed = vi.fn();
    const gaveUp = vi.fn();
    let resolveDial: (ok: boolean) => void = () => undefined;
    const loop = new ReconnectLoop({
      hasTarget: () => true,
      dial: () =>
        new Promise<boolean>((resolve) => {
          resolveDial = resolve;
        }),
      onDialFailed: failed,
      onGiveUp: gaveUp,
    });
    loop.begin();
    await vi.advanceTimersByTimeAsync(CURVE_FIRST_MS);
    expect(loop.recovering.value).toBe(true);
    loop.cancel();
    resolveDial(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).not.toHaveBeenCalled();
    expect(gaveUp).not.toHaveBeenCalled();
    expect(loop.running).toBe(false);
    expect(loop.recovering.value).toBe(false);
    // A cancelled loop does not come back on its own.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(failed).not.toHaveBeenCalled();
  });
});
