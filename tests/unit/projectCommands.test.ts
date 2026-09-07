import { describe, expect, it } from 'vitest';
import { shellQuote, shellQuoteRemotePath } from '../../src/shared/shellQuote';
import {
  FREE_SESSION_NAME_MAX_SUFFIX,
  createSessionCommand,
  fallbackCreateSessionCommand,
  freeSessionNameCommand,
  killSessionCommand,
  mkdirCommand,
  reposCloneCommand,
  renameSessionCommand,
  reposListCommand,
  resolveDirectoryCommand,
  sessionExistsCommand,
} from '@main/projects/commands';

/**
 * Folder paths, folder names and repo slugs all reach a remote POSIX shell.
 * These tests are the injection boundary: they assert that a value which
 * WOULD execute if it were interpolated raw comes out as one inert quoted
 * word instead. `PWNED` is the canary — if it ever appears outside a quoted
 * region in a built command, the escaping regressed.
 */
const HOSTILE = "wei'rd $(touch /tmp/PWNED) `id` ; rm -rf / #";

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
  });

  it("escapes an embedded quote as '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('renders a hostile value as one inert word', () => {
    const quoted = shellQuote(HOSTILE);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // Every `$`, backtick, `;` and `#` stays inside quotes: the only way out
    // of a single-quoted string is a `'`, and each one is escaped.
    expect(quoted).toBe("'wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'");
  });

  it('keeps a newline inside the quoted word', () => {
    expect(shellQuote('a\nrm -rf /')).toBe("'a\nrm -rf /'");
  });
});

describe('shellQuoteRemotePath', () => {
  it('leaves $HOME expandable and quotes the rest', () => {
    expect(shellQuoteRemotePath('~')).toBe('$HOME');
    expect(shellQuoteRemotePath('$HOME')).toBe('$HOME');
    expect(shellQuoteRemotePath('~/git/x')).toBe("$HOME/'git/x'");
    expect(shellQuoteRemotePath('$HOME/git/x')).toBe("$HOME/'git/x'");
  });

  it('quotes an absolute path whole', () => {
    expect(shellQuoteRemotePath('/var/log')).toBe("'/var/log'");
  });

  it('treats a blank path as home', () => {
    expect(shellQuoteRemotePath('   ')).toBe('$HOME');
  });

  it('does not let a hostile segment escape after the $HOME prefix', () => {
    expect(shellQuoteRemotePath(`~/${HOSTILE}`)).toBe(
      "$HOME/'wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'",
    );
  });

  it('does not expand a `$HOME`-lookalike that is not the prefix', () => {
    expect(shellQuoteRemotePath('/tmp/$HOME/x')).toBe("'/tmp/$HOME/x'");
  });
});

describe('directory commands', () => {
  it('builds `cd … && pwd -P` — the canonicalisation that also guards the start path', () => {
    expect(resolveDirectoryCommand('/var/log')).toBe("cd -- '/var/log' && pwd -P");
  });

  it('terminates mkdir option parsing so a leading `-` is not a flag', () => {
    expect(mkdirCommand('/home/a/-rf')).toBe("mkdir -p -- '/home/a/-rf'");
  });

  it('quotes a hostile folder path in every directory command', () => {
    for (const built of [
      resolveDirectoryCommand(`/home/a/${HOSTILE}`),
      mkdirCommand(`/home/a/${HOSTILE}`),
    ]) {
      expect(built).toContain("'/home/a/wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'");
    }
  });
});

describe('sessionExistsCommand', () => {
  it('uses tmux exact-match (`=name`) so a `-2` sibling is not mistaken for it', () => {
    expect(sessionExistsCommand('git-x')).toBe("tmux has-session -t '=git-x' 2>/dev/null");
  });

  it('quotes a hostile name', () => {
    expect(sessionExistsCommand("a'b")).toBe("tmux has-session -t '=a'\\''b' 2>/dev/null");
  });

  it('aims at the session’s own server when the locator found one', () => {
    // The per-session-server world: a bare `tmux` reaches the legacy default
    // socket only, and a session on its own `tmuxctl-*` server is invisible to
    // it — which is how Stop spent days answering "already gone" for a live
    // session. `-S` is the whole difference.
    expect(sessionExistsCommand('git-x', '/tmp/tmux-1000/tmuxctl-42')).toBe(
      "tmux -S '/tmp/tmux-1000/tmuxctl-42' has-session -t '=git-x' 2>/dev/null",
    );
  });

  it('keeps the bare spelling when no socket is known', () => {
    // Both nullish forms — an old probe without the column, and a failed sweep
    // — must land on the legacy command, not on `-S ''`.
    expect(sessionExistsCommand('git-x', null)).toBe("tmux has-session -t '=git-x' 2>/dev/null");
    expect(sessionExistsCommand('git-x', undefined)).toBe(
      "tmux has-session -t '=git-x' 2>/dev/null",
    );
  });
});

