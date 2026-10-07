import type { TransferProgress } from '@pocketshell/core';
export type { TransferProgress } from '@pocketshell/core';
import type { SFTPWrapper } from 'ssh2';
import { stat as fsStat } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionRegistry, ConnectionRecord } from '../ssh/ConnectionRegistry.js';
import { oversizeMessage } from '@pocketshell/core';
import {
  toDirEntry,
  toFileStat,
  type DirEntry,
  type FileStat,
  type SftpAttrsLike,
} from '@pocketshell/core';

// The entry shapes and the type-classification rules are shared code now
// (`shared/sftpCore.ts`) — the browser's Files pane normalises a listing with
// the exact same functions; re-exported here for the IPC layer's one import
// path.
export type { DirEntry, FileStat };

/**
 * SFTP service over an existing ssh2 connection — or over this machine's own
 * filesystem, for a `local` (self) connection, where every method below answers
 * from `node:fs` with the exact same shapes (`toDirEntry`/`toFileStat` are
 * shared code, so the Files pane cannot tell the transports apart).
 *
 * The Android app has no file browser (out of scope there); this is net-new
 * for desktop. We reuse the live ssh2 `Client` from a connectionId (no second
 * connection) and pull an `SFTPWrapper` on demand via `client.sftp()`. The
 * wrapper is cached per connection for the session.
 *
 * All operations are promise-based. Methods reject on transport errors but
 * return typed results for expected "not found" cases (e.g. exists() returns
 * false rather than throwing).
 */


export class SftpService {
  /** Per-connection cached SFTP wrapper. */
  private readonly wrappers = new Map<string, Promise<SFTPWrapper>>();

  constructor(private readonly registry: ConnectionRegistry) {}

  /**
   * True when the connection is this machine: every operation then runs
   * against the local filesystem instead of an SFTP channel.
   */
  private isLocal(connectionId: string): boolean {
    return this.registry.get(connectionId)?.kind === 'local';
  }

  /** Acquire (and cache) the SFTP wrapper for a connection. */
  private sftp(connectionId: string): Promise<SFTPWrapper> {
    const existing = this.wrappers.get(connectionId);
    if (existing) return existing;
    const rec = this.registry.require(connectionId);
    const promise = openSftp(rec).catch((err) => {
      // If acquisition failed, drop the cached rejection so the next call retries.
      this.wrappers.delete(connectionId);
      throw err;
    });
    this.wrappers.set(connectionId, promise);
    return promise;
  }

  /** Drop the cached wrapper for a connection (on disconnect). */
  evict(connectionId: string): void {
    void this.wrappers.get(connectionId)?.then((sftp) => {
      try {
        sftp.end();
      } catch {
        // ignore
      }
    });
    this.wrappers.delete(connectionId);
  }

  /** True if the path exists (any type). */
  async exists(connectionId: string, path: string): Promise<boolean> {
    if (this.isLocal(connectionId)) return localFs.exists(path);
    const sftp = await this.sftp(connectionId);
    try {
      await stat(sftp, path);
      return true;
    } catch {
      return false;
    }
  }

  /** Stat a path. Rejects if it does not exist. */
  async stat(connectionId: string, path: string): Promise<FileStat> {
    if (this.isLocal(connectionId)) return localFs.stat(path);
    const sftp = await this.sftp(connectionId);
    return toFileStat(await stat(sftp, path));
  }

