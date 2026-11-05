import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGatewayHosts, readGatewayPairings, writeGatewayPairing, type GatewayPairingRecord } from '../../src/main/ssh/GatewayHosts';
import { normalizeGatewayTarget } from '@pocketshell/core';

/**
 * The local enrollment file as the add-device flow's first writer leaves it:
 * the dial path's reader (readGatewayHosts) and the pairings capability's
 * reader (readGatewayPairings) must agree on every record, hand-provisioned
 * entries must survive a UI write, and an unreadable file must never be
 * clobbered.
 */

const gateway = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'win35' };
const pin = `SHA256:${'a'.repeat(43)}`;
const account = 'unit-account-sub';

function record(overrides: Partial<GatewayPairingRecord> = {}): GatewayPairingRecord {
  return {
    name: 'win35-gateway',
    user: 'user',
    identityFile: 'C:/Users/unit/.ssh/id_unit',
    gateway: normalizeGatewayTarget(gateway)!,
    sshHostKeyFingerprint: pin,
    pinKind: 'host-key',
    keyId: 'C:/Users/unit/.ssh/id_unit',
    accountSub: account,
    ...overrides,
  };
}

const dirs: string[] = [];
function enrollmentPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pocketshell-gateway-enrollment-'));
  dirs.push(dir);
  return join(dir, 'gateway-hosts.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('gateway pairing store', () => {
  it('writes a record both readers see, stamped with the pairing account', () => {
    const path = enrollmentPath();
    writeGatewayPairing(path, record());
    const registrations = readGatewayHosts(path);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.host).toMatchObject({ name: 'win35-gateway', user: 'user', identityFile: 'C:/Users/unit/.ssh/id_unit', gateway });
    expect(registrations[0]!.sshHostKeyFingerprint).toBe(pin);
    expect(readGatewayPairings(path, account)).toEqual([{
      serverUrl: gateway.serverUrl, deviceId: gateway.deviceId, fingerprint: pin, pinKind: 'host-key', keyId: 'C:/Users/unit/.ssh/id_unit',
    }]);
  });

  it('keeps hand-provisioned entries and replaces only the same route', () => {
    const path = enrollmentPath();
    const handProvisioned = [{
      name: 'hand-box', user: 'other', identityFile: 'C:/keys/hand',
      gateway: { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'hand-device' },
      sshHostKeyFingerprint: `SHA256:${'b'.repeat(43)}`,
    }];
    writeFileSync(path, JSON.stringify(handProvisioned));
    writeGatewayPairing(path, record());
    expect(readGatewayHosts(path).map((r) => r.host.name)).toEqual(['hand-box', 'win35-gateway']);
    // Same route again: replaced, not appended.
    writeGatewayPairing(path, record({ name: 'win35-renamed', pinKind: 'fingerprint' }));
    const hosts = readGatewayHosts(path).map((r) => r.host.name);
    expect(hosts).toEqual(['hand-box', 'win35-renamed']);
    expect(readGatewayPairings(path, account).map((p) => p.pinKind)).toEqual(['fingerprint']);
  });

  it('answers pairings only for the signed-in account', () => {
    const path = enrollmentPath();
    writeGatewayPairing(path, record());
    expect(readGatewayPairings(path, 'someone-else')).toEqual([]);
    expect(readGatewayPairings(path, null)).toEqual([]);
  });

  it('refuses to clobber an unreadable or non-array file', () => {
    const broken = enrollmentPath();
    writeFileSync(broken, '{ not json');
    expect(() => writeGatewayPairing(broken, record())).toThrow(/refusing to overwrite/i);
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');
    const nonArray = enrollmentPath();
    writeFileSync(nonArray, JSON.stringify({ name: 'not-an-array' }));
    expect(() => writeGatewayPairing(nonArray, record())).toThrow(/not an array/i);
  });

  it.each([
    ['missing name', { name: '   ' }],
    ['missing user', { user: '' }],
    ['missing identityFile', { identityFile: '' }],
    ['missing key reference', { keyId: '' }],
    ['missing account stamp', { accountSub: '' }],
    ['malformed fingerprint', { sshHostKeyFingerprint: 'SHA256:tooshort' }],
    ['malformed gateway', { gateway: { serverUrl: 'wss://gateway.pocketshell.io' } }],
    ['unknown pin kind', { pinKind: 'advisory' }],
  ] as Array<[string, Record<string, unknown>]>)('refuses an incomplete pairing (%s)', (_label, overrides) => {
    const path = enrollmentPath();
    expect(() => writeGatewayPairing(path, record(overrides))).toThrow(/incomplete/);
    expect(existsSync(path)).toBe(false);
  });

  it('writes atomically: the temp file is gone and the file is the array', () => {
    const path = enrollmentPath();
    writeGatewayPairing(path, record());
    const leftovers = readdirSync(join(path, '..')).filter((f) => f.includes('pocketshell-'));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
  });
});
