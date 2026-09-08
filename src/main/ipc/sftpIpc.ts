/**
 * The hard ceiling on `sftp:readBinary`, whatever the renderer asks for.
 *
 * The per-call `maxBytes` is a policy the CALLER owns (an image and an audio
 * file have very different sensible limits), but the cost of a read lands
 * here: the bytes are buffered in main, structured-cloned across the bridge,
 * and held again in the renderer. 128 MiB is the point past which that triple
 * is no longer something to do inside a click handler, and a file over it
 * belongs in `sftp:saveAs` — a streamed `fastGet` straight to disk that never
 * materialises in either process.
 */
const MAX_SFTP_READ_BYTES = 128 * 1024 * 1024;

import type { IpcContext } from './context.js';
import { ipcMain, dialog } from 'electron';
import { ipc } from '../../shared/channels.js';
import { type DirEntry, type FileStat, type TransferProgress } from '../sftp/SftpService.js';
import { MAX_IMAGE_READ_BYTES } from '../attachments/LocalFileReader.js';


export function registerSftpIpc(ctx: IpcContext): void {
  const { sftp, broadcast, getWindows } = ctx;
  // --- sftp:* --------------------------------------------------------------
  // File operations over SFTP on the existing connection. Upload/download
  // stream progress back over `sftp:event:progress` keyed by a transferId the
  // renderer supplies so it can update the right progress bar.
  ipcMain.handle(
    ipc.sftp.list,
    async (_evt, connectionId: string, path: string): Promise<DirEntry[]> => {
      return sftp.list(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.stat,
    async (_evt, connectionId: string, path: string): Promise<FileStat> => {
      return sftp.stat(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.readFile,
    async (_evt, connectionId: string, path: string): Promise<string> => {
      return sftp.readFile(connectionId, path);
    },
  );
  // The binary sibling of `sftp:readFile`, which decodes UTF-8 and so
  // cannot carry a PNG. Every Files-tab open now comes through here rather
  // than through `sftp:readFile`, because deciding whether bytes are text is
  // something only the caller that has LOOKED at them can do.
  //
  // The caller names its own ceiling, because the ceilings differ by an order
  // of magnitude and for a reason: an image is capped by the bitmap it
  // decodes to (32 MiB of JPEG is a great deal more than 32 MiB of pixels),
  // while audio is capped only by the copy across this bridge. What is NOT
  // negotiable is that a ceiling exists — an absent or absurd `maxBytes`
  // falls back to the image ceiling, and nothing is allowed above
  // MAX_SFTP_READ_BYTES no matter what the renderer asks for.
  ipcMain.handle(
    ipc.sftp.readBinary,
    async (_evt, connectionId: string, path: string, maxBytes?: number): Promise<Uint8Array> => {
      const requested =
        typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
          ? maxBytes
          : MAX_IMAGE_READ_BYTES;
      const buffer = await sftp.readBinary(
        connectionId,
        path,
        Math.min(requested, MAX_SFTP_READ_BYTES),
      );
      // Copy into a fresh, exactly-sized Uint8Array before it crosses the
      // bridge — same reason as `shell:event:data`: a Buffer is a view
      // into Node's shared allocation pool and loses its prototype in the
      // structured clone regardless, so hand over the plain view.
      return new Uint8Array(buffer);
    },
  );
  ipcMain.handle(
    ipc.sftp.writeFile,
    async (_evt, connectionId: string, path: string, content: string): Promise<boolean> => {
      await sftp.writeFile(connectionId, path, content);
      return true;
    },
  );
  // The create-only sibling of `sftp:writeFile`, which overwrites by
  // contract. The Files tab's "new file" needs exactly the refusal: a
  // creation flow that could clobber an existing name would be a data-loss
  // button. Service-side reasoning in SftpService.createFile.
  ipcMain.handle(
    ipc.sftp.createFile,
    async (_evt, connectionId: string, path: string, content?: string): Promise<boolean> => {
      await sftp.createFile(connectionId, path, content ?? '');
      return true;
    },
  );
  ipcMain.handle(ipc.sftp.mkdir, async (_evt, connectionId: string, path: string): Promise<boolean> => {
    await sftp.mkdir(connectionId, path);
    return true;
  });
  ipcMain.handle(
    ipc.sftp.rename,
    async (_evt, connectionId: string, fromPath: string, toPath: string): Promise<boolean> => {
      await sftp.rename(connectionId, fromPath, toPath);
      return true;
    },
  );
  ipcMain.handle(
    ipc.sftp.deleteFile,
    async (_evt, connectionId: string, path: string): Promise<boolean> => {
      await sftp.deleteFile(connectionId, path);
      return true;
    },
  );
  ipcMain.handle(ipc.sftp.rmdir, async (_evt, connectionId: string, path: string): Promise<boolean> => {
    await sftp.rmdir(connectionId, path);
    return true;
  });
  ipcMain.handle(
    ipc.sftp.realPath,
    async (_evt, connectionId: string, path: string): Promise<string> => {
      return sftp.realPath(connectionId, path);
    },
  );
  ipcMain.handle(
    ipc.sftp.upload,
    async (
      _evt,
      payload: { connectionId: string; localPath: string; remotePath: string; transferId: string },
    ): Promise<boolean> => {
      await sftp.upload(payload.connectionId, payload.localPath, payload.remotePath, (p: TransferProgress) => {
        broadcast(ipc.sftp.progress, { transferId: payload.transferId, ...p });
      });
      return true;
    },
  );
  ipcMain.handle(
    ipc.sftp.download,
    async (
      _evt,
      payload: { connectionId: string; remotePath: string; localPath: string; transferId: string },
    ): Promise<boolean> => {
      await sftp.download(payload.connectionId, payload.remotePath, payload.localPath, (p: TransferProgress) => {
        broadcast(ipc.sftp.progress, { transferId: payload.transferId, ...p });
      });
      return true;
    },
  );

  // `sftp:download` with the destination chosen by the user instead of
  // supplied by the caller. The Files tab needs this and cannot build it
  // itself: a sandboxed renderer has no filesystem and therefore no way to
  // name a local path, so the dialog has to live on this side — the same
  // reason `attachments:pickFiles` does.
  //
  // This is the only action the binary panel offers, which makes it the thing
  // that keeps "I will not render this" from being a dead end. Returns the
  // path written, or null when the user cancelled — cancelling is an outcome,
  // not an error.
  ipcMain.handle(
    ipc.sftp.saveAs,
    async (_evt, payload: { connectionId: string; remotePath: string }): Promise<string | null> => {
      const parent = getWindows().find((w) => !w.isDestroyed());
      const options: Electron.SaveDialogOptions = {
        title: 'Save file',
        defaultPath: payload.remotePath.split('/').pop() || 'download',
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await sftp.download(payload.connectionId, payload.remotePath, result.filePath);
      return result.filePath;
    },
  );

}
