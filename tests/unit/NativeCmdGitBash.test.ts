import { describe, expect, it, vi } from 'vitest';
import { shellQuote } from '@pocketshell/core';
import { cmdGitBashCommand, NativeWindowsHostCli, normalizeNativeWindowsHostCli } from '../../src/main/helper/NativeWindowsHostCli';

const shell = { kind: 'cmd-git-bash' as const, executable: 'C:/Program Files/Git/bin/bash.exe', sha256: 'a'.repeat(64) };
const executable = 'C:/Protected CLI/Scripts/pocketshell.exe';
function decode(command: string): string {
  const match = /eval \$'((?:\\x[0-9a-f]{2})*)'/.exec(command);
  if (!match) throw new Error('Missing encoded Bash script');
  return Buffer.from(match[1]!.replaceAll('\\x', ''), 'hex').toString('utf8');
}

describe('main-provisioned CMD to Git Bash transport', () => {
  it('retains legacy Git Bash hosts and accepts only the explicit provisioned shell kind/path/digest', () => {
    expect(normalizeNativeWindowsHostCli({ executable })).toEqual({ executable });
    expect(normalizeNativeWindowsHostCli({ executable, shellTransport: { ...shell, sha256: 'A'.repeat(64) } }))
      .toEqual({ executable, shellTransport: shell });
    for (const transport of [{ ...shell, kind: 'powershell' }, { ...shell, executable: 'bash.exe' },
      { ...shell, executable: 'C:/%TEMP%/bash.exe' }, { ...shell, executable: 'C:/x!y/bash.exe' },
      { ...shell, executable: 'C:/../bash.exe' }, { ...shell, sha256: 'unverified' }, null]) {
      expect(normalizeNativeWindowsHostCli({ executable, shellTransport: transport })).toBeNull();
    }
  });

  it('keeps percent expansion, quotes, metacharacters and Unicode out of CMD while preserving the literal Bash script', () => {
    const path = `C:/folder %TEMP%!^&() /it's ☃`;
    const script = `exec ${shellQuote(executable)} workspaces add ${shellQuote(path)} --host 'device' --json`;
    const command = cmdGitBashCommand(script, shell);
    expect(command.startsWith('"C:\\Program Files\\Git\\bin\\bash.exe" --noprofile --norc -c ')).toBe(true);
    expect(command).not.toMatch(/[%!^&()☃]/);
    expect(decode(command)).toBe(script);
    expect(command).not.toContain('PATH=');
    expect(() => cmdGitBashCommand('bad\0script', shell)).toThrow('NUL');
    expect(() => cmdGitBashCommand('x'.repeat(3000), shell)).toThrow('limit');
  });

  it('wraps non-PTY qualification/tree commands once, preserves JSON stdin and separately builds UUID attach', async () => {
    const exec = vi.fn(async (command: string, _options?: { stdin?: string; timeoutMs?: number }) => {
      const script = decode(command);
      const json = (value: unknown) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(value) });
      if (script.endsWith('--version')) return { exitCode: 0, stderr: '', stdout: '0.5.8' };
      if (script.endsWith('platform --json')) return json({ schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8',
        capabilities: ['workspaces', 'tree', 'sessions.list', 'sessions.attach'] });
      if (script.endsWith('tree get')) return json({ nodes: [], version: 0, cli_version: '0.5.8' });
      throw new Error('Unexpected native script');
    });
    const native = new NativeWindowsHostCli({ executable, shellTransport: shell }, exec, 'actual-enrolled-device');
    await native.readTree('alias');
    expect(exec.mock.calls.map(([command]) => decode(command)))
      .toEqual([`${shellQuote(executable)} --version`, `${shellQuote(executable)} platform --json`, `${shellQuote(executable)} tree get`]);
    expect(exec.mock.calls[2]![1]?.stdin).toBe(JSON.stringify({ host: 'actual-enrolled-device' }));
    const id = '11111111-1111-4111-8111-111111111111';
    expect(decode(await native.attachCommand(id))).toBe(`exec ${shellQuote(executable)} sessions attach -- '${id}'`);
    await expect(native.attachCommand('main')).rejects.toThrow('UUID');
  });
});
