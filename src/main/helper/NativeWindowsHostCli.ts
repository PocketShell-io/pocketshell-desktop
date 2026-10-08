import { HostCliCore, shellQuote, type BootstrapResult, type ExecResult, type SessionSummary } from '@pocketshell/core';

/** Main-provisioned policy, never accepted from renderer connection payloads. */
export interface NativeWindowsHostCliPolicy { executable: string }

export function normalizeNativeWindowsHostCli(value: unknown): NativeWindowsHostCliPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const executable = (value as Record<string, unknown>).executable;
  // Windows drive-absolute path, with forward slashes for the configured Git Bash shell.
  // Reject shell metacharacters that cannot survive the OpenSSH PTY argv wrapper.
  if (typeof executable !== 'string' || [...executable].some((char) => char.charCodeAt(0) < 32)
    || !/^[A-Za-z]:\/(?:[^"'\\$`]+\/)*pocketshell\.exe$/i.test(executable)
    || executable.split('/').some((part) => part === '..' || part === '.')) return null;
  return { executable };
}

type Exec = (command: string, options?: { stdin?: string; timeoutMs?: number }) => Promise<ExecResult>;
const REQUIRED = ['workspaces', 'tree', 'sessions.list', 'sessions.attach'];

/** One adapter per SSH connection; failed qualification never falls back to PATH. */
export class NativeWindowsHostCli {
  readonly binary: string;
  private readonly core: HostCliCore;
  private qualification?: Promise<string>;

  constructor(readonly policy: NativeWindowsHostCliPolicy, private readonly exec: Exec) {
    this.binary = shellQuote(policy.executable);
    this.core = new HostCliCore({ exec: (command, timeoutMs) => exec(command, { timeoutMs }) }, this.binary);
  }

  ready(): Promise<string> {
    return this.qualification ??= this.qualify();
  }

  private async qualify(): Promise<string> {
    const version = await this.exec(`${this.binary} --version`);
    if (version.exitCode !== 0 || !/\b0\.5\.8\b/.test(version.stdout)) {
      throw new Error('The provisioned native PocketShell CLI must report version 0.5.8.');
    }
    const result = await this.exec(`${this.binary} platform --json`);
    if (result.exitCode !== 0) throw new Error('The provisioned native PocketShell platform probe failed.');
    const platform = JSON.parse(result.stdout) as Record<string, unknown>;
    if (platform.schema !== 1 || platform.platform !== 'win32' || platform.os !== 'nt'
      || platform.cli_version !== '0.5.8' || !Array.isArray(platform.capabilities)
      || !REQUIRED.every((capability) => (platform.capabilities as unknown[]).includes(capability))) {
      throw new Error('The provisioned native PocketShell platform contract is incompatible.');
    }
    return '0.5.8';
  }

  async bootstrap(): Promise<BootstrapResult> {
    const version = await this.ready();
    const installed = { installed: true, path: this.policy.executable, version };
    const absent = { installed: false, path: null, version: null };
    return { platform: 'windows', pocketshell: installed, aplexer: installed, tmux: absent,
      tmuxctl: absent, installer: null, daemonRunning: null, daemonEnabled: null };
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.ready();
    const listing = await this.core.listSessions();
    if (listing.errors.length) throw new Error(listing.errors.map((error) => error.message).join('; '));
    return listing.sessions.map((row) => {
      if (!row.id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.id)) throw new Error('Native session has no valid immutable UUID.');
      return { name: row.name, created: row.createdEpoch ?? 0, activity: row.activityEpoch ?? 0,
        attached: row.attached, path: row.workspace, workspace: row.workspace, tag: row.tag,
        backend: 'aplexer', aplexerId: row.id, profile: row.profile, aplexerPhase: row.phase };
    });
  }

  async listWorkspaces(host: string) {
    await this.ready();
    return this.core.listWorkspaces(host);
  }

  async attachCommand(id: string | null | undefined): Promise<string> {
    await this.ready();
    if (!id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/i.test(id)) {
      throw new Error('Native attach requires a session UUID or its eight-character prefix.');
    }
    // Windows OpenSSH re-splits the command; the outer pair preserves the Bash script.
    return `"${this.core.buildAttachCommand(id)}"`;
  }
}
