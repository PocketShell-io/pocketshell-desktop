import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseSessionsList,
  parseTmuxListSessionsFallback,
  parseSessionEnrichment,
  agentKindFromTmuxOption,
  SESSION_ENRICHMENT_COMMAND,
} from '@main/helper/parsers';
import { mergeSessionEnrichment } from '@main/helper/sessionPathRecovery';

const FIXTURES = resolve(__dirname, '..', '..', 'tests-docker', 'fixtures');
const readFixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

/**
 * The session core of the helper output: the `sessions list` table and the
 * tmux probe that enriches it. The recovery half of that join
 * (`sessionPathRecovery`) is sessionPathRecovery.test.ts, the usage NDJSON
 * parser is usageParsers.test.ts, and the CLI probes (`command -v`,
 * `agent --help`, env rows, the tree registry) are cliParsers.test.ts.
 *
 * Output captured verbatim from the helper the user actually runs (0.4.44,
 * tmux 3.4). Nothing in here is hand-authored.
 *
 * These four files stay host-captured rather than Docker-captured: the
 * fixture image cannot produce any of them. `sessions list` dies on the
 * tmuxctl `list-sessions` tab bug (tmuxctl#6), and `usage --json` has no
 * provider credentials, so every row comes back `status: "error"`. The image
 * and the host now run the same pinned 0.4.44, so the two agree on wire
 * format.
 */
const V44 = resolve(__dirname, 'fixtures');
const readV44 = (name: string): string => readFileSync(resolve(V44, name), 'utf8');

describe('parseSessionsList', () => {
  it('parses the real pocketshell-sessions-list.txt fixture', () => {
    const out = parseSessionsList(readFixture('pocketshell-sessions-list.txt'));
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.name)).toEqual(['claude-main', 'codex', 'opencode-lab']);
    const first = out[0]!;
    expect(first.name).toBe('claude-main');
    expect(first.created).toBe(Date.parse('2026-05-23 10:00:00') / 1000);
    expect(first.attached).toBe(false);
  });

  it('skips the header, footer hints, and blank separator lines', () => {
    const text = `
IDX  SESSION               CREATED
1    one                   2026-01-02 03:04:05

Join a session: pocketshell sessions <id>
Create a new one: pocketshell sessions :<session>
`;
    const out = parseSessionsList(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('one');
  });

  it('handles multi-word session names', () => {
    const text = '1    my cool session      2026-01-02 03:04:05\n';
    const out = parseSessionsList(text);
    expect(out[0]!.name).toBe('my cool session');
  });

  it('returns [] for empty / no-server output', () => {
    expect(parseSessionsList('')).toEqual([]);
    expect(parseSessionsList('no server running on /tmp/tmux-1000/default\n')).toEqual([]);
  });

  it('parses real 0.4.44 output, including names that overflow the column', () => {
    const out = parseSessionsList(readV44('v0.4.44-sessions-list.txt'));
    expect(out).toHaveLength(15);
    expect(out[0]!.name).toBe('git-red-stamp');
    // `git-ai-dev-tools-zoomcamp` is 25 chars and overruns the SESSION column,
    // leaving a single space before the timestamp.
    expect(out[1]!.name).toBe('git-ai-dev-tools-zoomcamp');
    // 0.4.44 changed the footer hints from `pocketshell sessions <id>` to
    // `tmuxctl <id>`; the timestamp anchor skips them either way.
    expect(out.map((s) => s.name).filter((n) => n.startsWith('Join'))).toEqual([]);
  });

  it('leaves path/attached/agentKind for the companion probe to fill', () => {
    const out = parseSessionsList(readV44('v0.4.44-sessions-list.txt'));
    expect(out.every((s) => s.path === null)).toBe(true);
    expect(out.every((s) => s.attached === false)).toBe(true);
    expect(out.every((s) => s.agentKind === null)).toBe(true);
  });
});

