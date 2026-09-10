import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalFileReader,
  MAX_IMAGE_READ_BYTES,
} from '@main/attachments/LocalFileReader';

/**
 * `attachments:readLocal` is the one filesystem read the renderer gets.
 * These tests pin the two things that make that acceptable: the
 * allow-list (only paths the native picker handed out this session) and
 * the size ceiling (stat-ed before any bytes are materialised).
 */

describe('MAX_IMAGE_READ_BYTES', () => {
  it('bounds a doodle read-back, not an attach — it stands alone', () => {
    // This ceiling buffers three times: a Buffer + a structured clone +
    // a decoded bitmap that dwarfs the encoded file. The stager's picked
    // path streams with fastPut and carries no size cap at all, so there
    // is no upload ceiling for this number to sit under — the bitmap
    // arithmetic is the whole reason it exists.
    expect(MAX_IMAGE_READ_BYTES).toBe(32 * 1024 * 1024);
  });

  it('leaves room for a long recording to attach without being readable back', () => {
    // The asymmetry is deliberate, and this pins it so nobody "fixes"
    // a large audio attachment by raising the read ceiling. A 48 MiB
    // podcast episode streams to the host through the stager, and is
    // refused only by the doodle read-back, where its bytes would have
    // to survive a Buffer, a structured clone and a decode that will
    // never happen because it is not an image.
    const anHourOfSpokenAudio = 48 * 1024 * 1024;
    expect(anHourOfSpokenAudio).toBeGreaterThan(MAX_IMAGE_READ_BYTES);
  });
});

describe('LocalFileReader', () => {
  let dir: string;
  let picture: string;
  let folder: string;
  let missing: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-read-test-'));
    picture = join(dir, 'shot.png');
    folder = join(dir, 'a-folder');
    missing = join(dir, 'does-not-exist.png');
    await writeFile(picture, 'PNGDATA');
    await mkdir(folder);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A reader that has already "picked" the given paths. */
  const readerFor = (paths: string[], maxBytes?: number): LocalFileReader => {
    const reader = new LocalFileReader(maxBytes === undefined ? {} : { maxBytes });
    reader.remember(paths);
    return reader;
  };

  // --- happy path ---------------------------------------------------------

  it('reads the bytes of a picked file', async () => {
    const bytes = await readerFor([picture]).read(picture);
    expect(bytes.toString('utf8')).toBe('PNGDATA');
  });

  it('remembers every path from a multi-select, and nothing else', async () => {
    const other = join(dir, 'second.png');
    await writeFile(other, 'TWO');
    const reader = readerFor([picture, other]);

    expect((await reader.read(picture)).toString('utf8')).toBe('PNGDATA');
    expect((await reader.read(other)).toString('utf8')).toBe('TWO');
    expect(reader.isPicked(join(dir, 'never-picked.png'))).toBe(false);
  });

  it('accepts the same file spelled with redundant path segments', async () => {
    // `resolve` normalises both sides, so `<dir>/./shot.png` matches the
    // allow-list entry the picker created. Concatenated by hand because
    // `join` would normalise it away before the reader ever saw it.
    const noisy = `${dir}${sep}.${sep}shot.png`;
    expect((await readerFor([picture]).read(noisy)).toString('utf8')).toBe('PNGDATA');
  });

  it('follows a picked symlink to its target', async () => {
    const link = join(dir, 'link.png');
    try {
      await symlink(picture, link);
    } catch {
      return; // Windows without developer mode cannot create symlinks.
    }
    // The user saw (and chose) the link in the dialog; `stat` resolves it,
    // matching AttachmentStager's behaviour for a picked file.
    expect((await readerFor([link]).read(link)).toString('utf8')).toBe('PNGDATA');
  });

  // --- the allow-list -----------------------------------------------------

  it('refuses a path the picker never handed out', async () => {
    const reader = new LocalFileReader();
    await expect(reader.read(picture)).rejects.toThrow(/not picked in this session/);
  });

  it('refuses an unpicked path without revealing whether it exists', async () => {
    const reader = readerFor([picture]);
    const real = reader.read(join(dir, 'a-folder')).catch((e: Error) => e.message);
    const fake = reader.read(join(dir, 'imaginary')).catch((e: Error) => e.message);
    // Same refusal either way: a probe learns nothing about the filesystem.
    expect(await real).toBe(await fake);
  });

  it('refuses a private key even when it sits beside a picked file', async () => {
    const key = join(dir, 'id_ed25519');
    await writeFile(key, 'PRIVATE KEY');
    // The regression this whole class exists to prevent.
    await expect(readerFor([picture]).read(key)).rejects.toThrow(
      /not picked in this session/,
    );
  });

  // --- refusals for a picked-but-unreadable path --------------------------

  it('rejects a picked path that is not a regular file', async () => {
    await expect(readerFor([folder]).read(folder)).rejects.toThrow(/Not a regular file/);
  });

  it('rejects a picked file that has since gone missing', async () => {
    await expect(readerFor([missing]).read(missing)).rejects.toThrow(/ENOENT/);
  });

  it('rejects a file over the cap, naming both sizes', async () => {
    const big = join(dir, 'big.bin');
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024));
    // The cap is lowered to meet the file rather than writing 32 MiB in a
    // unit test; the refusal path is identical either way.
    await expect(readerFor([big], 1024 * 1024).read(big)).rejects.toThrow(
      /is 2\.0 MB; the limit is 1\.0 MB/,
    );
  });

  it('accepts a file exactly at the cap', async () => {
    const exact = join(dir, 'exact.bin');
    await writeFile(exact, Buffer.alloc(1024, 7));
    const bytes = await readerFor([exact], 1024).read(exact);
    expect(bytes).toHaveLength(1024);
  });
});
