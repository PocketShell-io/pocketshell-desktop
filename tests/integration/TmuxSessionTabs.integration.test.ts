import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { SshService } from '@main/ssh/SshService';
import { MAX_LIVE_CLIENTS, TmuxClientPool } from '@main/ssh/TmuxClientPool';
import { PocketshellClient } from '@main/helper/PocketshellClient';
import { pathAwareCommand } from '@main/helper/bootstrap';
import type { GridSize, ShellId } from '@pocketshell/core';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * A client per session tab, against the real thing: real tmux, real tmuxctl,
 * real sshd.
 *
 * The unit tests pin what the pool DECIDES. Only this can say whether the
 * decision works on a host — whether several tmux clients can sit on one server
 * at once without disturbing each other's sessions or each other's geometry,
 * whether returning to a tab really costs no bytes, and whether `sshd`'s
 * `MaxSessions` leaves room for the rest of the app.
 *
 * This file replaces TmuxSwitch.integration.test.ts, which tested the design
 * this one supersedes: one client per connection, moved with
 * `tmux switch-client`. That design's own numbers on the user's host are in the
 * header of TmuxClientPool — a switch that worked cost p50 210 ms and most did
 * not work — and its cost is structural, since a switch is an SSH exec channel
 * plus a full-screen repaint. Keeping the tab's client removes both.
 *
 * The helper image is used rather than `:tmux` because tmuxctl is what the join
 * runs. Auto-skips when Docker is unavailable.
 */
