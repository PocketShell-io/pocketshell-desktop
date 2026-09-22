/**
 * Recovering a session's working directory from its NAME, by asking the host
 * which candidate directory actually exists.
 *
 * ## Why this exists at all
 *
 * The companion tmux probe (`SESSION_ENRICHMENT_COMMAND`) is the primary
 * answer to "where is this session", and when it works it is authoritative:
 * it reports the pane's real cwd. On the user's host it does not always work.
 * Their log, verbatim:
 *
 *     [sessions] sessions with no reported working directory
 *     {"total":12,"probeRows":8,"unplaced":[
 *       {"name":"git-red-stamp-sound","probe":"absent",...},
 *       {"name":"git-auth","probe":"absent",...},
 *       {"name":"git-dtc-website-import","probe":"absent",...},
 *       {"name":"git-ai-engineering-field-guide","probe":"absent",...}],
 *      "unmatchedProbeKeys":[]}
 *
 * `pocketshell sessions list` returns twelve sessions; `tmux list-panes -a`
 * produces rows for eight of them, under any spelling. That is not a parsing
 * failure — measured against real tmux 3.4, `list-panes -a` iterates every
 * session on its server and omits none, and an unset `#{@ps_agent_kind}`
 * expands to an empty field rather than to literal text, so the row shape
 * holds. The two halves are simply not looking at the same set of sessions,
 * and the same log says so from a second direction: raw `tmux` on that
 * connection answered `can't find session: git-red-stamp-sound`,
 * `can't find session: git-dtc-website-import` and
 * `can't find session: git-ai-engineering-field-guide` — three of these exact
 * four — while the helper went on listing all twelve.
 *
 * So the cause is on the far side of a boundary we do not own: either those
 * sessions live on a tmux server our `tmux` does not reach, or the helper is
 * listing sessions that no longer exist. The socket sweep in
 * `SESSION_ENRICHMENT_COMMAND` closes the first case. This file is what makes
 * the remainder survivable, because a session with no folder is not a cosmetic
 * problem any more: the workspace keys everything on the folder, so an
 * unplaced session has nowhere to live and the user cannot reach it.
 *
 * ## Why deriving a directory from a name is acceptable HERE and not elsewhere
 *
 * `rootFromSessionName` (src/renderer/sessionGrouping.ts) deliberately refuses
 * to go past the root, and its reasoning is sound: `-` is both the component
 * separator AND a legal character inside a component, so
 * `git-dtc-website-import` is genuinely ambiguous between
 * `~/git/dtc-website-import` and `~/git/dtc-website/import`, and inventing a
 * folder out of that guess is worse than having none.
 *
 * The ambiguity is real. What was missing is that it is RESOLVABLE: the host
 * knows which of the candidates is a directory, and it costs one batched
 * `test -d` to ask. Nothing here guesses — every path this produces has been
 * confirmed to exist on the host. That is the same standard
 * `inferPathsFromSiblings` holds itself to (it only ever adopts a path another
 * session is actually reporting), reached by asking instead of by copying.
 *
 * ## Pure on purpose
 *
 * Candidate generation and result parsing are here; the exec, the batching and
 * the per-connection cache are the client's job
 * (../helper/PocketshellClient.ts), exactly as with the worktree probe added in
 * c614e7e. That is what lets every rule below be tested without a host.
 */

import { shellQuoteRemotePath } from '@pocketshell/core';

/**
 * How many candidate directories one session name may be asked about.
 *
 * The candidate set is every way of reading the name's hyphens as either a
 * separator or a literal, which is 2^(n-1) for n components — 8 for a
 * four-component name like `ai-engineering-field-guide`, 128 for an
 * eight-component one. The cap keeps a pathological name from turning one
 * session into a hundred `test -d` calls, and it costs nothing real: the
 * candidates are ordered fewest-separators-first (see
 * {@link sessionDirCandidates}), so the eight that survive the cap are the
 * flat name plus every single-split reading, and those are the shapes people
 * actually have. A name whose true directory needs three separators AND has
 * more than four components is not recovered — it keeps today's null and the
 * grey fallback row, which is exactly where it already was.
 */
export const MAX_CANDIDATES_PER_SESSION = 8;

