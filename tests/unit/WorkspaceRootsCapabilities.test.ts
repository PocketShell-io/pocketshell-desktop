/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects mock calls without invoking detached methods. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { WorkspaceRootsApi } from '@pocketshell/core';

const mocks = vi.hoisted(() => {
  const api: { workspaces?: WorkspaceRootsApi } = {};
  const local: Record<string, string[]> = {};
  return { api, local, add: vi.fn(() => true), remove: vi.fn() };
});
vi.mock('@ui/app/ipc', () => ({ api: mocks.api }));
vi.mock('@ui/app/stores/settings', () => ({ useSettingsStore: () => ({
  sessionRootsFor: (host: string) => mocks.local[host] ?? [],
  addSessionRoot: mocks.add, removeSessionRoot: mocks.remove,
}) }));
import { useWorkspaceRootsStore } from '@ui/app/stores/workspaceRoots';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function group(): WorkspaceRootsApi {
  return {
    list: vi.fn(async () => ({ workspaces: [{ path: 'C:/Projects', displayPath: 'C:/Projects' }] })),
    add: vi.fn(async () => ({ workspaces: [] })),
    remove: vi.fn(async () => ({ workspaces: [] })),
  };
}
beforeEach(() => {
  setActivePinia(createPinia());
  mocks.api.workspaces = undefined;
  mocks.local = {};
  vi.clearAllMocks();
});

