/**
 * The command that joins an existing session inside the session PTY.
 *
 * ## The join locates its own server, then attaches
 *
 * The join asks ONE question the host can answer exactly — which of this
 * user's tmux servers holds a session called exactly [sessionName]? — by
 * sweeping the socket directory the way `SESSION_ENRICHMENT_COMMAND` does and
 * running `has-session -t '=<name>'` on each socket. The winner is attached
 * directly with `tmux -S <socket> attach-session -t '=<name>'`. When the sweep
 * finds nothing the join falls back to `tmuxctl <name>`, the helper's own
 * spelling, which still covers the shapes the sweep cannot see: joins by
 * index, tmuxctl's name normalisation, and a `TMUX_TMPDIR` the glob does not
 * model.
 *
 * ## Why the sweep is the join's first arm (the fourth correction)
 *
 * This file has reversed itself three times, and each reversal was reasoned
 * from evidence, so the chain is kept: raw `tmux attach` was replaced by
 * `tmuxctl <name>` after raw attach answered `can't find session` for sessions
 * a freshly rendered list had just shown; the "helper keeps sessions off the
 * default socket" explanation was then corrected (tmuxctl 0.3.4 shells out to
 * a bare `tmux`); then tmuxctl 0.3.5 moved every create onto a PER-SESSION
 * server (`tmuxctl-<name>` sockets), which finally explained the original
 * failure and made `tmuxctl <name>` the only join that could find helper
 * sessions at all.
 *
 * The user's rename bug is the fourth correction, and it breaks
 * `tmuxctl <name>` itself. The per-session-server world gives the helper an
 * identity invariant the raw protocol does not have: the socket is named
 * after the session (`tmux_api.locate_session` resolves a join by checking
 * `robust.socket_for(name)` — literally `tmuxctl-<name>` — and then the
 * default socket, and nothing else). `tmux rename-session` keeps the session
 * on its original server, so the first raw rename leaves session `beta` on
 * `tmuxctl-alpha`: `tmuxctl beta` checks `tmuxctl-beta` and default, finds
 * nothing, and answers `tmux session 'beta' was not found`; `tmuxctl alpha`
 * finds the right server and no session of that name on it. Both names dead,
 * permanently, with no fallback behind them. Measured on the fixture the
 * helper pins (tmuxctl 0.3.5): a fresh session's join dies at `open terminal
 * failed: not a terminal` — resolution SUCCEEDED on an exec channel — while
 * the renamed session's dies at `was not found`. That is the whole of
 * "rename doesn't really rename": the rename committed at the tmux level and
 * orphaned the session out of the only join path that could reach it.
 *
 * The sweep is the same remedy every other command on this host ended up
 * taking (Stop, rename, redraw, the geometry probe): the locator's view of
 * where a session lives is the one fact that survives a rename, so the join
 * derives it from the host instead of from the name. It costs one
 * `has-session` per existing socket on the join path — local round trips
 * inside the PTY's own shell, no extra SSH channel — and it is exact where
 * `tmuxctl` is name-derived.
 *
 * ## What `tmuxctl <name>` is still for
 *
 * The degraded arm, not dead weight. A session the sweep cannot see (a
 * `TMUX_TMPDIR` outside the glob, a server created between the sweep and the
 * attach), a host where only the helper knows the spelling, the helper's own
 * normalisation of foreign session names — these still join the documented
 * way. What is NOT coming back is the raw default-socket attach: a command
 * that can only ever see one server has no arm here.
 *
 * ## Why there is still no ladder under `tmuxctl`
 *
 * Unchanged from the first correction: `pocketshell sessions <name>` is a
 * stale pre-0.4.44 spelling and stays gone, and the raw attach that joins is
 * aimed at a socket the host just proved holds the session — it is not the
 * default-socket guess that failed on a real host.
 *
 * ## Why the PATH is widened first
 *
 * `command -v tmuxctl` can come up empty on a host where tmuxctl is installed,
 * because the helper installs into `~/.local/bin` and the PTY's shell does not
 * always have it. Rather than probe and guess, the join prepends exactly the
 * directories {@link USER_BIN_DIRS} that `bootstrap.ts` prepends when it
 * decides whether the helper is installed at all — so the shell that joins
 * searches the same places as the probe that said the host was ready. The
 * sweep's `tmux` searches the same widened PATH, which is the same assumption
 * `tmux_api._run_tmux` makes when the helper itself shells out to `tmux`.
 *
 * The assignment sits inside a subshell so it lasts exactly as long as the
 * join. Nothing of it outlives the join — nor does the login shell itself: the
 * trailing `exit` (see "why the join ends with `exit`" above) closes the tab's
 * shell once the join is over, so the PATH the app widened is gone with it.
 *
 * ## Why a failed join shouts
 *
 * The PTY runs an interactive login shell and this command is written to its
 * stdin, so a failure leaves the user looking at a prompt — which is
 * indistinguishable from the app having done nothing at all. That ambiguity is
 * how the original bug survived: clicking a session looked like a no-op. The
 * `||` arm turns any non-zero exit — helper missing, session genuinely gone,
 * helper erroring — into a labelled line naming the session that failed. The
 * line is printed BEFORE the shell exits (the `exit` below runs after the
 * whole `||` expression), so the diagnostic is on the pane when the tab dies.
 *
 * ## Why the join ends with `exit`
 *
 * This PTY belongs to one session tab and nothing else — nobody types at the
 * login shell behind it. What the tab shows must therefore be true for as
 * long as the tab's channel lives, and a leftover prompt is the one state
 * that breaks that: when the attach ends under it (a user detach, a
 * worker-side disconnect, a dead session), the login shell kept the channel
 * open, the pool kept handing back the dead client, and clicking the tab
 * showed the corpse forever — the "switching between sessions doesn't work"
 * report. The trailing `exit` closes the shell when the join ends for ANY
 * reason, so the channel closes with it: the pool drops its record through
 * the ordinary `onExit`, the renderer marks the pane gone through the
 * ordinary `shell:exited`, and the next visit to the tab re-joins fresh.
 * Deliberately still no `exec`: the diagnostic above must survive to print.
 */

