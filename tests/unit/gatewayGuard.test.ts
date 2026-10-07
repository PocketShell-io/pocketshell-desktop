import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostEntry } from '@pocketshell/core';
import { SshService, GATEWAY_UNSUPPORTED_ERROR } from '../../src/main/ssh/SshService';
import { applyHostsToConfig, mergeSshConfigText } from '../../src/main/ssh-config/SshConfigWriter';

/**
 * Issue #3059 — the desktop has no gateway transport, so a host entry
 * carrying a PRESENT gateway marker (valid, null, malformed — presence alone
 * decides) must be refused before the dial loads a key or opens a socket,
 * and before the config writer touches the user's ~/.ssh/config. Ordinary
 * and link-only hosts stay exactly as they were.
 */

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'device-1' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };

function host(overrides: Record<string, unknown> = {}): HostEntry {
  return {
    name: 'box',
    hostname: 'box.example.com',
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
    ...overrides,
  };
}

describe('SshService.connect refuses a present gateway marker before any dial work', () => {
  it('resolves the stable refusal for a valid target, null, and a malformed marker', async () => {
    const ssh = new SshService();
    for (const marker of [VALID_GATEWAY, null, { deviceId: 42 }, 'wss://surprise']) {
      const result = await ssh.connect({ host: 'box.example.com', user: 'alexey', gateway: marker });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(GATEWAY_UNSUPPORTED_ERROR);
    }
  });

  it('refuses a marker present with an undefined value — presence, not truthiness, decides', async () => {
    const ssh = new SshService();
    const opts = { host: 'box.example.com', user: 'alexey', gateway: undefined };
    const result = await ssh.connect(opts);
    expect(result.error).toBe(GATEWAY_UNSUPPORTED_ERROR);
  });

  it('refuses before the private key is read: a nonexistent key file never surfaces', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({
      host: 'box.example.com',
      user: 'alexey',
      privateKeyPath: '/nonexistent/gateway-guard-key',
      gateway: VALID_GATEWAY,
    });
    // A guard that fired late would fail in loadKey with ENOENT copy instead.
    expect(result.error).toBe(GATEWAY_UNSUPPORTED_ERROR);
  });

  it('leaves an ordinary dial untouched (positive control): it fails on the dial, not the guard', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({
      host: 'box.example.com',
      user: 'alexey',
      privateKeyPath: '/nonexistent/ordinary-key',
    });
    // No gateway marker: the guard must not fire; the missing key file is
    // what stops this dial.
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe(GATEWAY_UNSUPPORTED_ERROR);
    expect(result.error).toContain('key');
  });
});

describe('SshConfigWriter refuses gateway entries before any filesystem mutation', () => {
  it('mergeSshConfigText refuses a valid, null, or malformed marker', () => {
    for (const marker of [VALID_GATEWAY, null, { unexpected: true }]) {
      expect(() => mergeSshConfigText('', [host({ gateway: marker })])).toThrowError(
        /PocketShell gateway/,
      );
    }
  });

  it('refuses a conflicting link + gateway entry rather than writing the link host', () => {
    const both = host({});
    (both as unknown as Record<string, unknown>)['link'] = VALID_LINK;
    (both as unknown as Record<string, unknown>)['gateway'] = null;
    expect(() => mergeSshConfigText('', [both])).toThrowError(/PocketShell gateway/);
  });

  it('applyHostsToConfig leaves the existing config byte-identical when it refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-gateway-'));
    const path = join(dir, 'config');
    const before = '# my config\nHost old\n  HostName old.example.com\n';
    writeFileSync(path, before);
    try {
      expect(() => applyHostsToConfig(path, [host({ name: 'nat-box' }), host({ gateway: VALID_GATEWAY })])).toThrowError(
        /PocketShell gateway/,
      );
      expect(readFileSync(path, 'utf8')).toBe(before);
      // No temp file from an aborted write either.
      expect(readdirSync(dir).filter((f) => f.startsWith('config.pocketshell-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applyHostsToConfig creates nothing when the refused entry is the only one and no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-gateway-'));
    const path = join(dir, 'config');
    try {
      expect(() => applyHostsToConfig(path, [host({ gateway: null })])).toThrowError(/PocketShell gateway/);
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(dir)).toEqual([]); // the writer created nothing beside the empty fixture dir
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still writes ordinary and link-only hosts (legacy behavior unchanged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-gateway-'));
    const path = join(dir, 'config');
    try {
      const linkOnly = host({ name: 'nat-box' });
      (linkOnly as unknown as Record<string, unknown>)['link'] = VALID_LINK;
      const applied = applyHostsToConfig(path, [host({ name: 'plain' }), linkOnly]);
      expect(applied.added).toEqual(['plain', 'nat-box']);
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('Host plain');
      expect(text).toContain('Host nat-box');
      expect(text).not.toContain('gateway');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
