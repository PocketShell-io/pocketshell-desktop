import { readFileSync } from 'node:fs';
import { normalizeGatewayTarget, normalizeSha256Fingerprint, type HostEntry } from '@pocketshell/core';
import { normalizeNativeWindowsHostCli, type NativeWindowsHostCliPolicy } from '../helper/NativeWindowsHostCli.js';

export interface GatewayHostRegistration {
  host: HostEntry;
  sshHostKeyFingerprint: string;
  nativeWindowsCli?: NativeWindowsHostCliPolicy;
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
    if (nativeWindowsCli === null) return [];
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
