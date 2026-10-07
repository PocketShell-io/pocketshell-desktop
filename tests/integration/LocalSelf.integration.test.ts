import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SshService } from '../../src/main/ssh/SshService';
import { AplexerClient } from '../../src/main/helper/AplexerClient';
import { runBootstrap } from '../../src/main/helper/bootstrap';
import { TmuxClientPool } from '../../src/main/ssh/TmuxClientPool';
import { SftpService } from '../../src/main/sftp/SftpService';
import { localBash } from '../../src/main/local/LocalHost';

/**
 * The self connection end to end, against whatever machine runs the tests —
 * no Docker. It is the exact path a `self` dial takes in the app: connect,
 * bootstrap, list the host's aplexer sessions, join one in a local PTY, kill
 * it, and browse its files. Skipped unless `a` and bash both exist here, so
 * CI and machines without the pair lose nothing.
 *
 * The aplexer session is created and killed by the test itself (a disposable
 * workspace under the OS temp dir), so nothing about the machine's real
 * session list is assumed or disturbed.
 */

function toolOnPath(name: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'command';
    const args = process.platform === 'win32' ? [name] : ['-v', name];
    execFileSync(probe, args, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const envReady = toolOnPath('a') && localBash() !== null;

describe.skipIf(!envReady)('LocalSelf — a self dial against this machine', () => {
  it(
    'bootstraps, lists the real sessions, joins one in a local PTY, and browses its files',
    { timeout: 60_000 },
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'ps-self-it-'));
      const tag = `self-it-${Date.now().toString(36)}`;

      const ssh = new SshService();
      const aplexer = new AplexerClient(ssh);
      const pool = new TmuxClientPool(ssh);
      const sftp = new SftpService(ssh.registry_);

      try {
        // Connect, exactly as the renderer's dial does for a `local` host.
        const dial = await ssh.connect({ host: 'self', user: 'self', local: true });
        expect(dial.ok).toBe(true);
        const id = dial.ok && dial.connectionId ? dial.connectionId : '';
        expect(await ssh.hostPlatform(id)).toBe('windows');

        // Bootstrap: on a Windows answer the helper/tmux probes are skipped,
        // and `a` is expected to answer.
        const boot = await runBootstrap(ssh, id);
        expect(boot).toBeTruthy();
        expect(await aplexer.isAvailable(id)).toBe(true);

        // A disposable session, created through the same command builder the
        // app's create flow uses.
        const started = await ssh.exec(
          id,
          `a start --workspace ${JSON.stringify(workspace)} --tag ${JSON.stringify(tag)} --json`,
        );
        expect(started.exitCode).toBe(0);
        const created = JSON.parse(started.stdout) as { id: string };

        const list = (await aplexer.listSessions(id)) ?? [];
        const mine = list.find((s) => s.aplexerId === created.id);
        expect(mine?.tag).toBe(tag);
        expect(mine?.backend).toBe('aplexer');
        // Separator-insensitive: aplexer canonicalises the workspace it was
        // given, and the exact spelling is the host's business, not ours —
        // the join `cd`s to whatever the listing reported.
        const norm = (p: string): string => p.toLowerCase().replace(/\\/g, '/');
        expect(mine?.workspace && norm(mine.workspace)).toBe(norm(workspace));

        // Join it: the pool builds the join, opens a LOCAL PTY, and the
        // attach repaints the session's screen into onData.
        let bytes = 0;
        let exited = false;
        const joined = await pool.attach(id, tag, {
          backend: 'aplexer',
          workspace,
          tag,
          aplexerId: created.id,
          onData: (data) => {
            bytes += data.length;
          },
          onExit: () => {
            exited = true;
          },
        });
        expect(joined.switched).toBe(false);

        // The join IS `a attach` under ConPTY — give the repaint a beat,
        // then send a keystroke through the tracked shell to prove the
        // round trip reaches the session.
        await new Promise((r) => setTimeout(r, 2_000));
        expect(bytes).toBeGreaterThan(0);
        expect(exited).toBe(false);
        expect(ssh.shellInput(joined.shellId, '\n')).toBe(true);
        await new Promise((r) => setTimeout(r, 500));

        // The Files tab's backing: listing the session's workspace locally.
        const entries = await sftp.list(id, workspace);
        expect(Array.isArray(entries)).toBe(true);

        // Done with the tab: release the pool's client, then kill the
        // session through the same client call the panel's kill uses.
        pool.release(id);
        const killed = await aplexer.killSession(id, created.id);
        expect(killed.ok).toBe(true);
        ssh.close(id);
      } finally {
        // A just-killed session's bash can hold the dir a beat longer on
        // Windows; give the handle three chances to close before giving up.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            rmSync(workspace, { recursive: true, force: true });
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
    },
  );
});
