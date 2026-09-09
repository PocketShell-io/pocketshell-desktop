import type { IpcContext } from './context.js';
import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';
import type { RemotePort } from '../portfwd/PortScanner.js';
import type { AutoForwarderStatus, DiscoveredPort } from '../portfwd/AutoForwarder.js';
import type { PortIntent } from '../portfwd/PortfwdStore.js';
import type { ForwardSpec } from '../../shared/types.js';


export function registerPortsIpc(ctx: IpcContext): void {
  const { forwards } = ctx;
  // --- forwards:* ---------------------------------------------------------
  // Port forwarding: scan remote listeners, start/stop the auto-forwarder,
  // and add/remove manual -L/-R/-D forwards. State snapshots stream over
  // `forwards:event:states` (subscribed above).
  ipcMain.handle(
    ipc.forwards.scan,
    async (_evt, connectionId: string): Promise<RemotePort[]> => {
      return forwards.scan(connectionId);
    },
  );
  // `configForwards` carries the host's `~/.ssh/config` `LocalForward` lines
  // (HostEntry.localForwards). They are opened once alongside the scan loop
  // and marked `origin: 'ssh-config'` so the panel can tell them from the
  // ports auto-discovery found. Omitted (or empty) keeps the old behaviour.
  ipcMain.handle(
    ipc.forwards.startAuto,
    async (_evt, connectionId: string, configForwards?: ForwardSpec[]): Promise<boolean> => {
      forwards.startAuto(connectionId, configForwards ?? []);
      return true;
    },
  );
  ipcMain.handle(ipc.forwards.stopAuto, async (_evt, connectionId: string): Promise<boolean> => {
    forwards.stopAuto(connectionId);
    return true;
  });
  ipcMain.handle(
    ipc.forwards.addManual,
    async (_evt, connectionId: string, spec: ForwardSpec): Promise<boolean> => {
      return forwards.addManual(connectionId, spec);
    },
  );
  ipcMain.handle(
    ipc.forwards.remove,
    async (_evt, connectionId: string, key: string): Promise<boolean> => {
      await forwards.remove(connectionId, key);
      return true;
    },
  );
  ipcMain.handle(ipc.forwards.list, async (_evt, connectionId: string) => {
    return forwards.list(connectionId);
  });

  // Run one policy-applying scan pass now — what the panel's "Scan" button
  // calls. Unlike `forwards:scan` (which only lists) this opens and closes
  // forwards; a no-op when auto is not running.
  ipcMain.handle(ipc.forwards.refresh, async (_evt, connectionId: string): Promise<boolean> => {
    await forwards.refresh(connectionId);
    return true;
  });

  // Every port the last scan saw, annotated — including the ones policy
  // declined to forward, so the panel can offer them.
  ipcMain.handle(
    ipc.forwards.discovered,
    async (_evt, connectionId: string): Promise<DiscoveredPort[]> => {
      return forwards.discovered(connectionId);
    },
  );

  // Scan health, so the panel distinguishes "idle" from "scan failing".
  // Null means no forwarder is running for this connection.
  ipcMain.handle(
    ipc.forwards.status,
    async (_evt, connectionId: string): Promise<AutoForwarderStatus | null> => {
      return forwards.status(connectionId);
    },
  );

  // Friendly name for a remote port. A null/blank name deletes it. Persisted
  // per host, so it survives reconnect and restart.
  ipcMain.handle(
    ipc.forwards.setName,
    async (
      _evt,
      connectionId: string,
      remotePort: number,
      name: string | null,
    ): Promise<boolean> => {
      forwards.setName(connectionId, remotePort, name);
      return true;
    },
  );

  // Pin a remote port to a specific local port (persisted per host).
  ipcMain.handle(
    ipc.forwards.setRemap,
    async (
      _evt,
      connectionId: string,
      remotePort: number,
      localPort: number,
    ): Promise<boolean> => {
      await forwards.setRemap(connectionId, remotePort, localPort);
      return true;
    },
  );

  // Drop a pin, returning the port to mirror-then-allocate resolution.
  ipcMain.handle(
    ipc.forwards.clearRemap,
    async (_evt, connectionId: string, remotePort: number): Promise<boolean> => {
      await forwards.clearRemap(connectionId, remotePort);
      return true;
    },
  );

  // Force a port on, off, or (null) back to the automatic policy. Persisted.
  ipcMain.handle(
    ipc.forwards.setIntent,
    async (
      _evt,
      connectionId: string,
      remotePort: number,
      intent: PortIntent | null,
    ): Promise<boolean> => {
      await forwards.setIntent(connectionId, remotePort, intent);
      return true;
    },
  );

  // Flip a remote port between forwarded and silenced, persisting whichever
  // intent the flip landed on.
  ipcMain.handle(
    ipc.forwards.togglePort,
    async (_evt, connectionId: string, remotePort: number): Promise<boolean> => {
      await forwards.togglePort(connectionId, remotePort);
      return true;
    },
  );

  // Whether auto-forward was left enabled for this connection's host — the
  // panel restores its toggle from this on connect.
  ipcMain.handle(
    ipc.forwards.isAutoEnabled,
    async (_evt, connectionId: string): Promise<boolean> => {
      return forwards.isAutoEnabled(connectionId);
    },
  );

}
