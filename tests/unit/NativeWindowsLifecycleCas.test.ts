import { describe, expect, it, vi } from 'vitest';
import { NativeWindowsHostCli } from '../../src/main/helper/NativeWindowsHostCli';
import { ProjectsService } from '../../src/main/projects/ProjectsService';
import { PocketshellClient } from '../../src/main/helper/PocketshellClient';
import { AplexerClient } from '../../src/main/helper/AplexerClient';
import type { SshService } from '../../src/main/ssh/SshService';

const executable = 'C:/Protected CLI/Scripts/pocketshell.exe';
const id = '01234567-89ab-cdef-0123-456789abcdef';
const folder = 'C:/Projects/Unicode space ☃';
const capabilities = ['workspaces', 'tree', 'sessions.list', 'sessions.attach',
  'workspaces.add', 'workspaces.remove', 'tree.cas', 'sessions.create', 'sessions.rename', 'sessions.kill'];
function fixture() {
  let version = 1;
  let nodes: Record<string, unknown>[] = [{ session: 'Project:main', folder_path: folder, order: 2,
    collapsed: false, foreign_kind: 'aplexer', session_id: id, session_created: 1730000000, optimistic_since: 1730000001 },
  { session: 'unplaced', foreign_kind: 'aplexer' }];
  let lifecycleExit = 0;
  const result = (value: unknown) => ({ exitCode: 0, stderr: '', stdout: typeof value === 'string' ? value : JSON.stringify(value) });
  const exec = vi.fn(async (command: string, options?: { stdin?: string; timeoutMs?: number }) => {
    if (command.endsWith('--version')) return result('0.5.8');
    if (command.endsWith('platform --json')) return result({ schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8', capabilities });
    if (command.includes('sessions list')) return result({ schema: 3, sessions: [{ name: 'Project:main', tag: 'main', workspace: folder, id, attached: false }] });
    if (command.includes('sessions create')) return result({ schema: 3, name: 'Project:main-2', id, created: true });
    if (command.includes('sessions rename')) return lifecycleExit ? { exitCode: lifecycleExit, stdout: '', stderr: 'Missing native session' }
      : result({ schema: 3, name: 'Project:new', id, tag: 'new', renamed: true });
    if (command.includes('sessions kill')) return lifecycleExit ? { exitCode: lifecycleExit, stdout: '', stderr: 'Missing native session' }
      : result({ schema: 3, name: 'Project:main', id, killed: true, reaped: true });
    if (command.includes('workspaces')) return result({ schema: 1, workspaces: [{ path: folder }] });
    if (command.endsWith('tree get')) return result({ nodes, version, cli_version: '0.5.8' });
    if (command.endsWith('tree upsert')) {
      const payload = JSON.parse(options?.stdin ?? '{}') as { expected_version: number; nodes: Record<string, unknown>[] };
      if (payload.expected_version !== version) return result({ status: 'conflict', version });
      nodes = payload.nodes;
      return result({ status: 'ok', version: ++version });
    }
    if (command.endsWith('tree reconcile')) return result({ alive: [], gone: [], added: [], cli_version: '0.5.8' });
    throw new Error(`Unexpected native command ${command}`);
  });
  const native = new NativeWindowsHostCli({ executable }, exec, 'enrolled-device');
  const directoryExec = vi.fn(async () => result(folder));
  const ssh = { nativeWindowsCli: () => native, exec: directoryExec } as unknown as SshService;
  return { native, exec, directoryExec, ssh, advanceVersion: () => ++version,
    failLifecycle: (exit: number) => { lifecycleExit = exit; }, nodes: () => nodes };
}

describe('qualified native lifecycle and workspace authority', () => {
  it('advertises only full native root mutation/CAS and uses enrolled identity', async () => {
    const f = fixture();
    expect(await f.native.workspaceCapability()).toEqual({ hostIdentity: 'enrolled-device' });
    await f.native.addWorkspace(folder);
    await f.native.removeWorkspace(folder);
    expect(f.exec.mock.calls.filter(([command]) => command.includes('workspaces')).every(([command]) =>
      command.includes("--host 'enrolled-device'") && !command.includes('PATH='))).toBe(true);
  });
  it('routes create, unique-name selection, rename and kill by native UUID without raw fallback', async () => {
    const f = fixture();
    const projects = new ProjectsService(f.ssh, new PocketshellClient(f.ssh), new AplexerClient(f.ssh));
    const created = await projects.startSession('native', { folder, namePolicy: 'unique' });
    expect(created).toMatchObject({ ok: true, sessionName: 'Project:main-2', aplexerId: id, via: 'aplexer', reused: false, folder });
    expect(f.exec.mock.calls.some(([command]) => command.includes("--cwd 'C:/Projects/Unicode space ☃' -- 'main-2'"))).toBe(true);
    expect((await projects.renameSession('native', 'Project:main', 'new', { aplexerId: id })).sessionName).toBe('Project:new');
    expect((await projects.killSession('native', 'Project:main', { aplexerId: id })).ok).toBe(true);
    expect(f.exec.mock.calls.some(([command]) => /\ba (start|kill|rename)|\btmux\b|--mem/.test(command))).toBe(false);
  });
  it('surfaces missing native lifecycle and invalid selectors without choosing another backend', async () => {
    const f = fixture();
    const projects = new ProjectsService(f.ssh, new PocketshellClient(f.ssh));
    f.failLifecycle(3);
    expect((await projects.killSession('native', 'name', { aplexerId: id })).code).toBe('not-found');
    await expect(f.native.killSession('name; a kill')).rejects.toThrow('UUID');
    expect(f.exec.mock.calls.filter(([command]) => command.includes('sessions kill'))).toHaveLength(1);
  });
});

describe('native tree corresponding-read CAS', () => {
  const replacement = [{ session: 'Project:main', folderPath: folder, order: 0, collapsed: true }];
  it('writes the corresponding version and preserves known cached metadata and unprojected rows', async () => {
    const f = fixture();
    const snapshot = await f.native.readTree('renderer-alias');
    expect(snapshot.hostIdentity).toBe('enrolled-device');
    await f.native.upsertTree(snapshot, replacement);
    expect(f.nodes()).toEqual([expect.objectContaining({ session: 'Project:main', collapsed: true,
      foreign_kind: 'aplexer', session_id: id, session_created: 1730000000, optimistic_since: 1730000001 }),
    { session: 'unplaced', foreign_kind: 'aplexer' }]);
    const write = f.exec.mock.calls.find(([command]) => command.endsWith('tree upsert'));
    expect(JSON.parse(write?.[1]?.stdin ?? '{}')).toMatchObject({ expected_version: 1, host: 'enrolled-device' });
    await expect(f.native.upsertTree(snapshot, replacement)).rejects.toThrow('corresponding read');
  });
  it('never substitutes a newer snapshot version for an older caller and surfaces exit0 conflicts', async () => {
    const f = fixture();
    const old = await f.native.readTree('alias');
    f.advanceVersion();
    const current = await f.native.readTree('alias');
    await expect(f.native.upsertTree(old, replacement)).rejects.toThrow('changed');
    const firstWrite = f.exec.mock.calls.find(([command]) => command.endsWith('tree upsert'));
    expect((JSON.parse(firstWrite?.[1]?.stdin ?? '{}') as { expected_version: number }).expected_version).toBe(1);
    await f.native.upsertTree(current, replacement);
    await expect(f.native.upsertTree(old, replacement)).rejects.toThrow('corresponding read');
  });
  it('rejects fabricated or mutable versions and invalidates snapshots before reconciliation', async () => {
    const f = fixture();
    const snapshot = await f.native.readTree('alias');
    expect(() => Object.assign(snapshot, { version: 100 })).toThrow();
    await expect(f.native.upsertTree({ ...snapshot }, replacement)).rejects.toThrow('corresponding read');
    await f.native.reconcileTree('alias');
    await expect(f.native.upsertTree(snapshot, replacement)).rejects.toThrow('corresponding read');
    expect(f.exec.mock.calls.filter(([command]) => command.endsWith('tree upsert'))).toEqual([]);
  });
});
