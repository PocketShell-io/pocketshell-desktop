/**
 * Retention policy + pruner for the remote attachments directory.
 *
 * Ported from the Android app's `composer/AttachmentRetentionPolicy.kt`.
 * Attachments accumulate forever otherwise: every paste and every
 * uploaded file lands a new object under
 * `~/.pocketshell/attachments/<scope>/` and nothing on the remote ever
 * cleans it up. After a successful stage we take one best-effort pass:
 * keep the newest {@link DEFAULT_KEEP_NEWEST}, drop anything past that
 * cap or older than the TTL, but never touch anything inside the
 * "protect newest" window.
 *
 * The protect window is what makes the pass safe under a truncated
 * listing (see {@link DEFAULT_MAX_SCAN_ENTRIES}): even if we only saw a
 * subset of a huge directory and mis-ranked the newest N, everything
 * recent enough to still matter to a live conversation is off limits.
 *
 * Planning is pure ({@link planPrune}, {@link buildDeleteCommands}) so
 * the retention rules are unit-testable without a remote; only
 * {@link RemoteAttachmentPruner} touches the network.
 */

import { shellQuoteRemotePath } from '../../shared/shellQuote.js';

/** Keep at least this many of the newest attachments per scope. */
export const DEFAULT_KEEP_NEWEST = 20;

/** Never list more than this many entries in one prune pass. */
const DEFAULT_MAX_SCAN_ENTRIES = 5_000;

/** Delete at most this many paths per `rm` invocation (ARG_MAX headroom). */
const DEFAULT_DELETE_BATCH_SIZE = 50;

/** Attachments older than this are eligible for deletion. */
const DEFAULT_TTL_MILLIS = 7 * 24 * 60 * 60 * 1_000;

/** Attachments newer than this are never deleted, cap or no cap. */
const DEFAULT_PROTECT_NEWEST_MILLIS = 24 * 60 * 60 * 1_000;

export interface AttachmentRetentionPolicy {
  ttlMillis: number;
  keepNewest: number;
  protectNewestMillis: number;
  maxScanEntries: number;
  deleteBatchSize: number;
  /** When true, plan and log deletions but never actually remove anything. */
  dryRun: boolean;
}

export const DEFAULT_RETENTION_POLICY: AttachmentRetentionPolicy = {
  ttlMillis: DEFAULT_TTL_MILLIS,
  keepNewest: DEFAULT_KEEP_NEWEST,
  protectNewestMillis: DEFAULT_PROTECT_NEWEST_MILLIS,
  maxScanEntries: DEFAULT_MAX_SCAN_ENTRIES,
  deleteBatchSize: DEFAULT_DELETE_BATCH_SIZE,
  dryRun: false,
};

/** A remote attachment considered for pruning. */
interface RemoteAttachment {
  name: string;
  /** Modification time in epoch milliseconds. */
  modifiedMillis: number;
}

export interface AttachmentPrunePlan {
  delete: RemoteAttachment[];
}

/**
 * The shape {@link planPrune} needs from a directory listing. Structurally
 * satisfied by `DirEntry` from the SFTP service.
 */
export interface PrunableEntry {
  name: string;
  type: string;
  /** Modification time in epoch milliseconds. */
  modifyTime: number;
}

/** Validate a policy, mirroring the Kotlin data class's `require` block. */
function assertValidPolicy(policy: AttachmentRetentionPolicy): void {
  if (!(policy.ttlMillis > 0)) throw new Error('ttlMillis must be positive');
  if (!(policy.keepNewest > 0)) throw new Error('keepNewest must be positive');
  if (!(policy.protectNewestMillis >= 0)) {
    throw new Error('protectNewestMillis must be non-negative');
  }
  if (!(policy.maxScanEntries > 0)) throw new Error('maxScanEntries must be positive');
  if (!(policy.deleteBatchSize > 0)) throw new Error('deleteBatchSize must be positive');
}

/**
 * Decide which entries to delete. Files are ranked newest-first (ties
 * broken by name for determinism); an entry is deleted when it is
 * outside the protect window AND either past the TTL or past the
 * keep-newest cap. Directories and entries with no usable mtime are
 * ignored entirely.
 */
export function planPrune(
  entries: readonly PrunableEntry[],
  nowMillis: number,
  policy: AttachmentRetentionPolicy = DEFAULT_RETENTION_POLICY,
): AttachmentPrunePlan {
  assertValidPolicy(policy);

  const files: RemoteAttachment[] = entries
    .filter((e) => e.type === 'file')
    .filter((e) => Number.isFinite(e.modifyTime) && e.modifyTime > 0)
    .map((e) => ({ name: e.name, modifiedMillis: e.modifyTime }))
    .sort((a, b) =>
      b.modifiedMillis !== a.modifiedMillis
        ? b.modifiedMillis - a.modifiedMillis
        : a.name.localeCompare(b.name),
    );

  const toDelete = files.filter((attachment, newestIndex) =>
    shouldDelete(attachment, newestIndex, nowMillis, policy),
  );
  return { delete: toDelete };
}