import { USER_BIN_PATH } from './userBinPath';
import { shellQuote } from './shellQuote';

/**
 * Build the join command for [sessionName].
 *
 * The name is quoted once per SHAPE and each quoting is reused everywhere that
 * shape appears: [name] (the bare word) goes to `tmuxctl` and the failure
 * diagnostic, [target] (`=`-prefixed, tmux's exact-match spelling) goes to the
 * sweep's `has-session` and the aimed `attach-session`. A session called
 * `it's mine` — which tmux permits and {@link sanitisePart} never produces but
 * a foreign session can carry — therefore survives all four positions.
 *
 * The diagnostic passes the name as a printf *argument* rather than splicing
 * it into the format string, so a name containing a `%` cannot turn into a
 * conversion specifier.
 *
 * The optional [socketPath] is a hint from session enrichment. `null` means
 * the default tmux socket is known; `undefined` means no hint is available.
 * A non-undefined hint is tried directly first, then falls back to the full
 * socket sweep if the session moved after listing.
 *
 * The sweep variables are `__ps_*` and live inside the subshell, so nothing
 * leaks into the login shell the user lands in afterwards.
 */
export function sessionAttachCommand(
  sessionName: string,
  ttyVar?: string,
  socketPath?: string | null,
): string {
  const name = shellQuote(sessionName);
  const target = shellQuote(`=${sessionName}`);
  const failure =
    '\\n[PocketShell] could not join session %s. ' +
    'No tmux server on this host has it, and the helper (tmuxctl) could not join it either.\\n';
  const handshake = ttyVar ? `${publishClientTty(ttyVar)}; ` : '';
  const locate =
    '__ps_sock=; ' +
    'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
    '[ -S "$__ps_s" ] || continue; ' +
    `if tmux -S "$__ps_s" has-session -t ${target} 2>/dev/null; then __ps_sock=$__ps_s; break; fi; done; `;
  const locatedJoin =
    'if [ -n "$__ps_sock" ]; then ' +
    `tmux -S "$__ps_sock" attach-session -t ${target}; ` +
    `else tmuxctl ${name}; fi`;
  const directJoin =
    socketPath === undefined
      ? null
      : `${socketPath === null ? 'tmux' : `tmux -S ${shellQuote(socketPath)}`} ` +
        `attach-session -t ${target} 2>/dev/null`;
  const join = directJoin
    ? `(${directJoin}) || (${locate}${locatedJoin})`
    : `${locate}${locatedJoin}`;
  return `( PATH="${USER_BIN_PATH}:$PATH"; ${handshake}${join} ) || printf '${failure}' ${name}; exit`;
}

