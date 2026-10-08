import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import { Server, utils } from 'ssh2';
import { SshService } from '../../src/main/ssh/SshService';

vi.mock('../../src/main/log', () => ({ log: vi.fn() }));

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const parsed = utils.parseKey(privateKey);
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Expected one generated host key');
const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

async function endpoint() {
  const auth = vi.fn();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => undefined);
    cleanup.push(() => client.end());
    client.on('authentication', (context) => {
      auth(context.method);
      if (context.method === 'publickey') context.accept(); else context.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      accept().on('exec', (acceptExec) => {
        const channel = acceptExec();
        channel.write('gateway-end-to-end-sentinel\n');
        channel.exit(0);
        channel.end();
      });
    }));
  });
  cleanup.push(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No SSH endpoint address');
  const sock = connect(address.port, '127.0.0.1');
  cleanup.push(() => sock.destroy());
  await once(sock, 'connect');
  return { sock, auth };
}

describe('gateway SSH fingerprint verification', () => {
  it('runs a real SSH exec when the independently provisioned fingerprint matches', async () => {
    const { sock } = await endpoint();
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'win35-gateway', user: 'User', sock,
      gatewayHostKeyFingerprint: fingerprint, privateKey, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    if (!result.connectionId) throw new Error(result.error);
    cleanup.push(() => ssh.close(result.connectionId!));
    expect(await ssh.exec(result.connectionId, 'echo sentinel')).toMatchObject({
      stdout: 'gateway-end-to-end-sentinel\n', exitCode: 0,
    });
  });

  it('rejects a substituted host key before any user authentication', async () => {
    const { sock, auth } = await endpoint();
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'win35-gateway', user: 'User', sock,
      gatewayHostKeyFingerprint: `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`,
      privateKey, timeoutMs: 3000 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('host key mismatch');
    expect(auth).not.toHaveBeenCalled();
  });

  it('requires a valid local pin before loading a user key or speaking SSH', async () => {
    const { sock, auth } = await endpoint();
    const result = await new SshService().connect({ host: 'private', user: 'User', sock });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fingerprint is required');
    expect(auth).not.toHaveBeenCalled();
  });
});
