import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KnownHosts } from '@main/ssh-config/KnownHosts';

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ED25519 = 'ssh-ed25519';

describe('KnownHosts', () => {
  it('parses a literal hostname entry', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    expect(kh.size).toBe(1);
  });

  it('reports trusted for a matching host + key', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    const result = kh.verify('dev.example.com', ED25519, KEY_A);
    expect(result.trusted).toBe(true);
    expect(result.mismatch).toBe(false);
    expect(result.unknown).toBe(false);
  });

  it('reports mismatch when the host matches but the key differs', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    const result = kh.verify('dev.example.com', ED25519, KEY_B);
    expect(result.mismatch).toBe(true);
    expect(result.trusted).toBe(false);
  });

  it('reports unknown for a host with no entry', () => {
    const kh = KnownHosts.fromText(`dev.example.com ${ED25519} ${KEY_A}\n`);
    const result = kh.verify('other.example.com', ED25519, KEY_A);
    expect(result.unknown).toBe(true);
  });

  it('matches a wildcard (*.example.com) across dot-separated labels', () => {
    // OpenSSH: `*` matches any run of characters including dots, so
    // `*.example.com` matches both single- and multi-level subdomains.
    const kh = KnownHosts.fromText(`*.example.com ${ED25519} ${KEY_A}\n`);
    expect(kh.verify('dev.example.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('prod.example.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('a.b.example.com', ED25519, KEY_A).trusted).toBe(true);
    // a host that does not end in .example.com does not match
    expect(kh.verify('example.com', ED25519, KEY_A).trusted).toBe(false);
    expect(kh.verify('other.org', ED25519, KEY_A).unknown).toBe(true);
  });

  it('matches comma-separated host patterns', () => {
    const kh = KnownHosts.fromText(`a.com,b.com ${ED25519} ${KEY_A}\n`);
    expect(kh.verify('a.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('b.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('c.com', ED25519, KEY_A).unknown).toBe(true);
  });

  it('ignores comments, blank lines, and @revoked markers', () => {
    const text = `
# comment
@revoked evil.com ${ED25519} ${KEY_A}
@cert-authority *.ca.com ${ED25519} ${KEY_A}

good.com ${ED25519} ${KEY_A}
`;
    const kh = KnownHosts.fromText(text);
    expect(kh.size).toBe(1);
    expect(kh.verify('good.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('evil.com', ED25519, KEY_A).unknown).toBe(true);
    expect(kh.verify('x.ca.com', ED25519, KEY_A).unknown).toBe(true);
  });

  it('only matches when the key type agrees', () => {
    const kh = KnownHosts.fromText(`dev.com ${ED25519} ${KEY_A}\n`);
    // Same key bytes but different type label -> unknown (no matching type entry)
    const result = kh.verify('dev.com', 'ssh-rsa', KEY_A);
    expect(result.unknown).toBe(true);
  });

  it('add() then verify() trusts the new host', () => {
    const kh = KnownHosts.fromText('');
    expect(kh.verify('new.com', ED25519, KEY_A).unknown).toBe(true);
    kh.add('new.com', ED25519, KEY_A); // in-memory; path '' means no file write
    expect(kh.verify('new.com', ED25519, KEY_A).trusted).toBe(true);
    // A different key now mismatches (because the host is known)
    expect(kh.verify('new.com', ED25519, KEY_B).mismatch).toBe(true);
  });

  it('keys a non-default port as [host]:port, so two ports do not share a pin', () => {
    // Regression: verify() ignored the port entirely, so 127.0.0.1:22 and
    // 127.0.0.1:3205 compared each other's keys. That reported a spurious
    // mismatch and blocked every connect to the test fixture after its image
    // was rebuilt on a new base.
    const kh = KnownHosts.fromText(`[127.0.0.1]:3205 ${ED25519} ${KEY_A}
`);
    // The pinned port matches.
    expect(kh.verify('127.0.0.1', ED25519, KEY_A, 3205).trusted).toBe(true);
    // The same host on port 22 is a DIFFERENT host and is simply unknown -
    // crucially not a mismatch, which would hard-block the connection.
    const other = kh.verify('127.0.0.1', ED25519, KEY_B, 22);
    expect(other.unknown).toBe(true);
    expect(other.mismatch).toBe(false);
  });

  it('does not bracket the default port', () => {
    const kh = KnownHosts.fromText(`example.com ${ED25519} ${KEY_A}
`);
    expect(kh.verify('example.com', ED25519, KEY_A, 22).trusted).toBe(true);
    // Same key offered on a non-default port is a different entry.
    expect(kh.verify('example.com', ED25519, KEY_A, 2222).unknown).toBe(true);
  });

  it('lets the LAST entry for a host + type decide, so a rotated key is honored', () => {
    // Regression: verify() answered on the FIRST same-type entry, so a key
    // rotated by appending the new pin under the stale one — what a rebuilt
    // test fixture produces — still read as a mismatch and blocked every
    // connect. OpenSSH's rule: the last matching line is authoritative.
    const kh = KnownHosts.fromText(`example.com ${ED25519} ${KEY_A}
example.com ${ED25519} ${KEY_B}
`);
    expect(kh.verify('example.com', ED25519, KEY_B).trusted).toBe(true);
    expect(kh.verify('example.com', ED25519, KEY_A).mismatch).toBe(true);
  });

  it('adds a non-default port in bracketed form', () => {
    const kh = KnownHosts.fromText('');
    kh.add('10.0.0.5', ED25519, KEY_A, 2222);
    expect(kh.verify('10.0.0.5', ED25519, KEY_A, 2222).trusted).toBe(true);
    expect(kh.verify('10.0.0.5', ED25519, KEY_A, 22).unknown).toBe(true);
  });

  it('handles a hashed host entry (|1|salt|hash)', () => {
    // Generate a valid hashed entry for 'dev.example.com'.
    const salt = randomBytes(20);
    const hmac = createHmac('sha1', salt);
    hmac.update('dev.example.com');
    const hash = hmac.digest();
    const token = `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
    const kh = KnownHosts.fromText(`${token} ${ED25519} ${KEY_A}\n`);
    expect(kh.verify('dev.example.com', ED25519, KEY_A).trusted).toBe(true);
    expect(kh.verify('other.example.com', ED25519, KEY_A).unknown).toBe(true);
  });
});
