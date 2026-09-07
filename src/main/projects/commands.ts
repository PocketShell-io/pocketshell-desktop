/**
 * The exact remote shell commands the folder-first session flow runs.
 *
 * They live in their own module, as pure string builders, for one reason:
 * every one of them interpolates a value the user chose (a folder path, a
 * folder name, a repo slug, a session name) into a command line that a remote
 * shell will parse. That is the injection boundary of this feature, so it is
 * a pure function with unit tests rather than a template literal buried in a
 * service method. Every interpolation goes through
 * {@link shellQuote}/{@link shellQuoteRemotePath} — see ../../shared/shellQuote.ts.
 *
 * Wrap the result in `pathAwareCommand` (../helper/bootstrap.ts) before
 * exec'ing: sshd runs a non-login shell, so `$HOME/.local/bin` — where uv
 * installs `pocketshell` and `tmuxctl` — is not on PATH by default.
 */

import { shellQuote, shellQuoteRemotePath } from '../../shared/shellQuote.js';

/**
 * Ceiling on the `-2`/`-3`… walk in {@link freeSessionNameCommand}. Ported
 * verbatim from `FREE_SESSION_NAME_MAX_SUFFIX` (FolderListGateway.kt:2233):
 * a folder with 200 live sessions is not a real state; the bound only stops a
 * pathological host from spinning the remote shell forever.
 */
export const FREE_SESSION_NAME_MAX_SUFFIX = 200;

/**
 * Resolve a remote path to its canonical absolute form (`cd … && pwd -P`).
 *
 * This one exec is the start path's folder guard as well as its
 * canonicalisation: a non-zero exit means the directory could not be entered,
 * and callers treat that as "not there". The guard used to be a separate
 * `[ -d ]` pre-flight in front of this command, and it existed for a measured
 * reason that still holds: the helper itself exits 0 for a missing `--cwd`
 * (`pocketshell sessions create probe -c "$HOME/no/such/dir"` creates a
 * session whose `session_path` is the missing directory and whose pane lands
 * in `$HOME` — re-measured on the Docker fixture, helper 0.4.44; the phone
 * runs the same guard, FolderListGateway.kt:1233). Folding the guard into the
 * `cd` keeps the refusal while costing one login-shell round trip instead of
 * two — the create is the latency-critical path, and every exec here pays the
 * user's profile startup on top of the network.
 */
export function resolveDirectoryCommand(path: string): string {
  return `cd -- ${shellQuoteRemotePath(path)} && pwd -P`;
}

/** Print the remote `$HOME`. */
export const HOME_COMMAND = 'printf %s "$HOME"';

/**
 * Create a directory (and any missing parents) at [path].
 *
 * `--` terminates option parsing so a folder whose name begins with `-`
 * cannot be read as a flag. Port of `createEmptyProject`
 * (FolderListGateway.kt:1630).
 */
export function mkdirCommand(path: string): string {
  return `mkdir -p -- ${shellQuoteRemotePath(path)}`;
}

/**
 * The `-S` argument that aims a tmux command at the server OUR session lives
 * on — the convention every aimed builder here shares, and the one
 * TmuxClientPool's `aimedTmux` imports rather than re-spelling. The helper's
 * ecosystem runs one tmux SERVER per session (`tmuxctl-*` sockets beside the
 * legacy shared one), and `pocketshell sessions list` sweeps every socket — so
 * a session the panel shows can live on a server a bare `tmux` has never heard
 * of. A null/absent socket keeps the bare default-socket spelling, which is
 * the only query available when the caller does not know where to aim.
 */
export function tmuxServerArg(socketPath: string | null | undefined): string {
  return socketPath ? `-S ${shellQuote(socketPath)} ` : '';
}

