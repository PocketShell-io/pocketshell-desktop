import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { oversizeMessage } from '../../shared/byteSize.js';

/**
 * Reads the BYTES of a local file back into the renderer.
 *
 * This is the counterpart to {@link AttachmentStager}, and it runs the
 * other way. The stager takes bytes (a clipboard paste) or a path (a
 * picked file) and pushes them AT the remote host; the doodle editor
 * needs the same picked file coming back the other way, as pixels it can
 * paint on before anything is uploaded.
 *
 * ## Why this needs its own module rather than a two-line handler
 *
 * `attachments:pickFiles` deliberately hands the renderer nothing but
 * opaque paths ("the renderer never needs filesystem access — it gets
 * back opaque paths it can only hand to `attachments:stage`", ipc.ts).
 * A `readLocal(path)` channel narrows that guarantee: it is a genuine
 * filesystem-read primitive on the privileged side of the bridge, and a
 * compromised or buggy renderer calling it with `~/.ssh/id_ed25519`
 * would exfiltrate a private key through a feature whose entire purpose
 * is drawing moustaches on screenshots.
 *
 * So the path argument is treated as the security boundary, and the
 * guarantee is restored in a narrower form: **the renderer may read back
 * only the paths this session's native picker actually handed it.** The
 * allow-list is not a heuristic — it is exactly complete. Auditing every
 * way a path reaches the renderer today turns up precisely one
 * (`PromptComposer.onAttachClick` -> `api.attachments.pickFiles`);
 * paste and drag-drop arrive as `File` objects and already carry their
 * own bytes, and a blank canvas reads nothing. The renderer therefore
 * cannot name a path it did not receive from a dialog the user clicked
 * through, which is the same consent boundary the picker already
 * established. Cheap to implement, no false negatives, so it is
 * implemented rather than waved at.
 *
 * The allow-list is per-process and in-memory: it dies with the app, and
 * a path picked in a previous run is not readable in this one.
 */

/**
 * Per-read ceiling for bytes crossing back to the renderer, 32 MiB.
 *
 * A read-back buffers the bytes three times over on their way to a
 * canvas: once as a Buffer here, once as the structured clone the
 * renderer receives, and once more as the decoded bitmap, which at 4
 * bytes per pixel dwarfs the encoded file (a 25 MB JPEG is comfortably
 * a gigabyte decoded). 32 MiB still clears any camera photo, scanned
 * page or 8K screenshot the doodle editor will realistically be
 * handed, and a file above it is not an image someone meant to
 * annotate.
 *
 * `sftp:readBinary` is the cousin, not a copy: its ceiling lives in
 * `ipc.ts` (`MAX_SFTP_READ_BYTES`, 128 MiB — a remote document may
 * legitimately be bigger than any photo) but defaults to this number
 * when the renderer does not ask for a cap, because the bytes land in
 * the renderer exactly the same way.
 *
 * It bounds the READ-BACK path only, and it is worth being explicit
 * about what that excludes, because the obvious reading is wrong.
 * Attaching a file does not come through here: the composer hands
 * `attachments:stage` the picked path and {@link AttachmentStager}
 * streams it to the host with `fastPut` — uncapped, since the bytes
 * never live in this process. So an hour-long recording or a scanned
 * PDF far over 32 MiB attaches to a prompt perfectly well; what it
 * cannot do is become a doodle backdrop, which is the correct outcome
 * for a file that has no pixels. Raising this number is therefore
 * never the way to make a large non-image attach — that path is
 * already open, and the bitmap arithmetic above still governs this one.
 */
export const MAX_IMAGE_READ_BYTES = 32 * 1024 * 1024;

export class LocalFileReader {
  /** Absolute, `resolve`d paths this session's picker has handed out. */
  private readonly picked = new Set<string>();
  private readonly maxBytes: number;

  constructor(opts: { maxBytes?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_IMAGE_READ_BYTES;
  }

  /**
   * Record paths the native picker just returned to the renderer, making
   * them readable by {@link read} for the rest of the process's life.
   * Called from the `attachments:pickFiles` handler; a cancelled dialog
   * passes an empty array and changes nothing.
   */
  remember(paths: readonly string[]): void {
    for (const path of paths) this.picked.add(resolve(path));
  }

  /** True if `path` is one the picker handed out. Exposed for tests. */
  isPicked(path: string): boolean {
    return this.picked.has(resolve(path));
  }

  /**
   * Read one picked file's bytes.
   *
   * Rejects — like `sftp:readFile` and unlike `attachments:stage`, whose
   * result-object shape exists only to carry per-file outcomes for a
   * BATCH. This reads exactly one file, so there is no partial success
   * to report and a rejected promise is the honest signal.
   *
   * The checks run allow-list, then type, then size, in that order:
   * a path the renderer was never given is refused before it can learn
   * whether the file even exists.
   */
  async read(path: string): Promise<Buffer> {
    if (!this.isPicked(path)) {
      // Deliberately says nothing about the path itself — not whether it
      // exists, not what it is. The renderer has no business asking.
      throw new Error('Refusing to read a file that was not picked in this session');
    }

    // Same shape as AttachmentStager.uploadSource's file branch: stat
    // first, so an oversized or non-regular file is refused before a
    // single byte is materialised. A missing file rejects here with the
    // ENOENT the caller expects.
    //
    // `stat` follows symlinks, matching the stager. A picked symlink
    // resolves to its target, which is what the user saw in the dialog.
    // The stat/read gap is theoretically racy, but the path is already
    // one the user chose through a native dialog, so the race needs an
    // attacker who can already write the user's filesystem.
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (info.size > this.maxBytes) {
      throw new Error(oversizeMessage(info.size, this.maxBytes, path));
    }
    return readFile(path);
  }
}

