import { describe, expect, it, vi } from 'vitest';

/**
 * The device-list client against a scripted fetch and a stubbed token
 * source: the pinned-origin refusal, the Bearer header, the one 401 re-mint,
 * and which refusals wear core's directory codes so the picker's failure
 * classification (classifyGatewayDirectoryFailure) can read them.
 */

import { GatewayDirectory } from '../../src/main/sync/GatewayDirectory';
import { NotSignedInError } from '../../src/main/sync/GoogleAuth';
import { SyncApiError } from '../../src/main/sync/SyncService';
import {
  classifyGatewayDirectoryFailure,
  GATEWAY_DEFAULT_SERVER_URL,
  type GatewayDevice,
} from '@pocketshell/core';

const DEVICES_URL = 'https://gateway.pocketshell.io/identity/v1/devices';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function makeDirectory(script: Response[], tokens: string[]): {
  directory: GatewayDirectory;
  calls: Call[];
  tokensSeen: string[];
} {
  const calls: Call[] = [];
  const tokensSeen: string[] = [];
  const sync = {
    gatewayToken: async (): Promise<string> => {
      const token = tokens[tokensSeen.length] ?? 'expired';
      tokensSeen.push(token);
      return token;
    },
  };
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof url !== 'string') throw new Error('expected a string URL');
    calls.push({ url, init });
    const response = script[calls.length - 1];
    if (!response) throw new Error(`unexpected call ${calls.length} to ${url}`);
    return response;
  });
  return { directory: new GatewayDirectory({ sync, fetchFn }), calls, tokensSeen };
}

const deviceBody = {
  devices: [
    { id: 'win35', account_id: 'acc', public_key: 'device-identity-only', ssh_host_key: 'ssh-ed25519 AAAA hint', revoked: false, presence: { online: true, observed_at: '2026-11-05T10:00:00Z', connected_since: '2026-11-05T09:00:00Z' } },
    { id: 'legacy-box', account_id: 'acc', public_key: 'k', ssh_host_key: '', revoked: false },
  ],
};

describe('gateway directory', () => {
  it('lists the account devices from the pinned https origin with the routing token', async () => {
    const { directory, calls, tokensSeen } = makeDirectory([jsonResponse(200, deviceBody)], ['routing-token']);
    const devices = await directory.devices(GATEWAY_DEFAULT_SERVER_URL);
    expect(tokensSeen).toEqual(['routing-token']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEVICES_URL);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer routing-token');
    expect(devices.map((d: GatewayDevice) => [d.id, d.revoked, d.presence.state])).toEqual([
      ['win35', false, 'online'],
      ['legacy-box', false, 'unknown'],
    ]);
    expect(devices[0]!.advisoryHostKey).toBe('ssh-ed25519 AAAA hint');
  });

  it('accepts the https spelling of the pinned origin', async () => {
    const { directory, calls } = makeDirectory([jsonResponse(200, deviceBody)], ['t']);
    await expect(directory.devices('https://gateway.pocketshell.io')).resolves.toBeInstanceOf(Array);
    expect(calls[0]!.url).toBe(DEVICES_URL);
  });

  it('refuses every other origin before the token or a fetch', async () => {
    const { directory, calls, tokensSeen } = makeDirectory([], []);
    for (const serverUrl of ['wss://gateway.attacker.example', 'http://gateway.pocketshell.io/', 'not a url']) {
      await expect(directory.devices(serverUrl)).rejects.toThrow(/Desktop lists gateway devices only on/);
    }
    expect(tokensSeen).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('mints a fresh routing token once on a 401', async () => {
    const { directory, calls, tokensSeen } = makeDirectory([jsonResponse(401, {}), jsonResponse(200, deviceBody)], ['aged-out', 'fresh']);
    const devices = await directory.devices(GATEWAY_DEFAULT_SERVER_URL);
    expect(tokensSeen).toEqual(['aged-out', 'fresh']);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
    expect(devices).toHaveLength(2);
  });

  it.each([[401, jsonResponse(401, {})], [403, jsonResponse(403, {})]])('a %i after the re-mint is a sign-in refusal', async (_status, response) => {
    const { directory } = makeDirectory([response, jsonResponse(401, {})], ['t1', 't2']);
    const error = await directory.devices(GATEWAY_DEFAULT_SERVER_URL).catch((e: unknown) => e) as Error & { code?: string };
    expect(error.code).toBe('GATEWAY_DEVICES_UNAUTHORIZED');
    expect(classifyGatewayDirectoryFailure(error).kind).toBe('sign_in_required');
  });

  it('a malformed list body refuses as unreadable, never an empty list', async () => {
    const { directory } = makeDirectory([jsonResponse(200, { devices: [{ id: 'BAD ID', revoked: false }] })], ['t']);
    const error = await directory.devices(GATEWAY_DEFAULT_SERVER_URL).catch((e: unknown) => e) as Error;
    expect(error.name).toBe('GatewayDeviceListError');
    expect(classifyGatewayDirectoryFailure(error).kind).toBe('unavailable');
  });

  it('being signed out wears the NOT_SIGNED_IN code', async () => {
    const calls: Call[] = [];
    const sync = { gatewayToken: async (): Promise<string> => { throw new NotSignedInError('not signed in'); } };
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (typeof url !== 'string') throw new Error('expected a string URL');
      calls.push({ url, init });
      throw new Error('fetch must not run');
    });
    const client = new GatewayDirectory({ sync, fetchFn });
    const error = await client.devices(GATEWAY_DEFAULT_SERVER_URL).catch((e: unknown) => e) as Error & { code?: string };
    expect(error.code).toBe('NOT_SIGNED_IN');
    expect(classifyGatewayDirectoryFailure(error).kind).toBe('sign_in_required');
    expect(calls).toEqual([]);
  });

  it('a gateway 500 with detail surfaces as a sync API error', async () => {
    const { directory } = makeDirectory([jsonResponse(500, { message: 'identity store offline' })], ['t']);
    const error = await directory.devices(GATEWAY_DEFAULT_SERVER_URL).catch((e: unknown) => e) as SyncApiError;
    expect(error).toBeInstanceOf(SyncApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe('identity store offline');
  });
});
