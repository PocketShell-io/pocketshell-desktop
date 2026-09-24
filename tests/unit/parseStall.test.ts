import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParseStallMonitor, PARSE_STALL_TIMEOUT_MS, type ParseStallReport } from '@ui/app/parseStall';

/**
 * The stall monitor, against a fake terminal.
 *
 * The contract under test is xterm's own write-callback shape: `write(data,
 * cb)` where cb fires when the chunk has been parsed — and, in the failure
 * mode this module exists for, never fires at all. The fake reproduces exactly
 * that surface and nothing else, so the tests say what happens when callbacks
 * complete, complete out of a deep backlog, or never complete.
 */

/** A terminal fake whose writes complete only when `settle` is called. */
function fakeTerminal() {
  const pending: { data: string; cb?: () => void }[] = [];
  const written: string[] = [];
  const term = {
    write(data: string, cb?: () => void): void {
      written.push(data);
      pending.push({ data, cb });
    },
  };
  return {
    term,
    written,
    /** Complete the OLDEST unwritten callback, like xterm's FIFO queue. */
    settle(): void {
      pending.shift()?.cb?.();
    },
    pendingCount: (): number => pending.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ParseStallMonitor', () => {
  it('does not fire when every chunk parses (the healthy path)', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    monitor.write(t.term, '\x1b[1mhello');
    t.settle();
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1_000);

    expect(stalls).toEqual([]);
    monitor.dispose();
  });

  it('fires once with the stalled chunk when its callback never comes', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    monitor.write(t.term, '\x1bMpoison');

    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS - 1);
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(stalls).toHaveLength(1);
    // The printable preview escapes control bytes so the log line stays legible.
    expect(stalls[0]?.chunk).toBe('\\x1bMpoison');
    expect(stalls[0]?.chunkHex).toBe('1b 4d 70 6f 69 73 6f 6e');
    expect(stalls[0]?.pendingBehind).toBe(0);
    monitor.dispose();
  });

  it('does not fire twice for the same wedged head, even as later writes pile up', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    monitor.write(t.term, 'dead');
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1);
    expect(stalls).toHaveLength(1);

    // The wedge means no callback ever fires; more output keeps arriving.
    monitor.write(t.term, 'more');
    monitor.write(t.term, 'and more');
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS * 10);

    expect(stalls).toHaveLength(1);
    monitor.dispose();
  });

  it('counts chunks queued behind the stalled head', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    monitor.write(t.term, 'head');
    monitor.write(t.term, 'second');
    monitor.write(t.term, 'third');
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.pendingBehind).toBe(2);
    monitor.dispose();
  });

  it('does not trip on a deep backlog that keeps parsing — the timer waits for the turn', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    // A burst heavier than the timeout, but each chunk completes in turn.
    for (let i = 0; i < 10; i++) monitor.write(t.term, `chunk-${i}`);
    for (let i = 0; i < 10; i++) {
      t.settle();
      vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS / 2);
    }
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1_000);

    expect(stalls).toEqual([]);
    expect(t.pendingCount()).toBe(0);
    monitor.dispose();
  });

  it('resumes guarding after a stalled chunk is completed late (recovery happened)', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    monitor.write(t.term, 'stalled');
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1);
    expect(stalls).toHaveLength(1);

    // The write loop was resumed externally; the backlogged callback arrives,
    // and fresh output parses normally again.
    t.settle();
    monitor.write(t.term, 'fresh bytes');
    t.settle();
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1_000);

    expect(stalls).toHaveLength(1); // the recovery path parsed fine — no new stall
    monitor.dispose();
  });

  it('reads live pane facts through describe() at stall time', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    let live = { rows: 10 };
    const monitor = new ParseStallMonitor({
      onStall: (r) => stalls.push(r),
      describe: () => ({ ...live }),
    });

    monitor.write(t.term, 'x');
    live = { rows: 42 }; // changed AFTER the write, BEFORE the stall
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1);

    expect(stalls[0]?.details).toEqual({ rows: 42 });
    monitor.dispose();
  });

  it('dispose() stops any further stall from a pending timer', () => {
    const t = fakeTerminal();
    const stalls: ParseStallReport[] = [];
    const monitor = new ParseStallMonitor({ onStall: (r) => stalls.push(r) });

    monitor.write(t.term, 'never parsed');
    monitor.dispose();
    vi.advanceTimersByTime(PARSE_STALL_TIMEOUT_MS + 1_000);

    expect(stalls).toEqual([]);
  });
});
