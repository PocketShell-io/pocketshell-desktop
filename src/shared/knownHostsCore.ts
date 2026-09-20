/**
 * The pure half of host-key verification (TOFU pinning) — everything both
 * clients agree on, with no Node and no platform APIs.
 *
 * The desktop stores pins as lines in ~/.ssh/known_hosts (`KnownHosts.ts`
 * owns the file and the pattern matching); the browser stores one pin per
 * host in its encrypted local envelope. Both classify a presented key the
 * same way — a pin either matches, conflicts, or does not exist yet — and
 * both key a host by the token OpenSSH uses, so a pin made for
 * `host:22` never collides with one for `host:3205`.
 *
 * This file is renderer-safe: pure types and string/blob builders only.
 */

export interface HostKeyPin {
  /** Key type label, e.g. ssh-ed25519 — the known_hosts field order. */
  keyType: string;
  /** Base64 of the wire public-key blob — directly comparable to a
   * known_hosts line's third field. */
  keyB64: string;
}

/** The three ways a presented key can relate to a stored pin. */
export type KnownHostsVerdict = 'trusted' | 'mismatch' | 'unknown';

/**
 * The token OpenSSH uses to key a host in known_hosts: the bare hostname on
 * the default port, `[host]:port` on any other.
 *
 * Without this, a host reached on two ports shares one pin — connecting to
 * `127.0.0.1:22` and `127.0.0.1:3205` would compare each other's keys and
 * report a mismatch, which is both wrong and a real block: it made every
 * connect to the test fixture fail after its image was rebuilt on a new base.
 */
export function knownHostsToken(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Classify a presented key against the one stored pin (if any). */
export function verifyHostKeyPin(
  pin: HostKeyPin | undefined,
  keyType: string,
  keyB64: string,
): KnownHostsVerdict {
  if (pin === undefined) return 'unknown';
  if (pin.keyType !== keyType || pin.keyB64 !== keyB64) return 'mismatch';
  return 'trusted';
}

/**
 * Decode an SSH public key blob (the raw bytes ssh2 hands to hostVerifier)
 * into the key-type label + the base64 that known_hosts stores.
 *
 * The blob format is RFC 4251 string-list: `<uint32 len><type><key-data...>`.
 * The base64 known_hosts line is the base64 of exactly this blob, so the b64
 * here is directly comparable to a known_hosts entry.
 */
export function decodePublicKeyBlob(blob: Uint8Array): HostKeyPin {
  const len =
    blob.length >= 4
      ? (((blob[0]! << 24) | (blob[1]! << 16) | (blob[2]! << 8) | blob[3]!) >>> 0)
      : 0;
  if (len === 0 || blob.length < 4 + len) return { keyType: 'unknown', keyB64: bytesToBase64(blob) };
  let keyType = '';
  for (let i = 4; i < 4 + len; i++) keyType += String.fromCharCode(blob[i]!);
  return { keyType, keyB64: bytesToBase64(blob) };
}

/** RFC 4648 base64, no platform APIs — identical output to Node's
 * Buffer#toString('base64') and the browser's btoa. */
export function bytesToBase64(bytes: Uint8Array): string {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1]! : 0;
    const b2 = has2 ? bytes[i + 2]! : 0;
    out += table[b0 >> 2];
    out += table[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += has1 ? table[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += has2 ? table[b2 & 0x3f] : '=';
  }
  return out;
}
