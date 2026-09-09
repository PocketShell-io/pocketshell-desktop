/**
 * Pure parsers for the server-side `pocketshell` helper's text/JSON output.
 *
 * Each parser turns raw stdout into typed rows. They are pinned to the
 * fixture strings shipped under tests-docker/fixtures/ (copied from the
 * source repo's tests/docker/agent-fixtures/) so the output contract stays
 * byte-identical to what the real helper emits.
 *
 * All functions are pure: string in, data out, no I/O.
 *
 * Parsers for the small non-session CLI outputs (`command -v` probes, agent
 * subcommand listings, the tree registry) live in ./cliParsers.ts.
 */

import type { SessionAgentKind, SessionSummary } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// `pocketshell sessions list` — fixed-width table
// ---------------------------------------------------------------------------
//
// Shape (from pocketshell-sessions-list.txt / tmuxctl-list.txt):
//
//   IDX  SESSION               CREATED
//   1    claude-main           2026-05-23 10:00:00
//   2    codex                 2026-05-23 09:45:00
//   3    opencode-lab          2026-05-23 09:15:00
//
//   Join a session: pocketshell sessions <id> ...
//
// The anchor is the trailing `YYYY-MM-DD HH:MM:SS` timestamp (issue #200).
// Footer/hint lines and a blank separator are skipped. (Helper 0.4.44 prints
// `tmuxctl <id>` rather than `pocketshell sessions <id>` in those hints — the
// timestamp anchor makes the wording irrelevant.)
//
// The table carries THREE columns and nothing else: there is no cwd, no
// attached flag, no agent kind in it. Those come from the companion tmux
// probe below ({@link SESSION_ENRICHMENT_COMMAND}); the rows this parser
// emits are deliberately bare and get merged with it by the client.

const SESSION_TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$/;

/**
 * Parse `pocketshell sessions list` (or `tmuxctl list`) output.
 * Returns sessions in document order (the helper already sorts by activity
 * when `--by activity` is passed). Unknown/blank output -> empty list.
 */
