import { connect, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';
import { Forwarder, forwardKey } from '@main/portfwd/Forwarder';

/**
 * Byte-direction accounting and the shared `'tcp'` dispatcher — the two
 * Forwarder-level defects fixed along the way:
 *
 *  - `bytesIn`/`bytesOut` were swapped relative to the panel's In/Out headers
 *    (`Forwarder.ts:210-216` vs `PortPanelView.vue:98`);
 *  - a `client.on('tcp')` handler was registered PER remote forward on the
 *    shared ssh2 client, so N remote forwards processed every inbound channel
 *    N times.
 */

const started: Forwarder[] = [];
afterEach(async () => {
  for (const f of started.splice(0)) await f.stop();
});

/** A duplex standing in for an ssh2 channel: writes sink, pushes emit. */
class FakeChannel extends Duplex {
  readonly written: Buffer[] = [];
  constructor() {
    super();
  }
  _read(): void {
    /* pushed manually */
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.written.push(Buffer.from(chunk));
    cb();
  }
  /** Simulate bytes arriving from the remote service. */
  fromRemote(text: string): void {
    this.push(Buffer.from(text));
  }
}

/** Registry double whose client hands back a controllable channel. */
function registryWithChannel(channel: FakeChannel): ConnectionRegistry {
  return {
    get: () => ({
      client: {
        forwardOut: (
          _sh: string,
          _sp: number,
          _dh: string,
          _dp: number,
          cb: (err: Error | null, ch: FakeChannel) => void,
        ) => cb(null, channel),
      },
    }),
  } as unknown as ConnectionRegistry;
}

function nextTickish(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe('byte direction', () => {
  it('counts local->remote as bytesOut and remote->local as bytesIn', async () => {
    const channel = new FakeChannel();
    const f = new Forwarder(registryWithChannel(channel), 'c1', {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 8461,
      destHost: '127.0.0.1',
      destPort: 80,
    });
    started.push(f);
    expect(await f.start()).toBe(true);

    const client: Socket = await new Promise((resolve) => {
      const s = connect({ port: 8461, host: '127.0.0.1' }, () => resolve(s));
    });

    client.write('GET / HTTP/1.0\r\n'); // 16 bytes UP
    await nextTickish();
    channel.fromRemote('HTTP/1.0 200 OK'); // 15 bytes DOWN
    await nextTickish();

    const state = f.snapshot();
    // "Out" is what we sent to the remote; "In" is what came back. Before the
    // fix these were the other way round and the panel's columns lied.
    expect(state.bytesOut).toBe(16);
    expect(state.bytesIn).toBe(15);
    expect(channel.written.map((b) => b.toString()).join('')).toBe('GET / HTTP/1.0\r\n');

    client.destroy();
  });

  it('reports rates once enough time has elapsed to divide by', async () => {
    const channel = new FakeChannel();
    const f = new Forwarder(registryWithChannel(channel), 'c1', {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 8462,
      destHost: '127.0.0.1',
      destPort: 80,
    });
    started.push(f);
    await f.start();
    // Two snapshots in quick succession must NOT divide by a near-zero
    // interval and report an absurd spike.
    const a = f.snapshot();
    const b = f.snapshot();
    expect(a.rateIn).toBe(0);
    expect(b.rateIn).toBe(0);
    expect(Number.isFinite(b.rateOut)).toBe(true);
  });
});

describe('remote (-R) channel dispatch', () => {
  /** ssh2 Client double recording how many 'tcp' listeners get attached. */
  function fakeClient(): {
    client: unknown;
    tcpListeners: ((info: unknown, accept: () => unknown, deny: () => void) => void)[];
    unforwarded: string[];
  } {
    const tcpListeners: ((info: unknown, accept: () => unknown, deny: () => void) => void)[] = [];
    const unforwarded: string[] = [];
    const client = {
      on: (event: string, listener: (i: unknown, a: () => unknown, d: () => void) => void) => {
        if (event === 'tcp') tcpListeners.push(listener);
        return client;
      },
      forwardIn: (host: string, port: number, cb: (e: Error | null, p: number) => void) =>
        cb(null, port),
      unforwardIn: (host: string, port: number, cb: () => void) => {
        unforwarded.push(`${host}:${port}`);
        cb();
      },
    };
    return { client, tcpListeners, unforwarded };
  }

  it('registers ONE tcp listener per client no matter how many -R forwards', async () => {
    const { client, tcpListeners } = fakeClient();
    const registry = { get: () => ({ client }) } as unknown as ConnectionRegistry;

    const specs = [9001, 9002, 9003].map((port) => ({
      kind: 'remote' as const,
      listenHost: '0.0.0.0',
      listenPort: port,
      destHost: '0.0.0.0',
      destPort: port,
    }));
    for (const spec of specs) {
      const f = new Forwarder(registry, 'c1', spec);
      started.push(f);
      expect(await f.start()).toBe(true);
    }
    // Previously this was 3, and every inbound channel was handled 3 times.
    expect(tcpListeners).toHaveLength(1);
  });

  it('routes each inbound channel to exactly the forward that bound it', async () => {
    const { client, tcpListeners } = fakeClient();
    const registry = { get: () => ({ client }) } as unknown as ConnectionRegistry;

    const forwards = await Promise.all(
      [9011, 9012].map(async (port) => {
        const f = new Forwarder(registry, 'c1', {
          kind: 'remote',
          listenHost: '0.0.0.0',
          listenPort: port,
          destHost: '0.0.0.0',
          destPort: port,
        });
        started.push(f);
        await f.start();
        return f;
      }),
    );

    const accepted: number[] = [];
    const makeChannel = (port: number): FakeChannel => {
      accepted.push(port);
      return new FakeChannel();
    };
    let denied = 0;

    const dispatch = tcpListeners[0]!;
    dispatch({ destIP: '0.0.0.0', destPort: 9011 }, () => makeChannel(9011), () => denied++);
    expect(accepted).toEqual([9011]);

    dispatch({ destIP: '0.0.0.0', destPort: 9012 }, () => makeChannel(9012), () => denied++);
    expect(accepted).toEqual([9011, 9012]);

    // Nothing bound 9999 -> denied, not silently accepted by every forward.
    dispatch({ destIP: '0.0.0.0', destPort: 9999 }, () => makeChannel(9999), () => denied++);
    expect(denied).toBe(1);
    expect(accepted).toEqual([9011, 9012]);

    // Stopping one forward unregisters only that forward's route.
    await forwards[0]!.stop();
    dispatch({ destIP: '0.0.0.0', destPort: 9011 }, () => makeChannel(9011), () => denied++);
    expect(denied).toBe(2);
  });
});

describe('ForwardState identity', () => {
  it('exposes the same key the renderer computes from the state fields', async () => {
    const f = new Forwarder({ get: () => undefined } as unknown as ConnectionRegistry, 'c1', {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 8471,
      destHost: '127.0.0.1',
      destPort: 3000,
    });
    started.push(f);
    await f.start();
    const s = f.snapshot();
    expect(s.key).toBe(`${s.kind}:${s.listenPort}->${s.destHost}:${s.destPort}`);
    expect(s.key).toBe(forwardKey(f.spec));
    expect(s.remapped).toBe(true); // 8471 != 3000
    expect(s.origin).toBe('manual');
  });
});

describe('stop() with a live connection', () => {
  it('ends a live proxied connection instead of waiting it out', async () => {
    const channel = new FakeChannel();
    const f = new Forwarder(registryWithChannel(channel), 'c1', {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 8463,
      destHost: '127.0.0.1',
      destPort: 80,
    });
    started.push(f);
    expect(await f.start()).toBe(true);

    // The keep-alive case: a connection the client never closes. `server.close()`
    // waits for every live connection to end on its own, and with the idle
    // reaper's hour as the only other exit, `stop()` used to hang for exactly
    // that long behind one of these — a stopPass inside a scan pass, a
    // stopAuto on disconnect.
    const client: Socket = await new Promise((resolve) => {
      const s = connect({ port: 8463, host: '127.0.0.1' }, () => resolve(s));
    });
    // The stop destroys the forward's side of this connection mid-flight, so
    // the OS may answer with a reset instead of an EOF — delivered to this
    // socket as an ECONNRESET on read. That is the teardown working, not a
    // failure, and without a listener the 'error' event surfaces as an
    // unhandled exception after the test has passed (observed on macOS, where
    // destroy-with-pending-data resets reliably).
    client.on('error', () => {});
    const clientClosed = new Promise<void>((resolve) => client.once('close', resolve));

    const timeout = (ms: number): Promise<'pending'> =>
      new Promise((r) => setTimeout(() => r('pending'), ms));
    const settled = await Promise.race([
      f.stop().then(() => 'stopped' as const),
      timeout(250),
    ]);
    expect(settled).toBe('stopped');
    // And the connection itself was ended by the stop, not left hanging.
    await clientClosed;
    client.destroy();
  });
});