/**
 * Does a tmux session named exactly [name] exist? Exit 0 yes.
 *
 * The `=` prefix forces tmux's EXACT match. Without it tmux falls back to
 * prefix then fnmatch matching, so probing `git-foo` while only `git-foo-2`
 * exists answers "taken" — which would make the free-name walk skip a
 * genuinely free name. `2>/dev/null` keeps "no server running" quiet: with no
 * tmux server nothing is taken.
 *
 * ## The [socketPath] argument, and when it is absent
 *
 * A name alone no longer locates a session — see {@link tmuxServerArg} for
 * the per-session-server world that makes the aiming necessary, and for the
 * user-visible bug (Stop answering "already gone" for a session alive on its
 * own server) that produced the convention. When the caller knows the
 * session's server (from the enrichment probe's `socket_path` column), the
 * command is aimed there; when it does not, null degrades to the default
 * socket, which was the whole answer before aiming existed.
 */
export function sessionExistsCommand(name: string, socketPath?: string | null): string {
  return `tmux ${tmuxServerArg(socketPath)}has-session -t ${shellQuote(`=${name}`)} 2>/dev/null`;
}

/**
 * A POSIX-sh function, `__ps_taken`, that answers "does a session called `$1`
 * exist ANYWHERE on this host" — every tmux server the user has, not only the
 * default socket.
 *
 * ## Why the default socket is not the whole answer
 *
 * Because this host has already proved it is not. The evidence is committed in
 * ../projects/sessionDirs.ts and quoted from the user's own log: `pocketshell
 * sessions list` returned twelve sessions while raw `tmux` on the same
 * connection answered `can't find session: git-red-stamp-sound`,
 * `can't find session: git-dtc-website-import` and
 * `can't find session: git-ai-engineering-field-guide`. Three sessions the app
 * lists, shows a tab for, and attaches to, that a bare `tmux has-session`
 * denies the existence of.
 *
 * {@link freeSessionNameCommand} used to ask exactly that bare question, and a
 * "no" from it means "this name is free". So on this host the walk answered
 * `<base>` for a folder whose `<base>` session was open on screen — and since
 * `pocketshell sessions create` is attach-or-create, the "new" session was the
 * one the user was already looking at. That is the whole of the `+` -> New
 * session bug: a shell create appeared to do nothing because it re-selected the
 * tab that was already selected, and an agent create typed its launch line into
 * the terminal that was already in front of the user.
 *
 * ## Why sweeping the socket directory is the right remedy and not a guess
 *
 * It is the remedy this repo already reached for the same discrepancy, and for
 * the same reason. `SESSION_ENRICHMENT_COMMAND` (../helper/parsers.ts) runs the
 * default invocation first and then loops over `${TMUX_TMPDIR:-/tmp}/tmux-$(id
 * -u)/*` precisely because `list-panes -a` is per-SERVER and the user's host has
 * more than one. `has-session` is per-server in exactly the same way. Asking one
 * socket and calling the answer "the host" was the assumption; this removes it
 * rather than restating it.
 *
 * The default invocation stays FIRST and is not replaced by the sweep, for the
 * reason the enrichment probe gives: a host whose `TMUX_TMPDIR` points somewhere
 * this glob does not model would otherwise go from one answer to none. A stale
 * socket whose server has died prints `no server running` and exits 1, which
 * `2>/dev/null` and the loop's own continuation absorb.
 *
 * Note the direction this fails in. A socket we cannot read makes a taken name
 * look free, which is the bug above; a socket we can read can only ever make the
 * walk skip a suffix and hand back `<base>-3` where `<base>-2` was spare. The
 * first costs the user a session they asked for; the second costs a number.
 */
const SESSION_TAKEN_ANYWHERE_FUNCTION =
  '__ps_taken() { ' +
  'tmux has-session -t "=$1" 2>/dev/null && return 0; ' +
  'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
  '[ -S "$__ps_s" ] || continue; ' +
  'tmux -S "$__ps_s" has-session -t "=$1" 2>/dev/null && return 0; ' +
  'done; ' +
  'return 1; ' +
  '}; ';

