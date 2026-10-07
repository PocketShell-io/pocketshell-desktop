import { describe, expect, it } from 'vitest';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { SshService } from '../../src/main/ssh/SshService';
import {
  execLocal,
  localBash,
  localHostPlatform,
  selfHostEntry,
  withSelfEntry,
} from '../../src/main/local/LocalHost';
import { resolveLocalShell } from '@pocketshell/core';
import type { HostEntry } from '@pocketshell/core';

/**
 * The local ("self") transport, against THIS machine's real bash — the exec
 * surface is one spawn, so a real child answers everything the fake could
 * only assert about plumbing, and the plumbing is the behaviour.
 *
 * Skipped where no bash exists (the exec tests), never for the service-level
 * tests: a local dial itself cannot fail — no transport, no keys.
 */

/**
 * Whether THIS machine can actually exec the shell a choice resolves to —
 * the machine question the main process's open asks before spawning,
 * answered with the public resolver so the tests can pick their subject by
 * availability instead of assuming what the runner image has installed. The
 * helper only SELECTS the subject: the availability contract itself is
 * asserted below by controls built on a real filesystem, never by this
 * predicate.
 */
function choiceSpawnable(choice: string): boolean {
  const resolved = resolveLocalShell(choice, { systemRoot: process.env['SystemRoot'] });
  if (!resolved) return false;
  const candidates = isAbsolute(resolved.file)
    ? [resolved.file]
    : (process.env['PATH'] ?? '')
        .split(delimiter)
        .filter((dir) => dir !== '')
        .map((dir) => join(dir, resolved.file));
  return candidates.some((candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The choices, in the order the settings picker offers them. All three are
 * Windows programs (core resolves `powershell`/`cmd` under the Windows
 * layout and `pwsh` on PATH as `pwsh.exe`), so which of them — if any — is
 * spawnable is a property of the machine, not of the test.
 */
const CHOICES = ['powershell', 'pwsh', 'cmd'] as const;

/** The chosen shell, when this machine has one. Undefined on POSIX runners. */
const chosenShell = CHOICES.find(choiceSpawnable);

/** Each choice's first paint, unmistakable and never printed by bash. */
const FIRST_PAINT_OF: Record<(typeof CHOICES)[number], string> = {
  powershell: 'PS ',
  pwsh: 'PS ',
  cmd: 'Microsoft Windows [',
};

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

  it.skipIf(!chosenShell)(
    'opens the chosen shell for a bare terminal when this machine has it',
    async () => {
      const ssh = new SshService();
      const result = await ssh.connect({ host: 'self', user: 'me', local: true });
      const connectionId = result.ok && result.connectionId ? result.connectionId : '';
      // A bare shell with the choice set lands in the CHOSEN program: its
      // first paint (the `PS ...>` prompt for the PowerShell flavors, the
      // version banner for cmd) is unmistakable, and bash never prints it.
      // The choice under test is whatever this machine actually has — on a
      // runner without any of the Windows shells the refusal test below is
      // the behavior this machine can show instead.
      const marker = FIRST_PAINT_OF[chosenShell!];
      const sawChosen = await new Promise<boolean>((resolve, reject) => {
        let output = '';
        let exit = -1;
        const timer = setTimeout(() => reject(new Error('shell never finished in 15s')), 15_000);
        const settle = () => {
          if (output.includes(marker) && exit >= 0) {
            clearTimeout(timer);
            resolve(true);
          }
        };
        void ssh
          .openTrackedShell(connectionId, {
            shell: chosenShell,
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
      expect(sawChosen).toBe(true);
      ssh.close(connectionId);
    },
  );

  it('runs a session join under bash even with a shell choice set', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    // A session join carries its POSIX script and must reach bash even with
    // the choice set: the join output is the bash-echoed sentinel. The choice
    // here is deliberately spelled as one this machine may not even have —
    // exec mode ignores it (the command IS the channel), and that ignorance
    // is the point.
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

  it('refuses a shell choice whose binary is missing instead of falling back to bash', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    const connectionId = result.ok && result.connectionId ? result.connectionId : '';
    // `pwsh` must be genuinely absent for the duration of the open. On POSIX
    // runners it already is — the resolver spells the choice `pwsh.exe`,
    // which no PATH there carries — so the bare name finds nothing; on
    // Windows, where pwsh may well be installed, the PATH goes away for the
    // one open. The main process's availability check is PATH-scoped for a
    // bare name, so this is "not installed" without uninstalling anything,
    // and no spawn happens on this path, so nothing inherits the stripped
    // environment.
    const realPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      await expect(
        ssh.openTrackedShell(connectionId, {
          shell: 'pwsh',
          onData: () => undefined,
        }),
      ).rejects.toThrow(/Could not open the pwsh shell/);
    } finally {
      process.env['PATH'] = realPath;
    }
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

/**
 * Runs [body] with PATH — and, when asked, SystemRoot — pointed at a fresh
 * owned temp directory, so the availability controls below plant their
 * candidates on a real filesystem and a real search path without leaking
 * either into the rest of the worker. Both are restored in the finally,
 * whatever the body decided.
 */
async function withTempSearchPath(
  body: (root: string) => Promise<void>,
  opts: { asSystemRoot?: boolean } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'local-shell-availability-'));
  const realPath = process.env['PATH'];
  const realSystemRoot = process.env['SystemRoot'];
  try {
    process.env['PATH'] = root;
    if (opts.asSystemRoot) process.env['SystemRoot'] = root;
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (realSystemRoot === undefined) delete process.env['SystemRoot'];
    else process.env['SystemRoot'] = realSystemRoot;
    if (realPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = realPath;
  }
}

/** A local dial, opened the way every test above opens one. */
async function openSelfConnection(): Promise<[SshService, string]> {
  const ssh = new SshService();
  const result = await ssh.connect({ host: 'self', user: 'me', local: true });
  return [ssh, result.ok && result.connectionId ? result.connectionId : ''];
}

/**
 * A bare-shell open that settles only when [marker] has streamed AND the
 * child has exited by itself — the same never-leaving-a-live-PTY shape the
 * PTY tests above use, with the same 15s bound.
 */
function openBareShellExpecting(
  ssh: SshService,
  connectionId: string,
  shell: string,
  marker: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let output = '';
    let exit = -1;
    const timer = setTimeout(() => reject(new Error('shell never finished in 15s')), 15_000);
    const settle = () => {
      if (output.includes(marker) && exit >= 0) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    void ssh
      .openTrackedShell(connectionId, {
        shell,
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
}

/**
 * The availability gate behind a bare-terminal open, driven through the
 * public open with candidates this suite built on a real filesystem — a
 * directory, a permissionless file, an uninspectable path piece, a symlink,
 * a genuinely runnable program — never by re-asking the main process's own
 * predicate. Every refusal must carry the contract's error sentence and
 * open nothing; every admitted candidate must genuinely run.
 */
describe('the availability gate behind a bare local shell', () => {
  it('refuses a directory standing where the chosen absolute program would be', async () => {
    const [ssh, connectionId] = await openSelfConnection();
    await withTempSearchPath(
      async (root) => {
        // The resolver builds the absolute candidate under SystemRoot, so a
        // temp SystemRoot moves that candidate into the temp directory —
        // where this test plants a DIRECTORY in the program's place.
        const candidate = resolveLocalShell('powershell', { systemRoot: root })!.file;
        mkdirSync(candidate, { recursive: true });
        await expect(
          ssh.openTrackedShell(connectionId, { shell: 'powershell', onData: () => undefined }),
        ).rejects.toThrow(/the executable is not on this machine/);
      },
      { asSystemRoot: true },
    );
    ssh.close(connectionId);
  });

  it('refuses a permissionless regular file standing where the chosen absolute program would be', async () => {
    const [ssh, connectionId] = await openSelfConnection();
    await withTempSearchPath(
      async (root) => {
        const candidate = resolveLocalShell('powershell', { systemRoot: root })!.file;
        mkdirSync(dirname(candidate), { recursive: true });
        writeFileSync(candidate, 'this is not a program\n');
        // POSIX refuses in the preflight: the file carries no execute
        // permission. Windows has no permission bit to ask, so the admission
        // there falls through to the real spawn, whose failure is the same
        // refusal — the sentence is what both platforms owe the caller.
        await expect(
          ssh.openTrackedShell(connectionId, { shell: 'powershell', onData: () => undefined }),
        ).rejects.toThrow(/Could not open the powershell shell/);
      },
      { asSystemRoot: true },
    );
    ssh.close(connectionId);
  });

  it('refuses a directory named pwsh.exe found on PATH', async () => {
    const [ssh, connectionId] = await openSelfConnection();
    await withTempSearchPath(async (root) => {
      mkdirSync(join(root, 'pwsh.exe'));
      await expect(
        ssh.openTrackedShell(connectionId, { shell: 'pwsh', onData: () => undefined }),
      ).rejects.toThrow(/the executable is not on this machine/);
    });
    ssh.close(connectionId);
  });

  it('refuses a permissionless pwsh.exe found on PATH', async () => {
    const [ssh, connectionId] = await openSelfConnection();
    await withTempSearchPath(async (root) => {
      writeFileSync(join(root, 'pwsh.exe'), 'this is not a program\n');
      // Same platform split as the absolute case above: preflight refusal on
      // POSIX, real spawn failure on Windows — one refusal sentence.
      await expect(
        ssh.openTrackedShell(connectionId, { shell: 'pwsh', onData: () => undefined }),
      ).rejects.toThrow(/Could not open the pwsh shell/);
    });
    ssh.close(connectionId);
  });

  it('refuses when the candidate cannot even be inspected — the PATH entry is a file', async () => {
    const [ssh, connectionId] = await openSelfConnection();
    await withTempSearchPath(async (root) => {
      // A PATH entry that is itself a regular file puts every candidate
      // under it behind an ENOTDIR: an inspection failure must read as
      // unavailable, not as an unhandled error.
      const notADirectory = join(root, 'path-is-a-file');
      writeFileSync(notADirectory, '');
      process.env['PATH'] = notADirectory;
      await expect(
        ssh.openTrackedShell(connectionId, { shell: 'pwsh', onData: () => undefined }),
      ).rejects.toThrow(/the executable is not on this machine/);
    });
    ssh.close(connectionId);
  });

  // The runnable candidates below are shebang scripts — a POSIX shape, so
  // these two run where the fixture is actually runnable; a Windows-runnable
  // positive is exactly what the honored-choice test above runs in the
  // Windows lane when a real shell exists there.
  it.skipIf(process.platform === 'win32')(
    'opens a genuinely executable pwsh.exe found on PATH',
    async () => {
      const [ssh, connectionId] = await openSelfConnection();
      await withTempSearchPath(async (root) => {
        const script = join(root, 'pwsh.exe');
        writeFileSync(script, '#!/bin/sh\nprintf availability-gate-ok\nexit 0\n');
        chmodSync(script, 0o755);
        expect(await openBareShellExpecting(ssh, connectionId, 'pwsh', 'availability-gate-ok')).toBe(
          true,
        );
      });
      ssh.close(connectionId);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs a PATH symlink to a runnable program as the program it points at',
    async () => {
      const [ssh, connectionId] = await openSelfConnection();
      await withTempSearchPath(async (root) => {
        const real = join(root, 'real-shell');
        writeFileSync(real, '#!/bin/sh\nprintf symlink-points-here\nexit 0\n');
        chmodSync(real, 0o755);
        symlinkSync(real, join(root, 'pwsh.exe'));
        expect(
          await openBareShellExpecting(ssh, connectionId, 'pwsh', 'symlink-points-here'),
        ).toBe(true);
      });
      ssh.close(connectionId);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a PATH entry that is a symlink pointing at nothing',
    async () => {
      const [ssh, connectionId] = await openSelfConnection();
      await withTempSearchPath(async (root) => {
        symlinkSync(join(root, 'no-such-program'), join(root, 'pwsh.exe'));
        await expect(
          ssh.openTrackedShell(connectionId, { shell: 'pwsh', onData: () => undefined }),
        ).rejects.toThrow(/the executable is not on this machine/);
      });
      ssh.close(connectionId);
    },
  );
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
