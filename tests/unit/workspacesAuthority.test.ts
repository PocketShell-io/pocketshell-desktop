// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The desktop's `workspaces` group, end to end in one process: the real
 * preload bridge, invoking the real main-process handlers
 * (src/main/ipc/workspacesIpc.ts), feeding the shared workspace-roots store
 * exactly as the renderer does after provideApi().
 *
 * The contract (core WorkspaceRootsApi): a null capability for a connection
 * keeps that connection's roots on the per-host Settings list. So binding a
 * connection must leave the store in LOCAL authority — the Settings roots
 * answer, an add writes Settings — and no host command is ever asked for.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const invoked: string[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      (globalThis as Record<string, unknown>).__exposedApi = api;
    },
  },
  ipcRenderer: {
    // The bridge's invoke lands on the registered main handler, as Electron's
    // own IPC would deliver it (a throw becomes a rejection).
    invoke: async (channel: string, ...args: unknown[]) => {
      invoked.push(channel);
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      return handler({}, ...args);
    },
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webFrame: { setZoomFactor: vi.fn(), getZoomFactor: () => 1 },
}));

const { registerWorkspacesIpc } = await import('../../src/main/ipc/workspacesIpc');
registerWorkspacesIpc({ ssh: { nativeWindowsCli: () => undefined } } as never);
(process as unknown as { contextIsolated: boolean }).contextIsolated = true;
await import('../../src/preload/index');
const bridged = (globalThis as Record<string, unknown>).__exposedApi as {
  workspaces: import('@pocketshell/core').WorkspaceRootsApi;
};

const { provideApi } = await import('@ui/app/ipc');
provideApi({ workspaces: bridged.workspaces } as never);
const { useWorkspaceRootsStore } = await import('@ui/app/stores/workspaceRoots');
const { useSettingsStore } = await import('@ui/app/stores/settings');

const HOST = { id: 'hetzner', name: 'hetzner' };

beforeEach(() => {
  localStorage.clear();
  invoked.length = 0;
  setActivePinia(createPinia());
});

describe('desktop workspaces authority', () => {
  it('keeps a bound connection on the Settings roots and never asks the host', async () => {
    const settings = useSettingsStore();
    expect(settings.addSessionRoot('hetzner', '~/git')).toBe(true);
    const roots = useWorkspaceRootsStore();

    await roots.bind('conn-1', HOST);

    expect(invoked).toEqual(['workspaces:capability']);
    expect(roots.hostManaged).toBe(false);
    expect(roots.rootsFor('hetzner')).toEqual(['~/git']);

    // An add is a Settings write, not a `workspaces add` on the host.
    await expect(roots.add('hetzner', '~/notes')).resolves.toBe(true);
    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/git', '~/notes']);
    expect(invoked).toEqual(['workspaces:capability']);
  });

  it('refuses the host verbs over the bridge for a connection that never qualified', async () => {
    await expect(bridged.workspaces.list('conn-1', 'hetzner')).rejects.toThrow(
      'This connection does not provide host-managed workspace roots.',
    );
    await expect(bridged.workspaces.add('conn-1', 'hetzner', '~/git')).rejects.toThrow(
      'This connection does not provide host-managed workspace roots.',
    );
    await expect(bridged.workspaces.remove('conn-1', 'hetzner', '~/git')).rejects.toThrow(
      'This connection does not provide host-managed workspace roots.',
    );
  });
});
