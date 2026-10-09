import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';
import type { IpcContext } from './context.js';

/** Main alone selects the provisioned native executable and enrolled identity. */
export function registerWorkspacesIpc({ ssh }: IpcContext): void {
  const native = (connectionId: string) => {
    if (typeof connectionId !== 'string' || connectionId === '') throw new Error('Invalid workspace connection.');
    const client = ssh.nativeWindowsCli(connectionId);
    if (!client) throw new Error('This connection does not provide host-managed workspace roots.');
    return client;
  };
  ipcMain.handle(ipc.workspaces.capability, async (_event, connectionId: string) => {
    if (typeof connectionId !== 'string' || connectionId === '') throw new Error('Invalid workspace connection.');
    const client = ssh.nativeWindowsCli(connectionId);
    return client ? client.workspaceCapability() : null;
  });
  ipcMain.handle(ipc.workspaces.list, async (_event, connectionId: string, _host: string) => {
    const client = native(connectionId);
    const { hostIdentity } = await client.workspaceCapability();
    return client.listWorkspaces(hostIdentity);
  });
  for (const operation of ['add', 'remove'] as const) {
    ipcMain.handle(ipc.workspaces[operation], async (_event, connectionId: string, _host: string, path: string) => {
      const client = native(connectionId);
      if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Invalid workspace path.');
      return operation === 'add' ? client.addWorkspace(path) : client.removeWorkspace(path);
    });
  }
}
