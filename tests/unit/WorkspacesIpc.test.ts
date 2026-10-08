import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/context';
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, callback: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, callback) } }));
import { registerWorkspacesIpc } from '../../src/main/ipc/workspacesIpc';
import { ipc } from '../../src/shared/channels';

function setup() {
  const client = { workspaceCapability: vi.fn(async () => ({ hostIdentity: 'enrolled-device' })),
    listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
    addWorkspace: vi.fn(async () => ({ workspaces: [] })), removeWorkspace: vi.fn(async () => ({ workspaces: [] })) };
  const ctx = { ssh: { nativeWindowsCli: (id: string) => id === 'native' ? client : undefined } } as unknown as IpcContext;
  registerWorkspacesIpc(ctx);
  return client;
}
function invoke(channel: string, ...args: unknown[]) {
  const callback = handlers.get(channel);
  if (!callback) throw new Error('No handler');
  return callback({}, ...args);
}
beforeEach(() => handlers.clear());
describe('workspace IPC authority', () => {
  it('advertises only a qualified main-bound native connection', async () => {
    const client = setup();
    expect(await invoke(ipc.workspaces.capability, 'legacy')).toBeNull();
    expect(await invoke(ipc.workspaces.capability, 'native')).toEqual({ hostIdentity: 'enrolled-device' });
    client.workspaceCapability.mockRejectedValueOnce(new Error('Unqualified native mutations'));
    await expect(invoke(ipc.workspaces.capability, 'native')).rejects.toThrow('Unqualified');
  });
  it('ignores renderer aliases when listing and never invokes a legacy CLI', async () => {
    const client = setup();
    await invoke(ipc.workspaces.list, 'native', 'spoofed-host');
    expect(client.listWorkspaces).toHaveBeenCalledWith('enrolled-device');
    await expect(invoke(ipc.workspaces.list, 'legacy', 'legacy')).rejects.toThrow('does not provide');
    expect(client.listWorkspaces).toHaveBeenCalledTimes(1);
  });
  it('routes only native registration mutations and rejects invalid payloads', async () => {
    const client = setup();
    await invoke(ipc.workspaces.add, 'native', 'spoofed-host', 'C:/Projects');
    await invoke(ipc.workspaces.remove, 'native', 'spoofed-host', 'C:/Projects');
    expect(client.addWorkspace).toHaveBeenCalledWith('C:/Projects');
    expect(client.removeWorkspace).toHaveBeenCalledWith('C:/Projects');
    await expect(invoke(ipc.workspaces.add, 'native', 'host', '\0')).rejects.toThrow('Invalid workspace path');
    await expect(invoke(ipc.workspaces.capability, {})).rejects.toThrow('Invalid workspace connection');
    await expect(invoke(ipc.workspaces.remove, 'legacy', 'host', 'C:/Projects')).rejects.toThrow('does not provide');
    expect(client.addWorkspace).toHaveBeenCalledTimes(1);
    expect(client.removeWorkspace).toHaveBeenCalledTimes(1);
  });
});
