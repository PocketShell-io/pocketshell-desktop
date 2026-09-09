import type { HostEntry } from '../shared/types';

/**
 * The launch-time "should we dial a host by ourselves?" decision.
 *
 * It is a pure function and a module-level latch, deliberately kept out of
 * HostPickerView. Two reasons:
 *
 *   - The rules are all about states the component cannot easily be put into
 *     from a test — a default naming a host that was deleted from ~/.ssh/config,
 *     a second visit to the picker after the user pressed Back, a picker
 *     mounted while a connection is still live. Each is one call here.
 *   - Getting it wrong is not a cosmetic bug. Re-deciding "connect" on every
 *     mount would mean pressing Back from the workspace bounces the user
 *     straight back into it, which is a trap with no exit.
 */

/** Why an auto-connect did not happen, for the picker to explain or ignore. */
type AutoConnectSkipReason =
  /** Already ran this launch. The user is on the picker because they chose to be. */
  | 'already-attempted'
  /** A connection is live — Back from the workspace, not a cold start. */
  | 'already-connected'
  /** No default host configured; the picker is the intended landing screen. */
  | 'no-default'
  /** A default is set, but ~/.ssh/config no longer has a host by that name. */
  | 'unknown-host';

export type AutoConnectDecision =
  | { action: 'connect'; host: HostEntry }
  | { action: 'skip'; reason: AutoConnectSkipReason };

export interface AutoConnectInput {
  /** `settings.defaultHost`. */
  defaultHost: string | null;
  /** Hosts as `listConfigHosts()` reported them — already loaded. */
  hosts: readonly HostEntry[];
  /** {@link autoConnectAttempted} at the moment of the decision. */
  attempted: boolean;
  /** True when the connection store already holds a live connection. */
  connected: boolean;
}

/**
 * Decide whether to dial, and what.
 *
 * Order matters and encodes the escape hatches:
 *   1. `attempted` first, so this can only ever fire ONCE per launch. Every
 *      later visit to the picker — Back, disconnect, a failed dial — is the
 *      user's own navigation and must be left alone.
 *   2. `connected` next, so a picker opened over a live session never re-dials
 *      a host it is already on.
 *   3. Only then is the default consulted, and a name that does not resolve is
 *      a plain skip rather than an error: a host can be renamed or removed from
 *      ~/.ssh/config at any time, and the app finding out at launch is normal.
 *      The stored value is left alone so the user can see what it was and fix
 *      it, rather than having it silently rewritten under them.
 */
export function decideAutoConnect(input: AutoConnectInput): AutoConnectDecision {
  if (input.attempted) return { action: 'skip', reason: 'already-attempted' };
  if (input.connected) return { action: 'skip', reason: 'already-connected' };
  const name = input.defaultHost?.trim();
  if (!name) return { action: 'skip', reason: 'no-default' };
  const host = input.hosts.find((h) => h.name === name);
  if (!host) return { action: 'skip', reason: 'unknown-host' };
  return { action: 'connect', host };
}

/**
 * Whether the configured default still names a real config host.
 *
 * Separate from {@link decideAutoConnect} because it answers a different
 * question with a different lifetime: the decision is made once per launch,
 * but "your default host is gone" is worth saying on the picker every time it
 * is true, including after the user pressed Back.
 */
export function defaultHostStatus(
  defaultHost: string | null,
  hosts: readonly HostEntry[],
): 'none' | 'present' | 'missing' {
  const name = defaultHost?.trim();
  if (!name) return 'none';
  return hosts.some((h) => h.name === name) ? 'present' : 'missing';
}

/**
 * The once-per-launch latch.
 *
 * Module scope, not store state: it must be tied to the lifetime of the loaded
 * renderer and nothing else. A Pinia store would work identically today, but it
 * would also invite someone to persist it or reset it with the rest of the
 * connection state, and either would break the single guarantee this flag
 * carries. A window reload re-evaluates the module, which is correct — a reload
 * IS a fresh launch.
 */
let attempted = false;

export function autoConnectAttempted(): boolean {
  return attempted;
}

/**
 * Latch BEFORE dialling, never after. If the dial throws, hangs, or the user
 * cancels it, the attempt still happened and must not be repeated on the next
 * mount — the whole point is that a failing default cannot trap the user in a
 * reconnect loop.
 */
export function markAutoConnectAttempted(): void {
  attempted = true;
}

/** Test-only: put the latch back to its launch state. */
export function resetAutoConnectLatch(): void {
  attempted = false;
}