function shouldDelete(
  attachment: RemoteAttachment,
  newestIndex: number,
  nowMillis: number,
  policy: AttachmentRetentionPolicy,
): boolean {
  const ageMillis = nowMillis - attachment.modifiedMillis;
  // The safety window wins over both other rules — a file the user just
  // attached must survive even when the cap is already blown.
  if (ageMillis < policy.protectNewestMillis) return false;

  const expiredByTtl = ageMillis >= policy.ttlMillis;
  const outsideNewestCap = newestIndex >= policy.keepNewest;
  return expiredByTtl || outsideNewestCap;
}

/**
 * Build the shell commands that delete `names` from `remoteDir`.
 *
 * `remoteDir` is home-relative (e.g. `.pocketshell/attachments/main`);
 * paths are emitted in `~/`-prefixed form so the shell expands the home
 * directory itself. Names containing a `/` (or `.`/`..`) are dropped
 * defensively — nothing should ever be able to steer a `rm` outside the
 * attachments directory.
 */
export function buildDeleteCommands(
  remoteDir: string,
  names: readonly string[],
  dryRun: boolean,
  batchSize: number,
): string[] {
  if (!(batchSize > 0)) throw new Error('batchSize must be positive');
  const cleanNames = names.filter(
    (n) => n.trim() !== '' && !n.includes('/') && n !== '.' && n !== '..',
  );
  if (cleanNames.length === 0) return [];

  const commands: string[] = [];
  for (let i = 0; i < cleanNames.length; i += batchSize) {
    const batch = cleanNames.slice(i, i + batchSize);
    const paths = batch.map((n) => `~/${remoteDir}/${n}`);
    if (dryRun) {
      commands.push(
        `printf 'would-delete\\t%s\\n' ${paths.map(shellQuoteRemotePath).join(' ')}`,
      );
    } else {
      const deleteArgs = paths.map(shellQuoteRemotePath).join(' ');
      commands.push(`rm -f -- ${deleteArgs} && printf 'deleted\\t${batch.length}\\n'`);
    }
  }
  return commands;
}

/** Sum the `deleted\t<n>` receipts a batch delete prints on success. */
export function parseDeletedCount(stdout: string): number {
  let total = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('deleted\t')) continue;
    const n = Number.parseInt(line.slice('deleted\t'.length).trim(), 10);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/** The slice of the SSH service the pruner needs. */
export interface PrunerSsh {
  exec(
    connectionId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** The slice of the SFTP service the pruner needs. */
export interface PrunerSftp {
  list(connectionId: string, path: string): Promise<PrunableEntry[]>;
}

/**
 * Best-effort remote pruner. Every failure path is swallowed: a prune
 * is housekeeping, and must never turn a successful attachment stage
 * into a user-visible error.
 */
export class RemoteAttachmentPruner {
  private readonly ssh: PrunerSsh;
  private readonly sftp: PrunerSftp;
  private readonly policy: AttachmentRetentionPolicy;
  private readonly now: () => number;

  constructor(deps: {
    ssh: PrunerSsh;
    sftp: PrunerSftp;
    policy?: AttachmentRetentionPolicy;
    now?: () => number;
  }) {
    this.ssh = deps.ssh;
    this.sftp = deps.sftp;
    this.policy = deps.policy ?? DEFAULT_RETENTION_POLICY;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Prune one scope's attachment directory.
   *
   * @param remoteDir home-relative directory (`.pocketshell/attachments/<scope>`).
   * @param absoluteDir the same directory resolved absolutely, for the SFTP listing.
   */
  async prune(connectionId: string, remoteDir: string, absoluteDir: string): Promise<void> {
    let entries: PrunableEntry[];
    try {
      entries = await this.sftp.list(connectionId, absoluteDir);
    } catch {
      // Directory vanished, permissions changed, transport hiccup — all
      // equally uninteresting for housekeeping.
      return;
    }

    const truncated = entries.length > this.policy.maxScanEntries;
    const scanned = truncated ? entries.slice(0, this.policy.maxScanEntries) : entries;

    const plan = planPrune(scanned, this.now(), this.policy);
    if (plan.delete.length === 0) return;

    const commands = buildDeleteCommands(
      remoteDir,
      plan.delete.map((a) => a.name),
      this.policy.dryRun,
      this.policy.deleteBatchSize,
    );
    for (const command of commands) {
      try {
        const result = await this.ssh.exec(connectionId, command);
        // `exec` never throws on a non-zero exit (see SshService); a
        // failed batch is logged by omission and the next one still runs.
        if (result.exitCode !== 0) continue;
      } catch {
        // ignore — see class doc
      }
    }
  }
}
