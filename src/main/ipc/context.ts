import type { BrowserWindow } from 'electron';
import type { SshService } from '../ssh/SshService.js';
import type { TmuxClientPool } from '../ssh/TmuxClientPool.js';
import type { PocketshellClient } from '../helper/PocketshellClient.js';
import type { AplexerClient } from '../helper/AplexerClient.js';
import type { SftpService } from '../sftp/SftpService.js';
import type { ForwardService } from '../portfwd/ForwardService.js';
import type { ProjectsService } from '../projects/ProjectsService.js';
import type { HtmlPreviewService } from '../preview/HtmlPreviewService.js';
import type { GoogleAuth } from '../sync/GoogleAuth.js';
import type { SyncService } from '../sync/SyncService.js';
import type { AttachmentStager } from '../attachments/AttachmentStager.js';
import type { LocalFileReader } from '../attachments/LocalFileReader.js';

/**
 * Everything a domain registrar needs to register its handlers: the services
 * (owned by the entry point), the services constructed per registration
 * (attachment staging, the local read allow-list, the tmux client pool), and
 * the broadcast helper that pushes events to every window.
 *
 * Registrars receive this one object rather than a parameter list, so adding
 * a capability is one field here and not a signature change in seven files.
 */
export interface IpcContext {
  ssh: SshService;
  helper: PocketshellClient;
  /** The aplexer client — the main session manager where `a` is installed. */
  aplexer: AplexerClient;
  sftp: SftpService;
  forwards: ForwardService;
  projects: ProjectsService;
  preview: HtmlPreviewService;
  /** Google sign-in state for settings sync (docs/SYNC.md). */
  syncAuth: GoogleAuth;
  /** The sync API client, speaking encrypted envelopes. */
  sync: SyncService;
  /** Open or focus the separate Account & sync window. */
  openAccountWindow: () => void;
  getWindows: () => BrowserWindow[];
  broadcast: (channel: string, payload: unknown) => void;
  tmuxClients: TmuxClientPool;
  attachments: AttachmentStager;
  localFiles: LocalFileReader;
}
