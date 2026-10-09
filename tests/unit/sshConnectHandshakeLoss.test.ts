import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils as sshUtils, type Client } from 'ssh2';

/**
 * desktop#8 follow-up: a host that accepts TCP and then drops the socket
 * before the SSH handshake must turn into ONE rejected connect, never an
 * unhandled 'error' on the ssh2 Client.
 *
 * ssh2 can emit 'error' twice for that drop: the socket's own error (a reset:
 * ECONNRESET) and then, on the socket's close, "Connection lost before
 * handshake". With only a `once('error')` handler the second emission had no
 * listener, so EventEmitter threw it as an uncaught exception — in Electron's
 * main process that is the app-wide crash dialog. A reset (RST) makes the
 * double emission deterministic on every platform; a plain FIN close (what
 * Linux usually delivered for `socket.destroy()`) emits only once, which is
 * why ubuntu CI stayed green while macOS/Windows caught it.
 */

const { clients } = vi.hoisted(() => ({ clients: [] as Client[] }));
vi.mock('../../src/main/ssh/ConnectionRegistry', async (orig) => {
  const real = await orig<typeof import('../../src/main/ssh/ConnectionRegistry')>();
  return {
    ...real,
    newClient: () => {
      const c = real.newClient();
      clients.push(c);
      return c;
    },
  };
});

const { SshService } = await import('../../src/main/ssh/SshService');

let dir = '';
let keyPath = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop8-handshake-'));
  keyPath = join(dir, 'id_ed25519');
  writeFileSync(keyPath, sshUtils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);
afterEach(() => {
  process.off('uncaughtException', onUncaught);
  uncaught.length = 0;
  clients.length = 0;
});

/** A listener that accepts, then drops each socket the way `drop` says. */
async function listen(drop: (s: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(drop);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

/**
 * Resolve once the dialled client has fully closed — every error it will emit
 * is out — or an uncaught error was seen (the bug throws INSIDE the socket's
 * close handler, before the client's own 'close' is emitted).
 */
const closed = (c: Client) =>
  new Promise<void>((r) => {
    c.once('close', () => r());
    const poll = setInterval(() => {
      if (uncaught.length > 0) {
        clearInterval(poll);
        r();
      }
    }, 10);
    c.once('close', () => clearInterval(poll));
  });

describe('SshService.connect: a socket dropped before the handshake', () => {
  it.each([
    // Drop only once the client is connected (its SSH ident arrived): a drop
    // during the TCP connect is a single ECONNREFUSED/ECONNRESET, not the
    // double emission.
    ['reset (RST) after connect', (s: Socket) => s.once('data', () => s.resetAndDestroy())],
    ['close (FIN) after connect', (s: Socket) => s.once('data', () => s.destroy())],
  ])('%s: resolves ok:false with one clear error and leaves no unhandled error', async (_l, drop) => {
    process.on('uncaughtException', onUncaught);
    const { server, port } = await listen(drop);
    try {
      const ssh = new SshService();
      const res = await ssh.connect({ host: '127.0.0.1', port, user: 'me', privateKeyPath: keyPath, timeoutMs: 5000 });
      expect(clients).toHaveLength(1);
      await closed(clients[0]!);
      // Let any emission queued behind 'close' run before judging.
      await new Promise((r) => setTimeout(r, 50));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Connection (reset|lost before handshake)/);
      expect(uncaught).toEqual([]);
    } finally {
      server.close();
    }
  });
});