/**
 * Print the smallest free name in the `<base>`, `<base>-2`, `<base>-3`… walk,
 * evaluated ENTIRELY on the host in one exec.
 *
 * Port of `freeSessionNameCommand` (FolderListGateway.kt:2245). Running the
 * whole walk remotely means the gap between "this name is free" and "create
 * it" is one command on one connection rather than a seconds-wide window
 * against a client-side cache.
 *
 * The per-candidate question is {@link SESSION_TAKEN_ANYWHERE_FUNCTION} and not
 * a bare `tmux has-session` — see that constant for the log lines that made the
 * difference load-bearing.
 *
 * [base] is quoted once and then concatenated with `-$i` in the loop, which is
 * safe because POSIX sh concatenates adjacent quoted and unquoted words.
 */
export function freeSessionNameCommand(base: string): string {
  const quoted = shellQuote(base);
  return (
    SESSION_TAKEN_ANYWHERE_FUNCTION +
    `__ps_n=${quoted}; __ps_i=2; ` +
    'while __ps_taken "$__ps_n"; do ' +
    `if [ "$__ps_i" -gt ${FREE_SESSION_NAME_MAX_SUFFIX} ]; then break; fi; ` +
    `__ps_n=${quoted}-$__ps_i; ` +
    '__ps_i=$((__ps_i+1)); ' +
    "done; printf '%s\\n' \"$__ps_n\""
  );
}

/**
 * Does a session called [name] exist ANYWHERE on this host? Exit 0 yes.
 *
 * The rename's uniqueness check. It uses {@link SESSION_TAKEN_ANYWHERE_FUNCTION}
 * — the same predicate the free-name walk uses — and not
 * {@link sessionExistsCommand} aimed at the session being renamed, because the
 * namespace a rename collides in is the helper's JOIN namespace, and that is
 * not one server. `tmux_api.locate_session` resolves `tmuxctl <name>` by
 * checking the socket DERIVED from the name (`tmuxctl-<name>`) and then the
 * default socket; the desktop's own tab bar, composer and enrichment map are
 * likewise keyed by name across every server. A rename onto a name that lives
 * on some third server would therefore produce two tabs with one name and a
 * join that resolves to whichever row the sweep printed last — so "taken"
 * means "the name exists on any socket this user has", exactly as it already
 * does for creates.
 */
export function sessionTakenAnywhereCommand(name: string): string {
  return SESSION_TAKEN_ANYWHERE_FUNCTION + `__ps_taken ${shellQuote(name)}`;
}

/**
 * `pocketshell sessions create '<name>' -c '<cwd>'`.
 *
 * `--mem` is deliberately NOT passed. Confirmed against the helper's own
 * `sessions create --help` on the fixture: "`--mem` is intentionally UNSET by
 * default so tmuxctl resolves the per-project cap from the repo's
 * cgroups.toml". The phone says the same thing at FolderListGateway.kt:2148.
 * Passing a number here would override a budget the repo declared for itself.
 *
 * The helper prints the resolved session name on stdout and exits 0; the
 * create is idempotent (a no-op when the session already exists).
 */
export function createSessionCommand(name: string, cwd: string): string {
  return `pocketshell sessions create ${shellQuote(name)} -c ${shellQuoteRemotePath(cwd)}`;
}

/**
 * The helper-absent fallback: raw `tmux new-session -A -d`.
 *
 * `-A` = attach-if-exists, which on a detached create means "succeed as a
 * no-op", preserving the same idempotency the helper's `create-detached` has.
 * `-d` = leave it detached; we attach over our own PTY afterwards.
 *
 * Note this is ONE fallback layer, not the phone's two. See the
 * `createSession` doc comment in ../helper/PocketshellClient.ts.
 */
export function fallbackCreateSessionCommand(name: string, cwd: string): string {
  return `tmux new-session -A -d -s ${shellQuote(name)} -c ${shellQuoteRemotePath(cwd)}`;
}

/** Options for {@link reposListCommand}. */
export interface ReposListOptions {
  /** Scan the local filesystem, or ask GitHub via `gh`. */
  scope: 'local' | 'remote';
  /** Scan roots, `--local` only. Replaces (does not augment) the default `~/git`. */
  roots?: string[];
  /** Directory depth for the local scan. Helper default is 4. */
  maxDepth?: number;
  /** Cap on remote repositories returned, `--remote` only. */
  limit?: number;
}

