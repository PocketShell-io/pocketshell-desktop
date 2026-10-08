import { describe, expect, it, vi } from 'vitest';
import { NativeWindowsHostCli, normalizeNativeWindowsHostCli } from '../../src/main/helper/NativeWindowsHostCli.js';
import { PocketshellClient } from '../../src/main/helper/PocketshellClient.js';
import { AplexerClient } from '../../src/main/helper/AplexerClient.js';
import { ProjectsService } from '../../src/main/projects/ProjectsService.js';
import type { SshService } from '../../src/main/ssh/SshService.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGatewayHosts } from '../../src/main/ssh/GatewayHosts.js';

const executable = 'C:/Users/User/Protected CLI/Scripts/pocketshell.exe';
const id = '01234567-89ab-cdef-0123-456789abcdef';
const platform = { schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8',
  capabilities: ['workspaces', 'tree', 'sessions.list', 'sessions.attach'] };
const result = (value: unknown) => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });

function fixture() {
  const exec = vi.fn(async (command: string, _options?: { stdin?: string; timeoutMs?: number }) => {
    if (command.endsWith('--version')) return result('pocketshell 0.5.8');
    if (command.endsWith('platform --json')) return result(platform);
    if (command.includes('sessions list')) return result({ schema: 3, sessions: [
      { id, name: 'shell', workspace: 'C:/work', tag: 'shell', attached: false, created_epoch: 10, activity_epoch: 20 },
    ] });
    if (command.includes('workspaces list')) return result({ schema: 1, workspaces: [{ path: 'C:/work' }] });
    if (command.includes('tree get')) return result({ nodes: [], version: 0, cli_version: '0.5.8' });
    throw new Error(`Unexpected command ${command}`);
  });
  const native = new NativeWindowsHostCli({ executable }, exec);
  const sshExec = vi.fn((_connection: string, command: string, _options?: unknown) => exec(command));
  const ssh = { nativeWindowsCli: () => native, exec: sshExec, hostPlatform: vi.fn() } as unknown as SshService;
  return { native, exec, ssh, sshExec };
}

