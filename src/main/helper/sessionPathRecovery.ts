/**
 * Recovering working directories for sessions the helper's table left bare.
 *
 * The `sessions list` table and the enrichment probe are independent reads on
 * one round trip, and each can fail or come back without a path: this module
 * holds every way a session's directory is recovered (cached paths, probe
 * merge, sibling inference) and the diagnostic that reports what happened —
 * the log lines the user is asked to paste.
 *
 * Split out of parsers.ts, which keeps the session-list and enrichment-row
 * parsing this consumes.
 */

import type { SessionSummary } from '../../shared/types.js';
import type { SessionEnrichment } from './parsers.js';

/**
 * Put back the sessions the helper's table omitted but the enrichment probe
 * SAW.
 *
 * ## Why this exists
 *
 * The table and the probe travel in the same round-trip but are independent
 * reads: the table is one CLI pass over every socket, the probe its own
 * sweep. On a loaded host the table can come back TRUNCATED — one socket's
 * rows missing while the probe saw them fine — and a table that merely
 * forgot a live session was being accepted as the whole truth, which pruned
 * the session's tab, closed its pane, and made a running session
 * un-openable until a luckier poll (measured on CI: tab bar held
 * `build` while the host sweep answered `main attached=1` and the
 * helper's own list named both).
 *
 * A session the probe saw is live — the same evidence the Stop locator
 * trusts — so the omission is repaired from the probe's rows. Timestamps
 * are the one thing the probe does not carry, so a restored row reports 0
 * for created/activity (it sorts last, it does not lie) and the next
 * complete poll replaces it wholesale.
 */
/**
 * Reuse the last reported working directory for a session whose placement
 * evidence dropped out of THIS poll.
 *
 * A session's folder placement rests entirely on the enrichment probe: the
 * helper's table carries names and times but no paths. When that probe has a
 * bad round trip — measured flapping on CI (`tmux -u list-panes -a` exiting 1
 * while the session sat alive and attached on the host) — every path-bearing
 * row vanishes at once, and a session with no path has nowhere to live: its
 * folder's tab bar prunes it, its pane closes, and a running agent becomes
 * un-openable until a luckier poll. The cache is the answer the same problem
 * already got for repository roots: a directory a session was in does not
 * stop being true because one read of it failed.
 *
 * Pure: [cache] maps session name to last reported path and is UPDATED in
 * place (new evidence overwrites, absence never deletes). Returns the list
 * with nulls filled from the cache where one exists, flagged via
 * `pathInferred` so the UI can say the placement is remembered, not read.
 */
export function applyCachedSessionPaths(
  sessions: SessionSummary[],
  cache: Map<string, string>,
): SessionSummary[] {
  for (const session of sessions) {
    if (typeof session.path === 'string' && session.path.length > 0) {
      cache.set(session.name, session.path);
    }
  }
  let changed = false;
  const out = sessions.map((session) => {
    if (session.path !== null) return session;
    const cached = cache.get(session.name);
    if (cached === undefined) return session;
    changed = true;
    return { ...session, path: cached, pathInferred: true };
  });
  return changed ? out : sessions;
}

