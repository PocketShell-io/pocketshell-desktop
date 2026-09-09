import { describe, expect, it } from 'vitest';
import { ReconnectBackoff, MAX_ATTEMPTS } from '../../src/shared/reconnectBackoff';

/**
 * The reconnect schedule, now in shared/ because its real consumer is the
 * renderer's connection store. All that survives of the old
 * `AutoForwarderSupervisor` (which opened its own second SSH connection). The Python has two contradictory versions of this:
 * the CLI's 5->60s exponential (`forwarder.py:1141`) and the TUI's flat 5s
 * with no backoff at all (`dashboard.py:1036-1038`). We keep the CLI curve.
 */
describe('ReconnectBackoff', () => {
  it('doubles from 5s and caps at 60s', () => {
    const backoff = new ReconnectBackoff();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(backoff.next(0)!.delayMs);
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('reports an absolute retry time so the renderer can tick a countdown', () => {
    const plan = new ReconnectBackoff().next(1_000)!;
    expect(plan).toEqual({ attempt: 1, delayMs: 5_000, retryAtEpochMs: 6_000 });
  });

  it('gives up after MAX_ATTEMPTS rather than hammering a dead host forever', () => {
    // The Python retries forever; the Android FSM stops at 10 and reports
    // 'lost', which is the behaviour worth keeping.
    const backoff = new ReconnectBackoff();
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(backoff.next(0)).not.toBeNull();
    expect(backoff.exhausted).toBe(true);
    expect(backoff.next(0)).toBeNull();
    expect(backoff.attempts).toBe(MAX_ATTEMPTS);
  });

  it('reset() puts the next failure back at the bottom of the curve', () => {
    const backoff = new ReconnectBackoff();
    backoff.next(0);
    backoff.next(0);
    backoff.reset();
    expect(backoff.attempts).toBe(0);
    expect(backoff.next(0)!.delayMs).toBe(5_000);
  });

  it('honours custom bounds', () => {
    const backoff = new ReconnectBackoff({ initialDelayMs: 100, maxDelayMs: 250, maxAttempts: 3 });
    expect([backoff.next(0)!.delayMs, backoff.next(0)!.delayMs, backoff.next(0)!.delayMs]).toEqual([
      100, 200, 250,
    ]);
    expect(backoff.next(0)).toBeNull();
  });
});
