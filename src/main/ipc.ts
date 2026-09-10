import { BrowserWindow } from 'electron';
import { ipc } from '../shared/channels.js';
import { SshService } from './ssh/SshService.js';
import { TmuxClientPool } from './ssh/TmuxClientPool.js';
import { PocketshellClient } from './helper/PocketshellClient.js';
import { AplexerClient } from './helper/AplexerClient.js';
import { SftpService } from './sftp/SftpService.js';
import { ForwardService } from './portfwd/ForwardService.js';
import { ProjectsService } from './projects/ProjectsService.js';
import { HtmlPreviewService } from './preview/HtmlPreviewService.js';
import { GoogleAuth } from './sync/GoogleAuth.js';
import { SyncService } from './sync/SyncService.js';
import { AttachmentStager } from './attachments/AttachmentStager.js';
import { LocalFileReader } from './attachments/LocalFileReader.js';
import type { IpcContext } from './ipc/context.js';
import { registerAppIpc } from './ipc/appIpc.js';
import { registerTerminalIpc } from './ipc/terminalIpc.js';
import { registerHelperIpc } from './ipc/helperIpc.js';
import { registerProjectsIpc } from './ipc/projectsIpc.js';
import { registerSftpIpc } from './ipc/sftpIpc.js';
import { registerPortsIpc } from './ipc/portsIpc.js';
import { registerPreviewIpc } from './ipc/previewIpc.js';
import { registerSyncIpc } from './ipc/syncIpc.js';

/**
 * Registers all ipcMain handlers. Called once from the main process entry.
 *
 * Every privileged operation lives in this module tree — one registrar per
 * domain (app/terminal/helper/projects/sftp/ports/preview), each taking the
 * IpcContext — and the composer below owns only the wiring: constructing the
 * per-registration services and subscribing the two event streams that
 * broadcast to every window. Keys/passphrases never leave this module.
 *
 * Streaming events (terminal bytes, shell exit, transfer progress) are pushed
 * to every BrowserWindow via `webContents.send` — keyed by the relevant id.
 */
export function registerIpcHandlers(deps: {
  ssh: SshService;
  helper: PocketshellClient;
  aplexer: AplexerClient;
  sftp: SftpService;
  forwards: ForwardService;
  projects: ProjectsService;
  preview: HtmlPreviewService;
  syncAuth: GoogleAuth;
  sync: SyncService;
  openAccountWindow: () => void;
  getWindows: () => BrowserWindow[];
}): void {
  const {
    ssh,
    helper,
    aplexer,
    sftp,
    forwards,
    projects,
    preview,
    syncAuth,
    sync,
    openAccountWindow,
    getWindows,
  } = deps;

  // Prompt attachments ride the SSH/SFTP services that are already here —
  // no second connection, no shelling out to scp.
  const attachments = new AttachmentStager({ ssh, sftp });

  // The read-back side of the picker. Holds the allow-list of paths the
  // native dialog has handed the renderer this session — see
  // LocalFileReader for why `attachments:readLocal` needs one at all.
  const localFiles = new LocalFileReader();

  // One attached tmux client per visited session tab. Returning to a tab is a
  // renderer visibility change rather than a fresh SSH channel + login shell +
  // join. The helper rides along so the pool can locate each session's tmux
  // server at join time — the aiming its redraw and geometry probe need on
  // hosts where tmuxctl puts every session on its own server.
  const tmuxClients = new TmuxClientPool(ssh, helper);

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  // Subscribe to forward-state changes and broadcast them to the renderer.
  forwards.onStates((connectionId, states) => {
    broadcast(ipc.forwards.states, { connectionId, states });
  });

  // Connection liveness. 'lost' means the transport dropped; 'idle' is a clean
  // disconnect the user asked for.
  ssh.onCloseConnection((connectionId, reason) => {
    // The pooled clients die with their connection; forgetting them here
    // stops a reconnect that reuses the id from handing out clients that are
    // no longer on the other end. The aplexer availability cache goes with
    // them: a reconnect may land on a host where `a` was installed or removed
    // since, and one probe per connection is the price of knowing.
    tmuxClients.release(connectionId);
    aplexer.evict(connectionId);
    broadcast(ipc.ssh.state, {
      connectionId,
      state: reason === 'lost' ? 'lost' : 'idle',
    });
  });

  const ctx: IpcContext = {
    ssh,
    helper,
    aplexer,
    sftp,
    forwards,
    projects,
    preview,
    syncAuth,
    sync,
    openAccountWindow,
    getWindows,
    broadcast,
    tmuxClients,
    attachments,
    localFiles,
  };

  registerAppIpc(ctx);
  registerTerminalIpc(ctx);
  registerHelperIpc(ctx);
  registerProjectsIpc(ctx);
  registerSftpIpc(ctx);
  registerPortsIpc(ctx);
  registerPreviewIpc(ctx);
  registerSyncIpc(ctx);
}
