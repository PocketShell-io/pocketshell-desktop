import { describe, expect, it } from 'vitest';
import { isValidLaunchHostName, parseLaunchHost } from '@main/launchArgs';

/**
 * The command line's one question: did this launch name a host, and which?
 * Every shape here is one a real launch produces — the packaged exe's argv,
 * a dev-mode `electron . --host x`, an OS "open with" dropping a document
 * path where the parser looks for a name.
 */

describe('parseLaunchHost', () => {
  it('reads a bare positional as the host', () => {
    expect(parseLaunchHost(['C:\\Apps\\PocketShell.exe', 'win35'])).toBe('win35');
  });

  it('reads --host VALUE and --host=VALUE wherever they sit', () => {
    expect(parseLaunchHost(['exe', '--host', 'hetzner'])).toBe('hetzner');
    expect(parseLaunchHost(['exe', '--host=hetzner'])).toBe('hetzner');
    expect(parseLaunchHost(['exe', '--no-sandbox', '--host', 'hetzner'])).toBe('hetzner');
  });

  it('skips the dev-mode app path argument', () => {
    expect(parseLaunchHost([ 'electron', '.', 'win35' ])).toBe('win35');
    expect(parseLaunchHost([ 'electron', '.', '--host', 'win35' ])).toBe('win35');
  });

  it('skips the first positional as the app path in the unpackaged spellings', () => {
    // electron CLI order: flags, then the entry path, then the app's argv.
    const dev = { firstPositionalIsAppPath: true } as const;
    expect(parseLaunchHost(['electron', '--no-sandbox', 'C:\\app\\out\\main\\index.js'], dev)).toBeNull();
    expect(parseLaunchHost(['electron', '.', 'win35'], dev)).toBe('win35');
    expect(parseLaunchHost(['electron', '--no-sandbox', 'C:\\app\\out\\main\\index.js', 'win35'], dev)).toBe('win35');
    expect(parseLaunchHost(['electron', '--no-sandbox', '.', '--host=hetzner'], dev)).toBe('hetzner');
    // A path-shaped "open with" positional AFTER the entry path is still none.
    expect(parseLaunchHost(['electron', '.', 'C:\\Users\\me\\notes.txt'], dev)).toBeNull();
  });

  it('reads no host from a plain launch', () => {
    expect(parseLaunchHost(['C:\\Apps\\PocketShell.exe'])).toBeNull();
    expect(parseLaunchHost([])).toBeNull();
    expect(parseLaunchHost(['electron', '.'])).toBeNull();
  });

  it('skips flags it does not own without abandoning the scan', () => {
    expect(parseLaunchHost(['exe', '--some-flag', 'win35'])).toBe('win35');
  });

  it('treats a positional that is not a host-shaped token as none', () => {
    // An "open with" drops a document path here; a path is never a host.
    expect(parseLaunchHost(['exe', 'C:\\Users\\me\\notes.txt'])).toBeNull();
    expect(parseLaunchHost(['exe', './script.sh'])).toBeNull();
  });

  it('treats an ill-formed --host value as none rather than guessing', () => {
    expect(parseLaunchHost(['exe', '--host', 'two words'])).toBeNull();
    expect(parseLaunchHost(['exe', '--host='])).toBeNull();
    expect(parseLaunchHost(['exe', '--host'])).toBeNull();
    // A flag is not a value, even when --host asks for one.
    expect(parseLaunchHost(['exe', '--host', '--new-window'])).toBeNull();
  });

  it('honours only the first positional', () => {
    expect(parseLaunchHost(['exe', 'hetzner', 'win35'])).toBe('hetzner');
  });

  it('accepts the characters a host alias actually has', () => {
    expect(parseLaunchHost(['exe', 'my-host.example'])).toBe('my-host.example');
    expect(parseLaunchHost(['exe', '_tunnel_1'])).toBeNull(); // must start alnum
  });
});

describe('isValidLaunchHostName', () => {
  it('matches the same shapes the parser accepts', () => {
    expect(isValidLaunchHostName('win35')).toBe(true);
    expect(isValidLaunchHostName('a.b.c')).toBe(true);
    expect(isValidLaunchHostName('')).toBe(false);
    expect(isValidLaunchHostName('-flag')).toBe(false);
    expect(isValidLaunchHostName('has space')).toBe(false);
    expect(isValidLaunchHostName('C:\\path')).toBe(false);
  });
});