/**
 * Candidate absolute directories for a session name, best guess first.
 *
 * The FIRST component is always taken as a directory directly under the home
 * directory — that is the convention the whole naming scheme rests on
 * (`resolveSessionName` derives `git-red-stamp` from `~/git/red-stamp`), and
 * it is the one part of the name that is not ambiguous. Everything after it is
 * enumerated: each remaining hyphen is read once as a path separator and once
 * as a literal character.
 *
 * Ordering is by NUMBER OF SEPARATORS ascending, and that ordering is a claim
 * about the world rather than an arbitrary tie-break. Repository directories
 * are overwhelmingly flat — `~/git/ai-engineering-field-guide`, not
 * `~/git/ai/engineering/field/guide` — so the flat reading is tried first, and
 * a host that somehow has both gets the flat one. Within the same separator
 * count the split that is furthest RIGHT comes first, because a nested
 * checkout is usually one repository holding one subdirectory
 * (`~/git/dtc-website/import`) rather than a deep tree.
 *
 * A name with no hyphen at all yields exactly one candidate, `<home>/<name>`.
 * An empty name yields none.
 */
export function sessionDirCandidates(name: string, home: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const base = home.replace(/\/+$/, '') || '';
  const parts = trimmed.split('-').filter((p) => p.length > 0);
  if (parts.length === 0) return [];
  // The root component is fixed; only the tail is ambiguous.
  const [root, ...tail] = parts;
  if (tail.length === 0) return [`${base}/${root}`];

  const gaps = tail.length - 1; // hyphens inside the tail
  const readings: { separators: number; rightmost: number; path: string }[] = [];
  for (let mask = 0; mask < 1 << gaps; mask++) {
    let segment = tail[0]!;
    const segments: string[] = [];
    let separators = 0;
    // The lowest bit is the LEFTMOST hyphen, so `rightmost` records how far
    // right the first separator sits — the tie-break described above.
    let rightmost = -1;
    for (let i = 0; i < gaps; i++) {
      if (mask & (1 << i)) {
        segments.push(segment);
        segment = tail[i + 1]!;
        separators += 1;
        if (rightmost < 0) rightmost = i;
      } else {
        segment = `${segment}-${tail[i + 1]!}`;
      }
    }
    segments.push(segment);
    readings.push({
      separators,
      rightmost: rightmost < 0 ? gaps : rightmost,
      path: `${base}/${root}/${segments.join('/')}`,
    });
  }
  readings.sort((a, b) => b.rightmost - a.rightmost);
  readings.sort((a, b) => a.separators - b.separators);
  return readings.slice(0, MAX_CANDIDATES_PER_SESSION).map((r) => r.path);
}

/**
 * The batched existence probe: `test -d` for every candidate, in one exec.
 *
 * ## Why it prints an INDEX and nothing else
 *
 * The worktree probe next door (`gitRepoProbeCommand`) learned this the hard
 * way — see the header of ./worktrees.ts. A path is user-named and can contain
 * any delimiter this app might pick, including `::`, so printing the path back
 * makes the output ambiguous with itself. Printing the REQUEST INDEX makes the
 * output digits, which cannot be ambiguous under any input, and the caller
 * already holds the array to map them back through.
 *
 * ## Why one exec and not one per candidate
 *
 * The same discipline as every other host probe in this app: the session list
 * refreshes on a timer, so a per-candidate exec would put a stream of SSH
 * channels on the user's host forever, against an `sshd` `MaxSessions` of ten
 * that the tmux client pool is already budgeting against.
 *
 * An empty request list returns a command that prints nothing and exits 0, so
 * the caller does not have to special-case it.
 */
export function directoryExistsProbeCommand(paths: readonly string[]): string {
  if (paths.length === 0) return 'true';
  const quoted = paths.map(shellQuoteRemotePath).join(' ');
  return (
    '__ps_i=0; ' +
    `for __ps_d in ${quoted}; do ` +
    '__ps_n=$__ps_i; __ps_i=$((__ps_i+1)); ' +
    '[ -d "$__ps_d" ] || continue; ' +
    "printf '%s\\n' \"$__ps_n\"; " +
    'done'
  );
}

/**
 * Which of the requested directories exist, as a set of the paths themselves.
 *
 * [requested] must be the exact array, in the exact order, that was passed to
 * {@link directoryExistsProbeCommand} — the index is a position in it. A line
 * that is not all digits, or whose index is out of range, is dropped: it can
 * only mean the output and the request have gone out of step, and reading a
 * banner line from a login shell as an index would report a directory as
 * existing on the strength of an unrelated number.
 */
export function parseExistingDirectories(
  stdout: string,
  requested: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\d+$/.test(line)) continue;
    const path = requested[Number.parseInt(line, 10)];
    if (path === undefined) continue;
    out.add(path);
  }
  return out;
}
