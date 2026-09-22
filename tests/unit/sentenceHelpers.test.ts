import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/shared/errors';
import { formatBytes, formatMb, oversizeMessage } from '@pocketshell/core';

/**
 * The two sentence-shaping helpers every error banner and size refusal goes
 * through. Small, but they are the app's VOICE: a wrong branch here shows up
 * as the word "undefined" in front of a user.
 */

describe('errorMessage', () => {
  it('prefers an Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back to the Error name when the message is empty', () => {
    const err = new Error('');
    err.name = 'TypeError';
    expect(errorMessage(err)).toBe('TypeError');
  });

  it('passes a rejected string through instead of yielding undefined', () => {
    // The failure that motivated the helper: `(e as Error).message` on a
    // rejected string is `undefined`, and a banner rendered the word.
    expect(errorMessage('plain refusal')).toBe('plain refusal');
  });

  it('answers unknown for null, undefined, and message-less objects', () => {
    expect(errorMessage(null)).toBe('unknown error');
    expect(errorMessage(undefined)).toBe('unknown error');
    expect(errorMessage({ code: 'EACCES' })).toBe('unknown error');
  });

  it('duck-types the message off a foreign Error-like', () => {
    expect(errorMessage({ message: 'from another realm' })).toBe('from another realm');
    expect(errorMessage({ message: '' })).toBe('unknown error');
  });
});

describe('byteSize', () => {
  it('climbs the B/KB/MB/GB ladder at the 1024 boundaries', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('formats the megabyte figure the refusals quote', () => {
    expect(formatMb(1024 * 1024)).toBe('1.0');
    expect(formatMb(25 * 1024 * 1024)).toBe('25.0');
  });

  it('builds the one oversize sentence with either a path or a label', () => {
    expect(oversizeMessage(50 * 1024 * 1024, 32 * 1024 * 1024, '/tmp/big.mp4')).toBe(
      '/tmp/big.mp4 is 50.0 MB; the limit is 32.0 MB',
    );
    expect(oversizeMessage(150 * 1024 * 1024, 100 * 1024 * 1024, 'screenshot')).toBe(
      'screenshot is 150.0 MB; the limit is 100.0 MB',
    );
  });
});