  /** List directory entries. Rejects if the path is not a directory. */
  async list(connectionId: string, path: string): Promise<DirEntry[]> {
    if (this.isLocal(connectionId)) return localFs.list(path);
    const sftp = await this.sftp(connectionId);
    return new Promise<DirEntry[]>((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((list ?? []).map((e) => toDirEntry({ ...e.attrs, longname: e.longname }, e.filename)));
      });
    });
  }

  /** Read a file as a UTF-8 string. */
  async readFile(connectionId: string, path: string): Promise<string> {
    if (this.isLocal(connectionId)) return localFs.readFile(path);
    const sftp = await this.sftp(connectionId);
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(path);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  /**
   * Read a file as raw bytes, refusing anything larger than `maxBytes`.
   *
   * {@link readFile} decodes UTF-8 and so cannot carry a PNG or a JPEG —
   * every byte outside ASCII comes back as U+FFFD. This is the binary
   * sibling for callers that need the actual file (the doodle editor
   * annotating an image that lives on the host).
   *
   * `maxBytes` is a required argument rather than a constant here on
   * purpose: an unbounded read into memory is the hazard, and making the
   * ceiling impossible to forget puts the policy with the caller that
   * knows what the bytes are for. The current caller passes
   * `MAX_IMAGE_READ_BYTES`.
   *
   * Rejects (like every other method here) rather than returning a
   * result object: on a missing path, on a non-regular file, and on an
   * oversized one.
   */
  async readBinary(connectionId: string, path: string, maxBytes: number): Promise<Buffer> {
    if (this.isLocal(connectionId)) return localFs.readBinary(path, maxBytes);
    const sftp = await this.sftp(connectionId);
    // Stat first so an oversized file is refused BEFORE it is dragged
    // across the wire, rather than after. `stat` follows symlinks, so a
    // link to a regular file reads fine.
    const info = toFileStat(await stat(sftp, path));
    if (info.type !== 'file') throw new Error(`Not a regular file: ${path}`);
    assertReadable(info.size, maxBytes, path);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const stream = sftp.createReadStream(path);
      stream.on('data', (chunk: Buffer) => {
        // The stat above is a snapshot; a remote file can grow between
        // it and the read (an appended log is the obvious case). Keep a
        // running total so the ceiling holds either way.
        received += chunk.length;
        if (received > maxBytes) {
          stream.destroy();
          reject(new Error(oversizeMessage(received, maxBytes, path)));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /** Write a UTF-8 string to a file (overwrites). */
  async writeFile(connectionId: string, path: string, content: string): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.writeFile(path, content);
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path);
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(Buffer.from(content, 'utf8'));
    });
  }

  /**
   * Create a file that must not already exist, optionally with content.
   *
   * The `wx` flag is the point. This service's other write verb,
   * {@link writeFile}, overwrites by contract because its caller is saving a
   * buffer the user opened on purpose; creation has no such prior read, and a
   * create that silently truncated an existing name would be a data-loss
   * button wearing a harmless one. The stat in front is only for the MESSAGE:
   * `wx` alone rejects an existing file with the server's terse "Failure",
   * while this names the file — and the flag still guards the gap between the
   * stat and the open.
   */
  async createFile(connectionId: string, path: string, content = ''): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.createFile(path, content);
    const sftp = await this.sftp(connectionId);
    if (await this.exists(connectionId, path)) {
      throw new Error(`Already exists: ${path}`);
    }
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path, { flags: 'wx' });
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(Buffer.from(content, 'utf8'));
    });
  }

  /** Create a directory. Rejects if it already exists. */
  async mkdir(connectionId: string, path: string): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.mkdir(path);
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Rename/move a path. */
  async rename(connectionId: string, fromPath: string, toPath: string): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.rename(fromPath, toPath);
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.rename(fromPath, toPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Delete a file. */
  async deleteFile(connectionId: string, path: string): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.deleteFile(path);
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Remove an empty directory. */
  async rmdir(connectionId: string, path: string): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.rmdir(path);
    const sftp = await this.sftp(connectionId);
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Resolve a (possibly relative or symlink) path to an absolute one. */
  async realPath(connectionId: string, path: string): Promise<string> {
    if (this.isLocal(connectionId)) return localFs.realPath(path);
    const sftp = await this.sftp(connectionId);
    return new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)));
    });
  }

  /**
   * Upload a local file to a remote path. Emits progress via `onProgress`.
   * Uses ssh2's `fastPut` which handles chunked transfer + parallelism.
   */
  async upload(
    connectionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.upload(localPath, remotePath, onProgress);
    const sftp = await this.sftp(connectionId);
    const total = await localSize(localPath);
    return new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        { step: (transferred) => onProgress?.({ bytes: transferred, total }) },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * Download a remote file to a local path. Emits progress via `onProgress`.
   */
  async download(
    connectionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    if (this.isLocal(connectionId)) return localFs.download(remotePath, localPath, onProgress);
    const sftp = await this.sftp(connectionId);
    const statRes = toFileStat(await stat(sftp, remotePath));
    const total = statRes.size;
    return new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        { step: (transferred) => onProgress?.({ bytes: transferred, total }) },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The self connection's file operations, straight off `node:fs`.
 *
 * Same contracts as the SFTP wrappers above: stat-shapes go through the
 * shared `toDirEntry`/`toFileStat` (an fs.Stats satisfies `SftpAttrsLike`
 * once mtimes are seconds), expected failures reject, and the size ceiling
 * of `readBinary` holds. The local copy is instant, so `upload`/`download`
 * report one final complete progress step rather than a wire's worth.
 */
const localFs = {
  async exists(path: string): Promise<boolean> {
    try {
      await fsPromises.stat(path);
      return true;
    } catch {
      return false;
    }
  },

  async stat(path: string): Promise<FileStat> {
    return toFileStat(attrs(await fsPromises.stat(path)));
  },

  async list(path: string): Promise<DirEntry[]> {
    const dirents = await fsPromises.readdir(path, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (dirent) => {
        // `stat` follows symlinks, like the SFTP listing's attrs do; a broken
        // link keeps its own kind rather than vanishing from the listing.
        try {
          return toDirEntry(attrs(await fsPromises.stat(join(path, dirent.name))), dirent.name);
        } catch {
          return toDirEntry(
            {
              isDirectory: () => dirent.isDirectory(),
              isFile: () => dirent.isFile(),
              isSymbolicLink: () => dirent.isSymbolicLink(),
              longname: '',
            },
            dirent.name,
          );
        }
      }),
    );
  },

  async readFile(path: string): Promise<string> {
    return fsPromises.readFile(path, 'utf8');
  },

  async readBinary(path: string, maxBytes: number): Promise<Buffer> {
    const info = toFileStat(attrs(await fsPromises.stat(path)));
    if (info.type !== 'file') throw new Error(`Not a regular file: ${path}`);
    assertReadable(info.size, maxBytes, path);
    const bytes = await fsPromises.readFile(path);
    // The stat was a snapshot; hold the ceiling against what actually read.
    if (bytes.length > maxBytes) throw new Error(oversizeMessage(bytes.length, maxBytes, path));
    return bytes;
  },

  async writeFile(path: string, content: string): Promise<void> {
    await fsPromises.writeFile(path, content, 'utf8');
  },

  async createFile(path: string, content: string): Promise<void> {
    if (await this.exists(path)) throw new Error(`Already exists: ${path}`);
    await fsPromises.writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  },

  async mkdir(path: string): Promise<void> {
    await fsPromises.mkdir(path);
  },

  async rename(fromPath: string, toPath: string): Promise<void> {
    await fsPromises.rename(fromPath, toPath);
  },

  async deleteFile(path: string): Promise<void> {
    await fsPromises.unlink(path);
  },

  async rmdir(path: string): Promise<void> {
    await fsPromises.rmdir(path);
  },

  async realPath(path: string): Promise<string> {
    return fsPromises.realpath(path);
  },

  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    const total = await localSize(localPath);
    await fsPromises.copyFile(localPath, remotePath);
    onProgress?.({ bytes: total, total });
  },

  async download(
    remotePath: string,
    localPath: string,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    const total = (await fsPromises.stat(remotePath)).size;
    await fsPromises.copyFile(remotePath, localPath);
    onProgress?.({ bytes: total, total });
  },
};