describe('freeSessionNameCommand', () => {
  const built = freeSessionNameCommand('git-x');

  it('walks base, base-2, base-3 … entirely on the host', () => {
    expect(built).toContain("__ps_n='git-x'");
    expect(built).toContain('while __ps_taken "$__ps_n"; do');
    expect(built).toContain("__ps_n='git-x'-$__ps_i");
    expect(built).toContain('__ps_i=$((__ps_i+1))');
    expect(built).toContain("printf '%s\\n' \"$__ps_n\"");
  });

  /**
   * The regression this file exists to hold down now that the `+` bug is
   * understood.
   *
   * The walk used to ask a bare `tmux has-session`, which reaches ONE tmux
   * server. This host has more than one — src/main/projects/sessionDirs.ts
   * quotes the log where raw `tmux` answered `can't find session:` for three
   * sessions `pocketshell sessions list` was happily listing — so "free" was
   * being decided against a socket that could not see the session already on
   * screen, and the create underneath is attach-or-create.
   *
   * Both halves are asserted because either alone is the bug: the default
   * socket first (a host whose `TMUX_TMPDIR` the glob does not model must keep
   * today's answer), then every socket in the sweep.
   */
  it('asks EVERY tmux server the user has, not only the default socket', () => {
    expect(built).toContain('tmux has-session -t "=$1" 2>/dev/null && return 0;');
    expect(built).toContain('for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do');
    expect(built).toContain('[ -S "$__ps_s" ] || continue;');
    expect(built).toContain('tmux -S "$__ps_s" has-session -t "=$1" 2>/dev/null && return 0;');
    // The default invocation runs BEFORE the sweep, never instead of it.
    expect(built.indexOf('tmux has-session')).toBeLessThan(built.indexOf('__ps_s'));
  });

  it('bounds the walk', () => {
    expect(built).toContain(`[ "$__ps_i" -gt ${FREE_SESSION_NAME_MAX_SUFFIX} ]`);
    expect(FREE_SESSION_NAME_MAX_SUFFIX).toBe(200);
  });

  it('quotes the base so a hostile name cannot break the loop', () => {
    const hostile = freeSessionNameCommand("a'; touch /tmp/PWNED; :'b");
    // The payload sits inside a quoted region on BOTH interpolations — the
    // seed and the `-$i` concatenation. The socket sweep interpolates nothing
    // at all, so the hostile name never reaches it.
    expect(hostile).toBe(
      '__ps_taken() { ' +
        'tmux has-session -t "=$1" 2>/dev/null && return 0; ' +
        'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
        '[ -S "$__ps_s" ] || continue; ' +
        'tmux -S "$__ps_s" has-session -t "=$1" 2>/dev/null && return 0; ' +
        'done; ' +
        'return 1; ' +
        '}; ' +
        "__ps_n='a'\\''; touch /tmp/PWNED; :'\\''b'; __ps_i=2; " +
        'while __ps_taken "$__ps_n"; do ' +
        'if [ "$__ps_i" -gt 200 ]; then break; fi; ' +
        "__ps_n='a'\\''; touch /tmp/PWNED; :'\\''b'-$__ps_i; " +
        '__ps_i=$((__ps_i+1)); ' +
        "done; printf '%s\\n' \"$__ps_n\"",
    );
    expect(singleQuotesBalanced(hostile)).toBe(true);
  });
});

/**
 * Every command this module builds must leave the shell's quote state where it
 * found it: an odd number of quote DELIMITERS means some interpolated value
 * escaped its quoted region, which is the exact failure that turns a folder
 * name into a command.
 *
 * The `\'` sequences are literal quotes, not delimiters — that is how a quote
 * gets through a single-quoted word at all — so they are removed before
 * counting.
 */
