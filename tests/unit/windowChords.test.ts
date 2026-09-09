import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The chords main intercepts before the page sees them. Zoom is forwarded to
 * the renderer as an intent (main must not own zoom state); the window
 * commands are decided here. `preventDefault` on a match is load-bearing —
 * it is what stops the OS accelerator table from acting behind the app's
 * back — and NOT matching must not suppress anything.
 */

const handlers: ((event: { preventDefault: () => void }, input: unknown) => void)[] = [];
const send = vi.fn();
const toggleDevTools = vi.fn();
const close = vi.fn();

vi.mock('electron', () => ({}));

const { applyChordDispatch } = await import('../../src/main/windowChords');

function dispatch(partial: Record<string, unknown>): { prevented: boolean } {
  const input = { type: 'keyDown', ...partial };
  let prevented = false;
  for (const handler of handlers) {
    handler({ preventDefault: () => (prevented = true) }, input);
  }
  return { prevented };
}

beforeEach(() => {
  handlers.length = 0;
  send.mockClear();
  toggleDevTools.mockClear();
  close.mockClear();
  applyChordDispatch(
    { on: (_e: string, fn: (event: unknown, input: unknown) => void) => handlers.push(fn), send, toggleDevTools } as never,
    close,
  );
});

describe('windowChords', () => {
  it('forwards every zoom spelling to the renderer as an intent', () => {
    const spellings: Record<string, unknown>[] = [
      { control: true, key: '=' },
      { control: true, shift: true, key: '+' },
      { control: true, code: 'NumpadAdd' },
    ];
    for (const input of spellings) {
      const { prevented } = dispatch(input);
      expect(prevented).toBe(true);
      expect(send).toHaveBeenLastCalledWith(expect.any(String), 'in');
    }
  });

  it('forwards zoom-out and reset as intents too', () => {
    dispatch({ control: true, key: '-' });
    expect(send).toHaveBeenLastCalledWith(expect.any(String), 'out');

    dispatch({ control: true, key: '0' });
    expect(send).toHaveBeenLastCalledWith(expect.any(String), 'reset');
  });

  it('closes the window on the close chord, deciding in main', () => {
    const { prevented } = dispatch({ control: true, shift: true, key: 'w' });
    expect(prevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('toggles DevTools on its chord', () => {
    dispatch({ control: true, shift: true, key: 'i' });
    expect(toggleDevTools).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('suppresses nothing it does not recognise', () => {
    const { prevented } = dispatch({ control: true, shift: true, key: 'a' });
    expect(prevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(toggleDevTools).not.toHaveBeenCalled();
  });
});