/**
 * `pocketshell repos list --local|--remote --json …`.
 *
 * The scope flag is ALWAYS passed explicitly. With neither flag the helper
 * defaults to `--local` and prints a discoverability hint ("defaulting to
 * --local…") alongside the rows — a naive parser would eat it.
 */
export function reposListCommand(options: ReposListOptions): string {
  const parts = ['pocketshell repos list', `--${options.scope}`, '--json'];
  if (options.scope === 'local') {
    for (const root of options.roots ?? []) {
      if (root.trim().length > 0) parts.push('--root', shellQuoteRemotePath(root));
    }
    if (options.maxDepth != null && Number.isInteger(options.maxDepth) && options.maxDepth > 0) {
      parts.push('--max-depth', String(options.maxDepth));
    }
  } else if (options.limit != null && Number.isInteger(options.limit) && options.limit > 0) {
    parts.push('--limit', String(options.limit));
  }
  return parts.join(' ');
}

/** Options for {@link reposCloneCommand}. */
export interface ReposCloneOptions {
  /** `owner/repo`. */
  repository: string;
  /** Clone root. Helper default is `~/git`. */
  root?: string;
  /** Target folder name under the root. Helper default is the repo name. */
  folder?: string;
  /** Clone URL protocol. Helper default is `ssh`. */
  protocol?: 'ssh' | 'https';
}

/**
 * `pocketshell repos clone <owner/repo> …`. Prints the created path on stdout.
 *
 * `repository` is quoted like every other argument even though it "should" be
 * a tame `owner/repo` slug — it arrives from the renderer, and a value that
 * only ever comes from a list today is exactly the one that comes from a text
 * field tomorrow.
 */
export function reposCloneCommand(options: ReposCloneOptions): string {
  const parts = ['pocketshell repos clone', shellQuote(options.repository)];
  if (options.root != null && options.root.trim().length > 0) {
    parts.push('--root', shellQuoteRemotePath(options.root));
  }
  if (options.folder != null && options.folder.trim().length > 0) {
    parts.push('--folder', shellQuote(options.folder.trim()));
  }
  if (options.protocol) parts.push('--protocol', options.protocol);
  return parts.join(' ');
}

/**
 * Rename tmux session [from] to [to].
 *
 * ## Why raw tmux and not the helper
 *
 * The helper has no rename verb, and it does not need one. `attachCommand.ts`
 * establishes that tmuxctl joins by name and resolves it against the tmux
 * servers it knows. This is the same mechanism, aimed at a name instead of at
 * a client — with the one correction the per-session-server world forces: the
 * "same server the helper's sessions live on" is no longer always the default
 * one, so when the caller learned [from]'s socket the rename is aimed there,
 * exactly as the kill is. A null socket keeps the bare spelling.
 *
 * ## Why both `=` prefixes matter
 *
 * tmux's `-t` is a prefix-then-fnmatch match unless the target begins with `=`.
 * Without it, renaming `api` on a host that also runs `api-staging` would pick
 * whichever tmux resolved first — so the `=` is what makes "rename THIS
 * session" mean this session. `sessionExistsCommand` above carries the same
 * note for the same reason.
 *
 * ## Why `--`
 *
 * The new name is the one argument here that is not option-position-safe: a
 * name beginning with `-` would be read as a flag. `sanitisePart` strips
 * leading `-`, so this app cannot produce such a name — but this builder is the
 * injection boundary and it should not depend on a caller upstream having
 * sanitised correctly.
 */
export function renameSessionCommand(
  from: string,
  to: string,
  socketPath?: string | null,
): string {
  return `tmux ${tmuxServerArg(socketPath)}rename-session -t ${shellQuote(`=${from}`)} -- ${shellQuote(to)}`;
}