/** fs.Stats dressed as the shared attrs shape — mtimes in whole seconds. */
function attrs(st: Awaited<ReturnType<typeof fsPromises.stat>>): SftpAttrsLike {
  return {
    isFile: () => st.isFile(),
    isDirectory: () => st.isDirectory(),
    isSymbolicLink: () => st.isSymbolicLink(),
    size: Number(st.size),
    mtime: Math.floor(Number(st.mtimeMs) / 1000),
    atime: Math.floor(Number(st.atimeMs) / 1000),
    mode: Number(st.mode),
  };
}

function openSftp(rec: ConnectionRecord): Promise<SFTPWrapper> {
  // Local connections never reach here — their methods take the localFs
  // branch first; the narrowing is what lets `.client` compile.
  if (rec.kind !== 'ssh') {
    return Promise.reject(new Error('No SFTP channel on a local connection.'));
  }
  return new Promise((resolve, reject) => {
    rec.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function stat(sftp: SFTPWrapper, path: string): Promise<SftpAttrsLike> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function assertReadable(size: number, maxBytes: number, path: string): void {
  if (size > maxBytes) throw new Error(oversizeMessage(size, maxBytes, path));
}

function localSize(path: string): Promise<number> {
  return new Promise((resolve) => {
    fsStat(path, (err, st) => resolve(err || !st ? 0 : st.size));
  });
}
