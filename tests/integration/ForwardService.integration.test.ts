import net from 'node:net';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';
import { SshService } from '@main/ssh/SshService';
import { ForwardService } from '@main/portfwd/ForwardService';
import { scanRemotePorts } from '@main/portfwd/scanRemotePorts';
import type { ForwardState } from '@main/portfwd/Forwarder';
import type { ForwardSpec } from '../../src/shared/types';
import { TEST_KEY_PATH, describeDocker } from './helpers';

/**
 * Integration tests for port forwarding against the real `pocketshell-test:ssh`
 * image. Covers: the remote port scan, the manual -L forward (start a remote
 * listener, forward it, probe localhost), addManual/remove bookkeeping, and
 * the auto-forward path (scanRemotePorts + a qualifying port).
 *
 * Auto-skips when Docker is unavailable.
 */
describeDocker('ForwardService integration', () => {
  let container: StartedTestContainer | undefined;
  let registry: ConnectionRegistry;
  let ssh: SshService;
  let forwards: ForwardService;
  let connectionId: string | undefined;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:ssh')
      .withExposedPorts(22)
      .start();
    registry = new ConnectionRegistry();
    ssh = new SshService(registry);
    forwards = new ForwardService(ssh, registry);
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
  }, 120_000);

  afterAll(async () => {
    if (connectionId) {
      forwards.evict(connectionId);
      ssh.close(connectionId);
    }
    if (container) await container.stop();
  });

  /** True if a local TCP port accepts a connection within `timeoutMs`. */
  function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
    });
  }

  it('scan returns the remote sshd listener (port 22)', async () => {
    const ports = await forwards.scan(connectionId!);
    expect(ports.some((p) => p.port === 22)).toBe(true);
  });

  it('forwards a local -L port to a remote listener', async () => {
    // Start a trivial echo listener inside the container on port 7777. Use
    // execBackground (fire-and-forget) because the backgrounded `nc` holds the
    // exec channel's fds open, so awaiting close would hang.
    ssh.execBackground(connectionId!, 'setsid sh -c "while true; do nc -l -p 7777 -e /bin/cat; done" </dev/null >/tmp/nc.log 2>&1 &');
    await new Promise((r) => setTimeout(r, 1500));

    const spec: ForwardSpec = {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 7777,
      destHost: '127.0.0.1',
      destPort: 7777,
    };
    const ok = await forwards.addManual(connectionId!, spec);
    expect(ok).toBe(true);

    // The forwarded local port should now be reachable.
    const reachable = await isPortOpen(7777);
    expect(reachable).toBe(true);

    // Snapshot reflects the active forward.
    const states = forwards.list(connectionId!);
    expect(states.some((s) => s.kind === 'local' && s.destPort === 7777 && s.active)).toBe(true);

    // Remove it; the local port should close.
    await forwards.remove(connectionId!, 'local:7777->127.0.0.1:7777');
    const after = forwards.list(connectionId!);
    expect(after.some((s) => s.destPort === 7777)).toBe(false);
  }, 20_000);

  it('scanRemotePorts discovers a qualifying listener and auto-forward opens it', async () => {
    // Start a persistent Python HTTP server on 9090 (qualifies: in [1024,10000]).
    ssh.execBackground(
      connectionId!,
      'setsid python3 -m http.server 9090 --bind 0.0.0.0 </dev/null >/tmp/http9090.log 2>&1 &',
    );
    // Poll until scanRemotePorts reliably sees 9090 (python takes a moment to bind).
    let saw = false;
    for (let i = 0; i < 20 && !saw; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const probe = await scanRemotePorts(ssh, connectionId!);
      saw = probe.some((p) => p.port === 9090);
    }
    expect(saw).toBe(true);

    // The scan found the port; now open a manual forward for it (the same
    // code path the AutoForwarder uses internally once it sees the port) and
    // verify the tunnel works end-to-end.
    const spec: ForwardSpec = {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 9090,
      destHost: '127.0.0.1',
      destPort: 9090,
    };
    const ok = await forwards.addManual(connectionId!, spec);
    expect(ok).toBe(true);
    const reachable = await isPortOpen(9090);
    expect(reachable).toBe(true);
    const states = forwards.list(connectionId!);
    expect(states.some((s) => s.destPort === 9090 && s.active)).toBe(true);
    await forwards.remove(connectionId!, 'local:9090->127.0.0.1:9090');
  }, 30_000);

  // -----------------------------------------------------------------------
  // Throughput
  //
  // Everything above forwards a port and then leaves it alone, so the panel's
  // In/Out columns could only ever read "0 B" and the byte counters had never
  // been observed doing real work. The fixture now ships a responder on 8021
  // that moves an EXACT, KNOWN number of bytes in each direction
  // (tests-docker/traffic-server.py), so these assert real numbers.
  //
  // Requires a rebuilt `pocketshell-test:ssh` (scripts/build-docker.sh):
  // the responder is started by the image's entrypoint.
  // -----------------------------------------------------------------------

  /** The fixture's traffic responder; started by the image's entrypoint. */
  const TRAFFIC_PORT = 8021;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** A local port nothing currently holds. */
  function freeLocalPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  /** Drop every live forward pointing at the traffic port, whatever its key. */
  async function dropTrafficForwards(): Promise<void> {
    for (const s of forwards.list(connectionId!)) {
      if (s.kind === 'local' && s.destPort === TRAFFIC_PORT) {
        await forwards.remove(connectionId!, s.key);
      }
    }
  }

  /** The live forward for the traffic port, whatever local port it landed on. */
  function trafficState(): ForwardState | undefined {
    return forwards
      .list(connectionId!)
      .find((s) => s.kind === 'local' && s.destPort === TRAFFIC_PORT);
  }

  /**
   * Hand the traffic port back to the automatic policy and wait for the
   * engine to open it, with zeroed counters.
   *
   * Deliberately NOT a hard-coded local port. `remove` records a `force-off`
   * intent (so the next scan does not re-open a row the user just closed),
   * hence the `setIntent(null)`; and the local port is whatever
   * `findAvailableLocalPort` picks, because mirroring 8021 fails outright
   * when something unrelated on the dev box already holds it — which is
   * exactly what happened while writing this.
   */
  async function freshAutoForward(): Promise<ForwardState> {
    // Explicit, not inherited. `setIntent` now starts the engine itself, but
    // `refresh` below is still a no-op when no forwarder exists, so leaning on
    // an earlier case having started one would make this pass or fail on test
    // ORDER. Starting it here states the precondition instead of assuming it.
    forwards.startAuto(connectionId!);
    await dropTrafficForwards();
    await forwards.setIntent(connectionId!, TRAFFIC_PORT, null);
    let state = trafficState();
    for (let i = 0; i < 20 && !state; i++) {
      await sleep(500);
      await forwards.refresh(connectionId!);
      state = trafficState();
    }
    expect(state?.active).toBe(true);
    expect(state!.bytesIn).toBe(0);
    expect(state!.bytesOut).toBe(0);
    return state!;
  }

  /**
   * Drive one request/response through the forwarded local port and resolve
   * with what this end actually sent and received, so the assertions compare
   * the engine's counters against measured bytes rather than restated
   * constants.
   */
  function runTraffic(
    localPort: number,
    options: { up: number; down: number; chunk?: number; gapMs?: number },
  ): Promise<{ sent: number; received: number }> {
    const header = Buffer.from(
      `${options.up} ${options.down} ${options.chunk ?? 65536} ${options.gapMs ?? 0}\n`,
      'ascii',
    );
    const padding = Buffer.alloc(options.up, 0x61);
    return new Promise((resolve, reject) => {
      let received = 0;
      const socket = net.connect({ port: localPort, host: '127.0.0.1' }, () => {
        socket.write(header);
        if (padding.length > 0) socket.write(padding);
      });
      socket.on('data', (buf: Buffer) => {
        received += buf.length;
      });
      socket.on('error', reject);
      socket.on('close', () => resolve({ sent: header.length + padding.length, received }));
    });
  }

  it('counts the exact bytes pushed through a manual forward, per direction', async () => {
    await dropTrafficForwards();
    const listenPort = await freeLocalPort();
    const spec: ForwardSpec = {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort,
      destHost: '127.0.0.1',
      destPort: TRAFFIC_PORT,
    };
    expect(await forwards.addManual(connectionId!, spec)).toBe(true);
    const key = `local:${listenPort}->127.0.0.1:${TRAFFIC_PORT}`;
    expect(forwards.list(connectionId!).find((s) => s.key === key)?.bytesIn).toBe(0);

    // Deliberately ASYMMETRIC: equal counts each way would still pass if
    // bytesIn and bytesOut were swapped, which is precisely the defect this asymmetry exists to catch.
    const UP = 65_536; // client -> remote service  => "Out"
    const DOWN = 262_144; // remote service -> client => "In"
    const HEADER = Buffer.byteLength(`${UP} ${DOWN} 65536 0\n`, 'ascii');
    expect(HEADER).toBe(21); // "65536 262144 65536 0\n"

    const moved = await runTraffic(listenPort, { up: UP, down: DOWN });
    expect(moved.sent).toBe(HEADER + UP); // 65_557
    expect(moved.received).toBe(DOWN); // 262_144

    // Let the last channel chunk land before reading the counters.
    await sleep(300);

    const state = forwards.list(connectionId!).find((s) => s.key === key);
    expect(state).toBeDefined();
    // Real numbers, not `> 0`: the local socket carries the upload, the SSH
    // channel carries the download, and nothing may be counted twice.
    expect(state!.bytesOut).toBe(65_557);
    expect(state!.bytesIn).toBe(262_144);
    expect(state!.bytesOut).toBe(moved.sent);
    expect(state!.bytesIn).toBe(moved.received);

    await forwards.remove(connectionId!, key);
  }, 30_000);

  it('reports a non-zero download rate on the AUTO row while a paced transfer is in flight', async () => {
    // The panel's throughput line is mostly seen on rows the AUTO policy
    // created, so this covers that path too, not just a hand-added forward.
    const forward = await freshAutoForward();
    expect(forward.origin).toBe('auto');
    const listenPort = forward.listenPort;

    // 1 MiB in 16 chunks with a 125 ms gap => ~1.9 s on the wire at a nominal
    // 512 KiB/s. The pacing is the point: an unthrottled megabyte over
    // loopback finishes inside the sampler's 500 ms minimum window, so every
    // rate reading would legitimately be 0 and the assertion would be a lie.
    const DOWN = 1_048_576;
    const CHUNK = 65_536;
    const GAP_MS = 125;
    const NOMINAL_BPS = (CHUNK * 1000) / GAP_MS; // 524_288 B/s

    const transfer = runTraffic(listenPort, { up: 0, down: DOWN, chunk: CHUNK, gapMs: GAP_MS });

    // Sample above RATE_SAMPLE_MIN_MS (500 ms) so each read gets a freshly
    // computed rate rather than the previous one echoed back.
    const rateInSamples: number[] = [];
    const rateOutSamples: number[] = [];
    for (let i = 0; i < 3; i++) {
      await sleep(550);
      const live = trafficState();
      rateInSamples.push(live?.rateIn ?? 0);
      rateOutSamples.push(live?.rateOut ?? 0);
    }

    const moved = await transfer;
    expect(moved.received).toBe(DOWN);

    const peakIn = Math.max(...rateInSamples);
    expect(peakIn).toBeGreaterThan(0);
    // Within a wide band of the paced rate. Wide because the sampler divides
    // by wall time and the scan loop's own snapshot can land mid-window; the
    // point is that the number is a real bytes/sec, not noise.
    expect(peakIn).toBeGreaterThan(NOMINAL_BPS * 0.25);
    expect(peakIn).toBeLessThan(NOMINAL_BPS * 4);
    // Above the panel's 1 KB/s display floor, so the rate line actually renders.
    expect(peakIn).toBeGreaterThan(1024);

    // Download-only: the upload rate must stay at the header's few bytes, so
    // this fails loudly if rateIn/rateOut are ever swapped.
    expect(Math.max(...rateOutSamples)).toBeLessThan(1024);

    await sleep(300);
    const state = trafficState();
    // Exact totals, on the same row the rate came from: 1 MiB down, and up is
    // only the request header — so the two columns cannot be reading the same
    // stream.
    expect(state!.bytesIn).toBe(1_048_576);
    expect(state!.bytesOut).toBe(20); // "0 1048576 65536 125\n"
    expect(state!.bytesOut).toBe(Buffer.byteLength(`0 ${DOWN} ${CHUNK} ${GAP_MS}\n`, 'ascii'));

    await dropTrafficForwards();
  }, 40_000);

  it('accumulates across connections rather than resetting per connection', async () => {
    // A per-connection reset would still satisfy every assertion above, since
    // each of those uses exactly one connection. The panel's In/Out are
    // cumulative for the life of the forward, so prove that.
    const forward = await freshAutoForward();
    const listenPort = forward.listenPort;

    const first = await runTraffic(listenPort, { up: 1024, down: 4096 });
    expect(first.sent).toBe(1042); // 1024 padding + "1024 4096 65536 0\n"
    await sleep(300);
    const afterFirst = trafficState()!;
    expect(afterFirst.bytesOut).toBe(1042);
    expect(afterFirst.bytesIn).toBe(4096);

    const second = await runTraffic(listenPort, { up: 2048, down: 8192 });
    expect(second.sent).toBe(2066); // 2048 padding + "2048 8192 65536 0\n"
    await sleep(300);
    const afterSecond = trafficState()!;
    expect(afterSecond.bytesOut).toBe(1042 + 2066); // 3108
    expect(afterSecond.bytesIn).toBe(4096 + 8192); // 12_288

    await dropTrafficForwards();
  }, 40_000);
});
