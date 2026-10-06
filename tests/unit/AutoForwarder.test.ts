import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SshService } from '@main/ssh/SshService';
import type { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';
import {
  AutoForwarder,
  DEFAULT_AUTO_CONFIG,
  type AutoForwardConfig,
} from '@main/portfwd/AutoForwarder';
import { forwardKey } from '@main/portfwd/Forwarder';

/**
 * The scan-loop policy: the empty-scan guard, the teardown debounce, real
 * local-port allocation, and the failed-port TTL.
 *
 * The forwards these open are genuine local TCP listeners (that is the whole
 * point of the bind probe), but nothing ever connects through them, so no SSH
 * client is needed — the registry double returns no connection and only the
 * listen side runs.
 */

/** A scriptable SshService: each scan pops the next canned listener output. */
class ScriptedSsh {
  private queue: { ports: number[] | null }[] = [];
  execCount = 0;

  hostPlatform(_id: string): Promise<'posix' | 'windows'> {
    return Promise.resolve('posix');
  }

  /** Queue one scan result. `null` means the scan FAILS (non-zero exit). */
  push(ports: number[] | null): this {
    this.queue.push({ ports });
    return this;
  }

  exec(_id: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.execCount += 1;
    if (/readlink/.test(command)) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }
    const next = this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? { ports: [] });
    if (next.ports === null) {
      return Promise.resolve({ stdout: '', stderr: 'transport hiccup', exitCode: -1 });
    }
    const rows = next.ports.map((p) => `LISTEN 0 128 0.0.0.0:${p} 0.0.0.0:*`);
    const stdout = [
      '<<<PS_SS_TLN>>>',
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port',
      ...rows,
      '<<<PS_SS_TLNP>>>',
      '<<<PS_NETSTAT_TLNP>>>',
      '<<<PS_NETSTAT_TLN>>>',
    ].join('\n');
    return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
  }

  asService(): SshService {
    return this as unknown as SshService;
  }
}

/** Registry double: no live connection, which is all the listen side needs. */
const registry = { get: () => undefined } as unknown as ConnectionRegistry;

const openServers: Server[] = [];
const forwarders: AutoForwarder[] = [];

