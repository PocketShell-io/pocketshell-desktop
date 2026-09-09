import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { GOOGLE_CLIENT_ID } from '../../shared/syncConfig.js';

/**
 * Google sign-in for settings sync — the optional "Gmail login".
 *
 * Desktop-app OAuth, straight against Google (no Cognito, no auth backend):
 * a one-shot loopback HTTP listener on 127.0.0.1, the system browser opened
 * at Google's authorization endpoint with PKCE, and the `code` exchanged at
 * the token endpoint for an ID token + refresh token. Every sync call then
 * carries `Authorization: Bearer <ID token>`; ID tokens last an hour and are
 * refreshed from the refresh token on demand (see `getIdToken`).
 *
 * Tokens at rest are encrypted with Electron `safeStorage` (OS keychain) in
 * a small file under the app's userData directory. If no OS keychain is
 * available — some minimal Linux sessions — login refuses rather than
 * writing tokens in the clear. The renderer never sees a token; it sees
 * `status()` and the email only.
 *
 * The API Gateway JWT authorizer re-validates every token (signature,
 * issuer, audience, expiry) server-side; nothing here is load-bearing for
 * the backend's security.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const SCOPE = 'openid email profile';
/** How long to leave the browser loopback open before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Treat an ID token as gone this many seconds before its real expiry. */
const EXPIRY_SKEW_S = 60;

export interface GoogleIdentity {
  sub: string;
  email: string | null;
}

export interface SyncAuthStatus extends GoogleIdentity {
  loggedIn: boolean;
  /** False on Linux sessions without a keyring: login refuses rather than storing plaintext tokens. */
  keychainAvailable: boolean;
}

/** Signed out, or the keychain is missing — not an error shape, a status. */
export class NotSignedInError extends Error {}

/** A fresh PKCE pair: verifier stays here, challenge travels in the URL. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * The ID token's claims, decoded WITHOUT verification — acceptable because
 * the token comes straight from Google's token endpoint over TLS, and the
 * server independently verifies everything it acts on.
 */
export function decodeIdTokenPayload(idToken: string): GoogleIdentity & { exp?: number } {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed ID token');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed ID token payload');
  }
  if (typeof claims !== 'object' || claims === null || typeof (claims as Record<string, unknown>)['sub'] !== 'string') {
    throw new Error('ID token has no subject');
  }
  const c = claims as Record<string, unknown>;
  return {
    sub: c['sub'] as string,
    email: typeof c['email'] === 'string' ? c['email'] : null,
    exp: typeof c['exp'] === 'number' ? c['exp'] : undefined,
  };
}

export function isIdTokenExpired(obtainedAtMs: number, expiresInS: number, nowMs: number): boolean {
  return nowMs >= obtainedAtMs + expiresInS * 1000 - EXPIRY_SKEW_S * 1000;
}

/**
 * The OAuth client secret, read at use time and never committed: GitHub
 * push protection refuses any push containing one, and the value belongs to
 * this machine's owner, not to the source tree. Environment first (dev),
 * then the one-line file under ~/.config.
 */
function readGoogleClientSecret(): string {
  const fromEnv = process.env['POCKETSHELL_GOOGLE_SECRET'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const path = join(homedir(), '.config', 'pocketshell', 'google-client-secret');
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (value !== '') return value;
  }
  throw new Error(`Google OAuth client secret not found — put it in ${path} (one line), or set POCKETSHELL_GOOGLE_SECRET`);
}

interface StoredAuth extends GoogleIdentity {
  idTokenEnc: string;
  /** Absent when Google did not hand one out — then expiry means re-login. */
  refreshEnc: string | null;
  obtainedAtMs: number;
  expiresInS: number;
}

