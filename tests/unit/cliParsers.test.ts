import { describe, expect, it } from 'vitest';
import {
  parseAgentSubcommands,
  parseCommandV,
  parseEnvVarRow,
  parseTreeGet,
  parseTreeReconcile,
  treeUpsertPayload,
} from '@main/helper/cliParsers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Host-captured 0.4.44 fixtures; helper-parsers.test.ts keeps the full note
 * on why these cannot come from the Docker fixture image.
 */
const V44 = resolve(__dirname, 'fixtures');
const readV44 = (name: string): string => readFileSync(resolve(V44, name), 'utf8');

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

/**
 * The capability probe behind the launch picker's Grok option.
 *
 * The positive case cannot be a fixture: `pocketshell agent grok` exists in the
 * helper's repo but in no RELEASED helper, so there is no host to capture a
 * grok-listing `--help` from. Rather than hand-author a whole fake file and let
 * it drift, the grok row is SPLICED into the real 0.4.44 capture — so the shape
 * being parsed stays the shape the helper actually prints, and only the one
 * line under test is synthetic.
 */
describe('parseAgentSubcommands', () => {
  const agentHelp = readV44('v0.4.44-agent-help.txt');

  it('reads the three subcommands out of the real 0.4.44 capture', () => {
    expect(parseAgentSubcommands(agentHelp, 0)).toEqual(['claude', 'codex', 'opencode']);
  });

  it('picks up a grok row appended to that same shape', () => {
    const withGrok = `${agentHelp.trimEnd()}\n  grok      Launch \`grok\` in --dir with first-run prompts suppressed.\n`;
    expect(parseAgentSubcommands(withGrok, 0)).toEqual([
      'claude',
      'codex',
      'opencode',
      'grok',
    ]);
  });

  it('is null, not [], when the host could not be asked', () => {
    // The distinction the launch picker acts on: null keeps the pinned
    // baseline offered, whereas [] would read as "this host launches nothing".
    expect(parseAgentSubcommands(agentHelp, 2)).toBeNull();
    expect(parseAgentSubcommands('', 0)).toBeNull();
    expect(parseAgentSubcommands('pocketshell: command not found\n', 127)).toBeNull();
    expect(parseAgentSubcommands('Usage: pocketshell agent [OPTIONS]\n', 0)).toBeNull();
    expect(parseAgentSubcommands('Commands:\n', 0)).toBeNull();
  });

  it('keeps a wrapped description out of the names', () => {
    // click indents continuation lines to the description column; treating one
    // as a subcommand would invent an engine, and stopping at one would hide
    // every engine listed after it.
    const wrapped = [
      'Commands:',
      '  claude    Launch `claude` in --dir with first-run prompts',
      '            suppressed and the folder env merged.',
      '  codex     Launch `codex` in --dir.',
      '',
    ].join('\n');
    expect(parseAgentSubcommands(wrapped, 0)).toEqual(['claude', 'codex']);
  });

  it('stops at the next unindented section', () => {
    const trailing = ['Commands:', '  claude    Launch `claude`.', '', 'Options:', '  -h, --help'].join(
      '\n',
    );
    expect(parseAgentSubcommands(trailing, 0)).toEqual(['claude']);
  });

  it('survives CRLF, which is how the exec can hand it back', () => {
    expect(parseAgentSubcommands(agentHelp.replace(/\n/g, '\r\n'), 0)).toEqual([
      'claude',
      'codex',
      'opencode',
    ]);
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
