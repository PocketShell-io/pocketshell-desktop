import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  normalizeGatewayTarget,
  normalizeSha256Fingerprint,
  type GatewayPairingSummary,
  type GatewayTransportTarget,
  type HostEntry,
} from '@pocketshell/core';
import { normalizeNativeWindowsHostCli, type NativeWindowsHostCliPolicy } from '../helper/NativeWindowsHostCli.js';

export interface GatewayHostRegistration {
  host: HostEntry;
  sshHostKeyFingerprint: string;
  nativeWindowsCli?: NativeWindowsHostCliPolicy;
}

/** One pairing the add-device flow writes: an enrollment plus its account stamp. */
export interface GatewayPairingRecord {
  name: string;
  user: string;
  identityFile: string;
  gateway: GatewayTransportTarget;
  sshHostKeyFingerprint: string;
  pinKind: 'host-key' | 'fingerprint';
  keyId: string;
  /** The signed-in account the pairing belongs to (`sub` from the ID token). */
  accountSub: string;
}

/** Local enrollment file: provision the fingerprint through trusted host access. */
export function readGatewayHosts(path: string): GatewayHostRegistration[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const r = entry as Record<string, unknown>;
    const gateway = normalizeGatewayTarget(r.gateway);
    const nativeWindowsCli = r.nativeWindowsCli === undefined ? undefined : normalizeNativeWindowsHostCli(r.nativeWindowsCli);
    if (nativeWindowsCli === null || (nativeWindowsCli?.transport === 'openssh-cmd-git-bash'
      && nativeWindowsCli.deviceId !== gateway?.deviceId)) return [];
    const pin = typeof r.sshHostKeyFingerprint === 'string'
      ? normalizeSha256Fingerprint(r.sshHostKeyFingerprint) : null;
    if (!gateway || !pin || typeof r.name !== 'string' || !r.name.trim()
      || typeof r.user !== 'string' || typeof r.identityFile !== 'string') return [];
    return [{
      host: {
        name: r.name, hostname: gateway.deviceId, port: 22, user: r.user,
        identityFile: r.identityFile, gateway, proxyJump: null, forwardAgent: false,
        localForwards: [], remoteForwards: [], fromConfig: false,
      },
      sshHostKeyFingerprint: pin,
      ...(nativeWindowsCli ? { nativeWindowsCli } : {}),
    }];
  });
}

/**
 * Add or replace one pairing enrollment in the file at [path], replacing any
 * existing record for the same route (canonical serverUrl + deviceId). The
 * write is atomic — temp file + rename in the same directory, the
 * SshConfigWriter pattern — so a crash mid-write cannot leave a truncated
 * enrollment file. A file that does not parse as an array is REFUSED, never
 * overwritten: it may be hand-provisioned trust (docs/gateway.md), and
 * PocketShell does not guess at trust.
 */
export function writeGatewayPairing(path: string, record: GatewayPairingRecord): void {
  const gateway = normalizeGatewayTarget(record.gateway);
  const fingerprint = normalizeSha256Fingerprint(record.sshHostKeyFingerprint);
  if (!gateway || !fingerprint
    || typeof record.name !== 'string' || !record.name.trim()
    || typeof record.user !== 'string' || !record.user.trim()
    || typeof record.identityFile !== 'string' || !record.identityFile.trim()
    || typeof record.keyId !== 'string' || !record.keyId.trim()
    || typeof record.accountSub !== 'string' || !record.accountSub.trim()
    || (record.pinKind !== 'host-key' && record.pinKind !== 'fingerprint')) {
    throw new Error('Refusing to enroll an incomplete gateway pairing.');
  }
  let entries: unknown[];
  if (existsSync(path)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('The gateway enrollment file is not valid JSON; refusing to overwrite it.'); }
    if (!Array.isArray(raw)) throw new Error('The gateway enrollment file is not an array; refusing to overwrite it.');
    entries = raw;
  } else {
    entries = [];
  }
  const kept = entries.filter((entry) => {
    const target = normalizeGatewayTarget((entry as Record<string, unknown> | null)?.['gateway']);
    return target === null || target.serverUrl !== gateway.serverUrl || target.deviceId !== gateway.deviceId;
  });
  kept.push({ ...record, gateway, sshHostKeyFingerprint: fingerprint, pairedAt: new Date().toISOString() });
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  const tmp = `${path}.pocketshell-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode });
  renameSync(tmp, path);
}

/**
 * The saved pairings the signed-in account created through the add-device
 * flow: a record counts only when it carries the account stamp, a key
 * reference and a pin kind. Hand-provisioned enrollments (docs/gateway.md)
 * are hosts — they dial, but they are nobody's pairing.
 */
export function readGatewayPairings(path: string, accountSub: string | null): GatewayPairingSummary[] {
  if (accountSub === null) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const r = entry as Record<string, unknown>;
    const gateway = normalizeGatewayTarget(r.gateway);
    const pin = typeof r.sshHostKeyFingerprint === 'string' ? normalizeSha256Fingerprint(r.sshHostKeyFingerprint) : null;
    if (!gateway || !pin || r.accountSub !== accountSub
      || typeof r.keyId !== 'string' || !r.keyId.trim()
      || (r.pinKind !== 'host-key' && r.pinKind !== 'fingerprint')
      || typeof r.name !== 'string' || !r.name.trim()
      || typeof r.user !== 'string' || typeof r.identityFile !== 'string') return [];
    return [{
      serverUrl: gateway.serverUrl,
      deviceId: gateway.deviceId,
      fingerprint: pin,
      pinKind: r.pinKind,
      keyId: r.keyId,
    }];
  });
}
