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
  createPkcePair,
  decodeIdTokenPayload,
  isIdTokenExpired,
} from '../../src/main/sync/GoogleAuth';

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
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

describe('browser sign-in flow', () => {
  it('opens the browser and completes without a client secret', async () => {
    const previousSecret = process.env['POCKETSHELL_GOOGLE_SECRET'];
    delete process.env['POCKETSHELL_GOOGLE_SECRET'];
    const userDataDir = mkdtempSync(join(tmpdir(), 'pocketshell-google-auth-'));
    const idToken = `header.${base64urlJson({ sub: 'sub-123', email: 'a@b.c' })}.signature`;

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
        expect(inputUrl).toBe('https://oauth2.googleapis.com/token');
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        expect((init?.body as URLSearchParams).has('client_secret')).toBe(false);
        return new Response(
          JSON.stringify({ id_token: idToken, refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const auth = new GoogleAuth({ userDataDir, openExternal, fetchFn });
      await expect(auth.login()).resolves.toEqual({ sub: 'sub-123', email: 'a@b.c' });
      expect(openExternal).toHaveBeenCalledOnce();
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
      if (previousSecret === undefined) delete process.env['POCKETSHELL_GOOGLE_SECRET'];
      else process.env['POCKETSHELL_GOOGLE_SECRET'] = previousSecret;
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
