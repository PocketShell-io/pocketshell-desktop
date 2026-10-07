import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, HostPlatform } from '@pocketshell/core';
import type { ExecOptions } from '../ssh/SshService.js';
import { EXEC_DEFAULT_TIMEOUT_MS } from '../ssh/SshService.js';
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
