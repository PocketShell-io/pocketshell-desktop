import { describe, expect, it } from 'vitest';
import {
  decryptEnvelope,
  encryptToEnvelope,
  KDF_ITERATIONS,
  SyncCryptoError,
} from '../../src/main/sync/SyncCrypto';

describe('SyncCrypto', () => {
  it('round-trips a plaintext', () => {
    const envelope = encryptToEnvelope('{"hosts":[]}', 'correct horse');
    expect(decryptEnvelope(envelope, 'correct horse')).toBe('{"hosts":[]}');
  });

  it('produces a fresh salt and IV per write', () => {
    const a = JSON.parse(encryptToEnvelope('same', 'pw')) as Record<string, string>;
    const b = JSON.parse(encryptToEnvelope('same', 'pw')) as Record<string, string>;
    expect(a['salt']).not.toBe(b['salt']);
    expect(a['iv']).not.toBe(b['iv']);
  });

  it('emits the documented envelope shape', () => {
    const fields = JSON.parse(encryptToEnvelope('x', 'pw')) as Record<string, unknown>;
    expect(fields['v']).toBe(1);
    expect(fields['kdf']).toBe('pbkdf2-sha256');
    expect(fields['iter']).toBe(KDF_ITERATIONS);
    // 16-byte salt and 12-byte IV, base64.
    expect(Buffer.from(fields['salt'] as string, 'base64').length).toBe(16);
    expect(Buffer.from(fields['iv'] as string, 'base64').length).toBe(12);
    // ct is ciphertext + 16-byte auth tag, at minimum longer than the tag.
    expect(Buffer.from(fields['ct'] as string, 'base64').length).toBeGreaterThan(16);
  });

  it('rejects the wrong passphrase with SyncCryptoError', () => {
    const envelope = encryptToEnvelope('secret', 'right');
    expect(() => decryptEnvelope(envelope, 'wrong')).toThrow(SyncCryptoError);
  });

  it('rejects a tampered ciphertext with SyncCryptoError', () => {
    const envelope = encryptToEnvelope('secret', 'pw');
    const fields = JSON.parse(envelope) as Record<string, string>;
    const ct = Buffer.from(fields['ct'] as string, 'base64');
    ct[0] = ct[0]! ^ 0x01;
    fields['ct'] = ct.toString('base64');
    expect(() => decryptEnvelope(JSON.stringify(fields), 'pw')).toThrow(SyncCryptoError);
  });

  it('rejects non-envelope and truncated blobs', () => {
    expect(() => decryptEnvelope('not json', 'pw')).toThrow(SyncCryptoError);
    expect(() => decryptEnvelope('{"v":2,"kdf":"pbkdf2-sha256"}', 'pw')).toThrow(SyncCryptoError);
    expect(() => decryptEnvelope('[]', 'pw')).toThrow(SyncCryptoError);
    expect(() =>
      decryptEnvelope(JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', iter: 1 }), 'pw'),
    ).toThrow(SyncCryptoError);
  });

  it('rejects a salt or IV of the wrong length', () => {
    const envelope = encryptToEnvelope('x', 'pw');
    const fields = JSON.parse(envelope) as Record<string, string>;
    fields['salt'] = Buffer.alloc(8).toString('base64');
    expect(() => decryptEnvelope(JSON.stringify(fields), 'pw')).toThrow(SyncCryptoError);
  });

  it('bounds the blob-controlled iteration count', () => {
    const envelope = encryptToEnvelope('x', 'pw');
    const fields = JSON.parse(envelope) as Record<string, unknown>;
    fields['iter'] = 500_000_000;
    expect(() => decryptEnvelope(JSON.stringify(fields), 'pw')).toThrow(SyncCryptoError);
  });

  it('round-trips multi-byte plaintext', () => {
    const text = '{"hosts":[{"name":" bäckerei","hostname":"höfn.internal"}]}';
    expect(decryptEnvelope(encryptToEnvelope(text, 'pässword'), 'pässword')).toBe(text);
  });
});
