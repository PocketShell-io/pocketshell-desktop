import { basename, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { AttachmentSource, StageAttachmentsResult } from '../../shared/types.js';
import {
  renderSanitised,
  sanitiseFilename,
  type SanitisedName,
} from './FilenameSanitiser.js';
import { extensionForMimeType } from './mimeTypes.js';
import { oversizeMessage } from '../../shared/byteSize.js';
import { RemoteAttachmentPruner } from './AttachmentRetentionPolicy.js';

/**
 * Stages prompt attachments on the remote host.
 *
 * Ported from the Android app's `composer/PromptAttachmentStager.kt`.
 * There is no "attachment" object sent to the coding agent: the file is
 * uploaded over the existing SSH/SFTP session into a well-known remote
 * directory and the resulting **path string** is inserted into the
 * prompt text, so Claude Code / Codex reads the bytes off disk itself.
 *
 * Two entry points converge here:
 *
 *  - a clipboard paste, which arrives as in-memory bytes plus a mime
 *    type and (maybe) a suggested name — the desktop analogue of
 *    Android's `ShareableItem.TextItem`;
 *  - a file the user picked or dropped, which arrives as a local
 *    filesystem path — the analogue of a content `Uri`.
 *
 * Both feed one pipeline (sanitise -> upload -> prune) so the remote
 * layout and the display paths are identical whichever way the user
 * attached the file. The pipeline is deliberately type-agnostic: only
 * the mime -> extension fallback is image-aware, and only because a
 * pasted screenshot is the one case that arrives without a name.
 */

/** Remote directory, relative to the user's home. */
export const REMOTE_DIRECTORY = '.pocketshell/attachments';

/**
 * Ceiling for the IN-MEMORY branch only, 100 MiB.
 *
 * Two kinds of source reach the stager, with different physics:
 *
 *  - A picked file arrives as a PATH and is streamed to the host by
 *    `fastPut`, which never holds the bytes in this process. Its size
 *    is bounded by the remote disk, not by us, so that branch carries
 *    no cap on purpose: a multi-gigabyte pick uploads for as long as
 *    it uploads, and a mid-air failure (full remote disk, dropped
 *    channel) fails through the normal per-file path (issue #570
 *    semantics) so its siblings still attach.
 *  - Clipboard bytes and pathless drops arrive fully materialised: the
 *    payload already sat in the renderer, crosses the IPC boundary as
 *    a structured clone (so it exists twice), is adopted as a Buffer
 *    here and drained to a temp file. THIS branch is what the number
 *    bounds — pasted screenshots are kilobytes, and a paste big enough
 *    to threaten the process is refused rather than copied.
 */
export const MAX_IN_MEMORY_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** The slice of {@link SshService} the stager needs. */
export interface StagerSsh {
  exec(
    connectionId: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** The slice of {@link SftpService} the stager needs. */
export interface StagerSftp {
  realPath(connectionId: string, path: string): Promise<string>;
  list(
    connectionId: string,
    path: string,
  ): Promise<{ name: string; type: string; modifyTime: number }[]>;
  upload(connectionId: string, localPath: string, remotePath: string): Promise<void>;
}

export class AttachmentStager {
  private readonly ssh: StagerSsh;
  private readonly sftp: StagerSftp;
  private readonly now: () => number;
  private readonly pruner: RemoteAttachmentPruner;

  constructor(deps: {
    ssh: StagerSsh;
    sftp: StagerSftp;
    now?: () => number;
    pruner?: RemoteAttachmentPruner;
  }) {
    this.ssh = deps.ssh;
    this.sftp = deps.sftp;
    this.now = deps.now ?? Date.now;
    this.pruner =
      deps.pruner ??
      new RemoteAttachmentPruner({ ssh: deps.ssh, sftp: deps.sftp, now: this.now });
  }

  /**
   * Upload `sources` into `~/.pocketshell/attachments/<safeScopePath>/` and
   * return the tilde-form display paths to splice into the prompt.
   *
   * Never rejects. Partial failures (issue #570) resolve with
   * `ok: false` AND a populated `paths` array — the caller must still
   * attach those survivors and surface `error` alongside them. Only an
   * empty `paths` means nothing landed.
   */
  async stage(
    connectionId: string,
    scopeKey: string,
    sources: readonly AttachmentSource[],
  ): Promise<StageAttachmentsResult> {
    if (sources.length === 0) return { ok: true, paths: [], failedCount: 0 };

    const safeScope = safeScopePath(scopeKey);
    const remoteDir = `${REMOTE_DIRECTORY}/${safeScope}`;
    const displayDir = `~/${remoteDir}`;

    let absoluteDir: string;
    try {
      await this.ensureRemoteDirectory(connectionId, remoteDir);
      // SFTP has no tilde expansion, so resolve the home directory once
      // and address the uploads absolutely. `realpath(".")` on an SFTP
      // channel is the session's home directory.
      const home = await this.sftp.realPath(connectionId, '.');
      absoluteDir = posix.join(home, remoteDir);
    } catch (err) {
      // The remote directory could not be created or resolved — nothing
      // can be uploaded, so this is a clean total failure.
      return {
        ok: false,
        paths: [],
        failedCount: sources.length,
        error: `Attachment upload failed: ${describeError(err)}`,
      };
    }

    const timestamp = formatAttachmentTimestamp(this.now());

    // Issue #570: upload each file independently so a single stalling or
    // failing item among N never discards the ones that DID upload.
    // Successful display paths are collected as they land; per-file
    // failures are recorded and aggregated after the loop.
    const uploadedPaths: string[] = [];
    let firstFailure: unknown = null;
    let failedCount = 0;
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      try {
        const sanitised = sanitiseSource(source);
        const remoteName = composeAttachmentName(timestamp, index, sanitised);
        await this.uploadSource(source, connectionId, posix.join(absoluteDir, remoteName));
        uploadedPaths.push(`${displayDir}/${remoteName}`);
      } catch (err) {
        failedCount++;
        if (firstFailure == null) firstFailure = err;
      }
    }

    // Best-effort prune runs whenever at least one upload landed — the
    // remote dir now has fresh files worth trimming. Failures are already
    // swallowed inside the pruner; never let it fail the stage.
    if (uploadedPaths.length > 0) {
      try {
        await this.pruner.prune(connectionId, remoteDir, absoluteDir);
      } catch {
        // ignore
      }
    }

    if (failedCount === 0) {
      return { ok: true, paths: uploadedPaths, failedCount: 0 };
    }
    if (uploadedPaths.length === 0) {
      return {
        ok: false,
        paths: [],
        failedCount,
        error: `Attachment upload failed: ${describeError(firstFailure)}`,
      };
    }
    return {
      ok: false,
      paths: uploadedPaths,
      failedCount,
      error: partialFailureMessage(uploadedPaths.length, failedCount, firstFailure),
    };
  }

  /**
   * `mkdir -p` the scope directory. The path is built from a constant
   * plus {@link safeScopePath} output (`[a-z0-9_-]` per `/`-segment, so
   * no `..` and no absolute paths), which makes it safe inside the
   * double quotes that let `$HOME` expand.
   *
   * `exec` never throws on a non-zero exit (see SshService), so the exit
   * code is checked explicitly.
   */
  private async ensureRemoteDirectory(connectionId: string, remoteDir: string): Promise<void> {
    const result = await this.ssh.exec(connectionId, `mkdir -p "$HOME/${remoteDir}"`);
    if (result.exitCode !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()) || 'mkdir failed';
      throw new Error(`Could not create attachment directory: ${detail}`);
    }
  }

  /**
   * Upload one source to `remotePath`.
   *
   * A picked file streams straight off disk via the SFTP service's
   * `fastPut` — never read into memory, since an uploaded file can be
   * large in a way a pasted screenshot is not. Clipboard bytes have no
   * path to stream from, so they are drained to a temp file first,
   * mirroring `PromptAttachmentStager.drainToTempFile`.
   */
  private async uploadSource(
    source: AttachmentSource,
    connectionId: string,
    remotePath: string,
  ): Promise<void> {
    if (source.kind === 'file') {
      const info = await stat(source.path);
      if (!info.isFile()) throw new Error(`Not a regular file: ${source.path}`);
      // Deliberately no size check on this branch: fastPut streams, so
      // memory never holds the file. See MAX_IN_MEMORY_ATTACHMENT_BYTES
      // for why the two branches are bounded differently.
      await this.sftp.upload(connectionId, source.path, remotePath);
      return;
    }

    // Check the declared length before materialising a Buffer — an
    // oversized paste should be rejected, not copied first.
    const size = source.data?.byteLength ?? 0;
    if (size === 0) throw new Error(`${sourceLabel(source)} is empty`);
    assertWithinSizeLimit(size, sourceLabel(source));
    const bytes = toBuffer(source.data);

    const dir = await mkdtemp(join(tmpdir(), 'pocketshell-attach-'));
    try {
      const localPath = join(dir, 'payload.bin');
      await writeFile(localPath, bytes);
      await this.sftp.upload(connectionId, localPath, remotePath);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Normalise a scope key (session name, tmux target, project path — the
 * caller decides) into one safe path segment: lowercased, `[a-z0-9_-]`
 * kept, everything else folded to `-`, runs collapsed, ends trimmed,
 * blank falls back to `session`, capped at 80 characters.
 */
export function safeScopeSegment(scopeKey: string): string {
  return foldScopeSegment(scopeKey) || 'session';
}

/**
 * Normalise a scope key that may name a NESTED directory — an aplexer
 * session scopes its uploads as `<workspace-name>/<tag>` so files from
 * the same project land together across its tags — into a safe relative
 * path. Each `/`-separated segment goes through the single-segment rule
 * independently, so no segment can contain a slash, `..` folds away
 * before it can traverse, and a leading `/` becomes a dropped empty
 * segment rather than an absolute path. Blank segments disappear; if
 * nothing survives, the result is `session`, matching
 * {@link safeScopeSegment}'s fallback.
 */
export function safeScopePath(scopeKey: string): string {
  const segments = scopeKey.split('/').map(foldScopeSegment).filter((s) => s !== '');
  return segments.length > 0 ? segments.join('/') : 'session';
}

/** {@link safeScopeSegment}'s character folding, without the fallback. */
function foldScopeSegment(scopeKey: string): string {
  let cleaned = '';
  for (const ch of scopeKey) {
    if (ch >= 'A' && ch <= 'Z') cleaned += ch.toLowerCase();
    else if (ch >= 'a' && ch <= 'z') cleaned += ch;
    else if (ch >= '0' && ch <= '9') cleaned += ch;
    else if (ch === '-' || ch === '_') cleaned += ch;
    else cleaned += '-';
  }
  cleaned = cleaned.replace(/-+/g, '-');
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === '-') start++;
  while (end > start && cleaned[end - 1] === '-') end--;
  return cleaned.slice(start, end).slice(0, 80);
}

/**
 * `<timestamp>-<NN>-<sanitisedName>`, where `NN` is the 1-based index
 * within the batch zero-padded to two digits. The ordinal is what keeps
 * a multi-file paste from colliding inside the same one-second
 * timestamp.
 */
export function composeAttachmentName(
  timestamp: string,
  index: number,
  sanitised: SanitisedName,
): string {
  const ordinal = String(index + 1).padStart(2, '0');
  return `${timestamp}-${ordinal}-${renderSanitised(sanitised)}`;
}

/** `yyyyMMdd-HHmmss` in the local timezone, matching `ShareUploader.formatTimestamp`. */
export function formatAttachmentTimestamp(epochMillis: number): string {
  const d = new Date(epochMillis);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/**
 * The per-batch message for a partial failure: some files landed, some
 * did not. The survivors are still attached; this only explains the
 * shortfall.
 */
export function partialFailureMessage(
  uploaded: number,
  failed: number,
  cause: unknown,
): string {
  const total = uploaded + failed;
  const detail = describeError(cause).split('\n')[0]!.trim();
  const suffix = detail === '' ? '' : ` (${detail})`;
  return `Attached ${uploaded} of ${total} files; ${failed} failed${suffix}.`;
}

/**
 * Sanitise a source's name, defaulting the extension from its mime type
 * only when the name has none of its own. A picked file's basename
 * almost always carries one, so the mime fallback is in practice the
 * clipboard path.
 */
export function sanitiseSource(source: AttachmentSource): SanitisedName {
  const rawName = source.name ?? (source.kind === 'file' ? basename(source.path) : null);
  return sanitiseFilename(rawName, extensionForMimeType(source.mimeType));
}

function assertWithinSizeLimit(size: number, label: string): void {
  if (size > MAX_IN_MEMORY_ATTACHMENT_BYTES) {
    throw new Error(oversizeMessage(size, MAX_IN_MEMORY_ATTACHMENT_BYTES, label));
  }
}

/** Human-facing label for a source, used in per-file error messages. */
function sourceLabel(source: AttachmentSource): string {
  const name = source.name ?? (source.kind === 'file' ? basename(source.path) : null);
  return name != null && name !== '' ? `"${name}"` : 'Attachment';
}

/** Adopt a Uint8Array view without copying; tolerate a plain ArrayBuffer. */
function toBuffer(data: Uint8Array | ArrayBuffer): Buffer {
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
