import type { HostEntry } from './types.js';

/**
 * Types and shapes shared by the sync feature across the IPC boundary
 * (main ↔ preload ↔ renderer). The pure merge logic for host lists lives in
 * syncMerge.ts; this module is only the vocabulary.
 */

export interface SyncStatus {
  loggedIn: boolean;
  email: string | null;
  /** False when there is no OS keychain: login refuses rather than storing plaintext tokens. */
  keychainAvailable: boolean;
}

/**
 * `sync:pull`'s answer. `absent` is a fresh account — normal, not an error.
 * `plaintext` is the decrypted settings JSON; the envelope never crosses IPC.
 */
export type SyncPullResult =
  | { kind: 'absent' }
  | { kind: 'ok'; version: number; plaintext: string };

/**
 * `sync:push`'s answer, as a RESULT rather than a throw because the UI
 * branches on `conflict` (re-pull, re-merge, retry) and a rejection would
 * flatten that into a string.
 */
export type SyncPushResult =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'error'; message: string };

export interface SyncApplyResult {
  /** Aliases appended to ~/.ssh/config by this call. */
  added: string[];
}

/**
 * Host entries arriving over IPC for the config write-back, degraded per
 * entry: an entry that is not a usable Host directive is dropped, the rest
 * are kept. The renderer is our code, but `sync:applyHosts` is the one
 * channel whose payload reaches a user file on disk, so its input is treated
 * as data, not as trusted shape (same posture as the update URL allow-list).
 */
export function coerceHostEntries(raw: unknown): HostEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: HostEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e['name'] === 'string' ? e['name'].trim() : '';
    const hostname = typeof e['hostname'] === 'string' ? e['hostname'].trim() : '';
    // A Host directive needs both, and neither may contain whitespace — the
    // config writer emits them on `Host <name>` / `HostName <hostname>` lines.
    if (name === '' || hostname === '' || /\s/.test(name) || /\s/.test(hostname)) continue;
    out.push({
      name,
      hostname,
      port: typeof e['port'] === 'number' && Number.isInteger(e['port']) && e['port'] > 0 && e['port'] <= 65535 ? e['port'] : 22,
      user: typeof e['user'] === 'string' ? e['user'] : '',
      identityFile: typeof e['identityFile'] === 'string' && e['identityFile'] !== '' ? e['identityFile'] : null,
      proxyJump: typeof e['proxyJump'] === 'string' && e['proxyJump'] !== '' ? e['proxyJump'] : null,
      forwardAgent: e['forwardAgent'] === true,
      localForwards: coerceForwards(e['localForwards'], 'local'),
      remoteForwards: coerceForwards(e['remoteForwards'], 'remote'),
      fromConfig: true,
    });
  }
  return out;
}

function coerceForwards(raw: unknown, kind: 'local' | 'remote'): HostEntry['localForwards'] {
  if (!Array.isArray(raw)) return [];
  const out: HostEntry['localForwards'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f['listenPort'] !== 'number' || typeof f['destPort'] !== 'number') continue;
    if (typeof f['destHost'] !== 'string' || f['destHost'] === '') continue;
    out.push({
      kind,
      listenHost: typeof f['listenHost'] === 'string' ? f['listenHost'] : '',
      listenPort: f['listenPort'],
      destHost: f['destHost'],
      destPort: f['destPort'],
    });
  }
  return out;
}