/**
 * Kill tmux session [name].
 *
 * **The only destructive command in this app.** There is no undo, and the thing
 * being destroyed is usually an agent in the middle of a task, so every clause
 * below was checked against the pinned Docker fixture rather than reasoned
 * about. The captures are committed beside this file's other evidence —
 * `tests/unit/fixtures/v0.4.44-*.txt` — the way 00eb3e7 captured
 * `pocketshell agent --help`.
 *
 * ## Why not the helper
 *
 * `pocketshell sessions` has **four** subcommands on 0.4.44 — `create`, `list`,
 * `resumable`, `resume` — and no kill verb at any spelling. `kill`, `stop`,
 * `rm`, `delete`, `destroy`, `remove`, `close` and `terminate` all come back
 * `Error: No such command` with exit 2
 * (`v0.4.44-sessions-help.txt`, `v0.4.44-sessions-no-such-command.stderr.txt`).
 *
 * ## Why not `tmuxctl kill`, which DOES exist
 *
 * `tmuxctl kill '<target>' --yes` is real, and `--yes` is not optional in
 * practice: without it `typer.confirm` prompts, and on the non-interactive
 * stdin an `exec` channel gives it that prompt aborts with exit 1 having killed
 * nothing (`v0.4.44-tmuxctl-kill-no-yes.stderr.txt`). It is rejected for two
 * measured defects rather than for taste:
 *
 *  1. **It cannot kill a numerically-named session.** `_resolve_session_target`
 *     branches on `target.isdigit()` and reads the name as an index into a
 *     recent list, so a session literally called `2` fails with
 *     `not enough values to unpack` and stays alive
 *     (`v0.4.44-tmuxctl-kill-numeric-name.stderr.txt`). This app can put such a
 *     tab on the bar — any session in the folder gets one — so a Stop that
 *     silently cannot stop THAT one is not acceptable for a destructive action.
 *  2. **Its own kill is not exact-match.** tmuxctl guards with
 *     `has-session -t "={name}"` and then kills with a BARE
 *     `["kill-session", "-t", session_name]`. The guard is exact and the kill is
 *     not, so between the two a neighbour can be hit.
 *
 * Raw tmux reaches the same server either way — `attachCommand.ts` records that
 * tmuxctl 0.4.x shells out to a bare `tmux` on the default socket, which is why
 * `sessionSwitchCommand` and {@link renameSessionCommand} are already raw.
 *
 * ## Why the `=` is the whole safety of this line
 *
 * tmux's `-t` is prefix-then-fnmatch unless the target begins with `=`, and the
 * dangerous case is NOT the obvious one. With `api` and `api-staging` both
 * alive, a bare `-t api` correctly kills `api` — exact match wins, so the bug
 * hides. The failure appears once `api` is already gone, which is exactly the
 * state a stale tab bar is in:
 *
 *   | alive                | command                        | outcome                        |
 *   |----------------------|--------------------------------|--------------------------------|
 *   | `api`, `api-staging` | `kill-session -t '=api'`       | exit 0, `api-staging` survives |
 *   | `api-staging` only   | `kill-session -t api`          | **exit 0, kills `api-staging`**|
 *   | `api-staging` only   | `kill-session -t '=api'`       | exit 1, `can't find session`   |
 *
 * A bare `-t` fails OPEN: it destroys the wrong session and reports success.
 * `=` fails CLOSED, with a message the caller can show. For a command with no
 * undo that is the only acceptable direction to fail in.
 * (`v0.4.44-tmux-kill-session-exact-match.txt.`)
 *
 * ## The [socketPath] argument
 *
 * Aimed exactly as {@link sessionExistsCommand} aims its probe, for the same
 * per-session-server reason: the probe that located [name] also reported which
 * tmux server it lives on, and killing that name through a `-S` there is the
 * only spelling that can reach it. A null socket keeps the bare default form —
 * both the legacy hosts that have only one server and the callers that could
 * not learn a socket land here unchanged.
 */
export function killSessionCommand(name: string, socketPath?: string | null): string {
  return `tmux ${tmuxServerArg(socketPath)}kill-session -t ${shellQuote(`=${name}`)}`;
}

