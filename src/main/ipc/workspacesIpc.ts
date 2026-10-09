import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';

/**
 * The shared contract's `workspaces` group (core `WorkspaceRootsApi`): host-
 * registered workspace roots over the host CLI's `pocketshell workspaces`.
 *
 * The desktop qualifies NO connection for host-managed roots yet. The
 * contract's per-connection `capability(connectionId)` exists for exactly
 * this: answering null keeps that connection on the per-host roots list in
 * Settings — the desktop's roots, unchanged — and the shared store then never
 * asks this platform to list, add or remove. Qualifying a connection takes a
 * stable host identity only the host CLI's enrolment can vouch for, and none
 * of the desktop's connection kinds carries one today.
 *
 * So the three verbs refuse rather than run: a caller that skipped the
 * capability gets an honest error instead of a command against a host that
 * was never qualified, and nothing here pretends to have listed anything.
 */
export function registerWorkspacesIpc(): void {
  ipcMain.handle(ipc.workspaces.capability, (_evt, connectionId: unknown) => {
    readConnectionId(connectionId);
    return null;
  });
  for (const verb of ['list', 'add', 'remove'] as const) {
    ipcMain.handle(ipc.workspaces[verb], (_evt, connectionId: unknown) => {
      readConnectionId(connectionId);
      throw new Error(NOT_QUALIFIED);
    });
  }
}

const NOT_QUALIFIED = 'This connection does not provide host-managed workspace roots.';

function readConnectionId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw new Error('Invalid workspace connection.');
  return raw;
}
