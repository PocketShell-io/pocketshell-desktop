import { describe, expect, it, vi } from 'vitest';
import { NativeWindowsHostCli } from '../../src/main/helper/NativeWindowsHostCli';
import { ProjectsService } from '../../src/main/projects/ProjectsService';
import { PocketshellClient } from '../../src/main/helper/PocketshellClient';
import type { SshService } from '../../src/main/ssh/SshService';

const folder = 'C:/Projects/same';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(outcome: '124' | '-1' | 'transport' | 'malformed' | '127' = '124', existing = false) {
  const rows: { name: string; tag: string; workspace: string; id: string; attached: boolean }[] = [];
  if (existing) rows.push({ name: 'same:main', tag: 'main', workspace: folder, id, attached: false });
  let failedRead = false;
  let heldRead: Promise<void> | null = null;
  let creates = 0;
  const result = (value: unknown) => ({ exitCode: 0, stderr: '', stdout: typeof value === 'string' ? value : JSON.stringify(value) });
  const exec = vi.fn(async (command: string) => {
    if (command === `:; cd -- 'C:/Projects/same' && pwd -P`) return result(folder);
    if (command.endsWith('--version')) return result('0.5.8');
    if (command.endsWith('platform --json')) return result({ schema: 1, platform: 'win32', os: 'nt', cli_version: '0.5.8',
      capabilities: ['workspaces', 'tree', 'sessions.list', 'sessions.attach', 'sessions.create'] });
    if (command.includes('sessions list')) {
      if (creates) {
        if (heldRead) await heldRead;
        if (failedRead) throw new Error('Authoritative listing unavailable');
      }
      return result({ schema: 3, sessions: rows });
    }
    if (command.includes('sessions create')) {
      creates++;
      const tag = command.endsWith("-- 'main-2'") ? 'main-2' : 'main';
      if (outcome !== '127') rows.push({ name: `same:${tag}`, tag, workspace: folder, id, attached: false });
      if (creates > 1) return result({ schema: 3, name: 'same:main-2', id, created: true });
      if (outcome === 'transport') throw new Error('Transport lost after dispatch');
      if (outcome === 'malformed') return result({ schema: 3, name: 'same:main', id: 'invalid', created: true });
      return { exitCode: outcome === '124' ? 124 : outcome === '-1' ? -1 : 127, timedOut: false, stderr: 'Create did not return a receipt', stdout: '' };
    }
    throw new Error('Unexpected native invocation');
  });
  const native = new NativeWindowsHostCli({ executable: 'C:/Protected/Scripts/pocketshell.exe' }, exec, 'device-id');
  const ssh = { nativeWindowsCli: () => native, exec: vi.fn(async () => { throw new Error('Native canonicalisation must not use raw SSH'); }) } as unknown as SshService;
  const projects = new ProjectsService(ssh, new PocketshellClient(ssh));
  return { projects, exec, creates: () => creates, failRead: (value: boolean) => { failedRead = value; },
    holdRead: (value: Promise<void>) => { heldRead = value; } };
}
const request = { folder, namePolicy: 'unique' as const };

describe('native create uncertain outcomes', () => {
  it.each(['124', '-1', 'transport', 'malformed'] as const)('rereads authoritative rows after %s without adopting a guessed UUID or retrying', async (outcome) => {
    const f = fixture(outcome);
    const response = await f.projects.startSession('native', request);
    expect(response).toMatchObject({ ok: false, code: 'create-uncertain', sessionName: null, aplexerId: null });
    expect(response.error).toContain('may have succeeded');
    expect(f.creates()).toBe(1);
    expect(f.exec.mock.calls.filter(([command]) => command.includes('sessions list'))).toHaveLength(2);
    // Only a later deliberate request, after a successful authoritative read, may create another.
    expect((await f.projects.startSession('native', request)).ok).toBe(true);
    expect(f.creates()).toBe(2);
  });

  it('retains the guard after a failed read and makes a retry only recheck, never allocate a suffix', async () => {
    const f = fixture();
    f.failRead(true);
    expect((await f.projects.startSession('native', request)).code).toBe('create-uncertain');
    expect((await f.projects.startSession('native', request)).code).toBe('create-uncertain');
    expect(f.creates()).toBe(1);
    f.failRead(false);
    expect((await f.projects.startSession('native', request)).code).toBe('create-uncertain');
    expect(f.creates()).toBe(1);
    expect((await f.projects.startSession('native', request)).ok).toBe(true);
    expect(f.creates()).toBe(2);
  });

  it('blocks another dispatch while authoritative reconciliation is pending', async () => {
    const f = fixture();
    let finish!: () => void;
    f.holdRead(new Promise<void>((resolve) => { finish = resolve; }));
    const first = f.projects.startSession('native', request);
    await vi.waitFor(() => expect(f.exec.mock.calls.filter(([command]) => command.includes('sessions list'))).toHaveLength(2));
    expect((await f.projects.startSession('native', request)).code).toBe('create-uncertain');
    expect(f.creates()).toBe(1);
    finish();
    expect((await first).code).toBe('create-uncertain');
  });

  it('also guards the exact issued suffix against a retry spelling that tag explicitly', async () => {
    const f = fixture('124', true);
    f.failRead(true);
    expect((await f.projects.startSession('native', request)).code).toBe('create-uncertain');
    expect(f.exec.mock.calls.some(([command]) => command.endsWith("-- 'main-2'"))).toBe(true);
    expect((await f.projects.startSession('native', { ...request, customName: 'main-2' })).code).toBe('create-uncertain');
    expect(f.creates()).toBe(1);
  });

  it('preserves a definitive pre-create bundle refusal without calling it uncertain', async () => {
    const f = fixture('127');
    expect((await f.projects.startSession('native', request)).code).toBe('create-failed');
    expect(f.exec.mock.calls.filter(([command]) => command.includes('sessions list'))).toHaveLength(1);
  });
});