/**
 * Ask git, for each of [paths], which repository it belongs to
 *
 *
 * ## Why this exists
 *
 * The user selected a folder called `merry-sniffing-token`, whose only session
 * is named `git-dtc-website-decisions`, and said: "this one should be in
 * dtc-website actually". That directory is a git WORKTREE of
 * `~/git/dtc-website`, and a worktree belongs with the repository it is a
 * worktree OF — which is also why the session carries that name, since it was
 * created against that repo. The name was telling us the answer all along and
 * the grouping was ignoring it in favour of the raw cwd.
 *
 * It is resolved by ASKING GIT rather than by parsing the name, because the
 * name cannot answer it: `-` is both the component separator and a legal
 * character inside a component, so `git-dtc-website-decisions` is ambiguous
 * between several paths (the same reason `rootFromSessionName` refuses to
 * invert past the first component).
 *
 * ## Why two queries per directory, not one
 *
 * `--git-common-dir` alone would over-reach. It answers "which repository is
 * this", so it maps a SUBDIRECTORY of a repo to the repo root too — meaning
 * sessions in `~/git/monorepo/pkg-a` and `~/git/monorepo/pkg-b` would collapse
 * into one folder. That is a much bigger behaviour change than the user asked
 * for and not obviously wanted.
 *
 * `--git-dir` is what makes the query precise. For a normal checkout — at the
 * root or anywhere below it — the two are EQUAL. Only in a linked worktree do
 * they differ: `--git-dir` is `<main>/.git/worktrees/<name>` while
 * `--git-common-dir` is `<main>/.git`. So emitting both lets the parser remap
 * worktrees and leave every other directory exactly where it is today.
 *
 * ## Why no `--path-format=absolute`
 *
 * That flag needs git 2.31+, and it turns out to be unnecessary. Both values
 * are resolved by `cd`-ing to them FROM the directory being asked about, which
 * handles the absolute and relative forms identically and costs nothing — so
 * there is no version gate, no fallback branch, and nothing to degrade.
 * `pwd -P` then resolves symlinks, so the two can be compared as strings.
 *
 * ## Why the host does the comparison, and prints an INDEX
 *
 * The output is `<index>::<commonDir>`, emitted ONLY for a directory that is a
 * worktree. Both halves of that are about parsing, and both were learned the
 * hard way (see ../projects/worktrees.ts): a directory path can contain the
 * `::` delimiter, and if it does then so do the two git answers, because they
 * are paths inside it. Printing all three fields is therefore unparseable in
 * principle, not merely awkward. Printing the request index — digits — plus a
 * single trailing path leaves exactly one ambiguous field, at the end, which a
 * split on the FIRST delimiter recovers whatever it contains.
 *
 * One exec for every directory, not one per directory: the same discipline the
 * session-enrichment probe and the port scanner already follow. A directory
 * that is not in a repository, or that git cannot read, prints nothing and is
 * simply absent from the result.
 */
export function gitRepoProbeCommand(paths: readonly string[]): string {
  const quoted = paths.map(shellQuoteRemotePath).join(' ');
  return (
    '__ps_i=0; ' +
    `for __ps_d in ${quoted}; do ` +
    '__ps_n=$__ps_i; __ps_i=$((__ps_i+1)); ' +
    '__ps_g=$(cd "$__ps_d" 2>/dev/null && git rev-parse --git-dir 2>/dev/null) || continue; ' +
    '[ -n "$__ps_g" ] || continue; ' +
    '__ps_c=$(cd "$__ps_d" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null) || continue; ' +
    '[ -n "$__ps_c" ] || continue; ' +
    '__ps_ga=$(cd "$__ps_d" && cd "$__ps_g" 2>/dev/null && pwd -P) || continue; ' +
    '__ps_ca=$(cd "$__ps_d" && cd "$__ps_c" 2>/dev/null && pwd -P) || continue; ' +
    // Equal means an ordinary checkout at any depth: say nothing, so the
    // caller leaves the session exactly where it is.
    '[ "$__ps_ga" != "$__ps_ca" ] || continue; ' +
    "printf '%s::%s\\n' \"$__ps_n\" \"$__ps_ca\"; " +
    'done'
  );
}