describeDocker('a tmux client per session tab', () => {
  let container: StartedTestContainer | undefined;
  let ssh: SshService;
  let pool: TmuxClientPool;
  let connectionId: string;

  /** Everything each shell has emitted, per shell id. */
  const output = new Map<ShellId, string>();
  /** Bytes seen per shell, so "a tab switch costs nothing" can be measured. */
  const byteCount = new Map<ShellId, number>();

  const sink = {
    onData: (shellId: ShellId, data: Buffer) => {
      output.set(shellId, (output.get(shellId) ?? '') + data.toString('utf8'));
      byteCount.set(shellId, (byteCount.get(shellId) ?? 0) + data.length);
    },
    onExit: () => {},
  };

  /** A line the session prints, so seeing it proves that session is on screen. */
  const marker = (session: string) => `MARK-${session.toUpperCase()}`;

  const TABS = ['tab-one', 'tab-two', 'tab-three'];

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:helper')
      .withExposedPorts(22)
      .start();
    ssh = new SshService();
    const result = await ssh.connect({
      host: container.getHost(),
      port: container.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.connectionId) throw new Error('connect failed');
    connectionId = result.connectionId;
    // The real helper rides along, exactly as it does in production: it is
    // what lets the pool locate the tmux server a session lives on, and this
    // file is the only place that can prove the aiming works on the thing.
    pool = new TmuxClientPool(ssh, new PocketshellClient(ssh));

    // `send-keys` rather than a start command so the marker sits in the pane's
    // visible screen, which is what an attach draws.
    for (const name of TABS) {
      await ssh.exec(connectionId, `tmux new-session -d -s ${name} -c "$HOME" 2>/dev/null || true`);
      await ssh.exec(connectionId, `tmux send-keys -t ${name} 'clear; echo ${marker(name)}' Enter`);
    }
  }, 180_000);

  afterAll(async () => {
    if (connectionId) ssh.close(connectionId);
    if (container) await container.stop();
  });

  /** Resolve once `needle` shows up in the shell's accumulated output. */
  function waitForOutput(shellId: ShellId, needle: string, timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        const acc = output.get(shellId) ?? '';
        if (acc.includes(needle)) resolve(acc);
        else if (Date.now() - start > timeoutMs) {
          reject(new Error(`timed out waiting for ${needle}; last 300: ${acc.slice(-300)}`));
        } else setTimeout(tick, 50);
      };
      tick();
    });
  }

  it('gives each tab its own PTY, each showing its own session', async () => {
    const shells: ShellId[] = [];
    for (const name of TABS) {
      const res = await pool.attach(connectionId, name, { cols: 80, rows: 24, ...sink });
      expect(res.switched).toBe(false);
      shells.push(res.shellId);
    }

    // Three tabs, three distinct PTYs — the property the design turns on.
    expect(new Set(shells).size).toBe(3);

    // And each one is genuinely showing its OWN session, concurrently. Under
    // the shared-client design only the last could be, because there was one
    // client and it had been moved to the last session asked for.
    for (let i = 0; i < TABS.length; i++) {
      await waitForOutput(shells[i]!, marker(TABS[i]!));
    }

    // tmux agrees: three clients, three different sessions, all at once.
    const clients = await ssh.exec(
      connectionId,
      `tmux list-clients -F '#{client_tty}=#{client_session}'`,
    );
    const sessions = clients.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=')[1]);
    for (const name of TABS) expect(sessions).toContain(name);
  }, 120_000);

  it('costs literally nothing to go back to a tab that is already open', async () => {
    // This is the whole point, and it is measured rather than asserted about:
    // returning to a tab must move no bytes at all. The shared client could not
    // have this property — `switch-client` makes tmux repaint every cell of the
    // new session down the PTY, 10.7 KB for one dense 200x50 screen.
    const first = await pool.attach(connectionId, TABS[0]!, { cols: 80, rows: 24, ...sink });
    await waitForOutput(first.shellId, marker(TABS[0]!));
    await pool.attach(connectionId, TABS[1]!, { cols: 80, rows: 24, ...sink });

    // Let the far end go quiet, then watch the byte counter across a return.
    await new Promise((r) => setTimeout(r, 1500));
    const before = byteCount.get(first.shellId) ?? 0;

    const started = Date.now();
    const back = await pool.attach(connectionId, TABS[0]!, { cols: 80, rows: 24, ...sink });
    const elapsed = Date.now() - started;

    expect(back.shellId).toBe(first.shellId);
    expect(back.switched).toBe(true);
    // No host round trip: this never leaves the main process.
    expect(elapsed).toBeLessThan(50);

    await new Promise((r) => setTimeout(r, 1000));
    expect(byteCount.get(first.shellId) ?? 0).toBe(before);
  }, 120_000);

  it('sizes each session from its own client, so one tab cannot shrink another', async () => {
    // The hazard a per-tab design has to clear: a hidden pane measures 0 and a
    // naive fit would push a tiny PTY at the remote. Even when that happens,
    // one tab's geometry must not reach another tab's session — which holds
    // because each session has exactly one client of ours attached to it.
    const a = await pool.attach(connectionId, TABS[0]!, { cols: 80, rows: 24, ...sink });
    const b = await pool.attach(connectionId, TABS[1]!, { cols: 80, rows: 24, ...sink });
    await waitForOutput(b.shellId, marker(TABS[1]!));
    await new Promise((r) => setTimeout(r, 500));

    // `list-windows -t` takes a target-SESSION, where `=` is the exact-match
    // prefix. `display-message -t` takes a target-PANE, where `=name` is not
    // valid syntax and silently yields an empty format instead of an error.
    const size = async (session: string): Promise<string> =>
      (
        await ssh.exec(
          connectionId,
          `tmux list-windows -t '=${session}' -F '#{window_width}x#{window_height}' | head -1`,
        )
      ).stdout.trim();

    const aBefore = await size(TABS[0]!);
    const bBefore = await size(TABS[1]!);

    ssh.shellResize(a.shellId, 120, 40);
    await new Promise((r) => setTimeout(r, 800));

    // The width is asserted exactly and the height only has to CHANGE: a tmux
    // window is one row shorter than its client because the status line takes
    // that row, so pinning 40 here would be pinning a tmux setting rather than
    // this app's behaviour.
    const aAfter = await size(TABS[0]!);
    expect(aAfter.split('x')[0]).toBe('120');
    expect(aAfter).not.toBe(aBefore);

    // The property that actually matters: the other tab did not move.
    expect(await size(TABS[1]!)).toBe(bBefore);
  }, 120_000);

  it('aims redraw and the geometry probe at a session living on its own tmux server', async () => {
    // The precondition that makes this test mean something: a session created
    // the way the app creates them — through the helper, which since tmuxctl
    // 0.3.5 puts each one on its OWN server — is invisible to a bare tmux.
    // Every aimed command the pool runs therefore has to name that server,
    // or it silently reaches a server that has never heard of our client.
    const created = await ssh.exec(
      connectionId,
      pathAwareCommand(`pocketshell sessions create 'sock-tab' -c "$HOME"`),
    );
    expect(created.exitCode).toBe(0);
    const bare = await ssh.exec(connectionId, `tmux has-session -t '=sock-tab' 2>/dev/null`);
    expect(bare.exitCode).not.toBe(0);

    const joined = await pool.attach(connectionId, 'sock-tab', { cols: 80, rows: 24, ...sink });
    expect(joined.switched).toBe(false);

    // The join resolves when the PTY opens, which can beat tmuxctl finishing
    // the attach. The geometry probe doubles as the readiness signal: an `ok`
    // answer means our client is attached, tmux can name it, and — under
    // `window-size latest` with it as the only client — the window has taken
    // the size we attached with.
    let size: GridSize | null = null;
    for (let i = 0; i < 100 && !size; i++) {
      const probe = await pool.windowSize(joined.shellId);
      if (probe.kind === 'ok') size = probe.client;
      else await new Promise((r) => setTimeout(r, 200));
    }
    // Asserted against the CLIENT's tty — exactly what the attach set. (The
    // window would be one row shorter: the status line takes that row. Same
    // reasoning the sizing test above gives for pinning the width exactly and
    // being careful about the height.)
    expect(size).toEqual({ cols: 80, rows: 24 });

    // The regression itself: refresh-client reaches the client through its
    // own server. With the default-socket spelling this answered `can't find
    // client` on exactly this fixture — the Redraw button that did nothing.
    await expect(pool.redraw(joined.shellId)).resolves.toBe(true);

    await ssh.exec(
      connectionId,
      `tmux -S /tmp/tmux-$(id -u)/tmuxctl-sock-tab kill-session -t '=sock-tab' 2>/dev/null || true`,
    );
  }, 120_000);

  it('stays under the SSH channel ceiling, evicting rather than failing', async () => {
    // `sshd`'s MaxSessions is 10 by default and is a hard ceiling — the 11th
    // channel fails outright, and it fails for every other feature that needs
    // one too. A folder with more sessions than the budget must therefore cost
    // an eviction, never a broken app.
    //
    // On its OWN connection, because MaxSessions is counted per SSH connection
    // and the tabs the tests above left open are on the shared one. Writing it
    // any other way makes the assertion depend on test order, which is how a
    // ceiling test ends up proving only that the ceiling exists.
    const own = await ssh.connect({
      host: container!.getHost(),
      port: container!.getMappedPort(22),
      user: 'testuser',
      privateKeyPath: TEST_KEY_PATH,
      knownHosts: null,
      tofuDecision: 'accept-once',
      timeoutMs: 15_000,
    });
    if (!own.ok || !own.connectionId) throw new Error('second connect failed');
    const budgetConn = own.connectionId;
    const fresh = new TmuxClientPool(ssh);

    try {
      const names: string[] = [];
      for (let i = 0; i < MAX_LIVE_CLIENTS + 2; i++) {
        const name = `budget-${i}`;
        names.push(name);
        await ssh.exec(budgetConn, `tmux new-session -d -s ${name} 2>/dev/null || true`);
        await fresh.attach(budgetConn, name, { cols: 80, rows: 24, ...sink });
      }

      expect(fresh.liveSessions(budgetConn)).toHaveLength(MAX_LIVE_CLIENTS);

      // There is still room for the exec channels the rest of the app needs.
      // Without the cap this is exactly what would have failed, and it would
      // have failed in the session list or the Files tab rather than here.
      const probe = await ssh.exec(budgetConn, 'echo still-here');
      expect(probe.stdout.trim()).toBe('still-here');

      // The evicted tab lost its channel and nothing else: the tmux session is
      // server-side, so going back to it re-joins and finds it as it was.
      const evicted = names[0]!;
      expect(fresh.liveSessions(budgetConn)).not.toContain(evicted);
      const back = await fresh.attach(budgetConn, evicted, { cols: 80, rows: 24, ...sink });
      expect(back.switched).toBe(false);
      expect(fresh.liveSessions(budgetConn)).toContain(evicted);

      for (const name of names) {
        await ssh.exec(budgetConn, `tmux kill-session -t '=${name}' 2>/dev/null || true`);
      }
    } finally {
      ssh.close(budgetConn);
    }
  }, 180_000);

  it('leaves any other client on the host alone', async () => {
    // A user with their own terminal attached to the same tmux server. Our
    // clients are additional attachments, so theirs must be untouched.
    const decoy = await ssh.openTrackedShell(connectionId, {
      command: `tmux attach-session -t '=${TABS[2]}'`,
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    await new Promise((r) => setTimeout(r, 1500));

    await pool.attach(connectionId, TABS[0]!, { cols: 80, rows: 24, ...sink });

    const clients = await ssh.exec(
      connectionId,
      `tmux list-clients -F '#{client_tty}=#{client_session}'`,
    );
    const onDecoySession = clients.stdout
      .trim()
      .split('\n')
      .filter((line) => line.endsWith(`=${TABS[2]}`));
    // Theirs is still there — ours never moves a client that is not its own.
    expect(onDecoySession.length).toBeGreaterThanOrEqual(1);

    ssh.shellClose(decoy);
  }, 90_000);

  it('surfaces the join diagnostic when the session is not there', async () => {
    // A tab whose session was killed on the host. There is no client to reuse,
    // so this is a plain join, and the join's own `||` arm is what tells the
    // user — in the terminal they are looking at — rather than a blank pane.
    const gone = await pool.attach(connectionId, 'tab-does-not-exist', {
      cols: 80,
      rows: 24,
      ...sink,
    });
    expect(gone.switched).toBe(false);
    await waitForOutput(gone.shellId, 'could not join session');
  }, 90_000);

  it('re-joins after the user detaches a tab from inside tmux', async () => {
    const held = await pool.attach(connectionId, TABS[1]!, { cols: 80, rows: 24, ...sink });
    await waitForOutput(held.shellId, marker(TABS[1]!));

    // prefix-d, as a user would: the PTY drops back to a login prompt and the
    // channel closes, so the pool must notice the shell is gone rather than
    // handing a dead client back to the tab.
    ssh.shellClose(held.shellId);
    await new Promise((r) => setTimeout(r, 500));

    const after = await pool.attach(connectionId, TABS[1]!, { cols: 80, rows: 24, ...sink });
    expect(after.switched).toBe(false);
    expect(after.shellId).not.toBe(held.shellId);
    await waitForOutput(after.shellId, marker(TABS[1]!));
  }, 120_000);
});