describe('SESSION_ENRICHMENT_COMMAND', () => {
  it('is one `tmux -u list-panes -a` probe with the seven fields we parse', () => {
    expect(SESSION_ENRICHMENT_COMMAND).toContain('tmux -u list-panes -a -F');
    for (const field of [
      '#{session_name}',
      '#{window_active}',
      '#{pane_active}',
      '#{pane_current_path}',
      '#{session_path}',
      '#{session_attached}',
      '#{@ps_agent_kind}',
    ]) {
      expect(SESSION_ENRICHMENT_COMMAND).toContain(field);
    }
  });
});

describe('agentKindFromTmuxOption', () => {
  it('maps every value record_agent_kind can write', () => {
    expect(agentKindFromTmuxOption('claude')).toBe('claude');
    expect(agentKindFromTmuxOption('codex')).toBe('codex');
    expect(agentKindFromTmuxOption('opencode')).toBe('opencode');
    expect(agentKindFromTmuxOption('grok')).toBe('grok');
    expect(agentKindFromTmuxOption('shell')).toBe('shell');
  });

  it('is case- and whitespace-insensitive, mirroring the phone', () => {
    expect(agentKindFromTmuxOption('CLAUDE')).toBe('claude');
    expect(agentKindFromTmuxOption(' codex ')).toBe('codex');
  });

  it('returns null for absent or unrecognised options rather than guessing', () => {
    expect(agentKindFromTmuxOption('')).toBeNull();
    expect(agentKindFromTmuxOption(null)).toBeNull();
    expect(agentKindFromTmuxOption(undefined)).toBeNull();
    // Real value observed on the user's box — a kind we do not know.
    expect(agentKindFromTmuxOption('test-engine')).toBeNull();
  });
});

describe('parseSessionEnrichment', () => {
  const map = parseSessionEnrichment(readV44('v0.4.44-tmux-list-panes.txt'));

  it('covers every live session in the capture', () => {
    expect(map.size).toBe(15);
  });

  it('prefers the active pane cwd over an unexpanded session_path', () => {
    // `git-red-stamp` was created with `-c ~/git`, so session_path is the
    // literal `~/git` while the pane reports the resolved absolute path.
    expect(map.get('git-red-stamp')!.path).toBe('/home/alexey/git');
  });

  it('reads the recorded @ps_agent_kind as the authoritative kind', () => {
    expect(map.get('git-ai-book-generator')!.agentKind).toBe('claude');
    expect(map.get('git-dataops')!.agentKind).toBe('codex');
    expect(map.get('git-pocketshell-quse')!.agentKind).toBe('opencode');
    // No option recorded -> foreign session, not a guess.
    expect(map.get('home-alexey')!.agentKind).toBeNull();
    // Recorded but unrecognised -> also null, never mislabeled.
    expect(map.get('git-pocketshell-2')!.agentKind).toBeNull();
  });

  it('reads session_attached as a count', () => {
    expect(map.get('git-game-tester')!.attached).toBe(true);
    expect(map.get('home-alexey-go')!.attached).toBe(true);
    expect(map.get('git-dataops')!.attached).toBe(false);
  });

  it('lets the active pane win over an earlier inactive pane of the session', () => {
    const out = parseSessionEnrichment(
      'main::0::1::/tmp/other::/home/u::0::\n' +
        'main::1::1::/home/u/git/app::/home/u::0::claude\n' +
        'main::1::0::/tmp/split::/home/u::0::claude\n',
    );
    expect(out.get('main')).toEqual({
      path: '/home/u/git/app',
      attached: false,
      agentKind: 'claude',
      socketPath: null,
    });
  });

  it('falls back to session_path when no pane is active', () => {
    const out = parseSessionEnrichment('main::0::0::/tmp/other::/home/u::2::shell\n');
    expect(out.get('main')).toEqual({
      path: '/home/u',
      attached: true,
      agentKind: 'shell',
      socketPath: null,
    });
  });

  it('degrades to an empty map for no-server / short output', () => {
    expect(parseSessionEnrichment('')).toEqual(new Map());
    expect(parseSessionEnrichment('no server running on /tmp/tmux-1000/default\n')).toEqual(
      new Map(),
    );
  });
});

