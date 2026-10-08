import { NotSignedInError, type GoogleAuth } from './GoogleAuth.js';
import { SYNC_API_URL } from '@pocketshell/core';

/**
 * The sync API client — the app's side of the contract documented in the
 * aws-infra repo (sandbox/pocketshell-sync/docs/CLIENT-INTEGRATION.md).
 *
 * Every request carries `Authorization: Bearer <ID token>`; a 401 means the
 * token aged out mid-flight, so the request is retried ONCE through a forced
 * token refresh before giving up (the server authorizes independently, so
 * this is a convenience, never a security mechanism). A 409 on push is the
 * multi-device conflict signal: the stored version moved under us, and the
 * caller is told the current version so it can re-pull, re-merge, re-push.
 *
 * This service speaks ENVELOPES, not plaintext: what goes over the wire is
 * exactly what SyncCrypto produced. Plaintext never reaches this module.
 */

/** The stored blob moved between our pull and our push. */
export class SyncConflictError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(`slot changed under us (stored version ${currentVersion})`);
    this.currentVersion = currentVersion;
  }
}

/** The API refused the request for a reason worth showing the user. */
export class SyncApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SlotMeta {
  slot: string;
  version: number;
  size: number;
  updatedAt: string;
}

export interface PulledSlot {
  slot: string;
  version: number;
  /** The envelope string exactly as stored — SyncCrypto's job to open. */
  data: string;
}

/** The Lambda rejects `data` over 8 KB; the app enforces it before upload. */
export const SYNC_DATA_LIMIT_BYTES = 8 * 1024;

export interface SyncServiceDeps {
  auth: GoogleAuth;
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export class SyncService {
  private readonly auth: GoogleAuth;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: SyncServiceDeps) {
    this.auth = deps.auth;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** `GET /me` — who the server thinks we are. Also the connectivity check. */
  async me(): Promise<{ sub: string; email: string | null }> {
    return this.request('GET', '/me');
  }

  /** Exchange Google admission at the trusted broker; only this scoped JWT reaches WSS. */
  async gatewayToken(): Promise<string> {
    if (this.baseUrl !== SYNC_API_URL.replace(/\/+$/, '')) {
      throw new Error('Gateway token exchange requires the trusted PocketShell broker.');
    }
    const result = await this.request<{ token?: unknown; token_type?: unknown }>('POST', '/gateway/token');
    if (typeof result.token !== 'string' || result.token_type !== 'Bearer') {
      throw new Error('The gateway broker returned an invalid token response.');
    }
    // Sanity-check the credential class before it can leave for a gateway.
    // Signature verification remains the gateway's duty; broker HTTPS is trusted here.
    let claims: Record<string, unknown>;
    try { claims = JSON.parse(Buffer.from(result.token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>; }
    catch { throw new Error('The gateway broker returned a malformed JWT.'); }
    const now = Math.floor(Date.now() / 1000);
    if (!claims || claims.iss !== this.baseUrl || claims.aud !== 'pocketshell-gateway'
      || claims.scope !== 'pocketshell.gateway' || typeof claims.iat !== 'number'
      || typeof claims.exp !== 'number' || claims.exp <= now || claims.exp - claims.iat > 300) {
      throw new Error('The gateway broker returned an unscoped or expired credential.');
    }
    return result.token;
  }

  /** `GET /settings` — the slots the account holds, no data. */
  async list(): Promise<SlotMeta[]> {
    const rows = await this.request<SlotMeta[]>('GET', '/settings');
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * `GET /settings/{slot}`, or null when the account has no blob there yet —
   * a fresh account is a normal state, not an error.
   */
  async pull(slot: string): Promise<PulledSlot | null> {
    const res = await this.requestRaw('GET', `/settings/${slot}`);
    if (res.status === 404) return null;
    return this.jsonBody<PulledSlot>(res);
  }

  /**
   * `PUT /settings/{slot}` with the envelope and the base version we last
   * saw (0 creates). Returns the new stored version; 409 throws
   * {@link SyncConflictError} with the version to re-base on.
   */
  async push(slot: string, envelope: string, baseVersion: number): Promise<{ version: number }> {
    if (Buffer.byteLength(envelope, 'utf8') > SYNC_DATA_LIMIT_BYTES) {
      throw new SyncApiError(0, 'settings blob exceeds the 8 KB sync limit');
    }
    const res = await this.requestRaw('PUT', `/settings/${slot}`, { data: envelope, version: baseVersion });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { currentVersion?: number };
      throw new SyncConflictError(typeof body.currentVersion === 'number' ? body.currentVersion : 0);
    }
    return this.jsonBody<{ version: number }>(res);
  }

  /** `DELETE /settings/{slot}` — remove the blob from the account. */
  async remove(slot: string): Promise<void> {
    await this.requestRaw('DELETE', `/settings/${slot}`);
  }

  /* --- internals --------------------------------------------------------- */

  /**
   * One API call with the 401-refresh-retry. The retry is single-shot: a 401
   * AFTER a forced refresh means the account is genuinely unauthorized
   * (allowlist, revoked grant) and retrying again would only spin.
   */
  private async request<T>(method: string, path: string): Promise<T> {
    const res = await this.requestRaw(method, path);
    return this.jsonBody<T>(res);
  }

  private async requestRaw(method: string, path: string, body?: unknown, alreadyRefreshed = false): Promise<Response> {
    const token = await this.auth.getIdToken(alreadyRefreshed).catch((err) => {
      if (err instanceof NotSignedInError) throw err;
      throw new SyncApiError(0, `could not obtain an ID token: ${(err as Error).message}`);
    });
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !alreadyRefreshed) {
      return this.requestRaw(method, path, body, true);
    }
    return res;
  }

  /** Non-2xx becomes {@link SyncApiError} with whatever detail the body had. */
  private async jsonBody<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new SyncApiError(res.status, detail?.message ?? `sync API returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}
