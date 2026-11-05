import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { utils } from 'ssh2';
import type { GatewayClientKey } from '@pocketshell/core';

/**
 * The SSH client keys a gateway pairing can pin: the user's existing
 * `~/.ssh` public keys and keys PocketShell generates on request
 * (`createClientKey`). Only public halves ever answer the IPC surface; the
 * private half of a generated key stays a 0600 file under the app's userData
 * and the pairing stores its PATH, which is exactly the identityFile the
 * gateway dial already knows how to load.
 */

/** One generated key's registry row: everything needed to list and resolve it. */
export interface GatewayManagedKeyRecord {
  id: string;
  label: string;
  /** The 0600 OpenSSH-format private key file; the private half never leaves disk. */
  privatePath: string;
  publicKey: string;
  createdAt: string;
}

const BLOB_LINE = /^[A-Za-z0-9+/]+=*$/;
/** The smallest real key blob (ed25519) is 51 base64 chars; anything shorter is prose. */
const MIN_BLOB_BYTES = 20;

/** `SHA256:<unpadded base64>` of a public key line's blob — what ssh-keygen -lf prints. */
function fingerprintOfBlob(blob: string): string {
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function keyOf(id: string, label: string, publicKey: string): GatewayClientKey | null {
  const line = publicKey.trim().split(/\r?\n/)[0] ?? '';
  const blob = line.split(/\s+/)[1];
  if (blob === undefined || !BLOB_LINE.test(blob) || Buffer.from(blob, 'base64').length < MIN_BLOB_BYTES) return null;
  return { id, label, fingerprint: fingerprintOfBlob(blob), publicKey: line };
}

/**
 * Every key this device can offer a pairing right now: the app's generated
 * keys (whose private file still exists) first, then the user's `~/.ssh`
 * public keys that have a private half beside them. Unreadable or shapeless
 * entries are skipped, never fatal — one broken file cannot hide the rest.
 */
export function listGatewayClientKeys(opts: { sshDir: string; registryPath: string }): GatewayClientKey[] {
  const keys: GatewayClientKey[] = [];
  let registry: unknown;
  try { registry = JSON.parse(readFileSync(opts.registryPath, 'utf8')); } catch { registry = []; }
  if (Array.isArray(registry)) {
    for (const entry of registry) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.label !== 'string'
        || typeof r.privatePath !== 'string' || typeof r.publicKey !== 'string') continue;
      if (!existsSync(r.privatePath)) continue;
      const key = keyOf(r.id, r.label, r.publicKey);
      if (key !== null) keys.push(key);
    }
  }
  let pubs: string[] = [];
  try { pubs = readdirSync(opts.sshDir).filter((f) => f.endsWith('.pub')); } catch { /* no ~/.ssh yet */ }
  for (const pub of pubs.sort()) {
    const privatePath = join(opts.sshDir, pub.slice(0, -'.pub'.length));
    if (!existsSync(privatePath)) continue;
    let text: string;
    try { text = readFileSync(join(opts.sshDir, pub), 'utf8'); } catch { continue; }
    const key = keyOf(privatePath, basename(privatePath), text);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/**
 * Generate an ed25519 pair, keep the private half under [managedDir], and
 * record the public half in the registry at [registryPath]. The registry
 * write is atomic (temp + rename, the SshConfigWriter pattern); a registry
 * that does not parse as an array is refused, not overwritten.
 */
export function createGatewayClientKey(opts: { managedDir: string; registryPath: string; label: string }): GatewayClientKey {
  const label = opts.label.trim();
  if (label === '' || label.length > 200) throw new Error('Give the key a name of 1–200 characters.');
  const pair = utils.generateKeyPairSync('ed25519');
  const id = `psk-${randomBytes(8).toString('hex')}`;
  const privatePath = join(opts.managedDir, id);
  let registry: unknown[];
  if (existsSync(opts.registryPath)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(opts.registryPath, 'utf8')); }
    catch { throw new Error('The gateway key registry is not valid JSON; refusing to overwrite it.'); }
    if (!Array.isArray(raw)) throw new Error('The gateway key registry is not an array; refusing to overwrite it.');
    registry = raw;
  } else {
    registry = [];
  }
  mkdirSync(opts.managedDir, { recursive: true });
  writeFileSync(privatePath, pair.private, { mode: 0o600 });
  const createdAt = new Date().toISOString();
  const tmp = `${opts.registryPath}.pocketshell-${process.pid}-${Date.now()}`;
  const row: GatewayManagedKeyRecord = { id, label, privatePath, publicKey: pair.public, createdAt };
  writeFileSync(tmp, `${JSON.stringify([...registry, row], null, 2)}\n`, { mode: existsSync(opts.registryPath) ? statSync(opts.registryPath).mode : 0o600 });
  renameSync(tmp, opts.registryPath);
  const key = keyOf(id, label, pair.public);
  if (key === null) throw new Error('The generated key could not be read back.');
  return key;
}

/**
 * The private key file a pairing's `keyId` authenticates with: the managed
 * record's path when the id names a generated key, otherwise the id itself
 * as a private-key path (an existing key's id IS its private path, so the
 * pairing summary round-trips without a lookup table). Null when neither.
 */
export function resolveGatewayKeyPath(registryPath: string, keyId: string): string | null {
  if (typeof keyId !== 'string' || keyId.trim() === '') return null;
  let registry: unknown;
  try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); } catch { registry = []; }
  if (Array.isArray(registry)) {
    for (const entry of registry) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      if (r.id === keyId && typeof r.privatePath === 'string' && existsSync(r.privatePath)) return r.privatePath;
    }
  }
  if (!existsSync(keyId)) return null;
  return keyId;
}