describe('mergeSessionEnrichment', () => {
  it('folds the probe into the bare sessions-list rows', () => {
    const merged = mergeSessionEnrichment(
      parseSessionsList(readV44('v0.4.44-sessions-list.txt')),
      parseSessionEnrichment(readV44('v0.4.44-tmux-list-panes.txt')),
    );
    // The whole point of task 1: no row lands in the Untracked bucket.
    expect(merged.every((s) => s.path !== null)).toBe(true);
    expect(new Set(merged.map((s) => s.path)).size).toBeGreaterThan(1);

    const dataops = merged.find((s) => s.name === 'git-dataops')!;
    expect(dataops.path).toBe('/home/alexey/git/dataops');
    expect(dataops.agentKind).toBe('codex');
    expect(dataops.attached).toBe(false);
    // Three sessions share /home/alexey/git/pocketshell — a real folder group.
    expect(merged.filter((s) => s.path === '/home/alexey/git/pocketshell')).toHaveLength(3);
    expect(merged.filter((s) => s.attached)).toHaveLength(2);
  });

  it('keeps rows untouched when the probe returned nothing for them', () => {
    const bare = parseSessionsList('1    solo   2026-01-02 03:04:05\n');
    expect(mergeSessionEnrichment(bare, new Map())).toEqual(bare);
  });
});

/**
 * The shape that left sessions with a null path — captured, not invented.
 *
 * `v0.4.44-tmux-list-panes-mangled.txt` and `v0.4.44-sessions-list-mangled.txt`
 * are the two sides of the join as a single host really produces them when
 * sshd exports no locale. Reproduced on the fixture image (tmux 3.4) by
 * creating four sessions and running both commands verbatim; the sessions-list
 * side is rendered in tmuxctl's own `f"{idx:<4} {name:<21} {created:<20}"`
 * because tmuxctl's list dies on that image for an unrelated reason (#6).
 *
 * The four rows are the four things that used to go wrong, one each:
 *
 *   git-café-guide   non-ASCII name, so the two tmux clients spell it
 *                    differently and the map lookup misses entirely
 *   git-od-ds        a `::` inside both path columns, which shifted the
 *                    scalar tail one field left
 *   git-game-tester  a dead pane, so `pane_current_path` is empty and only
 *                    `session_path` has the answer
 *   git-dataops      the ordinary case, which must not regress
 */
describe('the missing-cwd capture', () => {
  const panes = readV44('v0.4.44-tmux-list-panes-mangled.txt');
  const list = readV44('v0.4.44-sessions-list-mangled.txt');

  it('recovers a path for every session in the capture', () => {
    const merged = mergeSessionEnrichment(parseSessionsList(list), parseSessionEnrichment(panes));
    expect(merged).toHaveLength(4);
    expect(merged.filter((s) => s.path === null)).toEqual([]);
  });

  it('joins a name the un-`-u`-ed tmux client sanitised to underscores', () => {
    // `tmux list-sessions` (no -u, no UTF-8 locale) prints `git-caf_-guide`;
    // `tmux -u list-panes -a` prints the real bytes. Same session, two
    // spellings, and the exact-key lookup between them missed.
    const merged = mergeSessionEnrichment(parseSessionsList(list), parseSessionEnrichment(panes));
    const row = merged.find((s) => s.name === 'git-caf_-guide')!;
    expect(row.path).toBe('/home/testuser/git/red-stamp-sound');
    expect(row.agentKind).toBe('claude');
  });

  it('keeps a `::` inside a path whole, and the scalar tail with it', () => {
    const map = parseSessionEnrichment(panes);
    expect(map.get('git-od-ds')).toEqual({
      // Not truncated at the delimiter, which is what the old left-to-right
      // split did — it reported `/home/testuser/git/od`. The fixture predates
      // the socket column, so the tail reads null there.
      path: '/home/testuser/git/od::ds',
      attached: false,
      agentKind: null,
      socketPath: null,
    });
  });

  it('falls back to session_path for a pane with no live process', () => {
    expect(parseSessionEnrichment(panes).get('git-game-tester')!.path).toBe(
      '/home/testuser/git/game-tester',
    );
  });

  it('refuses a lenient match that two sessions would both claim', () => {
    // Attaching one session's directory to another is worse than the missing
    // path this leniency exists to fix, so an ambiguous key is dropped.
    const map = parseSessionEnrichment(
      'git-á::1::1::/home/u/a::/home/u/a::0::\n' + 'git-é::1::1::/home/u/b::/home/u/b::0::\n',
    );
    const bare = parseSessionsList('1    git-_    2026-01-02 03:04:05\n');
    expect(mergeSessionEnrichment(bare, map)[0]!.path).toBeNull();
  });
});