export function restoreUnlistedSessions(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionSummary[] {
  if (enrichment.size === 0) return sessions;
  const listed = new Set(sessions.map((session) => session.name));
  const restored: SessionSummary[] = [];
  for (const [name, extra] of enrichment) {
    if (listed.has(name)) continue;
    restored.push({
      name,
      created: 0,
      activity: 0,
      attached: extra.attached,
      path: extra.path ?? null,
      agentKind: extra.agentKind,
    });
  }
  if (restored.length === 0) return sessions;
  return [...sessions, ...restored];
}

export function mergeSessionEnrichment(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionSummary[] {
  // Fold the companion probe's data into the bare rows from `sessions list`.
  // A session with no enrichment entry keeps its bare defaults — the probe
  // degrading (no tmux, non-zero exit, a tmux too old for `#{@…}`) must never
  // cost us the list itself, only the grouping metadata.
  const merged = sessions.map((session) => {
    const extra = findEnrichment(enrichment, session.name);
    if (!extra) return session;
    return {
      ...session,
      // The pane probe's cwd is the better answer, but never downgrade a path
      // the fallback path already resolved to null.
      path: extra.path ?? session.path,
      attached: extra.attached,
      agentKind: extra.agentKind,
    };
  });
  return inferPathsFromSiblings(merged);
}

/**
 * Give a session with no reported working directory the directory of the
 * session it is named after.
 *
 * ## Why this exists
 *
 * The user reported four sessions rendering as orphans - direct children of a
 * root with no folder - and circled two pairs they expected to sit together:
 * `git-red-stamp-sound` against `git-red-stamp`, and `git-dtc-website-import`
 * against `git-dtc-website`. In every pair the orphan's name is the other
 * session's name plus a `-suffix`, which is exactly what a second session in
 * one folder is called.
 *
 * It matters more than it used to. The folder workspace keys EVERYTHING on the
 * folder - one panel row per folder, one workspace per folder, tabs derived
 * from the sessions in it - so a session with no folder has nowhere to live at
 * all. Leaving it unplaced is not an annoyance any more; it is a live session
 * the user can no longer reach.
 *
 * ## Why it matches against siblings rather than deriving a path from the name
 *
 * `rootFromSessionName` (src/renderer/sessionGrouping.ts) recovers only the
 * ROOT from a name, and its comment explains the refusal to go further: `-` is
 * both the component separator AND a legal character inside a component, so
 * `git-dtc-website-import` is genuinely ambiguous between
 * `~/git/dtc-website-import` and `~/git/dtc-website/import`, and inventing a
 * folder from that guess is worse than having none.
 *
 * This does not guess. It only ever adopts a path that ANOTHER SESSION IS
 * ACTUALLY REPORTING, so it can file a session into a folder that exists and
 * can never conjure one that does not. The longest matching prefix wins, so a
 * host running both `git-a` and `git-a-b` places `git-a-b-c` under `git-a-b`.
 *
 * ## When it is wrong, and why it is still worth doing
 *
 * If `git-red-stamp-sound` genuinely runs in `~/git/red-stamp-sound` - its own
 * repo - this files it under `~/git/red-stamp`, and the real fix is the null
 * path rather than the grouping. The rows are marked `pathInferred` so the
 * guess is legible rather than silent, and {@link diagnoseSessionPaths} is what
 * settles which case a host is in. The alternative is leaving the session in
 * the bucket the user has just complained about.
 *
 * Sessions that already have a path are returned untouched, and a session with
 * no matching sibling keeps its null.
 */
export function inferPathsFromSiblings(sessions: SessionSummary[]): SessionSummary[] {
  const anchors = sessions.filter((s) => s.path != null && s.path !== '');
  if (anchors.length === 0) return sessions;
  return sessions.map((session) => {
    if (session.path != null && session.path !== '') return session;
    let best: SessionSummary | null = null;
    for (const anchor of anchors) {
      // The `-` boundary is required for the same reason the tab-label
      // stripper requires it: `git-red-stamp` must not claim
      // `git-red-stampede`, which is a different folder entirely.
      if (!session.name.startsWith(`${anchor.name}-`)) continue;
      if (best === null || anchor.name.length > best.name.length) best = anchor;
    }
    if (best === null) return session;
    return { ...session, path: best.path, pathInferred: true };
  });
}

/**
 * What went wrong for every session that still has no working directory of its
 * own.
 *
 * A pure function, so the diagnosis is testable; `PocketshellClient.listSessions`
 * calls it and writes the result to `~/.pocketshell/desktop.log` (see
 * src/main/log.ts for why a file log exists at all). The point is to replace a
 * guess with an observation: the three candidate causes below produce an
 * identical symptom in the UI - a session in the wrong place - and are told
 * apart only by what the probe actually said.
 *
 *   absent     the probe emitted no row for this session under any spelling.
 *              Either tmux listed no panes for it, or the probe output was cut
 *              short.
 *   no-path    a row was there and both path columns were empty. That is what
 *              tmux reports for a pane whose process has exited under
 *              `remain-on-exit`.
 *   ambiguous  a row exists under a different spelling, but the
 *              column-sanitised key it would have been found by was claimed by
 *              two sessions and dropped by 3ac7abc's safety rule.
 *
 * `unmatchedProbeKeys` is the other half of the picture: enrichment rows that
 * matched no listed session at all. A spelling mismatch the sanitiser does not
 * model shows up there and nowhere else.
 */
interface SessionPathDiagnosis {
  name: string;
  probe: 'absent' | 'no-path' | 'ambiguous';
  /** The column-sanitised key the lenient lookup would have used. */
  lenientKey: string;
  /** True when the path this session ended up with came from a sibling. */
  inferred: boolean;
}

export interface SessionPathReport {
  total: number;
  /** Sessions the probe failed to place - inferred ones included. */
  unplaced: SessionPathDiagnosis[];
  /** Probe rows that belong to no listed session. */
  unmatchedProbeKeys: string[];
}

export function diagnoseSessionPaths(
  sessions: SessionSummary[],
  enrichment: Map<string, SessionEnrichment>,
): SessionPathReport {
  const { index: lenient, ambiguous } = lenientEnrichmentIndex(enrichment);
  const matched = new Set<string>();
  const unplaced: SessionPathDiagnosis[] = [];

  for (const session of sessions) {
    const lenientKey = asciiSanitised(session.name);
    const exact = enrichment.get(session.name);
    const loose = exact ?? lenient.get(lenientKey);
    if (exact) matched.add(session.name);

    // `pathInferred` means the path on the row is a SIBLING's, so the probe
    // still failed to place this session - which is what this report is about.
    // A row carrying a path of its own is simply fine.
    const placed = session.path != null && session.path !== '' && session.pathInferred !== true;
    if (placed) continue;

    const probe: SessionPathDiagnosis['probe'] = loose
      ? 'no-path'
      : ambiguous.has(lenientKey)
        ? 'ambiguous'
        : 'absent';
    unplaced.push({
      name: session.name,
      probe,
      lenientKey,
      inferred: session.pathInferred === true,
    });
  }

  const unmatchedProbeKeys = [...enrichment.keys()].filter((key) => !matched.has(key));
  return { total: sessions.length, unplaced, unmatchedProbeKeys };
}

/**
 * Why the two halves of this join can disagree about a session's NAME.
 *
 * The names come from `pocketshell sessions list`, which shells out to
 * `tmuxctl list`, which runs plain `tmux list-sessions`. The paths come from
 * our own probe, which runs `tmux -u list-panes -a`. Same host, same tmux
 * server, two different tmux CLIENTS — and a tmux client that has not been
 * told it is on a UTF-8 terminal SANITISES every byte it prints, replacing
 * each one outside ASCII with a single `_`. Captured on the fixture image
 * (tmux 3.4, sshd exporting no locale), for a session named `git-café-guide`:
 *
 *   $ tmux list-sessions -F '#{session_name}'
 *   git-caf_-guide
 *   $ tmux -u list-panes -a -F '#{session_name}::…'
 *   git-café-guide::…
 *
 * `-u` was added to the probe (issue #2160) so that PATHS survived exactly
 * this mangling. What it also did, unnoticed, was move one side of the join
 * key out of step with the other: the helper offers `git-caf_-guide`, the
 * probe is filed under `git-café-guide`, `Map.get` misses, and the session
 * keeps the `path: null` that `parseSessionsList` gave it. The row still
 * lists — it just has no working directory, so the Files tab opens at the
 * login home and the folder panel files it under `other`.
 *
 * Dropping `-u` would trade a broken name for a broken path and fix nothing.
 * Matching leniently costs one extra index and fixes both: look the exact
 * name up first, and only if that misses, look up the name with the same
 * sanitisation the un-`-u`'d client would have applied.
 *
 * Control bytes are folded too, because the same client applies the same
 * treatment to them — that is what breaks tmuxctl's own tab-delimited
 * `list-sessions` on this fixture (tmuxctl issue #6).
 *
 * The substitution is per DISPLAY COLUMN, not per byte and not per character,
 * which is worth stating because two of the three are wrong. Measured on the
 * same image:
 *
 *   git-café-guide  ->  git-caf_-guide     (1 char, 2 bytes, 1 column)
 *   git-ćé-x        ->  git-__-x           (2 chars, 4 bytes, 2 columns)
 *   git-日本-y       ->  git-____-y         (2 chars, 6 bytes, 4 columns)
 *
 * So a CJK or emoji character costs two underscores and a Latin accent one.
 * {@link displayColumns} models that; it does not have to be a complete
 * wcwidth, because a name this gets wrong simply fails to match and keeps
 * today's null path rather than acquiring a wrong one.
 */
function asciiSanitised(name: string): string {
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x20 && cp < 0x7f ? ch : '_'.repeat(displayColumns(cp));
  }
  return out;
}

/**
 * Terminal columns one code point occupies — enough of wcwidth to cover what
 * turns up in a session name, which is a directory basename.
 *
 * The wide ranges are the East Asian Wide/Fullwidth blocks plus the emoji
 * planes; everything else, control characters included, is one column.
 */
function displayColumns(cp: number): number {
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd); // CJK extension planes
  return wide ? 2 : 1;
}

