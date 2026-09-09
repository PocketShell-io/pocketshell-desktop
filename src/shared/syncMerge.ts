import type { HostEntry } from './types.js';

/**
 * The merge that decides what a sync writes, pure so both the tests and the
 * sync store's retry loop can drive it without a file or a network.
 *
 * Sync is SELECTIVE (docs/SYNC.md): the payload is the ticked aliases and
 * nothing else — a host the user has not ticked never leaves the machine,
 * encrypted or otherwise. The tick marks are the whole contract, and the
 * account is part of them rather than a rival: aliases pulled from the
 * account tick themselves on ({@link aliasesToAutoCheck}), so a plain
 * sequence of syncs only ever grows the set and an explicit UNTICK is the
 * one way a host leaves the account.
 *
 * Content per ticked alias:
 *   - the LOCAL entry when ~/.ssh/config has it — the machine you are
 *     sitting at is authoritative for the hosts it has;
 *   - else the ACCOUNT's entry — a ticked alias the config has lost (say,
 *     during a restore that went wrong) keeps its backup instead of
 *     silently vanishing from the account too.
 *
 * The payload stays the one JSON shape it has always been: `{ hosts }`, one
 * slot, whole list per sync. Still no per-field merge and no per-host
 * timestamps: HostEntry has none, and a half-merged host is worse than
 * either whole entry.
 */

/** The ticked aliases assembled into the list the envelope encrypts. */
export function assembleSyncSet(
  local: readonly HostEntry[],
  remote: readonly HostEntry[],
  checked: readonly string[],
): HostEntry[] {
  const localByName = new Map(local.map((host) => [host.name, host]));
  const remoteByName = new Map(remote.map((host) => [host.name, host]));
  const hosts: HostEntry[] = [];
  const seen = new Set<string>();
  for (const alias of checked) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    const entry = localByName.get(alias) ?? remoteByName.get(alias);
    // A tick with no entry on either side contributes nothing — there is
    // nothing left to send. It happens when a check outlived the host on
    // every machine; the tick stays so a re-added host syncs again.
    if (entry) hosts.push(entry);
  }
  return hosts;
}

/**
 * Account aliases the selection does not have yet AND the local config
 * lacks — the auto-tick. The config clause is what keeps an untick
 * meaningful: an alias this machine can see is one the user has decided
 * about, so their untick must stand; an alias the config lacks is one this
 * machine has never materialised (a fresh machine mid-restore), and it
 * ticks on so the push re-uploads the account instead of wiping it. That
 * is the whole self-healing property.
 */
export function aliasesToAutoCheck(
  remote: readonly HostEntry[],
  checked: readonly string[],
  localAliases: readonly string[],
): string[] {
  const known = new Set(checked);
  const local = new Set(localAliases);
  return remote
    .map((host) => host.name)
    .filter((name) => !known.has(name) && !local.has(name));
}

/** Serialize the payload the envelope encrypts — the envelope's plaintext. */
export function serializeSyncPayload(hosts: readonly HostEntry[]): string {
  return JSON.stringify({ hosts });
}

/**
 * Parse a pulled plaintext, degraded: anything that is not a payload with a
 * plausible host array parses to an EMPTY list, not an error — a blob is
 * user data from possibly an older build, and an empty list is the safe
 * outcome (no aliases to auto-tick, no entries to restore).
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
