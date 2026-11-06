/**
 * Pure parsers for the small CLI outputs that are not session-shaped:
 * env rows and the durable tree registry's JSON payloads. The agent
 * subcommand listing's parser went with the probe it served — the launch
 * picker's engine catalog is `a engines --json` now, parsed in core's
 * `parseAplexerEngineIds`.
 */


// `command -v` probe parsing lives in core now (see src/hostProbeParsers.ts there).
export { parseCommandV, parseEnvVarRow } from '@pocketshell/core';



/**
 * One node of the host's durable project-tree registry
 * (`pocketshell tree get`, FEATURES.md F18's successor item: the
 * session-to-folder record the phone keeps and the desktop never called).
 */
export interface TreeNodeRecord {
  session: string;
  order: number;
  folderPath: string;
  collapsed: boolean;
}

/**
 * Parse a `tree get` response: `{"nodes": [...], "version": N}`.
 *
 * **null, never [], when the payload is not a tree answer at all** — a proxy
 * banner, a truncated body, a wrong-version helper. The caller treats null as
 * "no registry" and falls back to the name heuristic, while a real `[]` is a
 * meaningful "registry exists and is empty". Malformed NODES are dropped row
 * by row rather than failing the batch, for the same reason
 * {@link parseEnvVarRow} drops them.
 */
export function parseTreeGet(stdout: string): TreeNodeRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  const out: TreeNodeRecord[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const doc = node as Record<string, unknown>;
    if (typeof doc['session'] !== 'string' || doc['session'].length === 0) continue;
    if (typeof doc['folder_path'] !== 'string' || doc['folder_path'].length === 0) continue;
    out.push({
      session: doc['session'],
      order: typeof doc['order'] === 'number' ? doc['order'] : 0,
      folderPath: doc['folder_path'],
      collapsed: doc['collapsed'] === true,
    });
  }
  return out;
}

/**
 * The `tree upsert` request body: `{"host": ..., "nodes": [...]}` on stdin.
 *
 * Upsert REPLACES the host's list (the helper's own help says "persist a
 * host's node list"), so callers must send the FULL merged list — the payload
 * builder is here, pure, because getting the wire shape wrong would silently
 * drop every session the phone recorded.
 */
export function treeUpsertPayload(host: string, nodes: readonly TreeNodeRecord[]): string {
  return JSON.stringify({
    host,
    nodes: nodes.map((n) => ({
      session: n.session,
      order: n.order,
      folder_path: n.folderPath,
      collapsed: n.collapsed,
    })),
  });
}

/**
 * Parse a `tree reconcile` response: `{"alive": [...], "gone": [...],
 * "added": [...]}` — session names in every list, never nodes. Null when the
 * answer is not a reconcile answer, matching {@link parseTreeGet}.
 */
export function parseTreeReconcile(stdout: string): {
  alive: string[];
  gone: string[];
  added: string[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  const names = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
  const alive = names(doc['alive']);
  const gone = names(doc['gone']);
  const added = names(doc['added']);
  return alive && gone && added ? { alive, gone, added } : null;
}
