import type { SessionSummary } from '../shared/types';

/**
 * Renderer-side identity for a session row.
 *
 * tmux names are host-global, so the bare name IS the identity — and keeping
 * it bare keeps every persisted key (`conn/name` composer drafts in
 * localStorage) stable. aplexer tags repeat across workspaces, so an aplexer
 * row with a known workspace addresses as `aplexer:<workspace>:<tag>`: two
 * folders holding same-named tags get two composer drafts and two shells
 * entries instead of one aliasing the other.
 *
 * An aplexer row WITHOUT a workspace (a stale row, a caller that only has a
 * name) falls back to the bare name — the same answer the tmux case gives.
 * That fallback is deliberate: an identity function must never refuse, and a
 * merged draft beats a dropped write. Callers that need strictness (kill,
 * rename) do their own snapshot resolution main-side instead.
 */
export function sessionIdentityKey(
  name: string,
  opts?: {
    backend?: SessionSummary['backend'];
    workspace?: string | null;
  },
): string {
  if (opts?.backend === 'aplexer' && opts.workspace) {
    return `aplexer:${opts.workspace}:${name}`;
  }
  return name;
}