describe('parseSessionEnrichment row splitting', () => {
  it('keeps a row whose trailing fields are missing rather than dropping it', () => {
    // A tmux too old for `#{@…}`, or a read cut short, loses the TAIL. The
    // row still says where the session is, which is the one thing it is for.
    const out = parseSessionEnrichment('main::1::1::/home/u/app::/home/u\n');
    expect(out.get('main')).toEqual({
      path: '/home/u/app',
      attached: false,
      agentKind: null,
      socketPath: null,
    });
  });

  it('still skips lines with no path column at all', () => {
    expect(parseSessionEnrichment('main::1::1\nno server running\n')).toEqual(new Map());
  });

  it('trims the name so it matches the trimmed sessions-list name', () => {
    const out = parseSessionEnrichment('  main::1::1::/home/u::/home/u::0::\n');
    expect(out.has('main')).toBe(true);
  });
});

describe('parseTmuxListSessionsFallback', () => {
  it('parses the ::-delimited tmux list-sessions shape', () => {
    const out = parseTmuxListSessionsFallback(
      "main::1716451200::1716454800::1::/home/test/project\n" +
        "build::1716450000::1716454000::0::\n",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'main', created: 1716451200, activity: 1716454800, attached: true, path: '/home/test/project' });
    expect(out[1]).toMatchObject({ name: 'build', attached: false, path: null });
  });

  it('skips the no-server line', () => {
    expect(parseTmuxListSessionsFallback('no server running\n')).toEqual([]);
  });
});

/**
 * The socket column is what lets Stop and rename be AIMED: the helper's
 * ecosystem runs one tmux server per session, so a row without its server is a
 * row nobody can act on. The column was added last, and the parser must keep
 * reading seven-field rows — every capture and fixture in this file is one.
 */
describe('parseSessionEnrichment — the socket column', () => {
  it('reads the eighth field as the server the session lives on', () => {
    const out = parseSessionEnrichment(
      'git-aplexer::1::1::/home/u/git/aplexer::/home/u/git/aplexer::0::claude::/tmp/tmux-1000/tmuxctl-42\n',
    );
    expect(out.get('git-aplexer')).toEqual({
      path: '/home/u/git/aplexer',
      attached: false,
      agentKind: 'claude',
      socketPath: '/tmp/tmux-1000/tmuxctl-42',
    });
  });

  it('leaves socketPath null for a row from before the column existed', () => {
    // Every capture fixture is a seven-field row; an old probe must keep
    // parsing, with null meaning "aim at the default server" to the caller.
    const out = parseSessionEnrichment('main::1::1::/home/u/a::/home/u::0::claude\n');
    expect(out.get('main')).toEqual({
      path: '/home/u/a',
      attached: false,
      agentKind: 'claude',
      socketPath: null,
    });
  });

  it('does not let a `::` inside a path shift the socket out of place', () => {
    // Same rule as the tail scalars have always had: the socket is read from
    // the END, so a path carrying the delimiter cannot steal it. The split of
    // the middle stays the ancestor heuristic's business, exactly as it was
    // before the column existed.
    const out = parseSessionEnrichment(
      'main::1::1::/data/x::y::/data::0::shell::/tmp/tmux-1000/tmuxctl-9\n',
    );
    expect(out.get('main')!.socketPath).toBe('/tmp/tmux-1000/tmuxctl-9');
    expect(out.get('main')!.path).toBe('/data/x::y');
  });

  it('keeps the socket across the active-pane dedup', () => {
    const out = parseSessionEnrichment(
      'main::0::1::/tmp/other::/home/u::0::\n' +
        'main::1::1::/home/u/app::/home/u::0::claude::/tmp/tmux-1000/tmuxctl-3\n',
    );
    expect(out.get('main')!.socketPath).toBe('/tmp/tmux-1000/tmuxctl-3');
  });
});
