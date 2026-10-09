import { execFileSync } from 'node:child_process';
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
    expect(exec.mock.calls.every(([command]) => command.startsWith(`exec '${executable}' `))).toBe(true);
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
    expect(exec).toHaveBeenLastCalledWith(`exec '${executable}' tree get`, { stdin: '{"host":"win35"}' });
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
    expect(exec.mock.calls.map(([command]) => command)).toEqual([`exec '${executable}' --version`, `exec '${executable}' platform --json`]);
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


describe('Win32 OpenSSH non-PTY Bash argument grouping', () => {
  it('preserves qualification, native arguments and tree stdin when a leading quoted executable would lose arguments', async () => {
    const calls: { command: string; stdin?: string; timeoutMs?: number }[] = [];
    const cwd = 'C:/Projects/%TEMP%! & snow ☃';
    const capabilities = [...platform.capabilities, 'workspaces.add', 'workspaces.remove', 'tree.cas',
      'sessions.create', 'sessions.rename', 'sessions.kill'];
    const capture = vi.fn(async (command: string, options?: { stdin?: string; timeoutMs?: number }) => {
      calls.push({ command, ...options });
      // The verified Win32 argv rule leaves arguments outside Bash -c when p1
      // begins with a quote. This models the actual native CLI usage response.
      if (command.startsWith("'")) return { exitCode: 2, stdout: 'Usage: pocketshell [OPTIONS] COMMAND [ARGS]...', stderr: '' };
      expect(command.startsWith("exec '" + executable + "' ")).toBe(true);
      expect(command.startsWith('exec exec ')).toBe(false);
      if (command.endsWith('--version')) return result('pocketshell 0.5.8');
      if (command.endsWith('platform --json')) return result({ ...platform, capabilities });
      if (command.includes('sessions list')) return result({ schema: 3, sessions: [{ id, name: 'snow:main', workspace: cwd, tag: 'main', attached: false }] });
      if (command.includes('workspaces')) return result({ schema: 1, workspaces: [{ path: cwd }] });
      if (command.includes('sessions create')) return result({ schema: 3, name: 'snow:main', id, created: true });
      if (command.includes('sessions rename')) return result({ schema: 3, name: 'snow:new', id, tag: 'new', renamed: true });
      if (command.includes('sessions kill')) return result({ schema: 3, name: 'snow:new', id, killed: true, reaped: true });
      if (command.endsWith('tree get')) return result({ nodes: [], version: 7, cli_version: '0.5.8' });
      if (command.endsWith('tree upsert')) return result({ status: 'ok', version: 8 });
      if (command.endsWith('tree reconcile')) return result({ alive: [], gone: [], added: [], cli_version: '0.5.8' });
      throw new Error('Unexpected command ' + command);
    });
    const native = new NativeWindowsHostCli({ executable }, capture, 'enrolled-device');
    expect((await native.bootstrap()).pocketshell.path).toBe(executable);
    expect((await native.listSessions())[0]?.aplexerId).toBe(id);
    await native.listWorkspaces('enrolled-device');
    await native.addWorkspace(cwd);
    await native.removeWorkspace(cwd);
    expect((await native.createSession('main', cwd)).id).toBe(id);
    expect(await native.renameSession(id, 'new')).toBe('snow:new');
    await native.killSession(id);
    const snapshot = await native.readTree('display-alias');
    await native.upsertTree(snapshot, []);
    await native.reconcileTree('display-alias');
    const prefix = "exec '" + executable + "' ";
    expect(calls[0]?.command).toBe(prefix + '--version');
    expect(calls[1]?.command).toBe(prefix + 'platform --json');
    expect(calls.find(({ command }) => command.includes('sessions create'))).toEqual({
      command: prefix + "sessions create --json --cwd '" + cwd + "' -- 'main'", timeoutMs: 60_000,
    });
    expect(calls.find(({ command }) => command.endsWith('tree get'))).toEqual({
      command: prefix + 'tree get', stdin: '{"host":"enrolled-device"}',
    });
    expect(calls.find(({ command }) => command.endsWith('tree upsert'))).toEqual({
      command: prefix + 'tree upsert', stdin: '{"host":"enrolled-device","nodes":[],"expected_version":7}',
    });
    const beforeAttach = calls.length;
    expect(await native.attachCommand(id)).toBe('"' + prefix + "sessions attach -- '" + id + "'\"");
    expect(calls).toHaveLength(beforeAttach);
  });
});


