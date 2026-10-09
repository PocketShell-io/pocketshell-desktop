import type { IpcContext } from './context.js';
import { ipcMain, app } from 'electron';
import { join } from 'node:path';
import { ipc } from '../../shared/channels.js';
import { unsupportedTransport, type HostEntry } from '@pocketshell/core';
import { readSshConfig } from '../ssh-config/SshConfigParser.js';
import { KnownHosts } from '../ssh-config/KnownHosts.js';
import { withSelfEntry } from '../local/LocalHost.js';
import { normalizeGatewayTarget } from '@pocketshell/core';
import { readGatewayHosts } from '../ssh/GatewayHosts.js';
import { openGatewayStream } from '../ssh/GatewayStream.js';


export function registerTerminalIpc(ctx: IpcContext): void {
  const { ssh, broadcast, tmuxClients } = ctx;
  const registrations = () => readGatewayHosts(join(app.getPath('userData'), 'gateway-hosts.json'));
  // --- ssh:listConfigHosts -------------------------------------------------
  // `self` leads the list: this machine, dialled locally (no SSH). It is not
  // a config host — `fromConfig: false` and an `id` keep it out of any
  // config-write path — but it rides the config group because that is the
  // group the picker renders by default.
  ipcMain.handle(ipc.ssh.listConfigHosts, async (): Promise<HostEntry[]> => {
    return withSelfEntry([...readSshConfig(), ...registrations().map((r) => r.host)]);
  });

  // --- ssh:connect ---------------------------------------------------------
  ipcMain.handle(
    ipc.ssh.connect,
    async (
      _evt,
      payload: {
        host: string;
        port?: number;
        user: string;
        /** `HostEntry.name` when the host came from ~/.ssh/config. */
        hostAlias?: string;
        privateKeyPath?: string;
        privateKey?: string;
        passphrase?: string;
        tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
        /** True for the self host: main answers locally, no SSH. */
        local?: boolean;
        gateway?: unknown;
        link?: unknown;
      },
    ) => {
      // Gateway is implemented here; link remains unsupported. Preserve own-present
      // malformed/conflicting markers and refuse before credentials or a socket.
      const refusal = unsupportedTransport(payload, { gateway: true, link: false }, payload.hostAlias ?? null);
      if (refusal.refused) return { ok: false as const, error: refusal.message };
      let transport = {};
      if (Object.prototype.hasOwnProperty.call(payload, 'gateway')) {
        const target = normalizeGatewayTarget(payload.gateway);
        if (!target || payload.local) return { ok: false, error: 'Invalid gateway connection target.' };
        const registration = registrations().find((r) => r.host.gateway?.deviceId === target.deviceId
          && r.host.gateway.serverUrl === target.serverUrl);
        if (!registration) return { ok: false, error: 'Enroll this gateway host and its trusted SSH fingerprint on this Desktop first.' };
        try {
          const token = await ctx.sync.gatewayToken();
          transport = {
            sock: await openGatewayStream(target, token),
            gatewayHostKeyFingerprint: registration.sshHostKeyFingerprint,
            nativeWindowsCli: registration.nativeWindowsCli,
            nativeWindowsCliHostIdentity: target.deviceId,
          };
        } catch (error) {
          return { ok: false, error: `Gateway connection failed: ${(error as Error).message}` };
        }
      }
      const knownHosts = new KnownHosts();
      return ssh.connect({
        ...transport,
        host: payload.host,
        port: payload.port,
        user: payload.user,
        hostAlias: payload.hostAlias,
        privateKeyPath: payload.privateKeyPath,
        privateKey: payload.privateKey,
        passphrase: payload.passphrase,
        knownHosts,
        tofuDecision: payload.tofuDecision,
        ...(payload.local ? { local: true } : {}),
      });
    },
  );

  // --- ssh:exec ------------------------------------------------------------
  ipcMain.handle(ipc.ssh.exec, async (_evt, connectionId: string, command: string) => {
    return ssh.exec(connectionId, command);
  });

  // --- ssh:close -----------------------------------------------------------
  ipcMain.handle(ipc.ssh.close, async (_evt, connectionId: string) => {
    ssh.close(connectionId);
    return true;
  });

  // --- shell:open ----------------------------------------------------------
  // Opens a tracked PTY shell (optionally running a command like
  // `tmux attach -t main`) and streams stdout bytes back over
  // `shell:event:data`. The renderer feeds input via `shell:input`.
  // This is what powers the xterm.js terminal view.
  ipcMain.handle(
    ipc.shell.open,
    async (
      _evt,
      payload: { connectionId: string; command?: string; cols?: number; rows?: number; shell?: string },
    ) => {
      const shellId = await ssh.openTrackedShell(payload.connectionId, {
        command: payload.command,
        cols: payload.cols,
        rows: payload.rows,
        ...(payload.shell ? { shell: payload.shell } : {}),
        onData: (data: Buffer) => {
          // Copy into a fresh Uint8Array view so the structured-clone across
          // the IPC boundary does not detach the underlying ssh2 buffer.
          broadcast(ipc.shell.data, { shellId, data: new Uint8Array(data) });
        },
        onExit: (exitCode: number) => {
          broadcast(ipc.shell.exited, { shellId, exitCode });
        },
      });
      return shellId;
    },
  );

  // --- shell:attachSession -------------------------------------------------
  // How a session tab gets its PTY. Unlike `shell:open` this may hand back a
  // PTY the renderer is already bound to: the pool keeps one client per
  // session tab and holds it for the life of the tab, so a tab that is already
  // open is answered with its existing shell and no host work at all.
  // `switched` tells the renderer which of the two happened — true means "this
  // is the shell you already have, leave your terminal alone".
  //
  // The backend rides along because the pool keys (and joins) by runtime: a
  // tmux name is host-global, while an aplexer tag repeats across workspaces.
  // Absent backend means tmux, which is every caller written before aplexer.
  ipcMain.handle(
    ipc.shell.attachSession,
    async (
      _evt,
      payload: {
        connectionId: string;
        sessionName: string;
        cols?: number;
        rows?: number;
        backend?: 'tmux' | 'aplexer';
        workspace?: string;
        tag?: string;
        aplexerId?: string;
      },
    ) => {
      return tmuxClients.attach(payload.connectionId, payload.sessionName, {
        cols: payload.cols,
        rows: payload.rows,
        ...(payload.backend ? { backend: payload.backend } : {}),
        ...(payload.workspace ? { workspace: payload.workspace } : {}),
        ...(payload.tag ? { tag: payload.tag } : {}),
        ...(payload.aplexerId ? { aplexerId: payload.aplexerId } : {}),
        onData: (shellId, data) => {
          broadcast(ipc.shell.data, { shellId, data: new Uint8Array(data) });
        },
        onExit: (shellId, exitCode) => {
          broadcast(ipc.shell.exited, { shellId, exitCode });
        },
      });
    },
  );

  // --- shell:input / resize / close ---------------------------------------
  // Return what actually happened, not an unconditional true: the composer's
  // delivery-failure path depends on this being honest.
  // `sessionName` is optional and is a FENCE, not a target: it says which tmux
  // session the caller believed it was writing to. It was built when one PTY
  // served every session on a connection, where a multi-step write that
  // straddled a session change — the composer's text-pause-Enter, above all —
  // would finish in whatever session the pane had switched to. A PTY is now
  // bound to one session for its whole life, so that race is gone and this
  // check has become an assertion about a STALE id instead: a composer still
  // holding the shell of a tab that was evicted and re-joined. It still turns
  // into an honest `false`, which the composer already reports as a delivery
  // failure. Callers with nothing to be confused about (terminal keystrokes,
  // which always mean the pane as it is now) leave it off.
  ipcMain.handle(
    ipc.shell.input,
    async (_evt, shellId: string, data: string, sessionName?: string, workspace?: string) => {
      if (sessionName && !tmuxClients.isShowing(shellId, sessionName, workspace)) return false;
      return ssh.shellInput(shellId, data);
    },
  );
  ipcMain.handle(ipc.shell.resize, async (_evt, shellId: string, cols: number, rows: number) =>
    ssh.shellResize(shellId, cols, rows),
  );
  // A repaint, not a resize. The renderer asks for this after it has made the
  // far end's idea of our geometry true again — see TerminalView's
  // `pushGeometry`, and TmuxClientPool.redraw for why tmux will not do it on
  // its own. False means "nothing to refresh", never an error.
  ipcMain.handle(ipc.shell.redraw, async (_evt, shellId: string) =>
    tmuxClients.redraw(shellId),
  );
  // The read-only question `redraw` exists to answer. Null means "no tmux
  // client behind this shell to ask" — a bare shell, an evicted tab — which is
  // an ordinary answer the renderer's reconcile loop treats as "nothing to
  // check", never as a failure.
  ipcMain.handle(ipc.shell.windowSize, async (_evt, shellId: string) =>
    tmuxClients.windowSize(shellId),
  );
  ipcMain.handle(ipc.shell.close, async (_evt, shellId: string) => {
    ssh.shellClose(shellId);
    return true;
  });

}
