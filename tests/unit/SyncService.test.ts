import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';

/**
 * The API client against a scripted fetch: header shape, the 401-refresh-
 * retry, the 409-to-conflict mapping, the 8 KB ceiling, and the 404-is-
 * nothing-yet read. GoogleAuth is a stub — this suite only asserts how the
 * client drives it.
 */

vi.mock('electron', () => ({ safeStorage: {} }));

import {
  SyncApiError,
  SyncConflictError,
  SyncService,
  SYNC_DATA_LIMIT_BYTES,
} from '../../src/main/sync/SyncService';
import type { GoogleAuth } from '../../src/main/sync/GoogleAuth';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** The client is only ever pointed at https URLs, which the mock asserts. */
function urlString(url: string | URL | Request): string {
  if (typeof url !== 'string') throw new Error(`expected a string URL, got ${typeof url}`);
  return url;
}

/** The request body the client builds is always a JSON string. */
function bodyString(init: RequestInit | undefined): unknown {
  const body = init?.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

/** The client only ever calls getIdToken; the class's other surface is dead weight here. */
function stubAuth(getIdToken: (force?: boolean) => Promise<string>): GoogleAuth {
  return { getIdToken } as unknown as GoogleAuth;
}

/**
 * A service whose HTTP answers come from [script], once per request in
 * order; the auth stub records every getIdToken call so the 401 retry path
 * can be observed asking for a FORCED refresh.
 */
function makeService(script: (call: Call, forceRefreshed: boolean) => Response, tokens: string[] = ['tok']): {
  service: SyncService;
  tokensSeen: Array<{ token: string; forceRefreshed: boolean }>;
} {
  const tokensSeen: Array<{ token: string; forceRefreshed: boolean }> = [];
  const service = new SyncService({
    auth: stubAuth(async (force?: boolean) => {
      const token = tokens[tokensSeen.length] ?? 'tok';
      tokensSeen.push({ token, forceRefreshed: Boolean(force) });
      return token;
    }),
    baseUrl: 'https://sync.example/',
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const call: Call = { url: urlString(url), init };
      return script(call, tokensSeen[tokensSeen.length - 1]?.forceRefreshed === true);
    }),
  });
  return { service, tokensSeen };
}

describe('SyncService', () => {
  it('sends the Bearer header and JSON body on push', async () => {
    const calls: Call[] = [];
    const { service } = makeService((call) => {
      calls.push(call);
      return jsonResponse(200, { slot: 'main', version: 1 });
    });
    const out = await service.push('main', 'envelope-json', 0);
    expect(out).toEqual({ slot: 'main', version: 1 });
    expect(calls[0]!.url).toBe('https://sync.example/settings/main');
    expect((calls[0]!.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(bodyString(calls[0]!.init)).toEqual({ data: 'envelope-json', version: 0 });
  });

  it('retries once through a forced refresh on 401', async () => {
    let requestNo = 0;
    const { service, tokensSeen } = makeService(
      () => {
        requestNo += 1;
        return requestNo === 1 ? jsonResponse(401, { message: 'Unauthorized' }) : jsonResponse(200, { sub: 's' });
      },
      ['stale', 'fresh'],
    );
    await expect(service.me()).resolves.toEqual({ sub: 's' });
    expect(requestNo).toBe(2);
    // The retry asked the auth service for a FORCED refresh, and got the
    // second token from the stub.
    expect(tokensSeen[1]).toEqual({ token: 'fresh', forceRefreshed: true });
  });

  it('does not retry twice — a second 401 surfaces as an error', async () => {
    let requests = 0;
    const { service } = makeService(() => {
      requests += 1;
      return jsonResponse(401, { message: 'Unauthorized' });
    });
    await expect(service.me()).rejects.toBeInstanceOf(SyncApiError);
    expect(requests).toBe(2);
  });

  it('maps 409 to SyncConflictError carrying the current version', async () => {
    const { service } = makeService(() => jsonResponse(409, { currentVersion: 7 }));
    const err = await service.push('main', 'env', 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncConflictError);
    expect((err as SyncConflictError).currentVersion).toBe(7);
  });

  it('treats 404 on pull as "no blob yet"', async () => {
    const { service } = makeService(() => jsonResponse(404, { message: 'Not Found' }));
    await expect(service.pull('main')).resolves.toBeNull();
  });

  it('refuses to push an envelope over the server limit', async () => {
    let called = 0;
    const { service } = makeService(() => {
      called += 1;
      return jsonResponse(200, {});
    });
    const big = 'x'.repeat(SYNC_DATA_LIMIT_BYTES + 1);
    await expect(service.push('main', big, 0)).rejects.toBeInstanceOf(SyncApiError);
    expect(called).toBe(0);
  });

  it('raises SyncApiError with the body detail for other failures', async () => {
    const { service } = makeService(() => jsonResponse(403, { message: 'forbidden email' }));
    const err = await service.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).message).toBe('forbidden email');
  });

  it('normalises a trailing slash on the base URL', async () => {
    const urls: string[] = [];
    const service = new SyncService({
      auth: stubAuth(async () => 'tok'),
      baseUrl: 'https://sync.example///',
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(urlString(url));
        return jsonResponse(200, []);
      }),
    });
    await service.list();
    expect(urls[0]).toBe('https://sync.example/settings');
  });
});
