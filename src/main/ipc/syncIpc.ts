import type { IpcContext } from './context.js';
import { ipcMain } from 'electron';
import { ipc } from '../../shared/channels.js';
import { coerceHostEntries, type SyncPullResult, type SyncPushResult } from '../../shared/sync.js';
import { parseSyncPayload } from '../../shared/syncMerge.js';
import { SYNC_SLOT } from '../../shared/syncConfig.js';
import type { HostEntry } from '../../shared/types.js';
import { decryptEnvelope, encryptToEnvelope, SyncCryptoError } from '../sync/SyncCrypto.js';
import { SyncConflictError } from '../sync/SyncService.js';
import { applyHostsToConfig } from '../ssh-config/SshConfigWriter.js';

/**
 * The sync domain's handlers. The passphrase arrives as a per-invoke
 * argument from the renderer's session memory and is used and dropped here —
 * nothing in main persists it, which is what keeps the backend
 * zero-knowledge even against this machine's disk.
 *
 * Push is a RESULT union, not a throw, because the UI branches on `conflict`
 * (re-pull → re-merge → retry) and an IPC rejection would flatten that into
 * a string. Pull distinguishes `absent` for the same reason.
 *
 * The account host cache: whichever window decrypted the account copy last
 * (a pull or a push) leaves the parsed host list here, in memory only, and
 * every window — the picker among them — can then read it without holding
 * the passphrase. It never reaches disk, and sign-out drops it.
 */
let decryptedAccountHosts: HostEntry[] | null = null;

export function registerSyncIpc(ctx: IpcContext): void {
  ipcMain.handle(ipc.sync.status, () => ctx.syncAuth.status());

  ipcMain.handle(ipc.sync.login, async () => {
    const identity = await ctx.syncAuth.login();
    return identity.email;
  });

  ipcMain.handle(ipc.sync.logout, () => {
    decryptedAccountHosts = null;
    return ctx.syncAuth.logout();
  });

  ipcMain.handle(
    ipc.sync.pull,
    async (_evt, slot: unknown, passphrase: unknown): Promise<SyncPullResult> => {
      const pulled = await ctx.sync.pull(readSlot(slot));
      if (pulled === null) {
        decryptedAccountHosts = [];
        return { kind: 'absent' };
      }
      const plaintext = decryptEnvelope(pulled.data, readPassphrase(passphrase));
      decryptedAccountHosts = parseSyncPayload(plaintext);
      return { kind: 'ok', version: pulled.version, plaintext };
    },
  );

  ipcMain.handle(
    ipc.sync.push,
    async (_evt, slot: unknown, plaintext: unknown, passphrase: unknown, baseVersion: unknown): Promise<SyncPushResult> => {
      if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
      // The version the caller merged from — the server's optimistic-
      // concurrency base. A value that is not a number could only mean a
      // mismatched caller; treat it as "create or first write" (0).
      const base = typeof baseVersion === 'number' && Number.isInteger(baseVersion) && baseVersion >= 0 ? baseVersion : 0;
      try {
        const envelope = encryptToEnvelope(plaintext, readPassphrase(passphrase));
        const pushed = await ctx.sync.push(readSlot(slot), envelope, base);
        decryptedAccountHosts = parseSyncPayload(plaintext);
        return { kind: 'ok', version: pushed.version };
      } catch (err) {
        if (err instanceof SyncConflictError) return { kind: 'conflict', currentVersion: err.currentVersion };
        return { kind: 'error', message: (err as Error).message };
      }
    },
  );

  ipcMain.handle(ipc.sync.accountHosts, (): HostEntry[] | null => decryptedAccountHosts);

  ipcMain.handle(ipc.sync.applyHosts, (_evt, hosts: unknown) => {
    const entries = coerceHostEntries(hosts);
    // "Not an array / nothing usable" means nothing to add — not an error.
    if (entries === null || entries.length === 0) return { added: [] };
    return applyHostsToConfig(undefined, entries);
  });
}

/**
 * The slot name comes from the renderer, but every caller in this app means
 * the one slot; a hand-rolled invoke with something else is refused rather
 * than obeyed. The server would reject it anyway — this is the local
 * spelling of that rule.
 */
function readSlot(slot: unknown): string {
  if (slot !== SYNC_SLOT) throw new TypeError(`unknown sync slot ${String(slot)}`);
  return SYNC_SLOT;
}

function readPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw new SyncCryptoError('a sync passphrase is required');
  }
  return passphrase;
}