describe('per-connection workspace authority', () => {
  it('keeps settings roots for a platform without host workspace API', async () => {
    mocks.local.legacy = ['/legacy'];
    const roots = useWorkspaceRootsStore();
    await roots.bind('legacy-connection', { name: 'legacy' });
    expect(roots.hostManaged).toBe(false);
    expect(roots.rootsFor('legacy')).toEqual(['/legacy']);
    expect(await roots.add('legacy', '/extra')).toBe(true);
    expect(mocks.add).toHaveBeenCalledWith('legacy', '/extra');
  });

  it('preserves platform-wide authority when the optional query is absent', async () => {
    const workspaces = group();
    mocks.api.workspaces = workspaces;
    const roots = useWorkspaceRootsStore();
    await roots.bind('web-connection', { id: 'saved-host', name: 'display-alias' });
    expect(roots.hostManaged).toBe(true);
    expect(roots.state.hostIdentity).toBe('saved-host');
    expect(vi.mocked(workspaces.list).mock.calls).toEqual([['web-connection', 'saved-host']]);
  });

  it('uses the main-provided enrolled identity and returns to local prefs for a legacy connection', async () => {
    const workspaces = group();
    workspaces.capability = vi.fn(async (id) => id === 'native' ? { hostIdentity: 'enrolled-device' } : null);
    mocks.api.workspaces = workspaces;
    mocks.local.legacy = ['/legacy'];
    const roots = useWorkspaceRootsStore();
    await roots.bind('native', { name: 'friendly-alias' });
    expect(roots.state.hostIdentity).toBe('enrolled-device');
    expect(roots.rootsFor('friendly-alias')).toEqual(['C:/Projects']);
    expect(vi.mocked(workspaces.list).mock.calls).toEqual([['native', 'enrolled-device']]);
    await roots.bind('legacy', { name: 'legacy' });
    expect(roots.hostManaged).toBe(false);
    expect(roots.rootsFor('legacy')).toEqual(['/legacy']);
    expect(vi.mocked(workspaces.list).mock.calls).toHaveLength(1);
  });

  it('never falls back to local roots while qualification is pending or failed', async () => {
    const pending = deferred<{ hostIdentity: string } | null>();
    const workspaces = group();
    workspaces.capability = () => pending.promise;
    mocks.api.workspaces = workspaces;
    mocks.local.native = ['/untrusted-local-fallback'];
    const roots = useWorkspaceRootsStore();
    const bind = roots.bind('native', { name: 'native' });
    expect(roots.rootsBusy).toBe(true);
    expect(roots.rootsFor('native')).toEqual([]);
    await Promise.resolve();
    pending.reject(new Error('Native qualification failed'));
    await bind;
    expect(roots.hostManaged).toBe(true);
    expect(roots.state.status).toBe('error');
    expect(roots.state.error).toBe('Native qualification failed');
    expect(roots.rootsFor('native')).toEqual([]);
    expect(vi.mocked(workspaces.list).mock.calls).toEqual([]);
    expect(vi.mocked(workspaces.add).mock.calls).toEqual([]);
  });

  it('ignores a stale capability result after switching to a legacy host', async () => {
    const pending = deferred<{ hostIdentity: string } | null>();
    const workspaces = group();
    workspaces.capability = (id) => id === 'first' ? pending.promise : Promise.resolve(null);
    mocks.api.workspaces = workspaces;
    mocks.local.second = ['/second'];
    const roots = useWorkspaceRootsStore();
    const old = roots.bind('first', { name: 'first' });
    await Promise.resolve();
    await roots.bind('second', { name: 'second' });
    pending.resolve({ hostIdentity: 'old-device' });
    await old;
    expect(roots.hostManaged).toBe(false);
    expect(roots.rootsFor('second')).toEqual(['/second']);
    expect(roots.state.hostIdentity).toBeNull();
    expect(vi.mocked(workspaces.list).mock.calls).toEqual([]);
  });

  it('rejects malformed authority and ignores stale failures after disconnect', async () => {
    const workspaces = group();
    workspaces.capability = async () => ({ hostIdentity: ' ' });
    mocks.api.workspaces = workspaces;
    const roots = useWorkspaceRootsStore();
    await roots.bind('native', { name: 'alias' });
    expect(roots.state.status).toBe('error');
    const pending = deferred<{ hostIdentity: string } | null>();
    workspaces.capability = () => pending.promise;
    const old = roots.bind('new-connection', { name: 'alias' });
    await Promise.resolve();
    await roots.bind(null, null);
    pending.reject(new Error('late failure'));
    await old;
    expect(roots.hostManaged).toBe(false);
    expect(roots.state.status).toBe('idle');
    expect(roots.state.error).toBeNull();
  });

  it('discards an old host listing after switching to another enrolled device', async () => {
    const pending = deferred<{ workspaces: { path: string; displayPath: string }[] }>();
    const workspaces = group();
    workspaces.capability = async (id) => ({ hostIdentity: `${id}-device` });
    workspaces.list = vi.fn((id) => id === 'first' ? pending.promise
      : Promise.resolve({ workspaces: [{ path: 'C:/Second', displayPath: 'C:/Second' }] }));
    mocks.api.workspaces = workspaces;
    const roots = useWorkspaceRootsStore();
    const old = roots.bind('first', { name: 'first' });
    await vi.waitFor(() => expect(workspaces.list).toHaveBeenCalledWith('first', 'first-device'));
    await roots.bind('second', { name: 'second' });
    pending.resolve({ workspaces: [{ path: 'C:/First', displayPath: 'C:/First' }] });
    await old;
    expect(roots.state.hostIdentity).toBe('second-device');
    expect(roots.rootsFor('second')).toEqual(['C:/Second']);
    expect(roots.rootsFor('first')).toEqual([]);
  });

  it('follows an alias rename during qualification without changing canonical host authority', async () => {
    const pending = deferred<{ hostIdentity: string } | null>();
    const workspaces = group();
    workspaces.capability = vi.fn(() => pending.promise);
    mocks.api.workspaces = workspaces;
    const roots = useWorkspaceRootsStore();
    const old = roots.bind('native', { id: 'profile-id', name: 'old-alias' });
    const renamed = roots.bind('native', { id: 'profile-id', name: 'new-alias' });
    pending.resolve({ hostIdentity: 'actual-enrolled-device' });
    await Promise.all([old, renamed]);
    expect(workspaces.capability).toHaveBeenCalledTimes(1);
    expect(workspaces.list).toHaveBeenCalledWith('native', 'actual-enrolled-device');
    expect(roots.rootsFor('new-alias')).toEqual(['C:/Projects']);
    expect(roots.rootsFor('old-alias')).toEqual([]);
  });
});
