import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, HostEntry, HostPlatform } from '@pocketshell/core';
import type { ExecOptions } from '../ssh/SshService.js';
import { EXEC_DEFAULT_TIMEOUT_MS } from '../ssh/SshService.js';
import { resolveLocalShell } from '@pocketshell/core';
import { log } from '../log.js';

/**
 * The platform's own machine as a connection ("self") — the same surface the
 * SSH path serves, answered by local processes instead of a transport.
 *
 * Everything the app does on a host is shell lines (`a snapshot --json`, the
 * join commands, git in ProjectsService) and PTY shells; on this machine those
 * are `child_process` and a ConPTY (`node-pty`), and the panel, the joins and
 * the composer behave identically because they are the identical code. The
 * commands the app execs are POSIX — `command -v a`, `/bin/sh -lc '...'` — so
 * they run under Git Bash on Windows (the shell aplexer itself picks there)
 * and under bash/sh elsewhere. No SSH, no keys, no network: a local dial
 * registers a record and answers.
 */

/**
 * The bash that local exec and local shells run under.
 *
 * Resolved once per process. On Windows the commands are POSIX and the shell
 * is Git Bash, found where installers put it and last via `where bash`; on
 * POSIX the login default. Null means this machine has none — a local dial
 * still connects (the UI can say why nothing answers) but every exec reports
 * the failure honestly.
 */
let cachedBash: string | null | undefined;

export function localBash(): string | null {
  if (cachedBash !== undefined) return cachedBash;
  cachedBash = findBash();
  log('local', `bash: ${cachedBash ?? 'not found'}`);
  return cachedBash;
}

