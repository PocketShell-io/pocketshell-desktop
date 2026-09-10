import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientChannel } from 'ssh2';
import type { ShellTracker } from '../../src/main/ssh/ShellTracker.js';

/**
 * A write aimed at a shell id main no longer tracks is refused, out loud.
 *
 * `shellInput` used to answer `false` for an unknown id before logging
 * anything, which is the one drop that must never be silent: it is the
 * signature of a sender holding a registry entry across the shell's death, and
 * the agent launch that left a user staring at a plain shell travelled exactly
 * this path — typed into a corpse, dropped, no trace in the log. The drop is
 * now logged at any size (the size threshold guards the per-keystroke noise of
 * the SUCCESS path; a drop is never per-keystroke noise).
 */

const log = vi.fn<(...args: unknown[]) => void>();

vi.mock('../../src/main/log.js', () => ({
  log: (...args: unknown[]) => log(...args),
}));

const { SshService } = (await import('../../src/main/ssh/SshService.js')) as {
  SshService: new () => {
    shellTracker: ShellTracker;
    shellInput: (id: string, data: string) => boolean;
  };
};

function fakeChannel(): { channel: ClientChannel; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    channel: {
      write: (data: string): boolean => {
        writes.push(data);
        return true;
      },
      end: (): void => undefined,
      close: (): void => undefined,
    } as unknown as ClientChannel,
  };
}

beforeEach(() => {
  log.mockReset();
});

describe('shellInput refuses and logs a write to an unknown shell id', () => {
  it('delivers to a live shell without the drop log', () => {
    const ssh = new SshService();
    const { channel, writes } = fakeChannel();
    const id = ssh.shellTracker.register({ channel, connectionId: 'conn-1' });

    expect(ssh.shellInput(id, 'hello world')).toBe(true);
    expect(writes).toEqual(['hello world']);
    expect(log).not.toHaveBeenCalledWith(
      'shell',
      'input dropped: no live shell for id',
      expect.anything(),
    );
  });

  it('refuses and logs when the id is already gone', () => {
    const ssh = new SshService();
    const id = ssh.shellTracker.register({
      channel: fakeChannel().channel,
      connectionId: 'conn-1',
    });
    ssh.shellTracker.remove(id);

    expect(ssh.shellInput(id, 'pocketshell agent codex --dir $HOME/git\r')).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'shell',
      'input dropped: no live shell for id',
      expect.objectContaining({ shellId: id }),
    );
  });

  it('refuses and logs an id that never existed, small writes included', () => {
    const ssh = new SshService();

    expect(ssh.shellInput('shell-never', 'a')).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'shell',
      'input dropped: no live shell for id',
      expect.objectContaining({ shellId: 'shell-never', bytes: 1 }),
    );
  });
});
