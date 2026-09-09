import type { HostEntry } from './types.js';

/**
 * The merge that decides what a sync writes, pure so both the tests and the
 * sync store's retry loop can drive it without a file or a network.
 *
 * The payload synced to the account is the list of host entries as
 * `listConfigHosts()` reports them (hostnames, users, ports, forwards —
 * never private keys, which are files on disk and never leave it). Two
 * machines editing "the same settings" are really two lists of host
 * directives, so the merge is a UNION BY ALIAS:
 *
 *   - a host known to only one side is kept (that is how a host added on
 *     the laptop reaches the desktop, and vice versa);
 *   - a host BOTH sides know is taken from the LOCAL side, entry as a whole.
 *
 * No per-field merge and no per-host timestamps: HostEntry has none, and a
 * half-merged host (this machine's user, that machine's port) is worse than
 * either whole entry. Local-wins means the machine you are sitting at is
 * authoritative for the hosts you are already using — after the push, the
 * account carries exactly what this machine carries, plus the hosts only
 * the other machine had.
 */

export interface MergeOutcome {
  /** The union, local entries first in local order, then remote-only ones. */
  hosts: HostEntry[];
  /** Remote aliases that did not exist locally (these become applyHosts' input). */
  addedFromRemote: string[];
  /** True when the remote side contributed anything — the union only ever grows. */
  changed: boolean;
}

export function mergeHostLists(local: readonly HostEntry[], remote: readonly HostEntry[]): MergeOutcome {
  const localByName = new Map(local.map((host) => [host.name, host]));
  const addedFromRemote: HostEntry[] = [];
  for (const host of remote) {
    if (!localByName.has(host.name)) {
      localByName.set(host.name, host);
      addedFromRemote.push(host);
    }
  }
  return {
    hosts: [...local, ...addedFromRemote],
    addedFromRemote: addedFromRemote.map((host) => host.name),
    changed: addedFromRemote.length > 0,
  };
}

/** Serialize the payload the envelope encrypts — the envelope's plaintext. */
export function serializeSyncPayload(hosts: readonly HostEntry[]): string {
  return JSON.stringify({ hosts });
}

/**
 * Parse a pulled plaintext, degraded: anything that is not a payload with a
 * plausible host array parses to an EMPTY list, not an error — a blob is
 * user data from possibly an older build, and an empty merge is the safe
 * outcome (nothing remote to add, push re-stores what local has).
 */
export function parseSyncPayload(plaintext: string): HostEntry[] {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>)['hosts'])) {
      return [];
    }
    const out: HostEntry[] = [];
    for (const entry of (parsed as Record<string, unknown>)['hosts'] as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const name = e['name'];
      const hostname = e['hostname'];
      // Same minimum a Host directive needs — the exact per-field degradation
      // for the trusted-file path lives in sync.ts's coerceHostEntries.
      if (typeof name !== 'string' || name.trim() === '' || typeof hostname !== 'string' || hostname.trim() === '') {
        continue;
      }
      out.push(e as unknown as HostEntry);
    }
    return out;
  } catch {
    return [];
  }
}
