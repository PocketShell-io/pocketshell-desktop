/**
 * Pure parsers for the small CLI outputs that are not session-shaped:
 * `command -v` probes, agent subcommand listings, env rows, and the durable
 * tree registry's JSON payloads.
 */

import type { EnvVarRow } from '@pocketshell/core';

// `command -v` probe parsing lives in core now (see src/hostProbeParsers.ts there).
export { parseCommandV, parseEnvVarRow } from '@pocketshell/core';

// ---------------------------------------------------------------------------
// bootstrap probe result parsing
// ---------------------------------------------------------------------------


/**
 * The subcommand names in the `Commands:` block of a click `--help`, or null
 * when the output could not be read that way.
 *
 * Written for `pocketshell agent --help`, which is how the app finds out
 * whether a host can launch a given engine. Asking the help text rather than
 * comparing `pocketshell --version` against a remembered table is the same
 * choice made everywhere else in this file: the helper is a separately
 * released project, this repo has been wrong about its documented contract
 * repeatedly, and the `Commands:` block is the host stating its own
 * capabilities in its own words. It also degrades honestly — a helper that
 * gains `grok` starts being offered the moment it is installed, with no
 * version table to bump here.
 *
 * The shape it parses, from `tests/unit/fixtures/v0.4.44-agent-help.txt`:
 *
 *     Commands:
 *       claude    Launch `claude` in --dir with first-run prompts suppressed.
 *       codex     Launch `codex` in --dir with first-run prompts suppressed.
 *       opencode  Launch `opencode` in --dir with first-run prompts suppressed.
 *
 * Names sit at exactly two spaces of indent; click wraps a long description
 * onto continuation lines indented to the description column, so an indented
 * line that does not start a name is SKIPPED rather than treated as the end of
 * the block. A non-indented line is a new section and does end it.
 *
 * **null, never `[]`, when the answer is unknown** — a non-zero exit, no
 * `Commands:` header, or a header with nothing parseable under it. Callers act
 * on the difference: `[]` would be a host claiming it can launch nothing,
 * which no real helper says, whereas null means we never got an answer and the
 * caller should fall back to what the pinned version guarantees rather than to
 * refusing everything. See shared/agentLaunch.ts `HostAgentSupport`.
 */
export function parseAgentSubcommands(stdout: string, exitCode: number): string[] | null {
  if (exitCode !== 0) return null;
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line));
  if (start < 0) return null;
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    // Back at the left margin: a new `--help` section, so the block is over.
    if (!/^\s/.test(line)) break;
    const match = /^ {2}(\S+)(?: {2,}\S|\s*$)/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names.length > 0 ? names : null;
}


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
