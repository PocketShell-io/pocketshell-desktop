import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyHostsToConfig, existingHostNames, mergeSshConfigText } from '../../src/main/ssh-config/SshConfigWriter';
import { parseSshConfigText } from '../../src/main/ssh-config/SshConfigParser';
import type { HostEntry } from '../../src/shared/types';

function host(overrides: Partial<HostEntry> = {}): HostEntry {
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

describe('existingHostNames', () => {
  it('collects every token of multi-pattern Host lines', () => {
    const names = existingHostNames('Host one two\n  HostName x\nHost three\n');
    expect([...names].sort()).toEqual(['one', 'three', 'two']);
  });

  it('is case-insensitive on the keyword and comment-aware', () => {
    const names = existingHostNames('# host not-a-directive\nhost alpha\n');
    expect(names.has('alpha')).toBe(true);
    expect(names.has('not-a-directive')).toBe(false);
  });

  it('ignores wildcard and negated patterns', () => {
    expect(existingHostNames('Host *.example.com !safe.example.com').size).toBe(0);
    expect(existingHostNames('Host safe.example.com !other').has('safe.example.com')).toBe(true);
  });
});

describe('mergeSshConfigText', () => {
  it('appends only the hosts that are missing', () => {
    const config = 'Host box\n  HostName old.example.com\n  Compression yes\n';
    const { text, added } = mergeSshConfigText(config, [host({ name: 'box' }), host({ name: 'fresh' })]);
    expect(added).toEqual(['fresh']);
    expect(text).toContain('Host fresh');
    // The user's own line survives byte-for-byte, including the unmodelled
    // directive that would be lost in any rewrite.
    expect(text).toContain('Compression yes');
    expect(text).toContain('HostName old.example.com');
  });

  it('produces a block OpenSSH round-trips', () => {
    const source = host({
      name: 'full',
      hostname: 'full.example.com',
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
      proxyJump: 'jump',
      forwardAgent: true,
      localForwards: [{ kind: 'local', listenHost: '127.0.0.1', listenPort: 5432, destHost: 'db', destPort: 5432 }],
      remoteForwards: [{ kind: 'remote', listenHost: '', listenPort: 8080, destHost: 'web', destPort: 80 }],
    });
    const { text } = mergeSshConfigText('', [source]);
    const parsed = parseSshConfigText(text);
    const back = parsed.find((h) => h.name === 'full')!;
    expect(back.hostname).toBe('full.example.com');
    expect(back.port).toBe(2222);
    expect(back.user).toBe('alexey');
    expect(back.identityFile).toBe(`${process.env['HOME']}/.ssh/id_ed25519`);
    expect(back.proxyJump).toBe('jump');
    expect(back.forwardAgent).toBe(true);
    expect(back.localForwards).toEqual([{ kind: 'local', listenHost: '127.0.0.1', listenPort: 5432, destHost: 'db', destPort: 5432 }]);
    expect(back.remoteForwards).toEqual([{ kind: 'remote', listenHost: '127.0.0.1', listenPort: 8080, destHost: 'web', destPort: 80 }]);
  });

  it('does not add the same host twice in one call', () => {
    const { added } = mergeSshConfigText('', [host({ name: 'dup' }), host({ name: 'dup', hostname: 'other' })]);
    expect(added).toEqual(['dup']);
  });

  it('leaves the text untouched when nothing is new', () => {
    const config = 'Host box\n';
    expect(mergeSshConfigText(config, [host({ name: 'box' })])).toEqual({ text: config, added: [] });
  });
});

describe('applyHostsToConfig', () => {
  it('creates the file when missing, adds hosts, then adds no more', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-sync-'));
    const path = join(dir, '.ssh', 'config');
    try {
      expect(applyHostsToConfig(path, [host({ name: 'alpha' })]).added).toEqual(['alpha']);
      expect(existsSync(path)).toBe(true);
      expect(applyHostsToConfig(path, [host({ name: 'alpha' })]).added).toEqual([]);
      // And the file OpenSSH would now read parses back to the host.
      expect(parseSshConfigText(path ? readFileSync(path, 'utf8') : '').map((h) => h.name)).toEqual(['alpha']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
