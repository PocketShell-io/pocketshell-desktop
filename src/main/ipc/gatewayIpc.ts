import { ipcMain, app } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  GATEWAY_DEFAULT_SERVER_URL,
  isValidGatewayDeviceId,
  normalizeGatewayTarget,
  parseGatewayHostPin,
  type GatewayAddDeviceRequest,
  type GatewayAddDeviceResult,
} from '@pocketshell/core';
import type { IpcContext } from './context.js';
import { ipc } from '../../shared/channels.js';
import { readGatewayPairings, writeGatewayPairing } from '../ssh/GatewayHosts.js';
import {
  createGatewayClientKey,
  listGatewayClientKeys,
  publicKeyFingerprint,
  resolveGatewayKeyPath,
} from '../ssh/GatewayClientKeys.js';
import { decodeIdTokenPayload } from '../sync/GoogleAuth.js';

/**
 * The gateway directory (PocketShellApi['gateway']): the account's enrolled
 * devices as the gateway lists them, this client's saved pairings, the SSH
 * client keys a pairing can pin, and the enrollment an "Add device" writes.
 *
 * Trust boundaries here: the routing token lives in ctx.gateway/ctx.sync and
 * never crosses this bridge; the host-key pin is ONLY what the user pasted
 * (the device list's advisory key is a hint the renderer compares, never
 * stored); and the enrollment file is the same hand-provisionable trust
 * store the dial path reads (docs/gateway.md) — a UI pairing is simply a
 * first-class way to write it.
 */

/** The desktop's one pairing-of-record store layout, under userData. */
function gatewayPaths(): { enrollment: string; registry: string; managedDir: string; sshDir: string } {
  const userData = app.getPath('userData');
  return {
    enrollment: join(userData, 'gateway-hosts.json'),
    registry: join(userData, 'gateway-keys.json'),
    managedDir: join(userData, 'gateway-keys'),
    sshDir: join(homedir(), '.ssh'),
  };
}

/** The signed-in account's `sub`, or null when there is no usable ID token. */
async function accountSub(ctx: IpcContext): Promise<string | null> {
  try {
    return decodeIdTokenPayload(await ctx.syncAuth.getIdToken()).sub;
  } catch {
    return null;
  }
}

function pairingInvalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'GATEWAY_PAIRING_INVALID' });
}

export function registerGatewayIpc(ctx: IpcContext): void {
  ipcMain.handle(ipc.gateway.devices, (_evt, serverUrl: unknown) => {
    if (typeof serverUrl !== 'string' || serverUrl === '') throw pairingInvalid('Name the gateway to list devices on.');
    return ctx.gateway.devices(serverUrl);
  });

  ipcMain.handle(ipc.gateway.pairings, async () => {
    return readGatewayPairings(gatewayPaths().enrollment, await accountSub(ctx));
  });

  ipcMain.handle(ipc.gateway.clientKeys, () => {
    const paths = gatewayPaths();
    return listGatewayClientKeys({ sshDir: paths.sshDir, registryPath: paths.registry });
  });

  ipcMain.handle(ipc.gateway.createClientKey, (_evt, label: unknown) => {
    if (typeof label !== 'string') throw pairingInvalid('Give the key a name of 1–200 characters.');
    const paths = gatewayPaths();
    return createGatewayClientKey({ managedDir: paths.managedDir, registryPath: paths.registry, label });
  });

  ipcMain.handle(
    ipc.gateway.addDevice,
    async (_evt, request: GatewayAddDeviceRequest): Promise<GatewayAddDeviceResult> => {
      const paths = gatewayPaths();
      const target = normalizeGatewayTarget(request?.gateway);
      if (!target || !isValidGatewayDeviceId(target.deviceId) || target.serverUrl !== GATEWAY_DEFAULT_SERVER_URL) {
        throw pairingInvalid('That device is not on the PocketShell gateway this Desktop pairs with.');
      }
      const pin = parseGatewayHostPin(typeof request?.pin === 'string' ? request.pin : '');
      if (!pin) throw pairingInvalid('Paste the device\'s host key line (`pocketshell gateway show --host-key`) or its SHA256: fingerprint.');
      const fingerprint = pin.kind === 'host-key' ? publicKeyFingerprint(pin.line) : pin.fingerprint;
      if (fingerprint === null) throw pairingInvalid('The pasted host key could not be read.');
      const identityFile = resolveGatewayKeyPath(paths.registry, request?.keyId);
      if (!identityFile) throw Object.assign(new Error('Pick a client key this Desktop can authenticate with.'), { code: 'GATEWAY_PAIRING_KEY_MISSING' });
      const sub = await accountSub(ctx);
      if (sub === null) throw Object.assign(new Error('Sign in to your PocketShell account to pair a gateway device.'), { code: 'NOT_SIGNED_IN' });
      const name = typeof request?.name === 'string' ? request.name.trim() : '';
      const username = typeof request?.username === 'string' ? request.username.trim() : '';
      if (name === '' || username === '') throw pairingInvalid('Give the host a name and the SSH username to connect as.');
      writeGatewayPairing(paths.enrollment, {
        name,
        user: username,
        identityFile,
        gateway: target,
        sshHostKeyFingerprint: fingerprint,
        pinKind: pin.kind,
        keyId: request.keyId,
        accountSub: sub,
      });
      return {
        hostName: name,
        pairing: { serverUrl: target.serverUrl, deviceId: target.deviceId, fingerprint, pinKind: pin.kind, keyId: request.keyId },
      };
    },
  );
}
