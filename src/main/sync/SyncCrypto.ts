import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';

/**
 * Client-side encryption for settings sync — the zero-knowledge half of the
 * feature (the server contract is documented in the aws-infra repo,
 * sandbox/pocketshell-sync/docs/CLIENT-INTEGRATION.md).
 *
 * The sync backend stores an opaque envelope and never sees plaintext, the
 * passphrase, or the key. The passphrase is typed by the user at sync time
 * and lives only in the renderer's memory for the session — never on disk —
 * so losing it loses the stored blob, which the settings screen says out
 * loud. What makes the same passphrase work on every machine is the salt
 * travelling INSIDE the envelope: each write derives its key from that
 * write's salt, so the header is enough to re-derive anywhere.
 *
 * Format (v1, matched byte-for-byte by any future reader):
 *
 *     {
 *       "v": 1, "kdf": "pbkdf2-sha256", "iter": 600000,
 *       "salt": "<b64 16B>", "iv": "<b64 12B>", "ct": "<b64 ct+tag>"
 *     }
 *
 * The 16-byte GCM auth tag is appended to the ciphertext — the standard
 * compact spelling, and what makes a wrong passphrase or a corrupted blob
 * fail the tag check instead of yielding garbage.
 */

const FORMAT_VERSION = 1;
const KDF_NAME = 'pbkdf2-sha256';
export const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The serialized envelope: exactly the JSON string the server stores as `data`. */
export type EnvelopeString = string;

interface EnvelopeFields {
  v: number;
  kdf: string;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/**
 * Everything that can go wrong while decrypting, as one error type the IPC
 * layer can render as a message: not the passphrase, a malformed envelope,
 * or a blob that is not ours.
 */
export class SyncCryptoError extends Error {}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decode(value: string, what: string): Buffer {
  const out = Buffer.from(value, 'base64');
  // `Buffer.from` never throws on bad base64 — it silently drops unknown
  // characters — so a mangled field would only surface later as a nonsense
  // length. The round-trip catches that: anything base64 cannot represent
  // does not survive it. Trailing padding is tolerated either way.
  if (b64encode(out).replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new SyncCryptoError(`envelope ${what} is not valid base64`);
  }
  return out;
}

function deriveKey(passphrase: string, salt: Buffer, iter: number): Buffer {
  return pbkdf2Sync(passphrase, salt, iter, KEY_BYTES, 'sha256');
}

/**
 * Encrypt [plaintext] under [passphrase] into the serialized envelope.
 * Fresh salt and IV on every call, so encrypting the same settings twice
 * never produces the same blob.
 */
export function encryptToEnvelope(plaintext: string, passphrase: string): EnvelopeString {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, KDF_ITERATIONS), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const fields: EnvelopeFields = {
    v: FORMAT_VERSION,
    kdf: KDF_NAME,
    iter: KDF_ITERATIONS,
    salt: b64encode(salt),
    iv: b64encode(iv),
    ct: b64encode(ct),
  };
  return JSON.stringify(fields);
}

/**
 * Reverse {@link encryptToEnvelope}. Throws {@link SyncCryptoError} for a
 * malformed envelope and for ANY decryption failure — GCM cannot distinguish
 * "wrong passphrase" from "corrupted blob", and neither message should
 * pretend to know which.
 */
export function decryptEnvelope(envelope: EnvelopeString, passphrase: string): string {
  let fields: unknown;
  try {
    fields = JSON.parse(envelope);
  } catch {
    throw new SyncCryptoError('stored blob is not a sync envelope');
  }
  if (typeof fields !== 'object' || fields === null) {
    throw new SyncCryptoError('stored blob is not a sync envelope');
  }
  const f = fields as Record<string, unknown>;
  if (f['v'] !== FORMAT_VERSION || f['kdf'] !== KDF_NAME) {
    throw new SyncCryptoError(`envelope this app cannot read (v=${String(f['v'])}, kdf=${String(f['kdf'])})`);
  }
  if (typeof f['iter'] !== 'number' || typeof f['salt'] !== 'string' || typeof f['iv'] !== 'string' || typeof f['ct'] !== 'string') {
    throw new SyncCryptoError('envelope is missing required fields');
  }
  if (f['iter'] < 1 || f['iter'] > 10_000_000) {
    // The iteration count is attacker-controlled input (it is in the blob)
    // and feeds PBKDF2's loop — bounded before use.
    throw new SyncCryptoError('envelope iteration count is out of range');
  }
  let salt: Buffer;
  let iv: Buffer;
  let ct: Buffer;
  try {
    salt = b64decode(f['salt'], 'salt');
    iv = b64decode(f['iv'], 'iv');
    ct = b64decode(f['ct'], 'ciphertext');
  } catch (err) {
    throw err instanceof SyncCryptoError ? err : new SyncCryptoError('envelope fields are not valid base64');
  }
  if (salt.length !== SALT_BYTES) throw new SyncCryptoError('envelope salt has the wrong length');
  if (iv.length !== IV_BYTES) throw new SyncCryptoError('envelope IV has the wrong length');
  if (ct.length <= 16) throw new SyncCryptoError('envelope ciphertext is truncated');

  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt, f['iter']), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Wrong passphrase and tampered ciphertext land here identically.
    throw new SyncCryptoError('decryption failed — wrong passphrase or corrupted blob');
  }
}