/** Occupy a local port for real, so the bind probe has something to find. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      openServers.push(server);
      resolve(server);
    });
  });
}

function makeForwarder(ssh: ScriptedSsh, config: Partial<AutoForwardConfig> = {}): AutoForwarder {
  const fwd = new AutoForwarder(ssh.asService(), 'conn-1', registry, {
    config: { ...DEFAULT_AUTO_CONFIG, ...config },
  });
  forwarders.push(fwd);
  return fwd;
}

afterEach(async () => {
  for (const fwd of forwarders.splice(0)) fwd.suspend();
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('forwardKey', () => {
  it('produces the exact string PortPanelView.vue builds', () => {
    // PortPanelView.vue:48-50 — `${s.kind}:${s.listenPort}->${s.destHost}:${s.destPort}`.
    // The auto path used to build `local:8080->8080` instead, so a
    // renderer-issued remove() silently matched nothing.
    expect(
      forwardKey({
        kind: 'local',
        listenHost: '127.0.0.1',
        listenPort: 8080,
        destHost: '127.0.0.1',
        destPort: 8080,
      }),
    ).toBe('local:8080->127.0.0.1:8080');
  });

  it('distinguishes the three forward kinds and a remapped local port', () => {
    const base = { listenHost: '127.0.0.1', destHost: '10.0.0.5' };
    expect(forwardKey({ ...base, kind: 'remote', listenPort: 1, destPort: 2 })).toBe(
      'remote:1->10.0.0.5:2',
    );
    expect(forwardKey({ ...base, kind: 'dynamic', listenPort: 1080, destPort: 0 })).toBe(
      'dynamic:1080->10.0.0.5:0',
    );
    expect(
      forwardKey({ kind: 'local', listenHost: '127.0.0.1', listenPort: 3000, destHost: '127.0.0.1', destPort: 19840 }),
    ).toBe('local:3000->127.0.0.1:19840');
  });
});

describe('auto-forward key round trip', () => {
  it('removes an AUTO-created forward using the renderer-built key', async () => {
    const ssh = new ScriptedSsh().push([8123]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();

    const states = fwd.snapshot();
    expect(states).toHaveLength(1);
    // The renderer rebuilds the key from the state fields it received.
    const rendererKey = `${states[0]!.kind}:${states[0]!.listenPort}->${states[0]!.destHost}:${states[0]!.destPort}`;
    expect(states[0]!.key).toBe(rendererKey);

    await fwd.remove(rendererKey);
    expect(fwd.snapshot()).toHaveLength(0);
  });
});

describe('empty-scan guard', () => {
  it('keeps every forward when a scan FAILS', async () => {
    const ssh = new ScriptedSsh().push([8231]).push(null).push(null).push(null);
    const fwd = makeForwarder(ssh, { missingScansBeforeStop: 1 });

    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(1);

    // Three consecutive failed scans. Before the guard, the first one alone
    // tore the tunnel down mid-transfer.
    await fwd.refresh();
    await fwd.refresh();
    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(1);
    expect(fwd.getStatus().lastScanOk).toBe(false);
    expect(fwd.getStatus().lastError).toBe('transport hiccup');
  });

  it('keeps every forward when a scan returns zero ports', async () => {
    const ssh = new ScriptedSsh().push([8232]).push([]).push([]);
    const fwd = makeForwarder(ssh, { missingScansBeforeStop: 1 });
    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(1);
    await fwd.refresh();
    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(1);
  });

  it('single-flights overlapping scans instead of interleaving them', async () => {
    const ssh = new ScriptedSsh().push([8233]);
    const fwd = makeForwarder(ssh);
    await Promise.all([fwd.refresh(), fwd.refresh(), fwd.refresh()]);
    // Two of the three are dropped, so only one listener probe went out
    // (plus no cwd probe: nothing was attributed).
    expect(ssh.execCount).toBe(1);
  });
});

describe('teardown debounce', () => {
  it('requires missingScansBeforeStop consecutive misses', async () => {
    const ssh = new ScriptedSsh().push([8241]).push([]).push([9000]).push([9000]);
    const fwd = makeForwarder(ssh, { missingScansBeforeStop: 2 });

    await fwd.refresh(); // seen
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([8241]);

    await fwd.refresh(); // empty scan -> guarded, not even a miss
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([8241]);

    await fwd.refresh(); // miss 1 of 2 -> still up
    expect(fwd.snapshot().map((s) => s.destPort).sort()).toEqual([8241, 9000]);

    await fwd.refresh(); // miss 2 of 2 -> torn down
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([9000]);
  });

  it('resets the miss counter when the port comes back', async () => {
    const ssh = new ScriptedSsh().push([8242]).push([7000]).push([8242, 7000]).push([7000]);
    const fwd = makeForwarder(ssh, { missingScansBeforeStop: 2 });
    await fwd.refresh(); // seen
    await fwd.refresh(); // miss 1 (a dev server reloading)
    await fwd.refresh(); // back -> counter reset
    expect(fwd.snapshot().some((s) => s.destPort === 8242)).toBe(true);
    await fwd.refresh(); // miss 1 again, not 2
    expect(fwd.snapshot().some((s) => s.destPort === 8242)).toBe(true);
  });

  it('never tears down a MANUAL forward whose port disappears', async () => {
    // Node's advantage over the Python, which kills hand-forwarded ports the
    // moment their process stops listening.
    const ssh = new ScriptedSsh().push([]).push([]);
    const fwd = makeForwarder(ssh, { missingScansBeforeStop: 1 });
    const ok = await fwd.addManual({
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 8251,
      destHost: '127.0.0.1',
      destPort: 8251,
    });
    expect(ok).toBe(true);

    const ssh2 = new ScriptedSsh().push([9999]);
    // Reuse the same forwarder but a scan that does not list 8251.
    (fwd as unknown as { ssh: SshService }).ssh = ssh2.asService();
    await fwd.refresh();
    await fwd.refresh();
    expect(fwd.snapshot().some((s) => s.destPort === 8251)).toBe(true);
  });
});

describe('local port allocation', () => {
  it('mirrors the remote port when it is free', async () => {
    const ssh = new ScriptedSsh().push([8261]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();
    expect(fwd.snapshot()[0]).toMatchObject({ listenPort: 8261, destPort: 8261, remapped: false });
  });

  it('asks the OS and falls forward to preferred+1 on a real collision', async () => {
    await occupy(8262);
    const ssh = new ScriptedSsh().push([8262]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();
    // Before the bind probe this resolved to 8262, Forwarder.start() returned
    // false, the forward was dropped silently, and the next scan retried the
    // identical port forever.
    expect(fwd.snapshot()[0]).toMatchObject({ listenPort: 8263, destPort: 8262, remapped: true });
  });

  it('reports a port as unavailable when something else holds it', async () => {
    await occupy(8264);
    const fwd = makeForwarder(new ScriptedSsh());
    expect(await fwd.isLocalPortAvailable(8264)).toBe(false);
    expect(await fwd.isLocalPortAvailable(8265)).toBe(true);
  });

  it('rejects out-of-range port numbers without touching the OS', async () => {
    const fwd = makeForwarder(new ScriptedSsh());
    expect(await fwd.isLocalPortAvailable(0)).toBe(false);
    expect(await fwd.isLocalPortAvailable(70000)).toBe(false);
    expect(await fwd.isLocalPortAvailable(1.5)).toBe(false);
  });

  it('sweeps localPortRange when the whole +1..+999 window is taken', async () => {
    const fwd = makeForwarder(new ScriptedSsh(), { localPortRange: [8300, 8310] });
    const seen: number[] = [];
    // Everything in the +1..+999 window is busy; only 8305 is free.
    fwd.isLocalPortAvailable = (port: number): Promise<boolean> => {
      seen.push(port);
      return Promise.resolve(port === 8305);
    };
    expect(await fwd.findAvailableLocalPort(20000)).toBe(8305);
    expect(seen[0]).toBe(20000); // preferred first
    expect(seen[1]).toBe(20001); // then +1
    expect(seen).toContain(8300); // then the sweep from the range floor
  });

  it('stops the +offset walk at 65535 rather than overflowing', async () => {
    const fwd = makeForwarder(new ScriptedSsh(), { localPortRange: [8400, 8400] });
    const seen: number[] = [];
    fwd.isLocalPortAvailable = (port: number): Promise<boolean> => {
      seen.push(port);
      return Promise.resolve(false);
    };
    await fwd.findAvailableLocalPort(65534);
    expect(Math.max(...seen)).toBe(65535);
  });

  it('returns null on exhaustion instead of throwing', async () => {
    // REGRESSION: allocateLocalPort used to `throw` from inside an un-awaited
    // `void this.scanAndForward()` in setInterval — an unhandled rejection
    // that killed the scan loop.
    const fwd = makeForwarder(new ScriptedSsh(), { localPortRange: [8500, 8510] });
    fwd.isLocalPortAvailable = () => Promise.resolve(false);
    await expect(fwd.findAvailableLocalPort(9000)).resolves.toBeNull();
  });

  it('records exhaustion as a reported failure and keeps scanning', async () => {
    const ssh = new ScriptedSsh().push([8600]);
    const fwd = makeForwarder(ssh, { localPortRange: [8700, 8701] });
    fwd.isLocalPortAvailable = () => Promise.resolve(false);

    await expect(fwd.refresh()).resolves.toBeUndefined();
    expect(fwd.snapshot()).toHaveLength(0);
    const row = fwd.discovered().find((p) => p.port === 8600);
    expect(row?.forwarded).toBe(false);
    expect(row?.lastError).toBe('no free local port for remote 8600');
    // The loop is alive: a second scan still runs and still reports.
    await expect(fwd.refresh()).resolves.toBeUndefined();
    expect(fwd.getStatus().lastScanOk).toBe(true);
  });

  it('honours a user remap over the mirror', async () => {
    const ssh = new ScriptedSsh().push([9840]);
    const fwd = new AutoForwarder(ssh.asService(), 'conn-1', registry, {
      config: DEFAULT_AUTO_CONFIG,
      remappings: { 9840: 8801 },
    });
    forwarders.push(fwd);
    await fwd.refresh();
    expect(fwd.snapshot()[0]).toMatchObject({
      listenPort: 8801,
      destPort: 9840,
      remapped: true,
    });
  });

  it('needs force-on as well as a remap for a port above maxAutoPort', async () => {
    // The Python's headline line is `Forwarding remote port 19840 -> local
    // port 3000`, but 19840 is above max_auto_port, so it only happens after
    // the user toggles it on. A remap alone changes the port CHOICE, not the
    // policy decision.
    const ssh = new ScriptedSsh().push([19840]);
    const fwd = new AutoForwarder(ssh.asService(), 'conn-1', registry, {});
    forwarders.push(fwd);
    // The remap target must be a port this machine can actually bind — the
    // Python's headline 3000 is a popular dev port and is not always free.
    const local = await fwd.findAvailableLocalPort(3000);
    expect(local).not.toBeNull();
    await fwd.setRemap(19840, local!);

    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(0);

    await fwd.setIntent(19840, 'force-on');
    expect(fwd.snapshot()[0]).toMatchObject({ listenPort: local, destPort: 19840 });
  });
});

describe('failed-port TTL', () => {
  it('does not retry a failed port until the TTL expires', async () => {
    const ssh = new ScriptedSsh().push([8901]);
    const fwd = makeForwarder(ssh, { localPortRange: [8902, 8903], failedPortTtlMs: 60_000 });
    let allow = false;
    fwd.isLocalPortAvailable = (port: number) => Promise.resolve(allow && port === 8901);

    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(0);

    // The port is now bindable, but the failure is still fresh.
    allow = true;
    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(0);
  });

  it('retries once the TTL has passed (the Python never does)', async () => {
    const ssh = new ScriptedSsh().push([8911]);
    const fwd = makeForwarder(ssh, { localPortRange: [8912, 8913], failedPortTtlMs: 0 });
    let allow = false;
    fwd.isLocalPortAvailable = (port: number) => Promise.resolve(allow && port === 8911);

    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(0);
    allow = true;
    await fwd.refresh();
    expect(fwd.snapshot().map((s) => s.listenPort)).toEqual([8911]);
  });
});

describe('policy', () => {
  it('skips privileged ports and anything above maxAutoPort, but shows them', async () => {
    const ssh = new ScriptedSsh().push([22, 8971, 19840]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([8971]);
    // Ports outside the policy must still reach the UI so the user can
    // toggle them on (forwarder.py:1053).
    expect(fwd.discovered().map((p) => ({ port: p.port, eligible: p.eligible }))).toEqual([
      { port: 22, eligible: false },
      { port: 8971, eligible: true },
      { port: 19840, eligible: false },
    ]);
  });

  it('forwards maxAutoPort itself (the boundary is inclusive)', async () => {
    const ssh = new ScriptedSsh().push([10_000, 10_001]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([10_000]);
  });

  it('honours the extra skipPorts list', async () => {
    const ssh = new ScriptedSsh().push([8981, 8982]);
    const fwd = makeForwarder(ssh, { skipPorts: [8981] });
    await fwd.refresh();
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([8982]);
  });

  it('force-on forwards a port the range policy would skip', async () => {
    const ssh = new ScriptedSsh().push([19841]);
    const fwd = makeForwarder(ssh);
    await fwd.setIntent(19841, 'force-on');
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([19841]);
  });

  it('force-off turns OFF a port the range policy forwards', async () => {
    // The old togglePort could only ADD to a `manual` set, so a port the auto
    // policy already forwarded could never be turned off from the UI.
    const ssh = new ScriptedSsh().push([8991]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(1);

    await fwd.togglePort(8991);
    expect(fwd.snapshot()).toHaveLength(0);
    await fwd.refresh();
    expect(fwd.snapshot()).toHaveLength(0); // and it stays off

    await fwd.togglePort(8991);
    expect(fwd.snapshot().map((s) => s.destPort)).toEqual([8991]);
  });

  it('excludes ports owned by an ssh-config LocalForward', async () => {
    const ssh = new ScriptedSsh().push([9101]);
    const fwd = new AutoForwarder(ssh.asService(), 'conn-1', registry, {
      configForwards: [
        {
          kind: 'local',
          listenHost: '127.0.0.1',
          listenPort: 9101,
          destHost: '127.0.0.1',
          destPort: 9101,
        },
      ],
    });
    forwarders.push(fwd);
    await fwd.refresh();
    // SSH itself owns that local port (forwarder.py:916-922), so the auto
    // policy must not race it.
    expect(fwd.snapshot().filter((s) => s.origin === 'auto')).toHaveLength(0);
  });

  it('suspend keeps names, remaps and intents but drops live forwards', async () => {
    const ssh = new ScriptedSsh().push([9201]);
    const fwd = makeForwarder(ssh);
    await fwd.refresh();
    fwd.setName(9201, 'admin UI');
    expect(fwd.snapshot()[0]?.name).toBe('admin UI');

    fwd.suspend();
    expect(fwd.snapshot()).toHaveLength(0);

    await fwd.refresh();
    expect(fwd.snapshot()[0]?.name).toBe('admin UI');
  });
});

describe('forward metadata', () => {
  it('carries the scanned process name onto the forward state', async () => {
    const ssh = {
      hostPlatform: (_id: string) => Promise.resolve('posix'),
      exec: (_id: string, command: string) => {
        if (/readlink/.test(command)) {
          return Promise.resolve({ stdout: '1812\t/srv/app\n', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({
          stdout: [
            '<<<PS_SS_TLN>>>',
            'LISTEN 0 128 0.0.0.0:9301 0.0.0.0:*',
            '<<<PS_SS_TLNP>>>',
            'LISTEN 0 128 0.0.0.0:9301 0.0.0.0:* users:(("gunicorn",pid=1812,fd=5))',
            '<<<PS_NETSTAT_TLNP>>>',
            '<<<PS_NETSTAT_TLN>>>',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        });
      },
    } as unknown as SshService;
    const fwd = new AutoForwarder(ssh, 'conn-1', registry);
    forwarders.push(fwd);
    await fwd.refresh();
    expect(fwd.snapshot()[0]).toMatchObject({
      destPort: 9301,
      process: 'gunicorn',
      cwd: '/srv/app',
      origin: 'auto',
    });
  });
});
