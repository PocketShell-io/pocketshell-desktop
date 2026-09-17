import type { IpcContext } from './context.js';
import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';
import type { BootstrapResult, SessionSummary } from '../../shared/types.js';
import { runBootstrap } from '../helper/bootstrap.js';
import type { UsageRow } from '../helper/usageParsers.js';
import type { AplexerAckOutcome } from '../helper/AplexerClient.js';
import type { AplexerWarning } from '../../shared/aplexer.js';


export function registerHelperIpc(ctx: IpcContext): void {
  const { ssh, helper, aplexer } = ctx;
  // --- helper:bootstrap ----------------------------------------------------
  ipcMain.handle(ipc.helper.bootstrap, async (_evt, connectionId: string): Promise<BootstrapResult> => {
    return runBootstrap(ssh, connectionId);
  });

  // --- helper:sessionsList -------------------------------------------------
  ipcMain.handle(
    ipc.helper.sessionsList,
    async (
      _evt,
      connectionId: string,
      sortBy?: 'activity' | 'created',
    ): Promise<SessionSummary[]> => {
      return helper.listSessions(connectionId, sortBy ?? 'activity');
    },
  );

  // --- helper:sessionsCreate ----------------------------------------------
  // Explicit-name create. The folder-first flow goes through
  // `projects:startSession`; this remains for a caller that genuinely knows
  // the tmux session name it wants (and it must supply the cwd — a session
  // with no start folder is not a project session).
  ipcMain.handle(
    ipc.helper.sessionsCreate,
    async (_evt, connectionId: string, name: string, cwd: string): Promise<boolean> => {
      const outcome = await helper.createSession(connectionId, { name, cwd });
      return outcome.ok;
    },
  );

  // --- helper:usage --------------------------------------------------------
  ipcMain.handle(ipc.helper.usage, async (_evt, connectionId: string): Promise<UsageRow[]> => {
    return helper.usage(connectionId);
  });

  // --- helper:warnings -----------------------------------------------------
  // Unacknowledged aplexer crash/OOM warnings (`a warnings --json`).
  // Aplexer-only by nature — the tmux fallback keeps no crash store — so this
  // rides the aplexer client, not the helper's tmux arms. The client method
  // is total ([] on any failure), so a bad round trip can only delay a
  // warning, never throw one away.
  ipcMain.handle(
    ipc.helper.warnings,
    async (_evt, connectionId: string): Promise<AplexerWarning[]> => {
      return aplexer.listWarnings(connectionId);
    },
  );

  // --- helper:ackWarnings --------------------------------------------------
  // `a ack [SESSION]`. The outcome object travels back whole: the renderer
  // distinguishes a real failure (an error line in the strip) from notFound
  // — the warning another client acked first — which the refresh that
  // follows settles, because the goal state "no warning showing" is already
  // true in that race, not violated by it.
  ipcMain.handle(
    ipc.helper.ackWarnings,
    async (_evt, connectionId: string, target?: string): Promise<AplexerAckOutcome> => {
      return aplexer.ackWarnings(connectionId, target);
    },
  );

}
