import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/context';

/**
 * The gateway directory's IPC surface: delegation with validated arguments,
 * the trust rules of addDevice (the pasted pin is the only pin, the key must
 * resolve, the account must be signed in), and the error codes the shared
 * tree's failure classification reads.
 */

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  pairings: vi.fn<(path: string, accountSub: string | null) => unknown>(),
  writePairing: vi.fn<(path: string, record: unknown) => void>(),
  listKeys: vi.fn<(opts: unknown) => unknown>(),
  createKey: vi.fn<(opts: unknown) => unknown>(),
  resolveKey: vi.fn<(registryPath: string, keyId: string) => string | null>(),
  devices: vi.fn<(serverUrl: string) => Promise<unknown>>(),
  getIdToken: vi.fn<() => Promise<string>>(),
}));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/unit-user-data' }, ipcMain: { handle: (c: string, fn: (...args: unknown[]) => Promise<unknown>) => state.handlers.set(c, fn) } }));
vi.mock('../../src/main/ssh/GatewayHosts', () => ({
  readGatewayPairings: (path: string, accountSub: string | null) => state.pairings(path, accountSub),
  writeGatewayPairing: (path: string, record: unknown) => state.writePairing(path, record),
}));
vi.mock('../../src/main/ssh/GatewayClientKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ssh/GatewayClientKeys')>()),
  listGatewayClientKeys: (opts: unknown) => state.listKeys(opts),
  createGatewayClientKey: (opts: unknown) => state.createKey(opts),
  resolveGatewayKeyPath: (registryPath: string, keyId: string) => state.resolveKey(registryPath, keyId),
}));
import { registerGatewayIpc } from '../../src/main/ipc/gatewayIpc';
import { ipc } from '../../src/shared/channels';
import { utils } from 'ssh2';
import type { GatewayAddDeviceRequest } from '@pocketshell/core';

/** A JWT-shaped token whose payload carries the unit account's subject. */
const idToken = ['h', Buffer.from(JSON.stringify({ sub: 'unit-account-sub', email: 'unit@example.invalid' })).toString('base64url'), 's'].join('.');
/** A real ed25519 key line — the pin parser structurally validates the blob. */
const hostKeyPin = utils.generateKeyPairSync('ed25519').public;
const fingerprint = 'SHA256:' + 'a'.repeat(43);
const gateway = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'win35' };

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  // ipcMain.handle turns a synchronous handler throw into a rejected invoke;
  // model that so the handlers' guard clauses are exercised as shipped.
  const handler = state.handlers.get(channel)!;
  return Promise.resolve().then(() => handler({}, ...args));
}
/** The error an invoke rejected with — toMatchObject on an Error compares messages, so codes are asserted by hand. */
async function invokeError(channel: string, ...args: unknown[]): Promise<Error & { code?: string }> {
  return await invoke(channel, ...args).catch((e: unknown) => e) as Error & { code?: string };
}
function addDeviceRequest(overrides: Partial<GatewayAddDeviceRequest> = {}): GatewayAddDeviceRequest {
  return { name: 'win35', username: 'user', gateway, pin: hostKeyPin, keyId: 'C:/Users/unit/.ssh/id_ed', ...overrides };
}
beforeEach(() => {
  for (const mock of [state.pairings, state.writePairing, state.listKeys, state.createKey, state.resolveKey, state.devices, state.getIdToken]) mock.mockReset();
  state.handlers.clear();
  state.getIdToken.mockResolvedValue(idToken);
  state.resolveKey.mockReturnValue('C:/Users/unit/.ssh/id_ed');
  state.devices.mockResolvedValue([]);
  registerGatewayIpc({ gateway: { devices: state.devices }, syncAuth: { getIdToken: state.getIdToken } } as unknown as IpcContext);
});