/**
 * The first non-empty line of [text], trimmed — or null when there is none.
 *
 * The shape every "the CLI echoes its answer on stdout" call site used to
 * re-derive: createSession's echoed name, reposClone's printed path,
 * `canonicalise`'s resolved directory.
 */
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** The last non-empty line of [text], trimmed — or null when there is none. */
export function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function parseSessionsList(stdout: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const match = SESSION_TIMESTAMP_RE.exec(line);
    if (!match) continue; // header, footer hints, blank -> skip
    const created = Date.parse(match[1]!);
    if (!Number.isFinite(created)) continue;

    // Everything before the timestamp is `<idx> <session-name>...`. Drop the
    // leading integer index, then the remainder (collapsed) is the name.
    const before = line.slice(0, match.index).trim();
    const idxEnd = before.indexOf(' ');
    const name = (idxEnd >= 0 ? before.slice(idxEnd + 1) : before).trim();
    if (!name) continue;

    out.push({
      name,
      created: Math.floor(created / 1000),
      activity: Math.floor(created / 1000), // created == activity in this shape
      // Filled in from the companion tmux probe — see mergeSessionEnrichment.
      attached: false,
      path: null,
      agentKind: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-session enrichment — the `tmux list-panes -a` companion probe
// ---------------------------------------------------------------------------
//
// `pocketshell sessions list` prints IDX/SESSION/CREATED and nothing more, so
// on its own it cannot answer the three questions the folder-grouped session
// list asks of every row: *where* is this session, is it *attached*, and *what
// is running* in it. The phone answers all three from tmux directly
// (`FolderListGateway.LIST_SESSIONS_COMMAND` / `LIST_PANES_COMMAND`,
// FolderListGateway.kt:2109-2124) and we mirror that here.
//
// One probe, not two, and not one-per-session: tmux resolves SESSION-scoped
// formats (`session_path`, `session_attached`, and session user options like
// `@ps_agent_kind`) inside a PANE-scoped `list-panes` context, because the
// pane's session is in its format tree. So a single `list-panes -a` yields
// both halves of what the phone fetches with two commands. Verified against
// tmux 3.4 (the user's box) and tmux 3.6b (the helper fixture image).
//
// Field order deliberately puts `pane_current_path` and `session_path` before
// the remaining scalar fields — see FIELD_SEP note below.

/** The `::` delimiter, matching the phone's `FolderListGateway.FIELD_SEP`. */
const FIELD_SEP = '::';

/**
 * The single companion probe run alongside `pocketshell sessions list`.
 *
 * `tmux -u` (issue #2160): a tmux client without a UTF-8 locale sanitises
 * every non-ASCII byte it prints to `_`, which would corrupt paths and
 * recorded option values on hosts whose sshd exports no locale.
 *
 * Column order is `name, window_active, pane_active, pane_current_path,
 * session_path, session_attached, @ps_agent_kind, socket_path`. Paths sit in
 * the middle rather than last (the phone parks `session_path` last for the
 * same reason) because a `::` inside a path would otherwise swallow the
 * fields after it — here the parser splits a FIXED count of fields, so only
 * the two path columns can be ambiguous and the scalar tail is always
 * recoverable.
 *
 * `socket_path` is the newest column and the reason aimed actions (Stop,
 * rename) can be aimed at all: the ecosystem now runs one tmux SERVER per
 * session, so two sessions can share a name legally and a bare `tmux` sees
 * only the legacy default one. The parser reads the socket from the same
 * positional end as the other scalars, and an old probe that lacks the
 * column simply yields null there — see {@link SessionEnrichment.socketPath}.
 *
 * That reasoning holds, but only if the parser actually splits from BOTH
 * ends, which it did not: it took the first seven fields left to right, so a
 * `::` in a path shifted `session_attached` and `@ps_agent_kind` one place
 * left and both were read out of a path fragment. {@link splitEnrichmentRow}
 * takes the three leading scalars and the two trailing ones by position from
 * their own end, which is what makes the tail genuinely recoverable.
 */
const ENRICHMENT_FORMAT =
  `#{session_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{pane_active}${FIELD_SEP}` +
  `#{pane_current_path}${FIELD_SEP}#{session_path}${FIELD_SEP}#{session_attached}` +
  `${FIELD_SEP}#{@ps_agent_kind}${FIELD_SEP}#{socket_path}`;

export const SESSION_ENRICHMENT_COMMAND =
  `tmux -u list-panes -a -F '${ENRICHMENT_FORMAT}' 2>/dev/null; ` +
  // Every OTHER tmux server this user has, not only the default one.
  //
  // `list-panes -a` is per-SERVER, and that is the half of this probe the
  // three previous attempts at the missing-directory bug never questioned. The
  // user's log has `pocketshell sessions list` returning twelve sessions while
  // this probe produced rows for eight, with `unmatchedProbeKeys` empty — so it
  // was not a spelling mismatch and not a parse failure, it was four sessions
  // this command could not see. Measured against real tmux 3.4, `list-panes -a`
  // omits nothing on the server it reaches, so the four were not on that
  // server. The same log says so from a second direction: raw `tmux` on that
  // connection answered `can't find session:` for three of those exact four.
  //
  // The note on `sessionAttachCommand` says tmuxctl shells out to a bare `tmux`
  // with no `-L`/`-S`, so there SHOULD be one socket. That was reasoned from a
  // host inspection, not from this host, and it is exactly the kind of
  // assumption that survives three fixes. Sweeping the socket directory costs
  // one shell loop and removes the assumption instead of restating it.
  //
  // The default invocation above is kept and run FIRST rather than being
  // replaced by the sweep: a host whose `TMUX_TMPDIR` points somewhere this
  // glob does not model would otherwise go from eight rows to zero. Duplicate
  // rows for the default socket are free — {@link parseSessionEnrichment} keys
  // by session name, so the second reading of a session overwrites the first
  // with itself.
  //
  // Stale sockets whose server has died print `no server running` to stderr and
  // exit 1; `2>/dev/null` and the loop's own continuation absorb both.
  'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
  '[ -S "$__ps_s" ] || continue; ' +
  `tmux -S "$__ps_s" -u list-panes -a -F '${ENRICHMENT_FORMAT}' 2>/dev/null; ` +
  'done';

/**
 * A per-session `socket_path` / `pid` reading, for the log only.
 *
 * Run ONLY when something came back unplaced, because it answers a question
 * nobody has on a healthy host: are these sessions on the server we think they
 * are on? Two sessions reporting different `#{pid}` values is a second tmux
 * server, full stop, and a session the helper lists that appears in NO row here
 * does not exist on any socket we can see — which are the two remaining
 * explanations for the user's report and are indistinguishable in the UI.
 */
export const SESSION_SOCKET_DIAGNOSTIC_COMMAND =
  `tmux -u list-panes -a -F '#{session_name}${FIELD_SEP}#{socket_path}${FIELD_SEP}#{pid}' 2>/dev/null; ` +
  'for __ps_s in "${TMUX_TMPDIR:-/tmp}"/tmux-$(id -u)/*; do ' +
  '[ -S "$__ps_s" ] || continue; ' +
  `tmux -S "$__ps_s" -u list-panes -a -F '#{session_name}${FIELD_SEP}#{socket_path}${FIELD_SEP}#{pid}' 2>/dev/null; ` +
  'done';

/** What the companion probe adds to a bare `sessions list` row. */
export interface SessionEnrichment {
  /** Active pane's cwd, falling back to `session_path`; null if neither. */
  path: string | null;
  attached: boolean;
  agentKind: SessionAgentKind | null;
  /**
   * The tmux server this session lives on, verbatim from `#{socket_path}`.
   *
   * The helper's ecosystem now runs one tmux SERVER per session (sockets
   * `tmuxctl-*` beside the legacy shared one — see the doc block on
   * `sessionExistsCommand`), so a name alone no longer says where a kill or a
   * rename must be aimed. Null when the probe's tmux predates the column or
   * the field came back empty; the caller then falls back to the bare,
   * default-socket commands.
   */
  socketPath: string | null;
}

/**
 * Map a raw host-side `@ps_agent_kind` value to a {@link SessionAgentKind}.
 *
 * The exact inverse of the helper's `record_agent_kind` write
 * (`tmux set-option @ps_agent_kind <kind>`, agents.py:419) and a direct port
 * of the phone's `sessionAgentKindFromOption`
 * (shared/ui-kit/.../SessionAgentKind.kt:97).
 *
 * Returns null for a blank option (a session we did not launch) AND for an
 * unrecognised one — the user's box really does carry values like
 * `test-engine` — so an unknown string falls back to "we don't know" rather
 * than mislabeling the row. `probing` / `exited` are never recorded and so
 * never appear here.
 */
export function agentKindFromTmuxOption(raw: string | null | undefined): SessionAgentKind | null {
  switch (raw?.trim().toLowerCase()) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'grok':
      return 'grok';
    case 'shell':
      return 'shell';
    default:
      return null;
  }
}

/**
 * Parse {@link SESSION_ENRICHMENT_COMMAND} output into a per-session map.
 *
 * cwd precedence is the phone's (FolderListGateway.kt:1085-1089): the ACTIVE
 * pane of the ACTIVE window wins, `session_path` is the fallback. A session
 * whose active pane has `cd`'d away should group where the user actually is,
 * and `session_path` can even be a literal unexpanded `~/git` on a session
 * created with a tilde cwd — which would otherwise become its own bogus
 * folder, since path canonicalisation deliberately never expands `~`.
 */
export function parseSessionEnrichment(stdout: string): Map<string, SessionEnrichment> {
  const out = new Map<string, SessionEnrichment>();
  /** Sessions whose active-pane row we have already seen (it wins outright). */
  const activeSeen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const row = splitEnrichmentRow(rawLine);
    if (!row) continue;
    const { name, windowActive, paneActive, panePath, sessionPath, attached, kind, socketPath } =
      row;

    const isActive = windowActive === '1' && paneActive === '1';
    if (activeSeen.has(name) && !isActive) continue;
    const path = (isActive ? panePath : '') || sessionPath || '';
    const attachedCount = Number.parseInt(attached, 10);
    out.set(name, {
      path: path ? path : null,
      attached: Number.isFinite(attachedCount) && attachedCount > 0,
      agentKind: agentKindFromTmuxOption(kind),
      socketPath: socketPath ? socketPath : null,
    });
    if (isActive) activeSeen.add(name);
  }
  return out;
}

/** One row of {@link SESSION_ENRICHMENT_COMMAND}, already de-shifted. */
interface EnrichmentRow {
  name: string;
  windowActive: string;
  paneActive: string;
  panePath: string;
  sessionPath: string;
  attached: string;
  kind: string;
  socketPath: string;
}

/**
 * Split one probe line into its fields, tolerating both of the shapes the
 * the old fixed left-to-right split got wrong.
 *
 * ## Too many fields
 *
 * A `::` inside either path column produces MORE than the seven parts a
 * socket-less row has (eight once the socket column is present). Reading
 * the first seven then shifted `session_attached` and `@ps_agent_kind` out of
 * a path fragment, which quietly reported the session as detached and
 * agent-less. Only the two path columns are ambiguous, so the three leading
 * scalars are taken from the front, the trailing ones from the back, and
 * whatever is left in the middle is the two paths.
 *
 * Splitting that middle is the one genuinely ambiguous decision here, and it
 * is resolved by what the two columns MEAN rather than by counting: the
 * session's path is the directory the session was created in and the pane's
 * is where its shell is now, so the former is almost always an ancestor of
 * (or equal to) the latter. When more than one `::` sits in the middle we
 * take the split that satisfies that relationship, and fall back to the first
 * `::` when none does — which is the old behaviour, so the common case is
 * unchanged.
 *
 * ## Too few fields
 *
 * `parts.length < 7` used to drop the line outright, which is the wrong
 * default for a probe whose whole contract is "degrade, never cost us the
 * row". A tmux too old to expand `#{@ps_agent_kind}` emits the literal text
 * rather than an empty field, and a genuinely truncated line (an SSH read cut
 * short) loses its TAIL, not its head — so a row that has at least the name
 * and the two active flags still tells us where the session is. Missing
 * trailing fields are treated as empty; a row with fewer than five fields
 * carries no path at all and is still skipped, along with header noise and
 * "no server running".
 */
function splitEnrichmentRow(rawLine: string): EnrichmentRow | null {
  const line = rawLine.trim();
  if (!line) return null;
  const parts = line.split(FIELD_SEP);
  // Below five there is no path column to read, so the row cannot do the one
  // job it exists for. This is also what skips "no server running" and any
  // banner a login shell printed before the probe's own output.
  if (parts.length < 5) return null;

  const name = (parts[0] ?? '').trim();
  if (!name) return null;
  const windowActive = parts[1] ?? '';
  const paneActive = parts[2] ?? '';

  // Trailing fields are counted from the END so a `::` in a path cannot shift
  // them. The socket column arrived LAST and is optional: a probe from before
  // it was added simply produces one fewer field, and empty is the right
  // reading of both that and a blank value ("aim at the default server").
  //
  // Which tail shape a row has is decided by what the last field IS, not by
  // how many fields there are — because a hostile path adds a part to BOTH
  // shapes alike. A socket is an absolute tmux socket path; the two scalars
  // beside it never look like one (`session_attached` is a digit, the agent
  // word is an engine name or blank). So a last field starting with `/` is a
  // socket, and anything else is a legacy row whose path grew the extra part,
  // which then reads with exactly the pre-socket tail logic. The one row this
  // can misread — new format, genuinely empty socket, hostile path — keeps its
  // row and loses its path, which is the pre-socket behaviour anyway.
  const n = parts.length;
  const hasSocket = n >= 8 && (parts[n - 1] ?? '').startsWith('/');

  if (hasSocket) {
    const socketPath = parts[n - 1] ?? '';
    const kind = parts[n - 2] ?? '';
    const attached = parts[n - 3] ?? '';
    const [panePath, sessionPath] = splitPathPair(parts.slice(3, n - 3));
    return { name, windowActive, paneActive, panePath, sessionPath, attached, kind, socketPath };
  }

  // The tail is taken from the END so a `::` in a path cannot shift it. When
  // the row is short the tail fields simply are not there, and empty is the
  // right reading of both: no attach count means "not attached", no recorded
  // option means "we did not launch this".
  const hasKind = n >= 7;
  const hasAttached = n >= 6;
  const kind = hasKind ? (parts[parts.length - 1] ?? '') : '';
  const attached = hasAttached ? (parts[parts.length - (hasKind ? 2 : 1)] ?? '') : '';

  const middleEnd = parts.length - (hasKind ? 2 : hasAttached ? 1 : 0);
  const middle = parts.slice(3, middleEnd);
  const [panePath, sessionPath] = splitPathPair(middle);

  return { name, windowActive, paneActive, panePath, sessionPath, attached, kind, socketPath: '' };
}

/**
 * Recover `pane_current_path` and `session_path` from the middle fields.
 *
 * The normal case is exactly two entries and no decision to make. See
 * {@link splitEnrichmentRow} for why the ancestor relationship is the
 * tie-break when a path contained the delimiter.
 */
function splitPathPair(middle: string[]): [string, string] {
  if (middle.length === 0) return ['', ''];
  if (middle.length === 1) return [middle[0] ?? '', ''];
  if (middle.length === 2) return [middle[0] ?? '', middle[1] ?? ''];
  for (let cut = 1; cut < middle.length; cut++) {
    const pane = middle.slice(0, cut).join(FIELD_SEP);
    const session = middle.slice(cut).join(FIELD_SEP);
    if (pane === session || pane.startsWith(session.endsWith('/') ? session : session + '/')) {
      return [pane, session];
    }
  }
  return [middle[0] ?? '', middle.slice(1).join(FIELD_SEP)];
}

/**
 * Parse the `tmux list-sessions -F` fallback (`::`-delimited):
 *   session_name::created_epoch::activity_epoch::attached_count[:path]
 */
export function parseTmuxListSessionsFallback(stdout: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('no server')) continue;
    const parts = line.split('::');
    const [name, created, activity, attached, path] = parts;
    if (!name || created === undefined || activity === undefined) continue;
    const createdNum = Number.parseInt(created, 10);
    const activityNum = Number.parseInt(activity, 10);
    const attachedNum = attached === undefined ? NaN : Number.parseInt(attached, 10);
    if (!name || !Number.isFinite(createdNum)) continue;
    out.push({
      name,
      created: createdNum,
      activity: Number.isFinite(activityNum) ? activityNum : createdNum,
      attached: Number.isFinite(attachedNum) && attachedNum > 0,
      path: path && path !== '' ? path : null,
      // This shape carries no `@ps_agent_kind`; the companion probe supplies it.
      agentKind: null,
    });
  }
  return out;
}
