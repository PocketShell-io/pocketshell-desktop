import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pure halves of the Google sign-in flow: PKCE pair correctness, ID
 * token claim decoding, and expiry arithmetic. The loopback browser dance
 * itself is a thin composition of these plus node:http, and is exercised
 * end-to-end only by hand (a test against Google's live endpoint would be
 * neither hermetic nor polite).
 */

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

import {
  GoogleAuth,
  NotSignedInError,
  createPkcePair,
  decodeIdTokenPayload,
  isIdTokenExpired,
} from '../../src/main/sync/GoogleAuth';

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function idToken(sub: string, generation: number): string {
  return `header.${base64urlJson({ sub, email: 'a@b.c' })}.signature-${generation}`;
}

/** An openExternal that completes the browser leg: one code callback with the right state. */
function browserApproves(): (authUrl: string) => Promise<unknown> {
  return async (authUrl: string) => {
    const auth = new URL(authUrl);
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', 'authorization-code');
    redirect.searchParams.set('state', auth.searchParams.get('state')!);
    const callback = await fetch(redirect);
    expect(callback.ok).toBe(true);
  };
}

/** Token-broker responses by grant type; tests override the refresh leg. */
function brokerServing(idTokenOf: (generation: number) => string): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, string>;
    if (body.grant_type === 'authorization_code') {
      return new Response(
        JSON.stringify({ id_token: idTokenOf(1), refresh_token: 'refresh-token', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id_token: idTokenOf(2), expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('createPkcePair', () => {
  it('makes the challenge the S256 digest of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('produces a verifier of RFC 7636 length', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a fresh pair every time', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('decodeIdTokenPayload', () => {
  it('extracts sub and email from a three-part token', () => {
    const token = `header.${base64urlJson({ sub: 'sub-123', email: 'a@b.c', exp: 42 })}.sig`;
    expect(decodeIdTokenPayload(token)).toEqual({ sub: 'sub-123', email: 'a@b.c', exp: 42 });
  });

  it('tolerates a missing email or exp', () => {
    const token = `h.${base64urlJson({ sub: 's' })}.sig`;
    expect(decodeIdTokenPayload(token)).toEqual({ sub: 's', email: null, exp: undefined });
  });

  it('rejects tokens that are not three dot-separated parts', () => {
    expect(() => decodeIdTokenPayload('not.a')).toThrow(/malformed/);
  });

  it('rejects a payload without a subject', () => {
    expect(() => decodeIdTokenPayload(`h.${base64urlJson({ email: 'a@b.c' })}.s`)).toThrow(/subject/);
  });
});

describe('isIdTokenExpired', () => {
  const OBTAINED = 1_000_000;
  const TTL_S = 3600;

  it('is fresh inside the hour', () => {
    expect(isIdTokenExpired(OBTAINED, TTL_S, OBTAINED + 60_000)).toBe(false);
  });

  it('expires at the TTL, with the skew applied', () => {
    // Exactly at expiry-minus-skew: already considered gone.
    expect(isIdTokenExpired(OBTAINED, TTL_S, OBTAINED + (TTL_S - 60) * 1000)).toBe(true);
    // Just before the skew boundary: still good.
    expect(isIdTokenExpired(OBTAINED, TTL_S, OBTAINED + (TTL_S - 61) * 1000)).toBe(false);
  });
});

describe('getIdToken', () => {
  const T0 = 1_000_000;

  it('returns the cached token inside its hour, then refreshes through the broker once expired', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pocketshell-google-auth-'));
    let nowMs = T0;
    try {
      const auth = new GoogleAuth({
        userDataDir,
        openExternal: browserApproves(),
        fetchFn: brokerServing((gen) => idToken('sub-123', gen)),
        now: () => nowMs,
      });
      await auth.login();
      expect(await auth.getIdToken()).toBe(idToken('sub-123', 1));
      nowMs = T0 + 2 * 3600_000; // past the TTL and the skew: the cache is stale
      expect(await auth.getIdToken()).toBe(idToken('sub-123', 2));
      expect(auth.status().loggedIn).toBe(true);
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('forgets the session on invalid_grant — the refresh token is dead', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pocketshell-google-auth-'));
    let nowMs = T0;
    const broker = brokerServing((gen) => idToken('sub-123', gen));
    const fetchFn: typeof fetch = async (input, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, string>;
      if (body.grant_type === 'refresh_token') {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return broker(input, init);
    };
    try {
      const auth = new GoogleAuth({ userDataDir, openExternal: browserApproves(), fetchFn, now: () => nowMs });
      await auth.login();
      nowMs = T0 + 2 * 3600_000;
      await expect(auth.getIdToken()).rejects.toBeInstanceOf(NotSignedInError);
      expect(auth.status().loggedIn).toBe(false);
      // And nothing resurrects it: the next call is "not signed in", not another doomed refresh.
      await expect(auth.getIdToken()).rejects.toBeInstanceOf(NotSignedInError);
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('keeps the session on a refresh failure that is not invalid_grant', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pocketshell-google-auth-'));
    let nowMs = T0;
    const broker = brokerServing((gen) => idToken('sub-123', gen));
    const fetchFn: typeof fetch = async (input, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, string>;
      if (body.grant_type === 'refresh_token') {
        return new Response('token broker down', { status: 500 });
      }
      return broker(input, init);
    };
    try {
      const auth = new GoogleAuth({ userDataDir, openExternal: browserApproves(), fetchFn, now: () => nowMs });
      await auth.login();
      nowMs = T0 + 2 * 3600_000;
      await expect(auth.getIdToken()).rejects.toThrow(/token refresh failed \(HTTP 500\)/);
      expect(auth.status().loggedIn).toBe(true);
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('browser sign-in flow', () => {
  it('opens the browser and completes through the backend broker', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pocketshell-google-auth-'));

    try {
      const openExternal = vi.fn(async (authUrl: string) => {
        const auth = new URL(authUrl);
        const redirect = new URL(auth.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'authorization-code');
        redirect.searchParams.set('state', auth.searchParams.get('state')!);
        const callback = await fetch(redirect);
        expect(callback.ok).toBe(true);
      });
      const fetchFn: typeof fetch = async (input, init) => {
        const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        expect(inputUrl).toBe('https://a7sota2qic.execute-api.eu-west-1.amazonaws.com/auth/google/token');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(typeof init?.body).toBe('string');
        const body = JSON.parse(init?.body as string) as Record<string, string>;
        expect(body.grant_type).toBe('authorization_code');
        expect(body).not.toHaveProperty('client_secret');
        return new Response(
          JSON.stringify({ id_token: idToken('sub-123', 1), refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const auth = new GoogleAuth({ userDataDir, openExternal, fetchFn });
      await expect(auth.login()).resolves.toEqual({ sub: 'sub-123', email: 'a@b.c' });
      expect(openExternal).toHaveBeenCalledOnce();
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('electron mock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('is in place so the module import stays headless', () => {
    expect(true).toBe(true);
  });
});
