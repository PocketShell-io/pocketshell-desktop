import type { IpcContext } from './context.js';
import { ipcMain, dialog } from 'electron';
import { ipc } from '../../shared/channels.js';
import type { AttachmentSource, StageAttachmentsResult } from '@pocketshell/core';


export function registerPreviewIpc(ctx: IpcContext): void {
  const { preview, broadcast, attachments, getWindows, localFiles } = ctx;
  // --- preview:* -----------------------------------------------------------
  // The Files tab's HTML preview. `openHtml` hands the renderer a URL on the
  // `psview:` scheme and nothing else — no bytes, no directory listing, no way
  // to widen the root — and `release` takes it back. Everything the URL can
  // reach is bounded in HtmlPreviewService, which is where the reasoning about
  // an untrusted remote document naming paths for us to read lives.
  ipcMain.handle(
    ipc.preview.openHtml,
    async (_evt, connectionId: string, path: string): Promise<{ token: string; url: string }> => {
      return preview.open(connectionId, path);
    },
  );
  // Markdown takes the app's palette as well as the path, because the document
  // is BUILT here (src/main/preview/markdownDocument.ts) rather than read off
  // the host, and only the renderer knows which theme is applied. The payload
  // is typed `unknown` on the way in and validated in the service — a preload
  // is not a trust boundary, and a value from this bridge ends up inside a
  // `<style>` block.
  ipcMain.handle(
    ipc.preview.openMarkdown,
    async (
      _evt,
      connectionId: string,
      path: string,
      style: { palette?: unknown; appearance?: unknown } | null,
    ): Promise<{ token: string; url: string }> => {
      return preview.openMarkdown(connectionId, path, style ?? {});
    },
  );
  // SVG, like HTML, needs nothing but the path: the file brings its own
  // styling, is served untouched at its own content type, and is bounded by
  // the same CSP, sandbox and containment checks — which for an SVG document
  // is not decoration, because a `<script>` inside one would run if any of
  // them were dropped (see HtmlPreviewService.openSvg).
  ipcMain.handle(
    ipc.preview.openSvg,
    async (_evt, connectionId: string, path: string): Promise<{ token: string; url: string }> => {
      return preview.openSvg(connectionId, path);
    },
  );
  // `send`, not `invoke`, on the renderer side: releasing is fire-and-forget
  // and happens on the way out of a file, where awaiting an IPC round trip
  // would put a hop inside a close handler for no observable benefit.
  ipcMain.on(ipc.preview.release, (_evt, token: unknown) => {
    if (typeof token === 'string') preview.release(token);
  });
  preview.setStatsListener((stats) => broadcast(ipc.preview.stats, stats));

  // --- attachments:* ------------------------------------------------------
  // Prompt attachments: upload pasted bytes / picked files into
  // `~/.pocketshell/attachments/<scope>/` and hand back the remote paths the
  // composer splices into the prompt text (the agent reads them off disk).
  // Never rejects — a partial batch resolves with the survivors in `paths`
  // AND an `error` describing the shortfall (Android issue #570).
  ipcMain.handle(
    ipc.attachments.stage,
    async (
      _evt,
      payload: { connectionId: string; scopeKey: string; sources: AttachmentSource[] },
    ): Promise<StageAttachmentsResult> => {
      return attachments.stage(payload.connectionId, payload.scopeKey, payload.sources ?? []);
    },
  );

  // Native file picker. Lives on this side so the renderer never needs
  // filesystem access — it gets back paths it can hand to
  // `attachments:stage` or, since the doodle editor, read back through
  // `attachments:readLocal`. Every returned path is recorded as the
  // allow-list for that read.
  ipcMain.handle(
    ipc.attachments.pickFiles,
    async (_evt, payload?: { title?: string; multiple?: boolean }): Promise<string[]> => {
      const parent = getWindows().find((w) => !w.isDestroyed());
      const options: Electron.OpenDialogOptions = {
        title: payload?.title ?? 'Attach files',
        buttonLabel: 'Attach',
        properties:
          payload?.multiple === false
            ? ['openFile']
            : ['openFile', 'multiSelections'],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      const paths = result.canceled ? [] : result.filePaths;
      localFiles.remember(paths);
      return paths;
    },
  );

  // Read a picked file's BYTES back into the renderer, so it can be drawn
  // on before anything is uploaded. This is the one place the renderer
  // gets a filesystem read, which is why it is not `readFile(path)`: the
  // reader serves only paths the native dialog handed out in this
  // session, and refuses everything else. See LocalFileReader.
  //
  // Rejects on refusal / missing file / not-a-file / oversize, matching
  // `sftp:readFile` rather than `attachments:stage` — one file, so there
  // is no partial-batch outcome to encode in a result object.
  ipcMain.handle(
    ipc.attachments.readLocal,
    async (_evt, path: string): Promise<Uint8Array> => {
      return new Uint8Array(await localFiles.read(path));
    },
  );

}
