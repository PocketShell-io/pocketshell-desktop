import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { openGatewayStream } from '../../src/main/ssh/GatewayStream';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function gateway() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('No test gateway address');
  return { server, target: { deviceId: 'win35', serverUrl: `ws://127.0.0.1:${address.port}` } };
}

describe('gateway stream', () => {
  it('rejects coalesced ready and invalid text without an unowned stream error', async () => {
    const { server, target } = await gateway();
    server.on('connection', (peer) => peer.once('message', () => {
      const transport = (peer as unknown as { _socket: Socket })._socket;
      transport.cork();
      peer.send(JSON.stringify({ type: 'ready', v: 1, device_id: 'win35', ssh_host_key: '' }));
      peer.send('unexpected-text');
      transport.uncork();
    }));
    await expect(openGatewayStream(target, 'test', { allowInsecureWs: true })).rejects.toThrow('Expected binary');
  });
  it('admits through text auth then carries opaque SSH bytes in both directions', async () => {
    const { server, target } = await gateway();
    const connected = once(server, 'connection');
    const opened = openGatewayStream(target, 'test-account-token', { allowInsecureWs: true });
    const [peer, request] = await connected as [WebSocket, IncomingMessage];
    const [auth, binary] = await once(peer, 'message') as [Buffer, boolean];
    expect(request.url).toBe('/api/v1/hosts/win35/ssh');
    expect(request.url).not.toContain('token');
    expect(binary).toBe(false);
    expect(JSON.parse(auth.toString())).toEqual({ type: 'auth', v: 1, device_id: 'win35', token: 'test-account-token' });
    peer.send(JSON.stringify({ type: 'ready', v: 1, device_id: 'win35', ssh_host_key: 'advisory-only' }));
    const stream = await opened;
    const inbound = once(stream, 'data');
    peer.send(Buffer.from('SSH-2.0-host\r\n'));
    expect((await inbound as [Buffer])[0].toString()).toBe('SSH-2.0-host\r\n');
    const outbound = once(peer, 'message');
    stream.write(Buffer.from([0, 255, 1, 13]));
    const [bytes, isBinary] = await outbound as [Buffer, boolean];
    expect(isBinary).toBe(true);
    expect(Buffer.from(bytes)).toEqual(Buffer.from([0, 255, 1, 13]));
    stream.destroy();
  });

  it.each(['another-host', ''])('rejects a ready frame aimed at another device (%s)', async (deviceId) => {
    const { server, target } = await gateway();
    server.on('connection', (peer) => peer.on('message', () => {
      peer.send(JSON.stringify({ type: 'ready', v: 1, device_id: deviceId, ssh_host_key: '' }));
    }));
    await expect(openGatewayStream(target, 'test', { allowInsecureWs: true })).rejects.toThrow('different device');
  });

  it('refuses plaintext WebSocket without explicit development opt-in', async () => {
    const { target } = await gateway();
    await expect(openGatewayStream(target, 'test')).rejects.toThrow('refusing unencrypted');
  });

  it('reports an offline host close before SSH can begin', async () => {
    const { server, target } = await gateway();
    server.on('connection', (peer) => peer.on('message', () => peer.close(4503)));
    await expect(openGatewayStream(target, 'test', { allowInsecureWs: true })).rejects.toThrow('not connected');
  });
});
