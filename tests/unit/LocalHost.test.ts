import { describe, expect, it } from 'vitest';
import { SshService } from '../../src/main/ssh/SshService';
import {
  execLocal,
  localBash,
  localHostPlatform,
  selfHostEntry,
  withSelfEntry,
} from '../../src/main/local/LocalHost';
import type { HostEntry } from '@pocketshell/core';

/**
 * The local ("self") transport, against THIS machine's real bash — the exec
 * surface is one spawn, so a real child answers everything the fake could
 * only assert about plumbing, and the plumbing is the behaviour.
 *
 * Skipped where no bash exists (the exec tests), never for the service-level
 * tests: a local dial itself cannot fail — no transport, no keys.
 */

describe('execLocal', () => {
  it.skipIf(!localBash())('runs a POSIX command and carries stdout and the exit code', async () => {
    const res = await execLocal('echo self-ok');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('self-ok');
    expect(res.stderr).toBe('');
  });

  it.skipIf(!localBash())('treats a non-zero exit as a result, not a rejection', async () => {
    const res = await execLocal('echo boom >&2; exit 3');
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('boom');
  });

  it.skipIf(!localBash())('writes opts.stdin and closes it', async () => {
    const res = await execLocal('cat', { stdin: 'secret-value' });
    expect(res.stdout).toBe('secret-value');
  });

  it.skipIf(!localBash())('kills a wedged command at the timeout and settles', async () => {
    const res = await execLocal('sleep 10', { timeoutMs: 300 });
    expect(res.exitCode).toBe(-1);
    expect(res.stderr).toContain('timed out');
  }, 10_000);

  it.skipIf(!localBash())('resolves the wrapped PATH command form the shared builders emit', async () => {
    // `pathAwareCommand` wraps in `/bin/sh -lc '...'` — the exact shape
    // aplexer's probe and snapshot ride. It must survive a local spawn.
    const res = await execLocal("/bin/sh -lc 'echo wrapped-ok'");
    expect(res.stdout.trim()).toBe('wrapped-ok');
  });
});

describe('SshService — a local dial', () => {
  it('connects without a transport and answers isLocal', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    expect(result.ok).toBe(true);
    expect(ssh.isLocal(result.ok && result.connectionId ? result.connectionId : '')).toBe(true);
    ssh.close(result.ok && result.connectionId ? result.connectionId : '');
  });

  it('answers hostPlatform from the process, no probe exec', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    expect(await ssh.hostPlatform(connectionId)).toBe(localHostPlatform());
    expect(localHostPlatform()).toBe(process.platform === 'win32' ? 'windows' : 'posix');
    ssh.close(connectionId);
  });

  it('execs through the local bash', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    const res = await ssh.exec(connectionId, 'echo routed-locally');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('routed-locally');
    ssh.close(connectionId);
  });

  it('close forgets the record', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    ssh.close(connectionId);
    expect(ssh.isLocal(connectionId)).toBe(false);
    await expect(ssh.exec(connectionId, 'true')).rejects.toThrow(/Unknown connection/);
  });

  it('opens a real PTY for a command and streams its bytes', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    // Both ends awaited: the command's own output AND its exit. Killing a
    // live ConPTY from inside a vitest worker takes the worker down with it
    // (an unhandled socket error during teardown), so a test never leaves
    // one running — the shell exits by itself and the exit is awaited.
    const [saw, exitCode] = await new Promise<[string, number]>((resolve, reject) => {
      let output = '';
      let exit = -1;
      const timer = setTimeout(() => reject(new Error('PTY never finished in 15s')), 15_000);
      const settle = () => {
        if (output.includes('pty-alive') && exit >= 0) {
          clearTimeout(timer);
          resolve([output, exit]);
        }
      };
      void ssh
        .openTrackedShell(connectionId, {
          command: 'echo pty-alive',
          commandMode: 'exec',
          cols: 100,
          rows: 30,
          onData: (data) => {
            output += data.toString('utf8');
            settle();
          },
          onExit: (code) => {
            exit = code;
            settle();
          },
        })
        .catch(reject);
    });
    expect(saw).toContain('pty-alive');
    expect(exitCode).toBe(0);
    ssh.close(connectionId);
  });

  it('opens the chosen shell for a bare terminal, and keeps joins on bash', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    // A bare shell with the choice set lands in PowerShell: its prompt line
    // ("PS ...>") is unmistakable and bash never prints it.
    const sawPs = await new Promise<boolean>((resolve, reject) => {
      let output = '';
      let exit = -1;
      const timer = setTimeout(() => reject(new Error('shell never finished in 15s')), 15_000);
      const settle = () => {
        if (output.includes('PS ') && exit >= 0) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      void ssh
        .openTrackedShell(connectionId, {
          shell: 'powershell',
          command: 'exit',
          commandMode: 'typed',
          onData: (data) => {
            output += data.toString('utf8');
            settle();
          },
          onExit: (code) => {
            exit = code;
            settle();
          },
        })
        .catch(reject);
    });
    expect(sawPs).toBe(true);

    // A session join carries its POSIX script and must reach bash even with
    // the choice set: the join output is the bash-echoed sentinel.
    const sawBash = await new Promise<boolean>((resolve, reject) => {
      let output = '';
      let exit = -1;
      const timer = setTimeout(() => reject(new Error('join never finished in 15s')), 15_000);
      const settle = () => {
        if (output.includes('join-is-bash') && exit >= 0) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      void ssh
        .openTrackedShell(connectionId, {
          shell: 'powershell',
          command: 'echo join-is-bash',
          commandMode: 'exec',
          onData: (data) => {
            output += data.toString('utf8');
            settle();
          },
          onExit: (code) => {
            exit = code;
            settle();
          },
        })
        .catch(reject);
    });
    expect(sawBash).toBe(true);
    ssh.close(connectionId);
  });

  it('refuses an unresolvable shell choice instead of falling back to bash', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    await expect(
      ssh.openTrackedShell(connectionId, {
        shell: 'pwsh',
        onData: () => undefined,
      }),
    ).rejects.toThrow(/Could not open the pwsh shell/);
    ssh.close(connectionId);
  });

  it('delivers a command-run exit code through the shell onExit', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('shell never exited in 10s')), 10_000);
      void ssh
        .openTrackedShell(connectionId, {
          command: 'exit 7',
          commandMode: 'exec',
          onData: () => undefined,
          onExit: (code) => {
            clearTimeout(timer);
            resolve(code);
          },
        })
        .catch(reject);
    });
    expect(exitCode).toBe(7);
    ssh.close(connectionId);
  });
});

describe('the self host entry', () => {
  it('is the local machine, identified as `self`', () => {
    const entry = selfHostEntry();
    expect(entry.id).toBe('self');
    expect(entry.name).toBe('self');
    expect(entry.local).toBe(true);
    expect(entry.fromConfig).toBe(false);
    expect(entry.identityFile).toBeNull();
    expect(entry.user.length).toBeGreaterThan(0);
  });

  it('leads the picker list, and yields to a config host already named self', () => {
    const configHost = (name: string): HostEntry => ({
      name,
      hostname: `${name}.example`,
      port: 22,
      user: 'me',
      identityFile: null,
      proxyJump: null,
      forwardAgent: false,
      localForwards: [],
      remoteForwards: [],
      fromConfig: true,
    });
    expect(withSelfEntry([configHost('hetzner')]).map((host) => host.name)).toEqual([
      'self',
      'hetzner',
    ]);
    const taken = [configHost('self'), configHost('hetzner')];
    expect(withSelfEntry(taken)).toBe(taken);
  });
});
