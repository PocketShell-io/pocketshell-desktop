import { describe, expect, it, vi } from 'vitest';
import { ConnectionRegistry, UnknownConnectionError, type SshConnectionRecord } from '../../src/main/ssh/ConnectionRegistry';
import { ShellTracker } from '../../src/main/ssh/ShellTracker';

/**
 * The two id registries everything else keys off.
 *
 * Both are the same shape — register mints an id, remove evicts, and cleanup
 * walks the map — and both are load-bearing in the same way: a stale id must
 * throw or answer undefined rather than hand back a DIFFERENT connection's
 * record, which is what a map that reused indices would do.
 */

/** A minimal stand-in for an ssh2 channel: the tracker calls end()+close(). */
function fakeChannel() {
  return { end: vi.fn(), close: vi.fn() } as never;
}

/** The fields register() requires besides the id it mints. */
const record = (over: Record<string, unknown> = {}): Omit<SshConnectionRecord, 'id'> =>
  ({
    kind: 'ssh',
    client: { end: vi.fn() },
    label: 'me@host:22',
    host: 'host',
    port: 22,
    user: 'me',
    knownHosts: null,
    connectedAt: 1,
    ...over,
  }) as unknown as Omit<SshConnectionRecord, 'id'>;

describe('ConnectionRegistry', () => {
  it('mints a distinct id per registration and hands the record back', () => {
    const registry = new ConnectionRegistry();
    const a = registry.register(record());
    const b = registry.register(record());
    expect(a).not.toBe(b);
    expect(registry.get(a)?.label).toBe('me@host:22');
  });

  it('require throws UnknownConnectionError for an unknown or removed id', () => {
    const registry = new ConnectionRegistry();
    const id = registry.register(record());
    registry.remove(id);

    expect(() => registry.require('conn-never')).toThrow(UnknownConnectionError);
    expect(() => registry.require(id)).toThrow(UnknownConnectionError);
    // get stays the honest optional: undefined, not a throw.
    expect(registry.get(id)).toBeUndefined();
  });

  it('remove evicts exactly the one record', () => {
    const registry = new ConnectionRegistry();
    const a = registry.register(record({ label: 'a' }));
    const b = registry.register(record({ label: 'b' }));

    expect(registry.remove(a)?.label).toBe('a');
    expect(registry.get(a)).toBeUndefined();
    expect(registry.get(b)?.label).toBe('b');
  });

  it('clear ends every client and empties the registry', () => {
    const registry = new ConnectionRegistry();
    const end = vi.fn();
    const rec = record({ client: { end } });
    const id = registry.register(rec);

    registry.clear();

    expect(end).toHaveBeenCalledTimes(1);
    expect(registry.get(id)).toBeUndefined();
  });
});

describe('ShellTracker', () => {
  it('registers, gets, and removes shells by minted id', () => {
    const tracker = new ShellTracker();
    const id = tracker.register({ channel: fakeChannel(), connectionId: 'conn-1' });
    expect(id).toMatch(/^shell-/);
    expect(tracker.get(id)?.connectionId).toBe('conn-1');

    expect(tracker.remove(id)?.connectionId).toBe('conn-1');
    expect(tracker.get(id)).toBeUndefined();
  });

  it('closeAllForConnection ends only the matching connection shells', () => {
    const tracker = new ShellTracker();
    // Typed as the record's channel type where stored; kept as fakes here so
    // the assertions can read the spies.
    const kept = { end: vi.fn(), close: vi.fn() };
    const killed = { end: vi.fn(), close: vi.fn() };
    const keepId = tracker.register({ channel: kept as never, connectionId: 'conn-1' });
    const killId = tracker.register({ channel: killed as never, connectionId: 'conn-2' });

    tracker.closeAllForConnection('conn-2');

    expect(killed.end).toHaveBeenCalledTimes(1);
    expect(killed.close).toHaveBeenCalledTimes(1);
    expect(kept.end).not.toHaveBeenCalled();
    expect(tracker.get(keepId)).toBeDefined();
    expect(tracker.get(killId)).toBeUndefined();
  });

  it('a channel that throws on close does not break the sweep', () => {
    const tracker = new ShellTracker();
    const explosive = {
      end: () => {
        throw new Error('already dead');
      },
      close: () => undefined,
    } as never;
    tracker.register({ channel: explosive, connectionId: 'conn-1' });

    expect(() => tracker.closeAllForConnection('conn-1')).not.toThrow();
    expect(tracker.get('shell-1')).toBeUndefined();
  });
});
