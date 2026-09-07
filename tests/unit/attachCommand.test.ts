import { describe, expect, it } from 'vitest';
import { clientTtyVar, sessionAttachCommand } from '../../src/shared/attachCommand';
import { shellQuote } from '../../src/shared/shellQuote';
import { USER_BIN_DIRS } from '../../src/shared/userBinPath';

/**
 * These pin the join contract, which is the thing that actually broke: the app
 * created and listed sessions through the helper but attached with raw
 * `tmux attach -t`, so every session in a freshly rendered list failed with
 * `can't find session`. The join that replaced it went through `tmuxctl`, and
 * the rename bug then broke THAT: tmuxctl resolves a name against the socket
 * derived from it, so a renamed session answered `was not found` under both
 * names. The join now locates the session's own server host-side and attaches
 * there, keeping `tmuxctl` as the arm for what the sweep cannot see — see
 * src/shared/attachCommand.ts for the four-correction history.
 */
/**
 * The inverse of POSIX single-quoting, used to prove a quoted name round-trips.
 * A quoted word is a concatenation of `'...'` runs and backslash escapes; this
 * walks it the way `sh` word-splitting would, so a name that survives is one
 * the shell passes through as a single argument.
 */
function posixUnquote(quoted: string): string {
  let out = '';
  let i = 0;
  while (i < quoted.length) {
    const ch = quoted[i];
    if (ch === "'") {
      const end = quoted.indexOf("'", i + 1);
      // An unterminated run means the quoting is broken — the caller's assertion
      // should fail rather than this silently papering over it.
      if (end === -1) return `${out}<unterminated>`;
      out += quoted.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '\\') {
      out += quoted[i + 1] ?? '';
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

describe('sessionAttachCommand', () => {
  const command = sessionAttachCommand('git-red-stamp-sound');

  it('locates the session by sweeping the host’s tmux sockets', () => {
    // The rename bug: tmuxctl resolves a join against the socket DERIVED from
    // the name (`tmuxctl-<name>`) plus the default socket, so the first raw
    // rename left the session unjoinable under EITHER name. The sweep asks the
    // host where the session actually lives instead.
    expect(command).toContain('for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*');
    expect(command).toContain('[ -S "$__ps_s" ] || continue;');
    // Exact match on every socket, and silent when a socket says no.
    expect(command).toContain("has-session -t '=git-red-stamp-sound' 2>/dev/null");
  });

  it('attaches on the socket the sweep found, exact-match', () => {
    expect(command).toContain('tmux -S "$__ps_sock" attach-session -t ');
    expect(command).toContain("attach-session -t '=git-red-stamp-sound'");
  });

  it('keeps tmuxctl as the arm for everything the sweep cannot see', () => {
    // Ids, tmuxctl's name normalisation, a TMUX_TMPDIR the glob does not
    // model: the helper's documented join remains the degraded arm.
    expect(command).toContain("else tmuxctl 'git-red-stamp-sound'");
    expect(command.match(/tmuxctl '/g)).toHaveLength(1);
  });

  it('joins with a bare name — never `:name`, which would CREATE', () => {
    // `Create a new one: tmuxctl :<session>`. A join that silently created a
    // session would turn a stale row into a brand-new empty pane.
    expect(command).not.toContain(":'git-red-stamp-sound'");
    expect(command).not.toMatch(/tmuxctl\s+:/);
    // And the exact-match target is `=name`, not the `:` create spelling.
    expect(command).toContain("'=git-red-stamp-sound'");
  });

  it('never attaches to the default socket by guesswork', () => {
    // The raw attach that failed on a real host was the DEFAULT-socket
    // spelling — blind to every per-session server. The only attach here is
    // the one pointed at a socket the host just proved holds the session.
    expect(command.match(/attach-session/g)).toHaveLength(1);
    expect(command).toContain('tmux -S "$__ps_sock" attach-session');
  });

  it('searches the same user-bin dirs bootstrap probes, so the two agree', () => {
    // A host where bootstrap finds tmuxctl in ~/.local/bin but the PTY does not
    // is the bug where the app reports the host is ready and the join fails.
    for (const dir of USER_BIN_DIRS) {
      expect(command).toContain(dir);
    }
    expect(command).toContain('$PATH');
  });

  it('carries no pre-0.4.44 helper spelling (hard cuts, no shims)', () => {
    expect(command).not.toContain('pocketshell sessions');
  });

  it('scopes the PATH change to a subshell', () => {
    expect(command).toMatch(/^\(\s*PATH=/);
    // The assignment is inside the parens, not before them, and the subshell
    // stays open across the whole locate-and-join, closing only before the
    // failure diagnostic.
    expect(command.indexOf('PATH=')).toBeGreaterThan(command.indexOf('('));
    expect(command.indexOf(') || printf')).toBeGreaterThan(command.indexOf('tmuxctl'));
  });

  it('reports a failed join instead of leaving a silent prompt', () => {
    // Clicking a session and getting an untouched prompt is exactly how the
    // original bug read as "nothing happened".
    expect(command).toContain('||');
    expect(command).toContain('printf');
    expect(command).toContain('PocketShell');
    expect(command).toContain('tmuxctl');
  });

  it('does not exec, and ends the tab shell when the join ends', () => {
    expect(command).not.toContain('exec ');
    // The trailing `exit` is the corpse-tab fix: when the attach ends (detach,
    // worker-side disconnect, dead session) the login shell behind the tab's
    // PTY must close with it, so the pool drops the client and the next visit
    // re-joins — never a live prompt parked behind a dead session. It comes
    // last, after the `||` diagnostic, so a failed join still prints its line.
    expect(command.trim().endsWith('; exit')).toBe(true);
    expect(command.indexOf('; exit')).toBeGreaterThan(command.indexOf('printf'));
  });

  it('passes the name to printf as an argument, not as the format string', () => {
    // A session called `100%s` spliced into a format string would consume the
    // next argument (or read garbage); as an argument it is inert data.
    const percent = sessionAttachCommand('100%s-done');
    expect(percent).toContain("printf '");
    // The only conversion in the format belongs to the format, and the name
    // sits after the closing quote of the format string.
    const formatEnd = percent.indexOf("' '100%s-done'");
    expect(formatEnd).toBeGreaterThan(-1);
  });

  it('quotes a name carrying a single quote everywhere it appears', () => {
    const nasty = sessionAttachCommand("it's mine");
    // Twice as the bare word — tmuxctl and the failure line. The aimed probe
    // and attach quote the WHOLE `=name` word (`'=it'\''s mine'`), so the
    // standalone escaped form does not surface there, but the name is still
    // inside quotes at those two positions.
    expect(nasty.match(/'it'\\''s mine'/g)).toHaveLength(2);
    expect(nasty).toContain("'=it'\\''s mine'");
    expect(nasty).not.toContain("'it's mine'");
  });

  it('cannot be broken out of by a name built to close the quote', () => {
    const payload = "x'; rm -rf ~; echo '";
    const injected = sessionAttachCommand(payload);

    // The payload's text DOES appear — inside the quotes, which is the point.
    // What must never happen is it appearing at top level, so the property to
    // assert is that every `'` originating in the name arrives as the POSIX
    // close-escape-reopen dance `'\''` rather than as a bare closing quote.
    const escaped = shellQuote(payload);
    // Round-trip through the inverse of POSIX single-quoting: a quoted word is
    // a concatenation of '...' segments and \-escapes. If unquoting yields the
    // original name exactly, the shell will pass it as ONE argument and none of
    // it was ever interpreted.
    expect(posixUnquote(escaped)).toBe(payload);

    // And the built command embeds exactly that form, twice — join and
    // diagnostic — with nothing of the name outside it.
    expect(injected.split(escaped)).toHaveLength(3);
  });
});

describe('sessionAttachCommand with a cached socket path', () => {
  it('tries the known socket before starting the multi-socket sweep', () => {
    const command = sessionAttachCommand(
      'git-red-stamp-sound',
      undefined,
      '/tmp/tmux-1000/tmuxctl-git-red-stamp-sound',
    );
    const direct =
      "tmux -S '/tmp/tmux-1000/tmuxctl-git-red-stamp-sound' attach-session -t '=git-red-stamp-sound'";

    expect(command).toContain(direct);
    expect(command.indexOf(direct)).toBeLessThan(command.indexOf('for __ps_s'));
    // A stale list hint still gets the old exact socket sweep as a recovery
    // arm; it is after the direct attach and therefore not on the normal path.
    expect(command).toContain("has-session -t '=git-red-stamp-sound'");
  });

  it('uses a known default socket without treating it as an unknown guess', () => {
    const command = sessionAttachCommand('main', undefined, null);

    expect(command).toContain("tmux attach-session -t '=main'");
    expect(command).toContain('for __ps_s');
  });
});

describe('shellQuote (as attachCommand uses it)', () => {
  it('wraps a plain value', () => {
    expect(shellQuote('main')).toBe("'main'");
  });

  it('escapes an embedded quote by closing, escaping, and reopening', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('leaves every other shell metacharacter to the quotes', () => {
    expect(shellQuote('$(id) `id` && rm')).toBe("'$(id) `id` && rm'");
  });
});

/**
 * The handshake half of the join — the line that lets `list-clients` say which
 * of a host's tmux clients are this app's. These pin the two properties that
 * keep a diagnostic from ever costing a join: publishing the tty must be
 * optional and must not be able to fail the join, and the join itself must be
 * byte-for-byte what it always was when no handshake is asked for.
 */
describe('sessionAttachCommand with a tty handshake', () => {
  const ttyVar = clientTtyVar('a1b2c3');
  const command = sessionAttachCommand('git-red-stamp-sound', ttyVar);

  it('is exactly the old command when no variable is given', () => {
    // The handshake is an optimisation's setup. A caller that does not want it
    // must not get a different join.
    expect(sessionAttachCommand('main')).toBe(
      sessionAttachCommand('main', undefined),
    );
    expect(sessionAttachCommand('main')).not.toContain('set-environment');
  });

  it('records the tty inside the same subshell as the PATH widening', () => {
    // Outside the subshell it would run before PATH is set, which is the one
    // place tmux might not be found on the hosts this app targets.
    expect(command).toMatch(/^\(\s*PATH=/);
    expect(command.indexOf('set-environment')).toBeGreaterThan(command.indexOf('PATH='));
    expect(command.indexOf('set-environment')).toBeLessThan(command.indexOf('tmuxctl'));
  });

  it('cannot fail the join when the handshake fails', () => {
    // Silenced and sequenced with `;`, never `&&`: a host with no tmux server
    // yet, or a tmux too old for set-environment, must still join normally and
    // simply not get the fast switch.
    expect(command).toContain('2>/dev/null;');
    expect(command).not.toContain('set-environment -g ' + ttyVar + ' "$(tty)" &&');
  });

  it('still joins with exactly one tmuxctl invocation', () => {
    expect(command.match(/tmuxctl '/g)).toHaveLength(1);
    expect(command).toContain("tmuxctl 'git-red-stamp-sound'");
  });

  it('does not smuggle in a second way to attach', () => {
    // `set-environment` is not a join; nothing here may look like one.
    expect(command).not.toContain('tmux attach');
    expect(command).not.toContain('switch-client');
  });
});

describe('clientTtyVar', () => {
  it('produces a shell identifier, whatever the token looks like', () => {
    // The name is spliced into `${v#NAME=}`, where a non-identifier cannot be
    // rescued by quoting.
    expect(clientTtyVar('abc123')).toBe('PS_DESKTOP_TTY_abc123');
    expect(clientTtyVar('a-b.c/$(id)')).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('is prefixed, so an entry left on a tmux server is identifiable', () => {
    // These outlive the app: a connection cannot unset its own variable,
    // because by the time it closes there is no channel left to unset it on.
    expect(clientTtyVar('x')).toMatch(/^PS_DESKTOP_TTY_/);
  });
});