describe('gateway ipc', () => {
  it('lists devices through the directory client', async () => {
    await invoke(ipc.gateway.devices, 'wss://gateway.pocketshell.io');
    expect(state.devices).toHaveBeenCalledWith('wss://gateway.pocketshell.io');
    await expect(invokeError(ipc.gateway.devices, 42)).resolves.toMatchObject({ code: 'GATEWAY_PAIRING_INVALID' });
    expect(state.devices).toHaveBeenCalledTimes(1);
  });

  it('reads pairings for the signed-in account and the userData enrollment file', async () => {
    state.pairings.mockReturnValueOnce([]);
    await invoke(ipc.gateway.pairings);
    expect(state.pairings).toHaveBeenCalledWith('C:\\unit-user-data\\gateway-hosts.json', 'unit-account-sub');
  });

  it('answers no pairings when there is no usable sign-in', async () => {
    state.getIdToken.mockRejectedValueOnce(new Error('not signed in'));
    await invoke(ipc.gateway.pairings);
    expect(state.pairings).toHaveBeenCalledWith('C:\\unit-user-data\\gateway-hosts.json', null);
  });

  it('lists and creates client keys in the userData key registry', async () => {
    await invoke(ipc.gateway.clientKeys);
    const listed = state.listKeys.mock.calls[0]?.[0] as { sshDir: string; registryPath: string } | undefined;
    expect(listed?.sshDir).toMatch(/[\\/]\.ssh$/);
    expect(listed?.registryPath).toBe('C:\\unit-user-data\\gateway-keys.json');
    await invoke(ipc.gateway.createClientKey, 'work key');
    expect(state.createKey).toHaveBeenCalledWith(expect.objectContaining({ managedDir: 'C:\\unit-user-data\\gateway-keys', registryPath: 'C:\\unit-user-data\\gateway-keys.json', label: 'work key' }));
    const error = await invokeError(ipc.gateway.createClientKey, 42);
    expect(error.code).toBe('GATEWAY_PAIRING_INVALID');
  });

  it('enrolls a pasted host-key pin with the resolved client key and account stamp', async () => {
    const result = await invoke(ipc.gateway.addDevice, addDeviceRequest()) as { hostName: string; pairing: Record<string, unknown> };
    expect(result.hostName).toBe('win35');
    expect(result.pairing).toMatchObject({ serverUrl: gateway.serverUrl, deviceId: gateway.deviceId, pinKind: 'host-key', keyId: 'C:/Users/unit/.ssh/id_ed' });
    expect(result.pairing.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(state.writePairing).toHaveBeenCalledWith('C:\\unit-user-data\\gateway-hosts.json', expect.objectContaining({
      name: 'win35', user: 'user', identityFile: 'C:/Users/unit/.ssh/id_ed', gateway, pinKind: 'host-key', keyId: 'C:/Users/unit/.ssh/id_ed', accountSub: 'unit-account-sub',
    }));
  });

  it('pins a fingerprint-only paste as such', async () => {
    await invoke(ipc.gateway.addDevice, addDeviceRequest({ pin: fingerprint }));
    expect(state.writePairing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pinKind: 'fingerprint', sshHostKeyFingerprint: fingerprint }));
  });

  it.each([
    ['wrong origin', addDeviceRequest({ gateway: { ...gateway, serverUrl: 'wss://gateway.other.example' } }), 'GATEWAY_PAIRING_INVALID'],
    ['malformed device id', addDeviceRequest({ gateway: { ...gateway, deviceId: 'bad id!' } }), 'GATEWAY_PAIRING_INVALID'],
    ['unparsable pin', addDeviceRequest({ pin: '-----BEGIN OPENSSH PRIVATE KEY-----' }), 'GATEWAY_PAIRING_INVALID'],
    ['missing key', addDeviceRequest({}), 'GATEWAY_PAIRING_KEY_MISSING'],
    ['signed out', addDeviceRequest({}), 'NOT_SIGNED_IN'],
  ])('refuses: %s', async (_label, request, code) => {
    if (code === 'GATEWAY_PAIRING_KEY_MISSING') state.resolveKey.mockReturnValue(null);
    if (code === 'NOT_SIGNED_IN') state.getIdToken.mockRejectedValue(new Error('not signed in'));
    const error = await invokeError(ipc.gateway.addDevice, request);
    expect(error.code).toBe(code);
    expect(state.writePairing).not.toHaveBeenCalled();
  });
});
