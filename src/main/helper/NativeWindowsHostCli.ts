import { HostCliCore, shellQuote, type BootstrapResult, type ExecResult, type SessionSummary } from '@pocketshell/core';
import { treeUpsertPayload, type TreeNodeRecord } from './cliParsers.js';

export interface NativeTreeSnapshot {
  readonly hostIdentity: string;
  readonly version: number;
  readonly nodes: readonly Record<string, unknown>[];
}

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
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SELECTOR = /^[a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/i;

export class NativeCommandError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}

/** One adapter per SSH connection; failed qualification never falls back to PATH. */
export class NativeWindowsHostCli {
  readonly binary: string;
  private readonly core: HostCliCore;
  private qualification?: Promise<string>;
  private capabilities = new Set<string>();
  private treeSnapshots = new WeakSet<NativeTreeSnapshot>();

  private readonly exec: Exec;

  constructor(readonly policy: NativeWindowsHostCliPolicy, exec: Exec,
    readonly hostIdentity?: string) {
    this.binary = shellQuote(policy.executable);
    // Win32 OpenSSH groups Bash -c arguments only when the script starts with
    // an unquoted word. Keep every non-PTY native invocation in that form.
    this.exec = (command, options) => exec(`exec ${command}`, options);
    this.core = new HostCliCore({ exec: (command, timeoutMs) => this.exec(command, { timeoutMs }) }, this.binary);
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
    this.capabilities = new Set((platform.capabilities as unknown[]).filter((value): value is string => typeof value === 'string'));
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
      if (!row.id || !UUID.test(row.id)) throw new Error('Native session has no valid immutable UUID.');
      return { name: row.name, created: row.createdEpoch ?? 0, activity: row.activityEpoch ?? 0,
        attached: row.attached, path: row.workspace, workspace: row.workspace, tag: row.tag,
        backend: 'aplexer', aplexerId: row.id, profile: row.profile, aplexerPhase: row.phase };
    });
  }

  async listWorkspaces(host: string) {
    await this.ready();
    return this.core.listWorkspaces(host);
  }

  async workspaceCapability(): Promise<{ hostIdentity: string }> {
    await this.ready();
    if (!this.hostIdentity || !['workspaces.add', 'workspaces.remove', 'tree.cas']
      .every((capability) => this.capabilities.has(capability))) {
      throw new Error('This native host does not provide qualified workspace mutations and tree CAS.');
    }
    return { hostIdentity: this.hostIdentity };
  }

  async requireCapability(capability: string): Promise<void> {
    await this.ready();
    if (!this.capabilities.has(capability)) throw new Error(`The provisioned native host does not support ${capability}.`);
  }

  async createSession(name: string, cwd: string) {
    await this.requireCapability('sessions.create');
    const created = await this.core.createSession(name, { cwd });
    if (!created.id || !UUID.test(created.id)) throw new Error('Native create returned no immutable session UUID.');
    return created;
  }

  private async lifecycle(verb: 'rename' | 'kill', id: string, tag?: string): Promise<Record<string, unknown>> {
    await this.requireCapability(`sessions.${verb}`);
    if (!SELECTOR.test(id)) throw new Error('Native lifecycle requires an immutable UUID or eight-character prefix.');
    const command = `${this.binary} sessions ${verb} --json -- ${shellQuote(id)}${tag === undefined ? '' : ` ${shellQuote(tag)}`}`;
    const result = await this.exec(command, { timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new NativeCommandError(result.stderr.trim() || result.stdout.trim()
      || `Native ${verb} failed.`, result.exitCode);
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Malformed native ${verb} result.`);
    const row = value as Record<string, unknown>;
    if (row.schema !== 3 || typeof row.name !== 'string' || typeof row.id !== 'string'
      || !UUID.test(row.id) || !row.id.toLowerCase().startsWith(id.toLowerCase())) throw new Error(`Malformed native ${verb} identity.`);
    return row;
  }

  async renameSession(id: string, tag: string): Promise<string> {
    const row = await this.lifecycle('rename', id, tag);
    if (typeof row.renamed !== 'boolean' || row.tag !== tag) throw new Error('Malformed native rename result.');
    return row.name as string;
  }

  async killSession(id: string): Promise<void> {
    const row = await this.lifecycle('kill', id);
    if (row.killed !== true || typeof row.reaped !== 'boolean') throw new Error('Malformed native kill result.');
  }

  async addWorkspace(path: string) {
    const { hostIdentity } = await this.workspaceCapability();
    return this.core.addWorkspace(hostIdentity, path);
  }

  async removeWorkspace(path: string) {
    const { hostIdentity } = await this.workspaceCapability();
    return this.core.removeWorkspace(hostIdentity, path);
  }

  async readTree(host: string): Promise<NativeTreeSnapshot> {
    await this.ready();
    const hostIdentity = this.hostIdentity ?? host;
    const result = await this.exec(`${this.binary} tree get`, { stdin: JSON.stringify({ host: hostIdentity }) });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Native tree read failed.');
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed native tree.');
    const row = value as Record<string, unknown>;
    if (row.cli_version !== '0.5.8' || !Number.isSafeInteger(row.version) || (row.version as number) < 0
      || !Array.isArray(row.nodes) || row.nodes.some((node: unknown) => !node || typeof node !== 'object'
        || Array.isArray(node) || typeof (node as Record<string, unknown>).session !== 'string')) {
      throw new Error('Malformed native tree version or nodes.');
    }
    const snapshot = Object.freeze({ hostIdentity, version: row.version as number,
      nodes: Object.freeze((row.nodes as Record<string, unknown>[]).map((node) => Object.freeze({ ...node }))) });
    this.treeSnapshots.add(snapshot);
    return snapshot;
  }

  async upsertTree(snapshot: NativeTreeSnapshot, nodes: readonly TreeNodeRecord[]): Promise<void> {
    await this.ready();
    if (!this.capabilities.has('tree.cas')) throw new Error('This native host does not support tree CAS.');
    if (!this.treeSnapshots.has(snapshot) || (this.hostIdentity && snapshot.hostIdentity !== this.hostIdentity)) {
      throw new Error('Native tree writes require the snapshot from their corresponding read.');
    }
    // Consume even on failure; retrying requires another read and merge.
    this.treeSnapshots.delete(snapshot);
    const payload = JSON.parse(treeUpsertPayload(snapshot.hostIdentity, nodes)) as { host: string; nodes: Record<string, unknown>[] };
    const previous = new Map(snapshot.nodes.map((node) => [node.session, node]));
    payload.nodes = payload.nodes.map((node) => ({ ...previous.get(node.session), ...node }));
    // Preserve rows the legacy projection cannot represent, rather than silently deleting them.
    payload.nodes.push(...snapshot.nodes.filter((node) => typeof node.folder_path !== 'string'
      && !payload.nodes.some((replacement) => replacement.session === node.session)));
    const result = await this.exec(`${this.binary} tree upsert`, {
      stdin: JSON.stringify({ ...payload, expected_version: snapshot.version }),
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Native tree write failed.');
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Malformed native tree write result.');
    const response = parsed as Record<string, unknown>;
    if (response.status === 'conflict') throw new Error('The host tree changed. Read it again and merge before retrying.');
    if (response.status !== 'ok' || response.version !== snapshot.version + 1) throw new Error('Malformed native tree write result.');
  }

  async reconcileTree(host: string): Promise<ExecResult> {
    await this.ready();
    if (!this.capabilities.has('tree.cas')) throw new Error('This native host does not support tree CAS.');
    // The endpoint may bump its version; invalidate all earlier issued snapshots.
    this.treeSnapshots = new WeakSet<NativeTreeSnapshot>();
    const result = await this.exec(`${this.binary} tree reconcile`, {
      stdin: JSON.stringify({ host: this.hostIdentity ?? host }),
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Native tree reconciliation failed.');
    return result;
  }

  async attachCommand(id: string | null | undefined): Promise<string> {
    await this.ready();
    if (!id || !SELECTOR.test(id)) {
      throw new Error('Native attach requires a session UUID or its eight-character prefix.');
    }
    // Windows OpenSSH re-splits the command; the outer pair preserves the Bash script.
    return `"${this.core.buildAttachCommand(id)}"`;
  }
}
