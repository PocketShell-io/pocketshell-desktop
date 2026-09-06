import type { IpcContext } from './context.js';
import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';
import type { AplexerSessionRef, CloneResult, CreateFolderRequest, CreateFolderResult, HomeResult, ReposCloneOptions, ReposListRequest, ReposListResult, KillSessionResult, RenameSessionResult, StartSessionRequest, StartSessionResult } from '../projects/ProjectsService.js';


export function registerProjectsIpc(ctx: IpcContext): void {
  const { projects, broadcast, tmuxClients, helper } = ctx;
  // --- projects:* ----------------------------------------------------------
  // Folder-first session creation. The renderer browses folders with the SFTP
  // channels below (there is no second folder-listing path here on purpose);
  // these add the pieces SFTP cannot answer: where home is, what a folder's
  // session would be called, the repo list, the clone, and the create.
  ipcMain.handle(ipc.projects.home, async (_evt, connectionId: string): Promise<HomeResult> => {
    return projects.home(connectionId);
  });

  ipcMain.handle(
    ipc.projects.deriveName,
    async (_evt, connectionId: string, folder: string, customName?: string): Promise<string> => {
      return projects.deriveSessionName(connectionId, folder, customName);
    },
  );

  ipcMain.handle(
    ipc.projects.createFolder,
    async (
      _evt,
      connectionId: string,
      request: CreateFolderRequest,
    ): Promise<CreateFolderResult> => {
      return projects.createFolder(connectionId, request);
    },
  );

  ipcMain.handle(
    ipc.projects.reposList,
    async (
      _evt,
      connectionId: string,
      request?: ReposListRequest,
    ): Promise<ReposListResult> => {
      return projects.reposList(connectionId, request ?? {});
    },
  );

  // A clone can run for tens of seconds. The invoke still resolves with the
  // final result, but `projects:event:cloneProgress` fires immediately with
  // phase 'started' (and again on 'finished') so the UI has something to show
  // rather than looking hung — the same shape as sftp transfer progress.
  ipcMain.handle(
    ipc.projects.reposClone,
    async (
      _evt,
      connectionId: string,
      request: ReposCloneOptions & { requestId?: string },
    ): Promise<CloneResult> => {
      return projects.cloneRepo(connectionId, request, (progress) => {
        broadcast(ipc.projects.cloneProgress, progress);
      });
    },
  );

  ipcMain.handle(
    ipc.projects.startSession,
    async (
      _evt,
      connectionId: string,
      request: StartSessionRequest,
    ): Promise<StartSessionResult> => {
      return projects.startSession(connectionId, request);
    },
  );

  // A rename is two operations, not one: the host renames the session, and
  // the pool's note of which session its client is showing has to move with
  // it. Doing the second here rather than in the service keeps the service
  // free of the pool, and there is nowhere else both facts are in scope. See
  // TmuxClientPool.renamed for what breaks if it is skipped. The aplexer ref
  // (backend + workspace) moves the workspace-qualified pool key; without it
  // the move misses and the renamed tab pays a full re-join.
  ipcMain.handle(
    ipc.projects.renameSession,
    async (
      _evt,
      connectionId: string,
      from: string,
      to: string,
      ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
    ): Promise<RenameSessionResult> => {
      const result = await projects.renameSession(connectionId, from, to, ref);
      if (result.ok && result.sessionName) {
        tmuxClients.renamed(connectionId, from, result.sessionName, ref);
      }
      return result;
    },
  );

  // A kill is two operations for the same reason a rename is, and the pool half
  // matters MORE here: a rename leaves a live client pointing at a live session
  // under the wrong key, whereas a kill leaves one pointing at nothing at all.
  // Done here rather than in the service so the service stays free of the pool.
  //
  // The pool is told even when the host says the session was already gone. That
  // is the ordinary race — the tab bar refreshes on a timer — and our record of
  // a session that has been dead for some seconds is exactly the record that
  // needs dropping. See TmuxClientPool.killed.
  ipcMain.handle(
    ipc.projects.killSession,
    async (
      _evt,
      connectionId: string,
      name: string,
      ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
    ): Promise<KillSessionResult> => {
      const result = await projects.killSession(connectionId, name, ref);
      if (result.ok || result.code === 'not-found') tmuxClients.killed(connectionId, name, ref);
      return result;
    },
  );

  // --- agent:* ------------------------------------------------------------
  // Agent-awareness: profiles and the env editor, delegated to the
  // server-side pocketshell helper. The conversation-log and resumable
  // channels that used to live here went with the Conversation feature
  //
  // Null, not [], when the host could not be asked — the launch picker uses
  // the difference to decide whether an engine it cannot confirm should be
  // offered anyway (shared/agentLaunch.ts).
  ipcMain.handle(ipc.agent.kinds, async (_evt, connectionId: string) => {
    return helper.agentSubcommands(connectionId);
  });
  ipcMain.handle(ipc.agent.profiles, async (_evt, connectionId: string) => {
    return helper.listProfiles(connectionId);
  });
  ipcMain.handle(
    ipc.agent.envList,
    async (_evt, connectionId: string, dir: string) => {
      return helper.envList(connectionId, dir);
    },
  );
  // `keys` is optional: omit it to reveal the folder's whole env (the helper
  // needs `env list` first, since `env get` has no "all keys" mode).
  ipcMain.handle(
    ipc.agent.envGet,
    async (_evt, connectionId: string, dir: string, keys?: string[]) => {
      return helper.envGet(connectionId, dir, keys);
    },
  );
  // A write, so unlike the two readers it REJECTS on failure — the panel must
  // be able to tell "the helper refused" from "done". `helper.envSet` carries
  // the values to the command's stdin as one JSON object; they never touch
  // argv.
  ipcMain.handle(
    ipc.agent.envSet,
    async (
      _evt,
      connectionId: string,
      dir: string,
      values: Record<string, string>,
      file?: string,
    ) => {
      return helper.envSet(connectionId, dir, values, file);
    },
  );

}
