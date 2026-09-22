/**
 * Pure parsers for the aplexer CLI's machine-readable output, the
 * snapshot-record → panel-row mapping, and the agent-kind vocabulary.
 *
 * The contract is `a snapshot --json` (the same records `a list --json`
 * prints): a bare JSON array of session records, each carrying at least the
 * required `session-v1` fields. Rows come back in the host's own order — with
 * `--sort` the requested key, and on a host that has no `--sort` its
 * newest-created-first default. All functions are pure — string in, data out,
 * no I/O — so they are pinned by unit tests rather than by a host. Both
 * clients (desktop main, browser bundle) parse with this exact code.
 */

import type { SessionAgentKind, SessionSummary } from './types';
import type { AplexerSessionRecord, AplexerWarning } from './aplexer';

/**
 * Records oldest-created first, ties in document order (Array#sort is
 * stable).
 *
 * The fallback order for a host whose `a` predates `--sort`: its unsorted
 * default is newest-first, and oldest-first is what such a host showed in
 * the panel before the flag existed. It is the same key the legacy helper
 * table is pinned to in `PocketshellClient` — one notion of "no host sort"
 * across both sources.
 */
export function byOldestCreated(records: AplexerSessionRecord[]): AplexerSessionRecord[] {
  return [...records].sort((a, b) => a.created_at_ms - b.created_at_ms);
}

/**
 * Parse `a snapshot --json` into records. Unknown/truncated output -> [].
 *
 * Rows that are not objects, or that lack the identity triple
 * (`id`/`workspace`/`tag`), are dropped individually rather than failing the
 * batch: one corrupt record must not hide every session on the host. Records
 * whose worker is gone (`worker_alive: false`, or a terminal `phase` with no
 * live worker) are dropped too — a dead record is not a session the panel can
 * open, and `a prune`/`a kill` own its removal host-side.
 */
export function parseAplexerSnapshot(stdout: string): AplexerSessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AplexerSessionRecord[] = [];
  for (const row of parsed) {
    const record = parseAplexerRecord(row);
    if (record) out.push(record);
  }
  return out;
}

/** One snapshot element, or null when it is not a live session record. */
function parseAplexerRecord(row: unknown): AplexerSessionRecord | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const doc = row as Record<string, unknown>;
  const id = doc['id'];
  const workspace = doc['workspace'];
  const tag = doc['tag'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof workspace !== 'string' || workspace.length === 0) return null;
  if (typeof tag !== 'string' || tag.length === 0) return null;
  const phase = typeof doc['phase'] === 'string' ? doc['phase'] : '';
  const workerAlive = doc['worker_alive'];
  // A worker killed without recording an exit leaves `phase: 'running'`
  // forever — liveness is the pair, never the phase alone. Records without
  // the enrichment are old-host rows; their phase is all there is.
  if (workerAlive === false) return null;
  if (workerAlive !== true && isTerminalPhase(phase)) return null;
  const createdMs = typeof doc['created_at_ms'] === 'number' ? doc['created_at_ms'] : NaN;
  const activityMs = typeof doc['last_activity_ms'] === 'number' ? doc['last_activity_ms'] : NaN;
  const cwdRaw = doc['cwd'];
  const cwd = typeof cwdRaw === 'string' && cwdRaw.length > 0 ? cwdRaw : null;
  const engineRaw = doc['engine'];
  const engine = typeof engineRaw === 'string' ? engineRaw : '';
  const profileRaw = doc['profile'];
  const profile = typeof profileRaw === 'string' ? profileRaw : null;
  return {
    id,
    workspace,
    tag,
    engine,
    ...(profile ? { profile } : {}),
    ...(cwd ? { cwd } : {}),
    phase,
    ...(typeof workerAlive === 'boolean' ? { worker_alive: workerAlive } : {}),
    created_at_ms: Number.isFinite(createdMs) ? createdMs : 0,
    ...(Number.isFinite(activityMs) ? { last_activity_ms: activityMs } : {}),
  };
}

/** Phases after which no worker work remains. Mirrors the spec §20 set. */
function isTerminalPhase(phase: string): boolean {
  return phase === 'exited' || phase === 'failed';
}

