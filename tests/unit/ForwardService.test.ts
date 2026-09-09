import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshService, CloseReason } from '../../src/main/ssh/SshService';
import { ConnectionRegistry } from '../../src/main/ssh/ConnectionRegistry';
import { ForwardService } from '../../src/main/portfwd/ForwardService';
import { MemoryBackend, PortfwdStore } from '../../src/main/portfwd/PortfwdStore';
import type { ForwardState } from '../../src/main/portfwd/Forwarder';

/**
 * ForwardService's own logic sits between the IPC verbs and the AutoForwarder:
 * the reconnect policy on connection close, the persistence round-trip through
 * PortfwdStore, and the lazy `ensure` that lets a cold panel force one port on.
 * The AutoForwarder scan policy is unit-tested in AutoForwarder.test.ts; here
 * the scan itself is just a scriptable exec.
 */
class ScriptedSsh {
  private closeListeners = new Set<(connectionId: string, reason: CloseReason) => void>();

  onCloseConnection(listener: (connectionId: string, reason: CloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(connectionId: string, reason: CloseReason): void {
    for (const l of this.closeListeners) l(connectionId, reason);
  }

  exec(_id: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (/readlink/.test(command)) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }
    const rows = this.scanPorts.map((p) => `LISTEN 0 128 0.0.0.0:${p} 0.0.0.0:*`);
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

  scanPorts: number[] = [];

  asService(): SshService {
    return this as unknown as SshService;
  }
}

function makeService(ssh: ScriptedSsh, store: PortfwdStore): ForwardService {
  return new ForwardService(ssh.asService(), new ConnectionRegistry(), store);
}

/** A port the OS has just released — Windows reserves whole ranges, so a
 *  hard-coded listen port can land in an excluded block and fail to bind. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe('ForwardService connection lifetime', () => {
  let service: ForwardService | undefined;

  afterEach(() => {
    service?.dispose();
    service = undefined;
  });

  it('keeps the host auto-forward preference across a lost transport', () => {
    const ssh = new ScriptedSsh();
    const store = new PortfwdStore(new MemoryBackend());
    service = makeService(ssh, store);

    service.startAuto('conn-1');
    ssh.close('conn-1', 'lost');

    // The renderer's reconnect path reads this preference using the new
    // connection id and starts the engine before the Ports panel is opened.
    expect(store.read('conn-1').autoEnabled).toBe(true);
  });

  it('a lost transport suspends the forwarder but keeps it for the reconnect', () => {
    const ssh = new ScriptedSsh();
    service = makeService(ssh, new PortfwdStore(new MemoryBackend()));

    service.startAuto('conn-1');
    ssh.close('conn-1', 'lost');

    expect(service.status('conn-1')).not.toBeNull();
    expect(service.list('conn-1')).toEqual([]);
  });

  it('a clean disconnect tears the forwarder down entirely', () => {
    const ssh = new ScriptedSsh();
    service = makeService(ssh, new PortfwdStore(new MemoryBackend()));

    service.startAuto('conn-1');
    ssh.close('conn-1', 'user');

    expect(service.status('conn-1')).toBeNull();
  });

  it('connection close clears the visible state for the panel', async () => {
    const ssh = new ScriptedSsh();
    ssh.scanPorts = [3000];
    service = makeService(ssh, new PortfwdStore(new MemoryBackend()));
    const seen: { id: string; states: ForwardState[] }[] = [];
    service.onStates((id, states) => seen.push({ id, states }));

    service.startAuto('conn-1');
    await vi.waitFor(() => expect(service!.list('conn-1').length).toBeGreaterThan(0));
    ssh.close('conn-1', 'lost');

    expect(seen.at(-1)).toEqual({ id: 'conn-1', states: [] });
  });

  it('stopAuto answers false to isAutoEnabled and broadcasts the empty list', () => {
    const ssh = new ScriptedSsh();
    service = makeService(ssh, new PortfwdStore(new MemoryBackend()));
    const listener = vi.fn();
    service.onStates(listener);

    service.startAuto('conn-1');
    service.stopAuto('conn-1');

    expect(service.isAutoEnabled('conn-1')).toBe(false);
    expect(listener).toHaveBeenCalledWith('conn-1', []);
  });

  it('dispose stops every forwarder and detaches the close subscription', () => {
    const ssh = new ScriptedSsh();
    const store = new PortfwdStore(new MemoryBackend());
    service = makeService(ssh, store);

    service.startAuto('conn-1');
    service.startAuto('conn-2');
    service.dispose();
    service = undefined;

    expect(() => ssh.close('conn-1', 'lost')).not.toThrow();
    expect(store.read('conn-1').autoEnabled).toBe(false);
    expect(store.read('conn-2').autoEnabled).toBe(false);
  });
});

describe('ForwardService persistence round-trip', () => {
  let service: ForwardService | undefined;

  afterEach(() => {
    service?.dispose();
    service = undefined;
  });

  it('restores names and remaps from the store when the engine starts', async () => {
    const ssh = new ScriptedSsh();
    ssh.scanPorts = [8080];
    const store = new PortfwdStore(new MemoryBackend());
    store.setName('conn-1', 8080, 'dev server');
    store.setRemap('conn-1', 8080, 9090);
    service = makeService(ssh, store);

    service.startAuto('conn-1');
    await vi.waitFor(() => expect(service!.list('conn-1').length).toBeGreaterThan(0));

    const state = service.list('conn-1')[0]!;
    expect(state.name).toBe('dev server');
    expect(state.listenPort).toBe(9090);
  });

  it('setIntent from a cold panel lazily starts the engine and persists', async () => {
    const ssh = new ScriptedSsh();
    const store = new PortfwdStore(new MemoryBackend());
    service = makeService(ssh, store);

    expect(service.status('conn-1')).toBeNull();
    await service.setIntent('conn-1', 5432, 'force-on');

    expect(service.status('conn-1')).not.toBeNull();
    expect(store.read('conn-1').forceOn).toContain(5432);
  });

  it('togglePort persists the intent the flip landed on', async () => {
    const ssh = new ScriptedSsh();
    ssh.scanPorts = [3000];
    const store = new PortfwdStore(new MemoryBackend());
    service = makeService(ssh, store);

    // The flip's persistence reads the LAST COMPLETED scan's annotations, so
    // each leg has to wait for the forwarder's async scan to settle.
    await service.togglePort('conn-1', 3000);
    await vi.waitFor(() => expect(store.read('conn-1').forceOn).toContain(3000));
    await vi.waitFor(() => expect(service!.list('conn-1').length).toBeGreaterThan(0));

    await service.togglePort('conn-1', 3000);
    await vi.waitFor(() => expect(store.read('conn-1').forceOff).toContain(3000));
  });

  it('togglePort on a port no scan has seen persists no intent', async () => {
    const ssh = new ScriptedSsh();
    const store = new PortfwdStore(new MemoryBackend());
    service = makeService(ssh, store);

    await service.togglePort('conn-1', 4567);
    expect(store.read('conn-1')).toMatchObject({ forceOn: [], forceOff: [] });
  });

  it('isAutoEnabled falls back to the persisted preference once stopped', () => {
    const ssh = new ScriptedSsh();
    const store = new PortfwdStore(new MemoryBackend());
    store.setAutoEnabled('conn-1', true);
    service = makeService(ssh, store);

    // No forwarder in the map — the answer comes from the store, which is
    // what lets a reconnecting panel restore its toggle.
    expect(service.isAutoEnabled('conn-1')).toBe(true);

    service.startAuto('conn-1');
    expect(service.isAutoEnabled('conn-1')).toBe(true);
    service.stopAuto('conn-1');
    expect(service.isAutoEnabled('conn-1')).toBe(false);
  });

  it('addManual works before auto-forwarding was ever turned on', async () => {
    const ssh = new ScriptedSsh();
    const store = new PortfwdStore(new MemoryBackend());
    service = makeService(ssh, store);

    const opened = await service.addManual('conn-1', {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      destHost: '127.0.0.1',
      destPort: 5432,
    });
    expect(opened).toBe(true);
    expect(service.status('conn-1')).not.toBeNull();
  });
});