function findBash(): string | null {
  if (process.platform !== 'win32') {
    for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  const roots = [
    process.env['ProgramW6432'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs'),
    process.env['ProgramFiles'],
  ].filter((root): root is string => !!root);
  for (const root of roots) {
    for (const sub of ['Git/bin', 'Git/usr/bin']) {
      const candidate = join(root, sub, 'bash.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  // Last: whatever `bash` resolves to on PATH (a scoop/winget bash, WSL's
  // bash.exe — which would be wrong for POSIX shell lines, but a machine with
  // Git Bash installed never gets here).
  try {
    const probed = spawnSync('where.exe', ['bash'], { encoding: 'utf8', timeout: 5000 });
    const first = probed.stdout?.split(/\r?\n/).find((line) => line.trim() !== '');
    if (first && existsSync(first.trim())) return first.trim();
  } catch {
    // no bash anywhere
  }
  return null;
}

/**
 * The `self` entry the desktop lists first in the host picker: this machine,
 * no SSH. `hostname` is identity only — the dial is `local: true` and never
 * resolves the name. `id: 'self'` makes it default-host eligible and stable
 * across list reloads (`hostEntryId` prefers `id`).
 */
export function selfHostEntry(): HostEntry {
  return {
    id: 'self',
    name: 'self',
    hostname: 'self',
    port: 0,
    user: userInfo().username,
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    local: true,
  };
}

/**
 * [configHosts] with `self` leading — unless the user already names a config
 * host `self`, in which case theirs wins (theirs resolves somewhere real, and
 * a duplicate identity would break the picker's keyed rows).
 */
export function withSelfEntry(configHosts: HostEntry[]): HostEntry[] {
  return configHosts.some((host) => host.name === 'self')
    ? configHosts
    : [selfHostEntry(), ...configHosts];
}

/** The platform answer without a probe: the process knows what it runs on. */
export function localHostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'windows' : 'posix';
}

/**
 * Run one command under the local bash, resolving `{stdout, stderr, exitCode}`.
 *
 * The same contract as the SSH exec (SshService's): never rejects, non-zero
 * exits are results not errors, `opts.stdin` is written then closed, and the
 * timeout kills the child and settles with what arrived. The child inherits
 * this process's environment, so `a` resolves through the user's PATH the way
 * it never does under sshd's minimal one.
 */
export function execLocal(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const bash = localBash();
  if (!bash) {
    return Promise.resolve({
      stdout: '',
      stderr: 'No bash on this machine — local commands cannot run.',
      exitCode: -1,
    });
  }
  const timeoutMs = opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(bash, ['-c', command], {
      cwd: homedir(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A GUI process on Windows opens no console; without this flag a child
      // console process would flash one for every exec.
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        const note = `exec timed out after ${Math.round(timeoutMs / 1000)}s`;
        finish({ stdout, stderr: stderr ? `${stderr}\n${note}` : note, exitCode: -1 });
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ stdout, stderr: err.message, exitCode: -1 });
    });
    child.on('close', (code: number | null) => {
      finish({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * Fire-and-forget a background command — the local twin of SshService's
 * `execBackground`. Detached and unref'd: the caller does not wait, and a
 * bg job outliving the app is the point (`setsid ... &` on the SSH side).
 */
export function execLocalBackground(command: string): void {
  const bash = localBash();
  if (!bash) return;
  try {
    const child = spawn(bash, ['-c', command], {
      cwd: homedir(),
      env: process.env,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } catch {
    // fire-and-forget: nothing to report to
  }
}

// ---------------------------------------------------------------------------
// PTY shells
// ---------------------------------------------------------------------------

/**
 * The node-pty module, loaded on the first local shell and cached.
 *
 * Lazy on purpose: it is a native binding, and a machine where it fails to
 * load must still be able to dial SSH hosts — the failure surfaces as an
 * honest error on the local shell open, not as a dead app at startup.
 * require() (not import): the main bundle is CJS and the package is
 * externalised, so this is a plain runtime load from node_modules.
 */
type NodePty = typeof import('@lydell/node-pty');
let ptyModule: NodePty | null | undefined;

function pty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('@lydell/node-pty') as NodePty;
  } catch (err) {
    log('local', `node-pty failed to load: ${(err as Error).message}`);
    ptyModule = null;
  }
  return ptyModule;
}

/**
 * A node-pty process dressed as the channel shape {@link ShellTracker} holds
 * (the ssh2 `ClientChannel` surface): EventEmitter-style `on('data'/'close')`,
 * `write`, ssh2-ordered `setWindow(rows, cols)`, and idempotent `end`/`close`.
 * 'close' fires exactly once, with the child's exit code.
 */
class LocalPtyChannel {
  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly closeListeners = new Set<(exitCode?: number) => void>();
  private exited = false;

  constructor(private readonly proc: import('@lydell/node-pty').IPty) {
    proc.onData((chunk) => {
      for (const listener of this.dataListeners) listener(Buffer.from(chunk));
    });
    proc.onExit(({ exitCode }) => {
      if (this.exited) return;
      this.exited = true;
      for (const listener of this.closeListeners) listener(exitCode);
    });
  }

  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: (exitCode?: number) => void): void;
  // The implementation signature stays invisible to callers; `string` and
  // `never[]` are supertypes of both overloads' parameters, which is what
  // their compatibility check requires.
  on(event: string, listener: (...args: never[]) => void): void {
    if (event === 'data') {
      this.dataListeners.add(listener as unknown as (chunk: Buffer) => void);
    } else {
      this.closeListeners.add(listener as unknown as (exitCode?: number) => void);
    }
  }

  write(data: string | Buffer): void {
    // A trailing LF becomes CR: a Windows console's Enter is `\r`, and bash —
    // which accepts either — is the only reason the SSH path's `\n` typing
    // ever worked. Without this, a typed command (`htop`, an `exit`) sits on
    // PowerShell's input line forever.
    if (typeof data === 'string' && data.endsWith('\n') && !data.endsWith('\r\n')) {
      data = data.slice(0, -1) + '\r';
    }
    this.proc.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  /** ssh2's argument order; the pixel sizes are meaningless to a local PTY. */
  setWindow(rows: number, cols: number, _height: number, _width: number): void {
    try {
      this.proc.resize(cols, rows);
    } catch {
      // a PTY whose child is gone refuses resizes; nothing to save
    }
  }

  end(): void {
    this.kill();
  }

  close(): void {
    this.kill();
  }

  private kill(): void {
    if (this.exited) return;
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}

/**
 * Open a local PTY shell.
 *
 * `command` given runs AS the PTY (`bash -c <command>`) — the `'exec'` mode
 * of the SSH path, and what a session join uses; the POSIX command spelling
 * is correct here precisely because there is no sshd re-splitting argv behind
 * the caller's back. Session joins always run under bash, chosen shell or
 * not: the join scripts are POSIX.
 *
 * Without a command, an interactive shell opens — the local twin of sshd's
 * default shell. That is the one place the user's choice applies (`shell`, a
 * core `LocalShellChoice`): a bare terminal on this machine runs what the
 * user picked, Git Bash unless they said otherwise. A choice whose binary is
 * missing (pwsh not installed) surfaces here as the open's error, not as a
 * silent fall-back to bash — a terminal that is quietly the wrong shell is
 * worse than one that says why it did not open.
 */
export function openLocalShell(opts: {
  cols?: number;
  rows?: number;
  term?: string;
  command?: string;
  shell?: string;
}): import('@lydell/node-pty').IPty {
  const bash = localBash();
  const ptyApi = pty();
  if (!bash) throw new Error('No bash found on this machine — a local terminal cannot open.');
  if (!ptyApi) throw new Error('The local PTY module failed to load — a local terminal cannot open.');
  const chosen = opts.command
    ? { file: bash, args: ['-c', opts.command] }
    : resolveLocalShell(opts.shell ?? '', { systemRoot: process.env['SystemRoot'] }) ?? {
        file: bash,
        args: ['--login', '-i'],
      };
  try {
    return ptyApi.spawn(chosen.file, chosen.args, {
      name: opts.term ?? 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: homedir(),
      env: process.env,
    });
  } catch (err) {
    throw new Error(
      `Could not open the ${opts.shell || 'default'} shell (${chosen.file}): ${(err as Error).message}`,
    );
  }
}

export { LocalPtyChannel };
