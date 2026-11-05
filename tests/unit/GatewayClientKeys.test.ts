import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayClientKey, listGatewayClientKeys, resolveGatewayKeyPath } from '../../src/main/ssh/GatewayClientKeys';

/**
 * The client-key surface against fixture files: existing ~/.ssh keys with a
 * private half beside them, generated keys in the registry, the fingerprint
 * the user compares on the host, and keyId → private-path resolution for the
 * pairing's identityFile.
 */

const ED25519_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAUhrHdfJRpW3QBKnJ7YipiG6tEJp4K+o7EDMt7zFjKNz unit@host';
const RSA_PUB = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDRmEET9mHNu0ukVQAA unit-rsa';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pocketshell-gateway-keys-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('gateway client keys', () => {
  it('lists existing ~/.ssh keys that have a private half, with ssh-keygen fingerprints', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'id_ed.pub'), `${ED25519_PUB}\n`);
    writeFileSync(join(dir, 'id_ed'), 'PRIVATE');
    writeFileSync(join(dir, 'orphan.pub'), ED25519_PUB); // no private half: not offerable
    const keys = listGatewayClientKeys({ sshDir: dir, registryPath: join(dir, 'registry.json') });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(join(dir, 'id_ed'));
    expect(keys[0]!.label).toBe('id_ed');
    expect(keys[0]!.publicKey).toBe(ED25519_PUB);
    expect(keys[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('generates a key whose private half stays local and whose id resolves back to it', () => {
    const dir = scratch();
    const managedDir = join(dir, 'managed');
    const registryPath = join(dir, 'registry.json');
    const key = createGatewayClientKey({ managedDir, registryPath, label: 'unit key' });
    expect(key.id).toMatch(/^psk-[0-9a-f]{16}$/);
    expect(key.label).toBe('unit key');
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(key.publicKey).toMatch(/^ssh-ed25519 /);
    expect(existsSync(join(managedDir, key.id))).toBe(true);
    expect(resolveGatewayKeyPath(registryPath, key.id)).toBe(join(managedDir, key.id));
    // The registry now lists it; the private file existing keeps it listed.
    expect(listGatewayClientKeys({ sshDir: join(dir, 'no-ssh'), registryPath }).map((k) => k.id)).toEqual([key.id]);
  });

  it('skips registry rows whose private file disappeared', () => {
    const dir = scratch();
    const registryPath = join(dir, 'registry.json');
    const key = createGatewayClientKey({ managedDir: join(dir, 'managed'), registryPath, label: 'unit key' });
    rmSync(join(dir, 'managed', key.id));
    expect(listGatewayClientKeys({ sshDir: dir, registryPath })).toEqual([]);
    expect(resolveGatewayKeyPath(registryPath, key.id)).toBeNull();
  });

  it('resolves an existing key by its own path and refuses a missing one', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'id_rsa'), 'PRIVATE');
    writeFileSync(join(dir, 'id_rsa.pub'), RSA_PUB);
    const registryPath = join(dir, 'registry.json');
    expect(resolveGatewayKeyPath(registryPath, join(dir, 'id_rsa'))).toBe(join(dir, 'id_rsa'));
    expect(resolveGatewayKeyPath(registryPath, join(dir, 'missing'))).toBeNull();
    expect(resolveGatewayKeyPath(registryPath, '')).toBeNull();
  });

  it('refuses an unreadable registry instead of overwriting it', () => {
    const dir = scratch();
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, '{ not json');
    expect(() => createGatewayClientKey({ managedDir: join(dir, 'm'), registryPath, label: 'x' })).toThrow(/refusing to overwrite/i);
    const listed = listGatewayClientKeys({ sshDir: dir, registryPath });
    expect(listed).toEqual([]);
  });

  it.each([['', /name of 1–200/], ['   ', /name of 1–200/], ['x'.repeat(201), /name of 1–200/]])(
    'refuses a bad label (%j)', (label, pattern) => {
      expect(() => createGatewayClientKey({ managedDir: scratch(), registryPath: join(scratch(), 'r.json'), label }))
        .toThrow(pattern);
    });

  it('skips a shapeless .pub file but still lists the rest', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'broken.pub'), 'not a public key at all');
    writeFileSync(join(dir, 'broken'), 'PRIVATE');
    writeFileSync(join(dir, 'good.pub'), ED25519_PUB);
    writeFileSync(join(dir, 'good'), 'PRIVATE');
    const keys = listGatewayClientKeys({ sshDir: dir, registryPath: join(dir, 'r.json') });
    expect(keys.map((k) => k.label)).toEqual(['good']);
  });
});