/**
 * Map a declared aplexer engine id to the panel's agent kind.
 *
 * The recorded `@ps_agent_kind` vocabulary and the aplexer engine ids are the
 * same words (`claude`, `codex`, `opencode`, `grok`, `shell`) because both
 * were ported from the same PocketShell registry — so this one table is ALSO
 * the tmux option mapper (`helper/parsers.ts` delegates to it), not a second
 * table to drift from it. Unknown engines read as "we did not launch this"
 * (null), exactly like an unknown option value.
 */
export function agentKindFromEngine(
  engine: string | null | undefined,
): SessionAgentKind | null {
  switch (engine?.trim().toLowerCase()) {
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
 * Parse `a warnings --json` into warnings. Unknown/truncated output -> [].
 *
 * The contract is a bare JSON array of warning objects, newest crash first
 * (the host sorts by `created_at_ms`). Like the snapshot parser, rows that
 * are not usable are dropped individually — one corrupt file on the host
 * must not hide the other crashes. A row needs the identity pair
 * (`session`/`tag`), a known `kind`, and a finite `created_at_ms`; `detail`
 * may be absent (the banner then speaks from kind + selector alone).
 *
 * The browser's bridge-PTY warnings path deliberately does NOT use this
 * parser: over a shell there is no framing, so one bad row means the output
 * itself is untrustworthy and that path refuses the whole batch instead.
 */
export function parseAplexerWarnings(stdout: string): AplexerWarning[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AplexerWarning[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const doc = row as Record<string, unknown>;
    const session = doc['session'];
    const tag = doc['tag'];
    const kind = doc['kind'];
    if (typeof session !== 'string' || session.length === 0) continue;
    if (typeof tag !== 'string' || tag.length === 0) continue;
    if (kind !== 'oom' && kind !== 'crash') continue;
    const createdMs = doc['created_at_ms'];
    if (typeof createdMs !== 'number' || !Number.isFinite(createdMs)) continue;
    const workspace = doc['workspace'];
    const engine = doc['engine'];
    const detail = doc['detail'];
    out.push({
      session,
      tag,
      kind,
      created_at_ms: createdMs,
      ...(typeof workspace === 'string' ? { workspace } : { workspace: '' }),
      ...(typeof engine === 'string' ? { engine } : { engine: '' }),
      ...(typeof detail === 'string' ? { detail } : { detail: '' }),
    });
  }
  return out;
}

/**
 * Parse `a start --json`'s single-record body.
 *
 * `start` prints one object, not the snapshot's array; rather than a second
 * record parser, reuse the array one by wrapping — with a direct-parse
 * fallback for a body that is already an object but wrapped in shell noise
 * the brackets would corrupt. The first non-empty JSON-looking line wins.
 */
export function parseSingleAplexerRecord(stdout: string): AplexerSessionRecord | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    const records = parseAplexerSnapshot(JSON.stringify([parsed]));
    return records.at(0) ?? null;
  } catch {
    return null;
  }
}

/**
 * An aplexer record as a session row.
 *
 * `name` carries the tag: display, tab identity, rename labelling, and the
 * folder-row tooltip all read `name` and work unchanged. `path` carries the
 * workspace — the grouping key — falling back to the workload cwd when the
 * workspace is ever unusable, so the row always files under a real folder
 * with no name-heuristic inference (`pathInferred` is never set here).
 * `attached` is always false: the snapshot carries no client count, and a
 * row that never claims attachment is a row whose dot is sometimes missing,
 * while the reverse would mark dead rows live.
 */
export function aplexerRecordToSummary(record: AplexerSessionRecord): SessionSummary {
  return {
    name: record.tag,
    created: Math.floor(record.created_at_ms / 1000),
    activity:
      record.last_activity_ms != null
        ? Math.floor(record.last_activity_ms / 1000)
        : Math.floor(record.created_at_ms / 1000),
    attached: false,
    path: record.workspace || record.cwd || null,
    agentKind: agentKindFromEngine(record.engine),
    backend: 'aplexer',
    workspace: record.workspace,
    tag: record.tag,
    aplexerId: record.id,
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.phase ? { aplexerPhase: record.phase } : {}),
  };
}