/**
 * Secondary index for {@link mergeSessionEnrichment}, keyed by the sanitised
 * name.
 *
 * A key that two different sessions sanitise to is DROPPED rather than
 * resolved arbitrarily. Attaching one session's working directory to another
 * is a worse outcome than the missing path this is here to fix: a null path
 * shows up as a session in the `other` bucket, while a wrong one silently
 * opens the Files tab in someone else's project.
 */
function lenientEnrichmentIndex(enrichment: Map<string, SessionEnrichment>): {
  index: Map<string, SessionEnrichment>;
  /** Keys two sessions both claimed, and which were therefore dropped. */
  ambiguous: Set<string>;
} {
  const index = new Map<string, SessionEnrichment>();
  const ambiguous = new Set<string>();
  for (const [name, value] of enrichment) {
    const key = asciiSanitised(name);
    if (key === name) continue; // the exact lookup already covers it
    if (index.has(key)) {
      ambiguous.add(key);
      continue;
    }
    index.set(key, value);
  }
  for (const key of ambiguous) index.delete(key);
  return { index, ambiguous };
}

/**
 * Look a session name up in the enrichment map exactly, then — and only then —
 * under the ASCII sanitisation a non-`-u` tmux client would have printed
 * ({@link asciiSanitised}).
 *
 * One function because the exact-then-lenient ORDER is load-bearing in more
 * than one caller now: {@link mergeSessionEnrichment} joins paths with it and
 * {@link PocketshellClient.locateSession} turns it into an aimed kill. A
 * caller inlining the two lookups is how the order drifts.
 */
export function findEnrichment(
  enrichment: Map<string, SessionEnrichment>,
  name: string,
): SessionEnrichment | null {
  const exact = enrichment.get(name);
  if (exact) return exact;
  const lenient = lenientEnrichmentIndex(enrichment).index.get(asciiSanitised(name));
  return lenient ?? null;
}