interface TokenResponse {
  id_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface GoogleAuthDeps {
  /** The app's userData directory — where the encrypted token file lives. */
  userDataDir: string;
  /** `shell.openExternal`, injected: this module should stay testable headlessly. */
  openExternal: (url: string) => Promise<unknown>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class GoogleAuth {
  private readonly dir: string;
  private readonly openExternal: (url: string) => Promise<unknown>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private loginInFlight: Promise<GoogleIdentity> | null = null;

  constructor(deps: GoogleAuthDeps) {
    this.dir = deps.userDataDir;
    this.openExternal = deps.openExternal;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private get tokenFile(): string {
    return join(this.dir, 'sync-auth.bin');
  }

  keychainAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /** Who is signed in, without touching the network. */
  status(): SyncAuthStatus {
    const stored = this.load();
    return {
      loggedIn: stored !== null,
      sub: stored?.sub ?? '',
      email: stored?.email ?? null,
      keychainAvailable: this.keychainAvailable(),
    };
  }

  /**
   * A usable ID token: the cached one, or a fresh one from the refresh
   * token. The one call {@link SyncService} needs before every request.
   */
  async getIdToken(forceRefresh = false): Promise<string> {
    const stored = this.load();
    if (!stored) throw new NotSignedInError('not signed in');
    if (!forceRefresh && !isIdTokenExpired(stored.obtainedAtMs, stored.expiresInS, this.now())) {
      return this.decrypt(stored.idTokenEnc);
    }
    if (!stored.refreshEnc) throw new NotSignedInError('sign-in expired — sign in again');
    const refreshToken = this.decrypt(stored.refreshEnc);
    const res = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: readGoogleClientSecret(),
      }),
    });
    if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status})`);
    const tokens = (await res.json()) as TokenResponse;
    // A refresh response carries no new refresh token; the old one stands.
    this.store(tokens, refreshToken, stored);
    return tokens.id_token;
  }

  /**
   * The full browser round-trip. Rejects on deny, timeout, or a keychain
   * that cannot protect the tokens; concurrent calls share one flow.
   */
  login(): Promise<GoogleIdentity> {
    this.loginInFlight ??= this.runLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Forget the tokens; best-effort revoke at Google so the grant dies too. */
  async logout(): Promise<void> {
    const stored = this.load();
    rmSync(this.tokenFile, { force: true });
    if (stored?.refreshEnc) {
      try {
        await this.fetchFn(REVOKE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: this.decrypt(stored.refreshEnc) }),
        });
      } catch {
        // Revocation is courtesy, not correctness — local logout already holds.
      }
    }
  }

  /* --- internals --------------------------------------------------------- */

  private async runLogin(): Promise<GoogleIdentity> {
    if (!this.keychainAvailable()) {
      throw new Error('no OS keychain available — tokens cannot be stored safely');
    }
    const { verifier, challenge } = createPkcePair();
    const state = randomBytes(16).toString('base64url');
    const redirect = await this.listenForCode(state);
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirect.uri);
    url.searchParams.set('scope', SCOPE);
    // offline + consent: a refresh token, so sync survives past the hour.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    await this.openExternal(url.toString());
    const tokens = await this.exchangeCode(redirect.code, verifier, redirect.uri);
    const identity = decodeIdTokenPayload(tokens.id_token);
    this.store(tokens, tokens.refresh_token ?? null, identity);
    return { sub: identity.sub, email: identity.email };
  }

  /**
   * One-shot loopback listener. Resolves with the authorization code once
   * Google (i.e. the browser) calls back with the state we sent; the server
   * is closed either way before this returns.
   */
  private listenForCode(state: string): Promise<{ uri: string; code: string }> {
    return new Promise((resolve, reject) => {
      let port = 0;
      const server = createServer((req, res) => {
        const path = req.url?.split('?')[0] ?? '/';
        if (path !== '/') {
          // Browsers poke favicon.ico and friends; ignore quietly.
          res.writeHead(404).end();
          return;
        }
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
        const fail = (message: string): void => {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h3>Sign-in failed</h3><p>${message}</p></body></html>`);
          server.close();
          reject(new Error(message));
        };
        const err = params.get('error');
        if (err) return fail(`Google sign-in was not completed (${err}).`);
        const code = params.get('code');
        if (!code) return fail('Google did not return an authorization code.');
        if (params.get('state') !== state) return fail('sign-in response did not match this request (state).');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>PocketShell sign-in complete — you can close this window.</p></body></html>');
        server.close(() => resolve({ uri: `http://127.0.0.1:${port}`, code }));
      });
      server.on('error', reject);
      // Port 0: the OS picks a free one, which is the point of loopback
      // redirect URIs — nothing to collide with, nothing to pre-register.
      // The address only exists once 'listening' fires, and the callback
      // above reads it only after a request — which cannot precede it.
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
      });
      setTimeout(() => {
        server.close();
        reject(new Error('sign-in timed out — no browser response within 5 minutes'));
      }, LOGIN_TIMEOUT_MS).unref();
    });
  }

  private async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    const res = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: readGoogleClientSecret(),
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);
    const tokens = (await res.json()) as TokenResponse;
    if (!tokens.id_token) throw new Error('token exchange returned no ID token');
    return tokens;
  }

  private store(tokens: TokenResponse, refreshToken: string | null, identity: GoogleIdentity): void {
    const record: StoredAuth = {
      sub: identity.sub,
      email: identity.email,
      idTokenEnc: this.encrypt(tokens.id_token),
      refreshEnc: refreshToken ? this.encrypt(refreshToken) : null,
      obtainedAtMs: this.now(),
      expiresInS: tokens.expires_in,
    };
    writeFileSync(this.tokenFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  }

  private load(): StoredAuth | null {
    try {
      const raw = readFileSync(this.tokenFile, 'utf8');
      const parsed = JSON.parse(raw) as StoredAuth;
      if (typeof parsed.idTokenEnc !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private encrypt(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64');
  }

  private decrypt(enc: string): string {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  }
}
