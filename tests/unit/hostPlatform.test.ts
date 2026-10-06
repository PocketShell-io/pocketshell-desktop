import { describe, expect, it } from 'vitest';
import type { SshService } from '../../src/main/ssh/SshService';
import { HostPlatformTracker } from '../../src/main/ssh/hostPlatform';

/**
 * The per-connection OS-family cache every Windows-aware caller shares.
 *
 * The contract is small and load-bearing: one probe exec per connection no
 * matter how many callers race for the answer around a fresh connect, and a
 * forgotten connection re-probes — a re-dial may land on a different machine.
 */

function fakeSsh(log: string[], reply: (command: string) => string): SshService {
  return {
    exec: (_id: string, command: string) => {
      log.push(command);
      return Promise.resolve({ stdout: reply(command), stderr: '', exitCode: 0 });
    },
  } as unknown as SshService;
}

describe('HostPlatformTracker', () => {
  it('probes once and shares the answer with every concurrent caller', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(log, (c) => (c === 'uname -s' ? 'MINGW64_NT-10.0-19045\n' : ''));
    const tracker = new HostPlatformTracker();

    const [a, b, c] = await Promise.all([
      tracker.platformOf(ssh, 'conn-1'),
      tracker.platformOf(ssh, 'conn-1'),
      tracker.platformOf(ssh, 'conn-1'),
    ]);

    expect(a).toBe('windows');
    expect(b).toBe('windows');
    expect(c).toBe('windows');
    // One `uname -s` for the whole burst, not one per caller.
    expect(log.filter((command) => command === 'uname -s')).toHaveLength(1);
  });

  it('answers per connection, not per tracker', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(log, (c) => (c === 'uname -s' ? 'Linux\n' : ''));
    const tracker = new HostPlatformTracker();

    expect(await tracker.platformOf(ssh, 'conn-1')).toBe('posix');
    expect(await tracker.platformOf(ssh, 'conn-2')).toBe('posix');
    expect(log.filter((command) => command === 'uname -s')).toHaveLength(2);
  });

  it('forgets on demand, so a re-dial re-probes the far end', async () => {
    const log: string[] = [];
    const ssh = fakeSsh(log, (c) => (c === 'uname -s' ? 'MINGW64_NT-10.0-19045\n' : ''));
    const tracker = new HostPlatformTracker();

    expect(await tracker.platformOf(ssh, 'conn-1')).toBe('windows');
    expect(log).toHaveLength(1);

    tracker.forget('conn-1');
    expect(await tracker.platformOf(ssh, 'conn-1')).toBe('windows');
    expect(log).toHaveLength(2);
  });
});
