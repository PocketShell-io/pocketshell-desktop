import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';

/**
 * Minimal ~/.ssh/known_hosts loader + matcher.
 *
 * The Android app supports known_hosts verification (`KnownHostsPolicy`)
 * but always passes `AcceptAll` in production. Desktop honours known_hosts
 * for real security: unknown host -> TOFU prompt (accept once/always);
 * mismatch -> hard block; known + match -> proceed.
 *
 * Only the hash/markers we need for the ssh2 `hostVerifier` callback are
 * implemented: literal hostnames, a single `*` wildcard, and hashed host
 * entries (`|1|<salt>|<hash>`). Revocation markers (`@revoked`) and
 * certificate authority lines (`@cert-authority`) are parsed permissively
 * (CA lines accepted, revoked entries skipped) — full handling can come
 * later; the dev-box use case rarely hits them.
 */

export interface HostKeyEntry {
  /** Raw hostnames field, for matching. */
  patterns: string[];
  /** Key type, e.g. ssh-ed25519. */
  keyType: string;
  /** Base64 public key. */
  keyB64: string;
}

export interface VerificationResult {
  /** A known_hosts entry matched the host AND its key. */
  trusted: boolean;
  /** Host matched but the presented key differs — must block. */
  mismatch: boolean;
  /** No entry for this host — caller should TOFU-prompt. */
  unknown: boolean;
  /** The matched entry, when trusted or mismatch. */
  entry?: HostKeyEntry;
}

/**
 * The token OpenSSH uses to key a host in known_hosts: the bare hostname on
 * the default port, `[host]:port` on any other.
 *
 * Without this, a host reached on two ports shares one pin — connecting to
 * `127.0.0.1:22` and `127.0.0.1:3205` would compare each other's keys and
 * report a mismatch, which is both wrong and a real block: it made every
 * connect to the test fixture fail after its image was rebuilt on a new base.
 */
function knownHostsToken(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export class KnownHosts {
  private entries: HostKeyEntry[] = [];
  private path: string;

  constructor(path?: string) {
    this.path = path ?? defaultKnownHostsPath();
    this.load();
  }

  static fromText(text: string): KnownHosts {
    const kh = Object.create(KnownHosts.prototype) as KnownHosts;
    kh.path = '';
    kh.entries = parseKnownHostsText(text);
    return kh;
  }

  private load(): void {
    try {
      const text = readFileSync(this.path, 'utf8');
      this.entries = parseKnownHostsText(text);
    } catch {
      this.entries = []; // no known_hosts -> everything is unknown (TOFU)
    }
  }

  /**
   * Verify a host key presented by ssh2.
   *
   * @param host       the hostname being connected to
   * @param keyType    e.g. 'ssh-ed25519'
   * @param keyB64     base64 of the public key blob
   * @param port       remote port; non-22 ports key as `[host]:port`
   */
  verify(host: string, keyType: string, keyB64: string, port = 22): VerificationResult {
    const token = knownHostsToken(host, port);
    for (const entry of this.entries) {
      if (!hostMatches(token, entry.patterns)) continue;
      if (entry.keyType !== keyType) continue;
      if (entry.keyB64 === keyB64) {
        return { trusted: true, mismatch: false, unknown: false, entry };
      }
      return { trusted: false, mismatch: true, unknown: false, entry };
    }
    return { trusted: false, mismatch: false, unknown: true };
  }

  /** TOFU: append a new host key so future connects match. */
  add(host: string, keyType: string, keyB64: string, port = 22): void {
    const token = knownHostsToken(host, port);
    const entry: HostKeyEntry = { patterns: [token], keyType, keyB64 };
    this.entries.push(entry);
    if (this.path) {
      try {
        writeFileSync(this.path, `${token} ${keyType} ${keyB64}\n`, { flag: 'a' });
      } catch {
        // best-effort; in-memory entry still lets the current session proceed
      }
    }
  }

  get size(): number {
    return this.entries.length;
  }
}

function defaultKnownHostsPath(): string {
  return resolve(homedir(), '.ssh', 'known_hosts');
}

function parseKnownHostsText(text: string): HostKeyEntry[] {
  const out: HostKeyEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@cert-authority')) continue; // CA entries: skip for now
    if (line.startsWith('@revoked')) continue; // revoked: never trust
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [patternsRaw, keyType, keyB64] = parts;
    if (!patternsRaw || !keyType || !keyB64) continue;
    const patterns = expandPatterns(patternsRaw);
    out.push({ patterns, keyType, keyB64 });
  }
  return out;
}

/** Expand comma-separated + wildcard patterns into individual matchers. */
function expandPatterns(raw: string): string[] {
  // Hashed host: `|1|<salt>|<hash>` — kept as a single opaque matcher token;
  // hostMatches handles the HMAC comparison. Keep the literal token so the
  // salt/hash are available.
  if (raw.startsWith('|1|')) return [raw];
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

function hostMatches(host: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith('|1|')) {
      if (hashedHostMatches(pattern, host)) return true;
      continue;
    }
    if (pattern === host) return true;
    // OpenSSH wildcard semantics: `*` matches any run of characters INCLUDING
    // dots, so `*.example.com` matches `dev.example.com` AND `a.b.example.com`;
    // a bare `*` matches anything. No other metacharacters (`?` is not handled).
    if (pattern.includes('*')) {
      const re = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      if (re.test(host)) return true;
    }
  }
  return false;
}

/** Verify a hashed known_hosts entry: `|1|<saltB64>|<hashB64>`, HMAC-SHA1. */
function hashedHostMatches(token: string, host: string): boolean {
  const segs = token.split('|'); // ['', '1', salt, hash]
  if (segs.length < 4) return false;
  const salt = Buffer.from(segs[2] ?? '', 'base64');
  const expected = Buffer.from(segs[3] ?? '', 'base64');
  // OpenSSH hashes the host with HMAC-SHA1 keyed by the salt.
  const hmac = createHmac('sha1', salt);
  hmac.update(host);
  const digest = hmac.digest();
  return digest.equals(expected);
}
