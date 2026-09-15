import { describe, expect, it } from 'vitest';
import { decodeOsc52SetClipboard } from '../../src/shared/osc52';

/** tmux sends `ESC ] 52 ; Pc ; Pt BEL`; xterm hands this function `Pc ; Pt`. */

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64');

describe('decodeOsc52SetClipboard', () => {
  it('decodes a plain tmux yank', () => {
    expect(decodeOsc52SetClipboard(`c;${b64('hello world')}`)).toBe('hello world');
  });

  it('decodes the tmux window-buffer selector', () => {
    expect(decodeOsc52SetClipboard(`p;${b64('primary')}`)).toBe('primary');
    expect(decodeOsc52SetClipboard(`s;${b64('selection')}`)).toBe('selection');
    expect(decodeOsc52SetClipboard(`0;${b64('named')}`)).toBe('named');
  });

  it('accepts an empty selector as the terminal default', () => {
    expect(decodeOsc52SetClipboard(`;${b64('default')}`)).toBe('default');
  });

  it('round-trips multi-byte UTF-8', () => {
    expect(decodeOsc52SetClipboard(`c;${b64('héllo ☃ — ok')}`)).toBe('héllo ☃ — ok');
  });

  it('accepts unpadded and URL-safe base64', () => {
    const padded = b64('any carnal pleasure');
    expect(padded).toMatch(/=+$/);
    expect(decodeOsc52SetClipboard(`c;${padded.replace(/=+$/, '')}`)).toBe(
      'any carnal pleasure',
    );
    expect(decodeOsc52SetClipboard(`c;${b64('a?b/c').replace(/\+/g, '-').replace(/\//g, '_')}`)).toBe(
      'a?b/c',
    );
  });

  it('refuses a "clear the clipboard" request', () => {
    expect(decodeOsc52SetClipboard('c;')).toBeNull();
  });

  it('refuses data with no selector separator', () => {
    expect(decodeOsc52SetClipboard(b64('no semicolon'))).toBeNull();
  });

  it('refuses an unknown clipboard selector', () => {
    expect(decodeOsc52SetClipboard(`x;${b64('hello')}`)).toBeNull();
  });

  it('refuses base64 that does not decode', () => {
    expect(decodeOsc52SetClipboard('c;not base64!')).toBeNull();
  });

  it('refuses a payload over the cap', () => {
    const cap = 1_000_000;
    expect(decodeOsc52SetClipboard(`c;${b64('x').repeat(cap)}`)).toBeNull();
    expect(decodeOsc52SetClipboard(`c;${b64('fits under the cap')}`)).not.toBeNull();
  });

  it('does not throw on truncated UTF-8', () => {
    // A lone 0xC3 is half a two-byte sequence; fatal:false mangles, never throws.
    expect(decodeOsc52SetClipboard(`c;${Buffer.from([0xc3]).toString('base64')}`)).toBe(
      '\uFFFD',
    );
  });
});