// ---------------------------------------------------------------------------
// Telling OUR tmux client apart from the user's own
// ---------------------------------------------------------------------------
/**
 * ## Why a joined PTY announces its tty
 *
 * A host's tmux server will happily have several clients attached at once, and
 * `list-clients` lists them all: the tabs this app is holding, the user's own
 * terminal, their phone. Nothing in tmux's own output says which is which, so
 * the joining PTY writes its `$(tty)` into the tmux server's global environment
 * under a name only this app knows.
 *
 * That rendezvous also proves the two halves of a join reached the SAME tmux
 * server. The write happens in the session PTY's login shell; anything reading
 * it back does so from a separate, non-login exec channel, so a host where
 * those resolve `tmux` differently simply finds nothing rather than acting on
 * the wrong server.
 *
   * The per-session-server world quietly demoted this write. `tmux
   * set-environment -g` is a bare command: it reaches the DEFAULT socket, while
   * a helper-created session lives on its own `tmuxctl-<name>` server — so the
   * variable is NOT readable from the server the client actually belongs to.
   * That no longer matters, because the value is a plain string (a tty path)
   * and the readers (`TmuxClientPool.redraw` / `windowSize`) read it back from
   * the default socket, where this write lands, while aiming the command
   * itself at the session's own server via the socket path the pool learns
   * from the enrichment probe at join time (`locateSession` — the same
   * locator Stop and rename use). Before that aiming existed, the readers
   * ran bare `tmux` against the default socket and answered `can't find
   * client` for every session the helper makes, which is how Redraw became a
   * silent no-op; see TmuxClientPool.redraw for the fix.
 *
   * ## What reads it back now
   *
   * This variable was built for `tmux switch-client -c <tty>`: one attached
   * client per connection, moved between sessions instead of being rebuilt, which
   * turned a ~250 ms re-join into a ~10 ms exec on a loopback fixture. Measured
   * on a real host it did not hold up — a switch that worked cost p50 210 ms
   * because an exec channel is round trips and a repaint is 10.7 KB, and most
   * switches did not work at all. The pool now keeps a client per session tab and
   * never moves one, so switching tabs costs nothing and there is no switch
   * command left to read this. See the header of TmuxClientPool for the numbers.
   *
   * The handshake is kept because two readers grew on it: `TmuxClientPool.redraw`
   * and the geometry probe `windowSize` recover our client's tty from it, so
   * their commands are about OUR client and never about whoever else is
   * attached. Both aim their tmux invocation at the session's own server —
   * the socket is the one fact this write cannot carry, and the pool learns it
   * elsewhere for exactly that reason.
 */

/**
 * The tmux global-environment variable a joined PTY publishes its tty under.
 *
 * Non-identifier characters are stripped rather than escaped: this name is
 * spliced into shell text where quoting cannot save a name that is not an
 * identifier in the first place. The caller supplies a random token, so
 * stripping never collides in practice.
 */
export function clientTtyVar(token: string): string {
  return `PS_DESKTOP_TTY_${token.replace(/[^A-Za-z0-9_]/g, '')}`;
}

/**
 * The statement the join command runs before `tmuxctl` to record its own tty.
 *
 * `2>/dev/null` and a `;` rather than `&&`: this is a diagnostic's setup, not
 * part of the join. A host where it fails (no server yet, a tmux too old for
 * `set-environment`, tmux not on PATH) must still join normally, and the only
 * cost of the failure is that `list-clients` cannot be read back with
 * certainty.
 */
function publishClientTty(ttyVar: string): string {
  return `tmux set-environment -g ${ttyVar} "$(tty)" 2>/dev/null`;
}