describe('explicit enrolled CMD Desktop native policy', () => {
  const deviceId = 'host-laptop-fixture';
  const bash = 'C:/Program Files/Git/bin/bash.exe';
  const policy = { executable, transport: 'openssh-cmd-git-bash' as const, deviceId,
    trustedBashExecutable: bash, trustedBashSha256: 'a'.repeat(64) };
  function decode(command: string, pty = false): string {
    const prefix = (pty ? 'call ' : '') + '"C:\\Program Files\\Git\\bin\\bash.exe" --noprofile --norc -c "eval $\'';
    expect(command.startsWith(prefix)).toBe(true);
    expect(command.endsWith('\'"')).toBe(true);
    const hex = command.slice(prefix.length, -2);
    expect(hex).toMatch(/^(?:\\x[0-9a-f]{2})*$/);
    return Buffer.from(hex.replaceAll('\\x', ''), 'hex').toString('utf8');
  }
  it('retains only the explicitly matching device-bound main registration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pocketshell-cmd-policy-'));
    try {
      const registration = { name: 'Laptop', user: 'alexey', identityFile: 'protected-key',
        gateway: { serverUrl: 'wss://gateway.pocketshell.io', deviceId },
        sshHostKeyFingerprint: 'SHA256:Qjlw4xV9MzuBS4r5FJxy9fyZaexWMN3xHIhiluYZT2w' };
      const file = join(dir, 'hosts.json');
      writeFileSync(file, JSON.stringify([
        { ...registration, nativeWindowsCli: policy },
        { ...registration, nativeWindowsCli: { ...policy, deviceId: 'foreign-device' } },
        { ...registration, nativeWindowsCli: { ...policy, trustedBashSha256: '' } },
        { ...registration, nativeWindowsCli: { ...policy, trustedBashExecutable: 'C:/bad%PATH%/bash.exe' } },
      ]));
      expect(readGatewayHosts(file)).toEqual([expect.objectContaining({ nativeWindowsCli: policy })]);
      expect(normalizeNativeWindowsHostCli({ ...policy, trustedBashSha256: 'A'.repeat(64) })).toEqual(policy);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('routes real Desktop callers through one literal encoder, preserving stdin and UUID attach', async () => {
    const calls: { command: string; options?: { stdin?: string; timeoutMs?: number } }[] = [];
    const cwd = 'C:/own/%TEMP%! & snow ☃';
    const capture = vi.fn(async (command: string, options?: { stdin?: string; timeoutMs?: number }) => {
      const script = decode(command); calls.push({ command, options });
      if (script.endsWith('--version')) return result('pocketshell 0.5.8');
      if (script.endsWith('platform --json')) return result({ ...platform, capabilities: [...platform.capabilities, 'sessions.create', 'tree.cas'] });
      if (script.includes('sessions list')) return result({ schema: 3, sessions: [{ id, name: 'snow:main', workspace: cwd, tag: 'main', attached: false }] });
      if (script.endsWith('tree get')) return result({ nodes: [], version: 7, cli_version: '0.5.8' });
      if (script.includes('sessions create')) return result({ schema: 3, name: 'snow:main', id, created: true });
      throw new Error('Unexpected script ' + script);
    });
    const native = new NativeWindowsHostCli(policy, capture, deviceId);
    const legacyExec = vi.fn();
    const ssh = { nativeWindowsCli: () => native, exec: legacyExec, hostPlatform: vi.fn() } as unknown as SshService;
    const helper = new PocketshellClient(ssh, new AplexerClient(ssh));
    expect((await helper.listSessions('connection'))[0]?.aplexerId).toBe(id);
    await helper.treeGet('connection', 'display-alias');
    expect((await native.createSession('main', cwd)).id).toBe(id);
    const scripts = calls.map(({ command }) => decode(command));
    expect(scripts[0]).toBe("exec '" + executable + "' --version");
    expect(scripts[1]).toBe("exec '" + executable + "' platform --json");
    expect(scripts.filter((script) => script.endsWith('--version'))).toHaveLength(1);
    expect(calls.find(({ command }) => decode(command).endsWith('tree get'))?.options).toEqual({ stdin: JSON.stringify({ host: deviceId }) });
    expect(scripts.at(-1)).toBe("exec '" + executable + "' sessions create --json --cwd '" + cwd + "' -- 'main'");
    expect(calls.at(-1)?.options).toEqual({ timeoutMs: 60_000 });
    expect(decode(await native.attachCommand(id), true)).toBe("exec '" + executable + "' sessions attach -- '" + id + "'");
    expect(legacyExec).not.toHaveBeenCalled();
  });
  it('refuses missing authority, ambiguous Bash fields, NUL and over-bound commands before transport', async () => {
    const exec = vi.fn(async (command: string) => decode(command).endsWith('--version') ? result('0.5.8') : result(platform));
    expect(() => new NativeWindowsHostCli(policy, exec, 'foreign-device')).toThrow('device identity');
    expect(() => new NativeWindowsHostCli(policy, exec)).toThrow('device identity');
    for (const path of ['bash.exe', 'C:/bad!x!/bash.exe', 'C:/bad&x/bash.exe', 'C:/bad^x/bash.exe', 'C:/../bash.exe', 'C:/bad\n/bash.exe']) {
      expect(normalizeNativeWindowsHostCli({ ...policy, trustedBashExecutable: path })).toBeNull();
    }
    expect(normalizeNativeWindowsHostCli({ ...policy, extraAuthority: true })).toBeNull();
    expect(normalizeNativeWindowsHostCli({ executable, trustedBashExecutable: bash })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    const native = new NativeWindowsHostCli(policy, exec, deviceId);
    await native.ready();
    await expect(native.listWorkspaces('bad\0host')).rejects.toThrow('NUL');
    await expect(native.listWorkspaces('x'.repeat(2000))).rejects.toThrow('8000');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});


describe('qualified native generic script boundary', () => {
  it.skipIf(process.platform !== 'linux')('executes compound and pipeline semantics with fixed builtin prefix and preserves options', async () => {
    const options = { stdin: 'literal input', timeoutMs: 1234 };
    const capture = vi.fn(async (command: string, supplied?: { stdin?: string; timeoutMs?: number }) => {
      if (command.endsWith('--version')) return result('0.5.8');
      if (command.endsWith('platform --json')) return result(platform);
      expect(command).toBe(":; printf '%s' 'nonce'; printf '%s' 'tail' | cat; cat; exit 0");
      expect(supplied).toBe(options);
      return result(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command],
        { input: supplied?.stdin, encoding: 'utf8' }));
    });
    const native = new NativeWindowsHostCli({ executable }, capture);
    expect(await native.runScript("printf '%s' 'nonce'; printf '%s' 'tail' | cat; cat; exit 0", options))
      .toEqual(result('noncetailliteral input'));
    expect(capture.mock.calls.slice(0, 2).every(([command]) => command.startsWith('exec '))).toBe(true);
  });
  it('preserves script timeout results and thrown transport refusal without fallback', async () => {
    const f = fixture();
    await f.native.ready();
    f.exec.mockResolvedValueOnce({ stdout: '', stderr: 'timeout', exitCode: 124 });
    expect(await f.native.runScript('pwd -P', { timeoutMs: 7 })).toEqual({ stdout: '', stderr: 'timeout', exitCode: 124 });
    expect(f.exec).toHaveBeenLastCalledWith(':; pwd -P', { timeoutMs: 7 });
    f.exec.mockRejectedValueOnce(new Error('transport refused'));
    await expect(f.native.runScript('pwd -P')).rejects.toThrow('transport refused');
  });
  it('rejects CMD generic scripts outside the qualified bound before qualification', async () => {
    const capture = vi.fn();
    const native = new NativeWindowsHostCli({ executable, transport: 'openssh-cmd-git-bash',
      deviceId: 'host-fixture', trustedBashExecutable: 'C:/Program Files/Git/bin/bash.exe',
      trustedBashSha256: 'a'.repeat(64) }, capture, 'host-fixture');
    await expect(native.runScript('x'.repeat(2100))).rejects.toThrow('8000');
    await expect(native.runScript('pwd\0')).rejects.toThrow('NUL');
    expect(capture).not.toHaveBeenCalled();
  });
  it('never dispatches generic scripts after failed qualification or malformed input', async () => {
    const capture = vi.fn(async () => ({ stdout: '', stderr: 'untrusted', exitCode: 1 }));
    const native = new NativeWindowsHostCli({ executable }, capture);
    await expect(native.runScript('pwd -P')).rejects.toThrow('version');
    await expect(native.runScript('pwd -P')).rejects.toThrow('version');
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(native.runScript('pwd\0')).rejects.toThrow('NUL');
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
