/**
 * The SFTP data shapes and the dir-entry classification both clients run —
 * the desktop's `main/sftp/SftpService` and the browser's
 * `workspace/sftp.ts` normalise a host's readdir/stat output into these
 * exact types with this exact code, so a listing renders the same verdicts
 * (file / dir / symlink / other) on both.
 *
 * Renderer-safe: pure types and pure functions over an attrs-like shape. The
 * transport (an ssh2 SFTPWrapper) stays platform-side.
 */

/** A directory entry, normalised from the server's readdir output. */
export interface DirEntry {
  name: string;
  longname: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  modifyTime: number; // epoch ms
  accessTime: number; // epoch ms
  /** Rights in rwx string form, e.g. 'rwxr-xr-x'. */
  rights: { user: string; group: string; other: string };
  owner: number;
  group: number;
}

export interface FileStat {
  type: DirEntry['type'];
  size: number;
  modifyTime: number;
  accessTime: number;
}

/**
 * The attrs shape both platforms hand us, with every member optional:
 * Node's ssh2 Stats carries the full set with working helpers, while the
 * browser bundle's readdir attrs may lack helpers that read fs constants
 * that do not exist there (calling one THROWS — every accessor is guarded).
 */
export interface SftpAttrsLike {
  isFile?(): boolean;
  isDirectory?(): boolean;
  isSymbolicLink?(): boolean;
  size?: number;
  mtime?: number;
  atime?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  longname?: string;
}

/**
 * The dir/symlink/file/other verdict.
 *
 * The longname's ls-style first character wins when the server sent one
 * (OpenSSH always does) — it is the one signal that never needs fs
 * constants. The attrs helpers are the fallback, each guarded: a helper
 * that throws in the browser must not take the listing down with it.
 */
export function entryTypeOf(longname: string | undefined, attrs: SftpAttrsLike): DirEntry['type'] {
  if (longname && longname.length > 0) {
    if (longname.startsWith('d')) return 'dir';
    if (longname.startsWith('l')) return 'symlink';
    if (longname.startsWith('-')) return 'file';
  }
  try {
    if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) return 'dir';
    if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) return 'symlink';
    if (typeof attrs.isFile === 'function' && attrs.isFile()) return 'file';
  } catch {
    // no fs constants under this bundle — the longname already told us enough
  }
  return 'other';
}

/** Normalise one readdir element. Missing numerics read as 0, never NaN. */
export function toDirEntry(attrs: SftpAttrsLike, name?: string): DirEntry {
  const mode = typeof attrs.mode === 'number' ? attrs.mode : 0;
  return {
    name: name ?? '',
    longname: attrs.longname ?? '',
    type: entryTypeOf(attrs.longname, attrs),
    size: typeof attrs.size === 'number' ? attrs.size : 0,
    modifyTime: (typeof attrs.mtime === 'number' ? attrs.mtime : 0) * 1000,
    accessTime: (typeof attrs.atime === 'number' ? attrs.atime : 0) * 1000,
    rights: {
      user: modeToRwx((mode >> 6) & 7),
      group: modeToRwx((mode >> 3) & 7),
      other: modeToRwx(mode & 7),
    },
    owner: typeof attrs.uid === 'number' ? attrs.uid : 0,
    group: typeof attrs.gid === 'number' ? attrs.gid : 0,
  };
}

/** Normalise a stat result. Same verdict rules as {@link toDirEntry}. */
export function toFileStat(attrs: SftpAttrsLike): FileStat {
  return {
    type: entryTypeOf(attrs.longname, attrs),
    size: typeof attrs.size === 'number' ? attrs.size : 0,
    modifyTime: (typeof attrs.mtime === 'number' ? attrs.mtime : 0) * 1000,
    accessTime: (typeof attrs.atime === 'number' ? attrs.atime : 0) * 1000,
  };
}

function modeToRwx(m: number): string {
  return (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-');
}