describe('provisioned Windows gateway CLI', () => {
  it('retains ordinary gateway registrations and omits an invalid opt-in policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pocketshell-native-policy-'));
    try {
      const registration = { name: 'win35', user: 'user', identityFile: 'key',
        gateway: { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'win35' },
        sshHostKeyFingerprint: 'SHA256:Qjlw4xV9MzuBS4r5FJxy9fyZaexWMN3xHIhiluYZT2w' };
      const file = join(dir, 'hosts.json');
      writeFileSync(file, JSON.stringify([registration, { ...registration, nativeWindowsCli: { executable } },
        { ...registration, nativeWindowsCli: { executable: 'pocketshell' } }]));
      expect(readGatewayHosts(file)).toEqual([
        expect.objectContaining({ sshHostKeyFingerprint: registration.sshHostKeyFingerprint }),
        expect.objectContaining({ nativeWindowsCli: { executable } }),
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('accepts only an absolute, shell-safe native executable path', () => {
    expect(normalizeNativeWindowsHostCli({ executable })).toEqual({ executable });
    for (const path of ['pocketshell', 'C:/../pocketshell.exe', 'C:/x"/pocketshell.exe', 'C:/x$/pocketshell.exe', 'C:\\x\\pocketshell.exe']) {
      expect(normalizeNativeWindowsHostCli({ executable: path })).toBeNull();
    }
  });

  it('qualifies once and uses the quoted executable for schema3 sessions and schema1 workspaces', async () => {
    const { native, exec } = fixture();
    expect(await native.listSessions()).toEqual([expect.objectContaining({ backend: 'aplexer', aplexerId: id, path: 'C:/work' })]);
    expect((await native.listWorkspaces('win35')).workspaces[0]?.path).toBe('C:/work');
    expect(exec.mock.calls.filter(([command]) => command.endsWith('--version'))).toHaveLength(1);
    expect(exec.mock.calls.every(([command]) => command.startsWith(`'${executable}' `))).toBe(true);
    expect(await native.bootstrap()).toMatchObject({ platform: 'windows', pocketshell: { installed: true, path: executable } });
  });

  it('refuses incompatible platform capabilities without trying global binaries', async () => {
    const exec = vi.fn(async (command: string) => command.endsWith('--version') ? result('0.5.8') : result({ ...platform, capabilities: [] }));
    const native = new NativeWindowsHostCli({ executable }, exec);
    await expect(native.listSessions()).rejects.toThrow('incompatible');
    await expect(native.listSessions()).rejects.toThrow('incompatible');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('refuses an old session schema and a missing UUID', async () => {
    for (const sessions of [{ schema: 2, sessions: [] }, { schema: 3, sessions: [{ name: 'shell', attached: false }] }]) {
      const exec = vi.fn(async (command: string) => command.endsWith('--version') ? result('0.5.8') : command.endsWith('platform --json') ? result(platform) : result(sessions));
      await expect(new NativeWindowsHostCli({ executable }, exec).listSessions()).rejects.toThrow();
      expect(exec).toHaveBeenCalledTimes(3);
    }
  });

  it('attaches by UUID through one OpenSSH argv word and rejects arbitrary selectors', async () => {
    const { native } = fixture();
    expect(await native.attachCommand(id)).toBe(`"exec '${executable}' sessions attach -- '${id}'"`);
    expect(await native.attachCommand('01234567')).toContain("-- '01234567'");
    await expect(native.attachCommand('shell; a attach')).rejects.toThrow('UUID');
  });

  it('routes Desktop list and tree stdin directly without legacy aplexer probes', async () => {
    const { ssh, exec, sshExec } = fixture();
    const aplexer = new AplexerClient(ssh);
    const helper = new PocketshellClient(ssh, aplexer);
    expect(await aplexer.isAvailable('connection')).toBe(false);
    expect(await aplexer.snapshotRecords('connection')).toEqual([]);
    expect(await helper.listSessions('connection')).toHaveLength(1);
    expect(await helper.treeGet('connection', 'win35')).toEqual([]);
    expect(exec).toHaveBeenLastCalledWith(`'${executable}' tree get`, { stdin: '{"host":"win35"}' });
    expect(sshExec).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([command]) => /\ba (attach|list|snapshot)|PATH=/.test(command))).toBe(false);
  });

  it('refuses unsupported lifecycle before executing any speculative commands', async () => {
    const { ssh, exec } = fixture();
    const helper = new PocketshellClient(ssh);
    const projects = new ProjectsService(ssh, helper, new AplexerClient(ssh));
    expect((await projects.startSession('connection', { folder: 'C:/work' })).ok).toBe(false);
    expect((await projects.renameSession('connection', 'old', 'new')).ok).toBe(false);
    expect((await projects.killSession('connection', 'old')).ok).toBe(false);
    await expect(helper.treeUpsert('connection', 'win35', [])).rejects.toThrow('version-aware');
    await expect(helper.treeReconcile('connection', 'win35')).rejects.toThrow('tree CAS');
    expect(exec.mock.calls.map(([command]) => command)).toEqual([`'${executable}' --version`, `'${executable}' platform --json`]);
  });

  it('does not query global helper or raw warning commands for unadvertised optional features', async () => {
    const { ssh, exec } = fixture();
    const helper = new PocketshellClient(ssh);
    const aplexer = new AplexerClient(ssh);
    expect(await helper.usage('connection')).toEqual([]);
    expect(await helper.agentSubcommands('connection')).toBeNull();
    expect(await helper.agentBinaries('connection')).toBeNull();
    expect(await helper.listProfiles('connection')).toEqual([]);
    expect(await helper.envList('connection', 'C:/work')).toEqual([]);
    expect(await helper.envGet('connection', 'C:/work', ['TEST'])).toEqual({});
    await expect(helper.envSet('connection', 'C:/work', { TEST: 'value' })).rejects.toThrow('does not support');
    expect(await aplexer.listWarnings('connection')).toEqual([]);
    expect((await aplexer.ackWarnings('connection')).ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
