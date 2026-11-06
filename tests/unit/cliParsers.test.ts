import { describe, expect, it } from 'vitest';
import {
  parseCommandV,
  parseEnvVarRow,
  parseTreeGet,
  parseTreeReconcile,
  treeUpsertPayload,
} from '@main/helper/cliParsers';

/**
 * Host-captured 0.4.44 fixtures; helper-parsers.test.ts keeps the full note
 * on why these cannot come from the Docker fixture image.
 */

describe('parseCommandV', () => {
  it('returns the path on exit 0', () => {
    expect(parseCommandV('/home/test/.local/bin/pocketshell\n', 0)).toBe(
      '/home/test/.local/bin/pocketshell',
    );
  });
  it('returns null on non-zero exit', () => {
    expect(parseCommandV('', 1)).toBeNull();
    expect(parseCommandV('not found', 127)).toBeNull();
  });
});

describe('parseEnvVarRow', () => {
  it('keeps a well-formed row, mapping has_value → hasValue', () => {
    expect(parseEnvVarRow({ file: '.env', has_value: true, key: 'API_KEY' })).toEqual({
      file: '.env',
      hasValue: true,
      key: 'API_KEY',
    });
    expect(parseEnvVarRow({ file: '.envrc', has_value: false, key: 'EMPTY' })).toEqual({
      file: '.envrc',
      hasValue: false,
      key: 'EMPTY',
    });
  });

  it('degrades a malformed row to nothing rather than smuggling it through', () => {
    // The env editor renders whatever this returns, so a row without a usable
    // key is DROPPED here, not carried into a list of names downstream.
    expect(parseEnvVarRow(null)).toBeUndefined();
    expect(parseEnvVarRow('API_KEY')).toBeUndefined();
    expect(parseEnvVarRow({ file: '.env', has_value: true })).toBeUndefined();
    expect(parseEnvVarRow({ key: '' })).toBeUndefined();
    expect(parseEnvVarRow({ key: 42 })).toBeUndefined();
  });

  it('tolerates a missing file name — the key is the load-bearing field', () => {
    expect(parseEnvVarRow({ has_value: true, key: 'LONE' })).toEqual({
      file: '',
      hasValue: true,
      key: 'LONE',
    });
  });
});

describe('tree registry parsing (pocketshell tree)', () => {
  const GOOD = {
    nodes: [
      { session: 'git-x', order: 1, folder_path: '/home/u/git/x', collapsed: false },
      { session: 'lone', order: 2 },
      'rubbish',
      null,
    ],
    version: 7,
  };

  it('parses the envelope, maps folder_path, and drops malformed rows', () => {
    const nodes = parseTreeGet(JSON.stringify(GOOD));
    // The 'lone' row (no folder_path) and the non-object rows are DROPPED,
    // not defaulted: an empty path would place the session somewhere false
    // rather than nowhere.
    expect(nodes).toEqual([
      { session: 'git-x', order: 1, folderPath: '/home/u/git/x', collapsed: false },
    ]);
  });

  it('distinguishes an empty registry from no registry at all', () => {
    expect(parseTreeGet('{"nodes": [], "version": 0}')).toEqual([]);
    for (const garbage of ['', 'not json', '{"version": 1}', '{"nodes": {}}', '[1,2]']) {
      expect(parseTreeGet(garbage)).toBeNull();
    }
  });

  it('builds the upsert payload in the helper snake_case wire shape', () => {
    const body = treeUpsertPayload('hetzner', [
      { session: 'git-x', order: 1, folderPath: '/home/u/git/x', collapsed: true },
    ]);
    expect(JSON.parse(body)).toEqual({
      host: 'hetzner',
      nodes: [{ session: 'git-x', order: 1, folder_path: '/home/u/git/x', collapsed: true }],
    });
  });

  it('parses reconcile only when all three name lists are present', () => {
    expect(
      parseTreeReconcile(JSON.stringify({ alive: ['a'], gone: ['b'], added: ['c'] })),
    ).toEqual({ alive: ['a'], gone: ['b'], added: ['c'] });
    expect(parseTreeReconcile(JSON.stringify({ alive: ['a'], gone: ['b'] }))).toBeNull();
    expect(parseTreeReconcile('')).toBeNull();
  });
});
