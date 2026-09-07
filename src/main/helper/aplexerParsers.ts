/**
 * Pure parsers for the aplexer CLI's machine-readable output.
 *
 * The contract is `a snapshot --json`: a bare JSON array of session records,
 * newest first, each carrying at least the required `session-v1` fields. All
 * functions are pure — string in, data out, no I/O — so they are pinned by
 * unit tests rather than by a host.
 */

import type { SessionAgentKind, SessionSummary } from '../../shared/types.js';
import type { AplexerSessionRecord } from '../../shared/aplexer.js';
import { agentKindFromTmuxOption } from './parsers.js';

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
 * were ported from the same PocketShell registry — so the tmux option mapper
 * is the mapping, not a second table to drift from it. Unknown engines read
 * as "we did not launch this" (null), exactly like an unknown option value.
 */
export function agentKindFromEngine(engine: string): SessionAgentKind | null {
  return agentKindFromTmuxOption(engine);
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

