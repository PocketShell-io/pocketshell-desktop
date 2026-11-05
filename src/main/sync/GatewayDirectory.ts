import {
  GATEWAY_DEFAULT_SERVER_URL,
  gatewayDevicesUrl,
  parseGatewayDeviceList,
  GatewayDeviceListError,
  type GatewayDevice,
} from '@pocketshell/core';
import { SyncApiError } from './SyncService.js';
import { NotSignedInError } from './GoogleAuth.js';

/**
 * The account's gateway device list, as the gateway itself reports it
 * (core gatewayDevices.ts holds the wire contract). The routing token minted
 * at the broker (`SyncService.gatewayToken`) authorizes the read, so it may
 * only ever be shown to the one gateway origin the broker pins — any other
 * origin is refused before a fetch, the same posture `gatewayToken` takes
 * toward any other sync backend. The parsing is core's strict
 * {@link parseGatewayDeviceList}; this module is only the platform fetch
 * where the token lives.
 */
export interface GatewayDirectoryDeps {
  sync: { gatewayToken(): Promise<string> };
  fetchFn?: typeof fetch;
}

export class GatewayDirectory {
  private readonly sync: { gatewayToken(): Promise<string> };
  private readonly fetchFn: typeof fetch;

  constructor(deps: GatewayDirectoryDeps) {
    this.sync = deps.sync;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** The account's devices on `serverUrl`, from the gateway's own last list. */
  async devices(serverUrl: string): Promise<GatewayDevice[]> {
    const url = gatewayDevicesUrl(serverUrl);
    if (url === null || url !== gatewayDevicesUrl(GATEWAY_DEFAULT_SERVER_URL)) {
      throw new Error(`Desktop lists gateway devices only on ${GATEWAY_DEFAULT_SERVER_URL}.`);
    }
    let res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) {
      // The routing token is short-lived; one fresh mint answers an aged-out
      // one. A 401 after that is a genuine refusal, never retried again.
      res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('The gateway refused the device list.'), { code: 'GATEWAY_DEVICES_UNAUTHORIZED' });
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new SyncApiError(res.status, detail?.message ?? `the gateway returned HTTP ${res.status}`);
    }
    const body: unknown = await res.json().catch(() => {
      throw new GatewayDeviceListError();
    });
    return parseGatewayDeviceList(body);
  }

  /** The routing token, with the signed-out case wearing core's native code. */
  private async token(): Promise<string> {
    try {
      return await this.sync.gatewayToken();
    } catch (error) {
      if (error instanceof NotSignedInError) {
        throw Object.assign(new Error(error.message), { code: 'NOT_SIGNED_IN' });
      }
      throw error;
    }
  }
}
