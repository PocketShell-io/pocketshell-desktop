import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import {
  hasCompleteViewport,
  repairIncompleteViewport,
  resumeWriteBufferAfterError,
} from '@ui/app/xtermWriteBuffer';

/**
 * The write-loop recovery, against the REAL xterm internals.
 *
 * `@xterm/headless` is the same CoreTerminal the renderer's Terminal is built
 * on, minus the DOM — including `WriteBuffer`, the component that dies when a
 * parser handler throws. That death is the whole subject, so the test does
 * not fake it: it registers a CSI handler that throws (the same sync-throw
 * path `reverseIndex` took in the production incident), lets the exception
 * escape into Node's `uncaughtException` exactly as it escapes into the
 * renderer's window `error` handler, and holds the recovery to account: the
 * loop parses again — proven the only way the loop's health is observable,
 * write callbacks firing again.
 *
 * Deliberately NOT asserted: that bytes written after the recovery land
 * verbatim. They cannot. The throw left the parser mid-escape-sequence, and
 * xterm interprets the next chunk's head bytes as that sequence's
 * continuation — a test run measured it (` p` of a following ` probe` got
 * eaten as the intermediate+final of a half-entered CSI). That corruption is
 * why the pane's recovery does not stop at the resume: the caller follows it
 * with a fresh join, whose `reset()` re-initialises the parser from a known
 * state. This test pins the loop; TerminalView owns the repair.
 *
 * It is also the guard on `resumeWriteBufferAfterError`'s shape checks: run
 * against an upgraded xterm whose internals moved, the false-return path is
 * what must happen — a recovery that half-applies is worse than none.
 */

const { Terminal } = headless;

function makeTerminal(): headless.Terminal {
  return new Terminal({ cols: 40, rows: 6, scrollback: 200 });
}

/**
 * Register a handler on the parser's own CSI dispatch — the same table the
 * built-in handlers (reverseIndex, the scroll handlers, …) sit in. The
 * headless package keeps `registerCsiHandler` off its public Terminal, so the
 * test reaches it through the core; the renderer's Terminal has it public.
 */
function registerPoisonCsi(term: headless.Terminal, message: string): void {
  const core = (term as unknown as {
    _core: { _inputHandler: { _parser: { registerCsiHandler: (id: { final: string }, cb: () => never) => void } } };
  })._core;
  core._inputHandler._parser.registerCsiHandler({ final: 'q' }, () => {
    throw new Error(message);
  });
}

/** Await one macrotask turn — enough for xterm's setTimeout-driven parse pass. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Write and wait for xterm's own completion callback for that chunk. */
const writeParsed = (term: headless.Terminal, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve));

let uncaught: Error[] = [];
const onUncaught = (err: Error): void => { uncaught.push(err); };

beforeEach(() => {
  uncaught = [];
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.off('uncaughtException', onUncaught);
});

describe('resumeWriteBufferAfterError', () => {
  it('a healthy terminal has nothing to recover', async () => {
    const term = makeTerminal();
    await writeParsed(term, 'hello');
    expect(resumeWriteBufferAfterError(term)).toBe(false);
    expect(uncaught).toEqual([]);
    term.dispose();
  });

  it('a throwing parser handler wedges the loop, and the resume restarts it', async () => {
    const term = makeTerminal();
    registerPoisonCsi(term, 'parser boom');

    await writeParsed(term, 'before '); // settles normally — the loop is alive
    term.write('POISON\x1b[0qAFTER'); // dies mid-chunk; callback never fires
    await tick();
    await tick();

    // The throw escaped the parse pass into the process, like it escapes into
    // the renderer's window `error` handler — and it killed the loop: nothing
    // after the dead chunk parses, and queued write callbacks never fire.
    expect(uncaught.map((e) => e.message)).toEqual(['parser boom']);
    let parsedAfterWedge = false;
    term.write(' probe', () => { parsedAfterWedge = true; });
    await tick();
    await tick();
    expect(parsedAfterWedge).toBe(false);

    // The recovery: retire the dead chunk, restart the loop.
    expect(resumeWriteBufferAfterError(term)).toBe(true);

    // The loop parses again — callbacks fire, which is the one signal the
    // pane's stall monitor has. (The TEXT is not asserted: the dead chunk
    // left the parser mid-escape, so the first bytes of the next chunk are
    // consumed as its continuation. The caller's fresh join repairs that.)
    await writeParsed(term, ' anything');
    term.dispose();
  });

  it('recovers when the dead chunk was the last one, and stays recoverable', async () => {
    const term = makeTerminal();
    registerPoisonCsi(term, 'parser boom');

    term.write('\x1b[0q');
    await tick();
    await tick();
    expect(uncaught.map((e) => e.message)).toEqual(['parser boom']);
    expect(resumeWriteBufferAfterError(term)).toBe(true);

    await writeParsed(term, 'still alive');
    expect(resumeWriteBufferAfterError(term)).toBe(false); // healthy again
    term.dispose();
  });
});

describe('xterm viewport invariant repair', () => {
  it('backfills missing lines exposed by a real row-growing resize', async () => {
    const term = new Terminal({ cols: 39, rows: 18, scrollback: 100 });
    const core = (term as unknown as {
      _core: {
        rows: number;
        buffers: { active: { ybase: number; y: number; lines: { length: number; get: (row: number) => unknown } } };
      };
    })._core;
    const active = core.buffers.active;

    // This is the masked precondition from xtermjs/xterm.js#6063: the logical
    // length is shorter than the viewport while stale CircularList backing
    // slots can still make reads appear valid. The actual resize below is what
    // takes the broken row-decrement path and leaves the missing viewport.
    await writeParsed(term, Array.from({ length: 22 }, (_, i) => `line-${i}\r\n`).join('') + '\x1b[4A');
    expect(active.ybase).toBe(5);
    expect(active.y).toBe(13);
    active.lines.length = 18;
    term.resize(37, 23);

    expect(active.lines.length).toBeLessThan(active.ybase + core.rows);
    expect(hasCompleteViewport(term)).toBe(false);
    expect(repairIncompleteViewport(term)).toBe(true);
    expect(hasCompleteViewport(term)).toBe(true);

    // Backfill preserves the lines already parsed and makes every newly
    // exposed row safe for the same erase/print sequence that crashed xterm.
    expect(active.lines.get(0)).toBeDefined();
    for (let row = 18; row <= 22; row++) {
      await writeParsed(term, `\x1b[${row + 1};1H\x1b[2Kbottom-${row}`);
      expect(active.lines.get(row)).toBeDefined();
    }

    term.dispose();
  });

  it('leaves a healthy terminal alone', () => {
    const term = makeTerminal();
    expect(hasCompleteViewport(term)).toBe(true);
    expect(repairIncompleteViewport(term)).toBe(false);
    term.dispose();
  });
});
