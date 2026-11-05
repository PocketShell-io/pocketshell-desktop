import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import {
  buildGatewayAuthFrame,
  classifyGatewayClose,
  gatewaySshUrl,
  GATEWAY_CLOSED_ERROR_CODE,
  GATEWAY_HANDSHAKE_TIMEOUT_MS,
  GATEWAY_MAX_WS_MESSAGE_BYTES,
  isGatewayVerdictCloseCode,
  parseGatewayHandshakeFrame,
  type GatewayTransportTarget,
} from '@pocketshell/core';

/**
 * A handshake close the gateway meant as a verdict (an application close
 * code, 4000–4999). The close code rides the error so the dial's IPC layer
 * can classify it through core's one matrix (classifyGatewayDialFailure)
 * without re-deriving it from prose.
 */
export type GatewayVerdictError = Error & { code: typeof GATEWAY_CLOSED_ERROR_CODE; gatewayCloseCode: number };

function gatewayVerdictError(closeCode: number): GatewayVerdictError {
  return Object.assign(new Error(classifyGatewayClose(closeCode).userMessage), {
    code: GATEWAY_CLOSED_ERROR_CODE,
    gatewayCloseCode: closeCode,
  }) as GatewayVerdictError;
}

/** Real SSH bytes only; account admission happens before ssh2 sees the stream. */
export function openGatewayStream(
  target: GatewayTransportTarget,
  token: string,
  opts: { allowInsecureWs?: boolean } = {},
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(gatewaySshUrl(target, opts), {
      maxPayload: GATEWAY_MAX_WS_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    let ready = false;
    let settled = false;
    const stream = new Duplex({
      read() { socket.resume(); },
      write(chunk: Buffer, _encoding, done) {
        socket.send(chunk, { binary: true }, done);
      },
      final(done) { socket.close(); done(); },
      destroy(error, done) { socket.terminate(); done(error); },
    });
    // Own errors continuously, including ready→ssh2's listener handoff. The
    // consumer still sees the error and .errored; no EventEmitter gap may crash main.
    stream.on('error', () => undefined);
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.terminate();
        stream.destroy();
        reject(error);
      } else if (ready) stream.destroy(error);
    };
    const timer = setTimeout(() => fail(new Error('PocketShell gateway handshake timed out.')),
      GATEWAY_HANDSHAKE_TIMEOUT_MS);
    socket.on('open', () => socket.send(buildGatewayAuthFrame(token, target.deviceId)));
    socket.on('error', fail);
    socket.on('close', (code) => {
      if (!settled) {
        if (isGatewayVerdictCloseCode(code)) fail(gatewayVerdictError(code));
        else fail(new Error(classifyGatewayClose(code).userMessage));
      } else { stream.push(null); stream.destroy(); }
    });
    socket.on('message', (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (!ready) {
        if (binary) { fail(new Error('Expected a gateway ready frame.')); return; }
        const result = parseGatewayHandshakeFrame(bytes.toString('utf8'));
        if (result.kind !== 'ready') {
          fail(new Error(result.kind === 'error' ? result.frame.message : result.reason));
          return;
        }
        if (result.frame.device_id !== target.deviceId) {
          fail(new Error('Gateway answered for a different device.'));
          return;
        }
        ready = true;
        // Drain this receiver turn before handing ownership to ssh2: ready
        // and another frame can be coalesced in the same TCP read.
        setImmediate(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(stream);
        });
        return;
      }
      if (!binary) { fail(new Error('Expected binary SSH bytes from the gateway.')); return; }
      if (!stream.push(bytes)) socket.pause();
    });
  });
}