function singleQuotesBalanced(command: string): boolean {
  const delimitersOnly = command.replace(/\\'/g, '');
  return (delimitersOnly.match(/'/g)?.length ?? 0) % 2 === 0;
}

describe('quote balance across every builder', () => {
  const hostiles = [
    HOSTILE,
    "a'b",
    "'",
    "''",
    "a'; touch /tmp/PWNED; :'b",
    '\n; touch /tmp/PWNED',
  ];

  it('holds for every builder and every hostile input', () => {
    for (const value of hostiles) {
      const built = [
        shellQuote(value),
        shellQuoteRemotePath(`/x/${value}`),
        shellQuoteRemotePath(`~/${value}`),
        resolveDirectoryCommand(`/x/${value}`),
        mkdirCommand(`/x/${value}`),
        sessionExistsCommand(value),
        freeSessionNameCommand(value),
        createSessionCommand(value, `/x/${value}`),
        fallbackCreateSessionCommand(value, `/x/${value}`),
        reposListCommand({ scope: 'local', roots: [`/x/${value}`] }),
        reposCloneCommand({ repository: value, root: `/x/${value}`, folder: value }),
      ];
      for (const command of built) {
        expect(singleQuotesBalanced(command), `unbalanced for ${JSON.stringify(value)}`).toBe(
          true,
        );
      }
    }
  });
});

describe('createSessionCommand', () => {
  it('passes --cwd and, deliberately, no --mem', () => {
    expect(createSessionCommand('git-x', '/home/a/git/x')).toBe(
      "pocketshell sessions create 'git-x' -c '/home/a/git/x'",
    );
    expect(createSessionCommand('git-x', '/home/a/git/x')).not.toContain('--mem');
  });

  it('keeps `~` expandable in the cwd', () => {
    expect(createSessionCommand('git-x', '~/git/x')).toBe(
      "pocketshell sessions create 'git-x' -c $HOME/'git/x'",
    );
  });

  it('quotes both the name and the cwd', () => {
    const built = createSessionCommand("a'b", `/home/a/${HOSTILE}`);
    expect(built).toContain("create 'a'\\''b'");
    expect(built).toContain("-c '/home/a/wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'");
  });
});

describe('fallbackCreateSessionCommand', () => {
  it('is the idempotent attach-or-create raw tmux form', () => {
    expect(fallbackCreateSessionCommand('git-x', '/home/a/git/x')).toBe(
      "tmux new-session -A -d -s 'git-x' -c '/home/a/git/x'",
    );
  });
});

describe('reposListCommand', () => {
  it('always passes the scope flag explicitly', () => {
    // With neither flag the helper prints a "defaulting to --local" hint
    // alongside the rows.
    expect(reposListCommand({ scope: 'local' })).toBe('pocketshell repos list --local --json');
    expect(reposListCommand({ scope: 'remote' })).toBe('pocketshell repos list --remote --json');
  });

  it('adds local-only options', () => {
    expect(reposListCommand({ scope: 'local', roots: ['~/git', '/srv/code'], maxDepth: 2 })).toBe(
      "pocketshell repos list --local --json --root $HOME/'git' --root '/srv/code' --max-depth 2",
    );
  });

  it('adds remote-only options', () => {
    expect(reposListCommand({ scope: 'remote', limit: 50 })).toBe(
      'pocketshell repos list --remote --json --limit 50',
    );
  });

  it('ignores options that do not apply to the scope', () => {
    expect(reposListCommand({ scope: 'remote', roots: ['/x'], maxDepth: 3 })).toBe(
      'pocketshell repos list --remote --json',
    );
    expect(reposListCommand({ scope: 'local', limit: 10 })).toBe(
      'pocketshell repos list --local --json',
    );
  });

  it('rejects a non-integer or non-positive numeric option rather than emitting it', () => {
    expect(reposListCommand({ scope: 'remote', limit: 0 })).not.toContain('--limit');
    expect(reposListCommand({ scope: 'remote', limit: 1.5 })).not.toContain('--limit');
    expect(reposListCommand({ scope: 'local', maxDepth: -1 })).not.toContain('--max-depth');
  });

  it('quotes a hostile scan root', () => {
    expect(reposListCommand({ scope: 'local', roots: [`/srv/${HOSTILE}`] })).toContain(
      "--root '/srv/wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'",
    );
  });
});

describe('reposCloneCommand', () => {
  it('builds the plain form', () => {
    expect(reposCloneCommand({ repository: 'octocat/Hello-World' })).toBe(
      "pocketshell repos clone 'octocat/Hello-World'",
    );
  });

  it('adds root, folder and protocol', () => {
    expect(
      reposCloneCommand({
        repository: 'octocat/Hello-World',
        root: '~/git',
        folder: 'hello',
        protocol: 'https',
      }),
    ).toBe("pocketshell repos clone 'octocat/Hello-World' --root $HOME/'git' --folder 'hello' --protocol https");
  });

  it('quotes the repository slug — it comes from the renderer', () => {
    expect(reposCloneCommand({ repository: "o/r'; touch /tmp/PWNED; :" })).toBe(
      "pocketshell repos clone 'o/r'\\''; touch /tmp/PWNED; :'",
    );
  });

  it('quotes the target folder name', () => {
    expect(reposCloneCommand({ repository: 'o/r', folder: HOSTILE })).toContain(
      "--folder 'wei'\\''rd $(touch /tmp/PWNED) `id` ; rm -rf / #'",
    );
  });
});

describe('renameSessionCommand', () => {
  it('forces an exact match on the source and terminates options', () => {
    expect(renameSessionCommand('api', 'api-staging')).toBe(
      "tmux rename-session -t '=api' -- 'api-staging'",
    );
  });

  it('quotes both sides — a foreign session name can carry anything tmux allows', () => {
    // Built from the same quoter rather than spelled out: the point is that
    // BOTH arguments go through it, not what a nested single quote looks like.
    expect(renameSessionCommand(HOSTILE, HOSTILE)).toBe(
      `tmux rename-session -t ${shellQuote(`=${HOSTILE}`)} -- ${shellQuote(HOSTILE)}`,
    );
    // And that the `=` really is inside the quotes, where a hostile name
    // cannot get in front of it.
    expect(renameSessionCommand(HOSTILE, HOSTILE)).toContain("-t '=wei");
  });

  it('aims at the source session’s own server when the locator found one', () => {
    expect(renameSessionCommand('api', 'api-2', '/tmp/tmux-1000/tmuxctl-9')).toBe(
      "tmux -S '/tmp/tmux-1000/tmuxctl-9' rename-session -t '=api' -- 'api-2'",
    );
  });
});

/**
 * Kill — the ONLY destructive command this app issues, and the
 * only one with no undo.
 *
 * The option list was captured from the pinned 0.4.44 Docker fixture the way
 * 00eb3e7 captured `pocketshell agent --help`, and the captures are committed
 * at `tests/unit/fixtures/v0.4.44-*.txt`. Two findings decided this builder:
 *
 *  - `pocketshell sessions` has NO kill verb (create/list/resumable/resume, and
 *    eight kill-ish spellings all answer `No such command`);
 *  - `tmuxctl kill <t> --yes` exists but cannot kill a numerically-named
 *    session (`_resolve_session_target` reads a digit target as a recent-list
 *    index) and issues its own kill with a BARE `-t`.
 */
describe('killSessionCommand', () => {
  it('forces the EXACT match, which is the whole safety of the line', () => {
    expect(killSessionCommand('api')).toBe("tmux kill-session -t '=api'");
  });

  it('cannot be made to prefix-match a neighbour', () => {
    // The dangerous case is NOT "both alive" — there, exact match wins and the
    // bug hides. It is a target that is ALREADY GONE, which is the state a tab
    // bar refreshed on a timer is routinely in: measured on the fixture, a bare
    // `-t api` with only `api-staging` alive exits 0 having killed
    // `api-staging`. `=` fails closed with exit 1 instead.
    const built = killSessionCommand('api');
    expect(built).toContain("'=api'");
    expect(built).not.toContain("-t 'api'");
  });

  it('renders a hostile name as one inert quoted word', () => {
    // `PWNED` is the file-wide canary: it must never appear outside a quoted
    // region. The `=` rides INSIDE the quotes with the name, so a name that
    // opens with a quote cannot break the target apart either.
    expect(killSessionCommand(HOSTILE)).toBe(
      `tmux kill-session -t ${shellQuote(`=${HOSTILE}`)}`,
    );
    expect(killSessionCommand(HOSTILE)).toContain("'=wei'\\''rd");
  });

  it('does not reach for `tmuxctl kill`, whose own kill is not exact-match', () => {
    expect(killSessionCommand('api')).not.toContain('tmuxctl');
    expect(killSessionCommand('api')).not.toContain('--yes');
  });

  it('aims at the session’s own server when the locator found one', () => {
    // The whole of the "Stop session… does nothing" bug: the session was alive
    // on its own per-session tmux server while both the probe and this command
    // asked the default socket. Same exact-match target, one `-S` of aim.
    expect(killSessionCommand('git-aplexer', '/tmp/tmux-1000/tmuxctl-42')).toBe(
      "tmux -S '/tmp/tmux-1000/tmuxctl-42' kill-session -t '=git-aplexer'",
    );
    // And the hostile-name guarantees survive the extra flag: the socket is
    // quoted on its own, the name still inside the `=`.
    const hostile = killSessionCommand(HOSTILE, "/tmp/wi'rd");
    expect(hostile).toContain("-S '/tmp/wi'\\''rd'");
    expect(hostile).toContain(`-t ${shellQuote(`=${HOSTILE}`)}`);
  });
});
