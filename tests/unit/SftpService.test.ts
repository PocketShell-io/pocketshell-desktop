import { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { SftpService } from '@main/sftp/SftpService';
import { ConnectionRegistry } from '@main/ssh/ConnectionRegistry';

/**
 * Unit tests for `SftpService.readBinary` — the binary sibling of
 * `readFile`, which decodes UTF-8 and so cannot carry an image.
 *
 * The real SFTP round-trip is covered by
 * tests/integration/SftpService.integration.test.ts against a container.
 * What matters here is the part that has no business needing Docker: the
 * size ceiling, and that it is applied off the stat rather than after
 * dragging the file over the wire.
 *
 * The fake `SFTPWrapper` is deliberately a thin slice of a very large
 * ssh2 surface (the same approach as the fake in AttachmentStager.test.ts).
 */

interface FakeFile {
  type: 'file' | 'dir' | 'symlink';
  /** Bytes the read stream will emit. Defaults to a single empty chunk. */
  chunks?: Buffer[];
  /** Size `stat` reports. Defaults to the real total of `chunks`. */
  reportedSize?: number;
}

interface Harness {
  sftp: SftpService;
  connectionId: string;
  /** Paths whose read stream was actually opened. */
  streamed: string[];
  /** Create-stream opens: path + the flags the service asked for. */
  opened: { path: string; flags: string }[];
  /** Bytes handed to each create stream, keyed by path. */
  written: Record<string, string>;
}

function harnessFor(
  files: Record<string, FakeFile>,
  failOpen: Record<string, string> = {},
): Harness {
  const streamed: string[] = [];
  const opened: { path: string; flags: string }[] = [];
  const written: Record<string, string> = {};

  const wrapper = {
    stat(path: string, cb: (err: Error | null, stats?: unknown) => void): void {
      const file = files[path];
      if (!file) {
        cb(Object.assign(new Error(`No such file: ${path}`), { code: 'ENOENT' }));
        return;
      }
      const chunks = file.chunks ?? [];
      const size = file.reportedSize ?? chunks.reduce((n, c) => n + c.length, 0);
      cb(null, {
        isFile: () => file.type === 'file',
        isDirectory: () => file.type === 'dir',
        isSymbolicLink: () => file.type === 'symlink',
        size,
        mtime: 0,
        atime: 0,
        mode: 0o644,
        uid: 0,
        gid: 0,
      });
    },
    createReadStream(path: string): Readable {
      streamed.push(path);
      // objectMode iteration over Buffers: each chunk arrives intact, which
      // is all the running-total guard cares about.
      return Readable.from(files[path]?.chunks ?? []);
    },
    createWriteStream(path: string, opts?: { flags?: string }): Writable {
      opened.push({ path, flags: opts?.flags ?? 'w' });
      const stream = new Writable({
        write(chunk: Buffer, _enc: string, done: (error?: Error | null) => void): void {
          written[path] = (written[path] ?? '') + chunk.toString('utf8');
          done();
        },
      });
      // A server refusal of the OPEN arrives asynchronously on the real
      // wrapper (the reply comes over the wire); a nextTick destroy reproduces
      // that ordering — the service's error listener is attached before it
      // fires.
      const failure = failOpen[path];
      if (failure) {
        process.nextTick(() => stream.destroy(new Error(failure)));
      }
      return stream;
    },
    end(): void {
      // no-op
    },
  };

  const client = {
    sftp(cb: (err: Error | null, sftp: unknown) => void): void {
      cb(null, wrapper);
    },
  };

  const registry = new ConnectionRegistry();
  const connectionId = registry.register({
    kind: 'ssh',
    client: client as unknown as Client,
    label: 'testuser@fake:22',
    host: 'fake',
    port: 22,
    user: 'testuser',
    knownHosts: null,
    connectedAt: 0,
  });

  return { sftp: new SftpService(registry), connectionId, streamed, opened, written };
}

const CAP = 1024;

describe('SftpService.readBinary', () => {
  it('returns the raw bytes of a remote file', async () => {
    // A leading PNG signature: the exact byte range `readFile`'s UTF-8
    // decode would replace with U+FFFD.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    const h = harnessFor({ '/home/me/shot.png': { type: 'file', chunks: [png] } });

    const bytes = await h.sftp.readBinary(h.connectionId, '/home/me/shot.png', CAP);

    expect(Buffer.compare(bytes, png)).toBe(0);
  });

  it('joins multiple chunks in order', async () => {
    const h = harnessFor({
      '/f': {
        type: 'file',
        chunks: [Buffer.from('AB'), Buffer.from('CD'), Buffer.from('EF')],
      },
    });
    const bytes = await h.sftp.readBinary(h.connectionId, '/f', CAP);
    expect(bytes.toString('utf8')).toBe('ABCDEF');
  });

  it('reads an empty file as zero bytes', async () => {
    const h = harnessFor({ '/empty': { type: 'file', chunks: [] } });
    expect(await h.sftp.readBinary(h.connectionId, '/empty', CAP)).toHaveLength(0);
  });

  it('accepts a file exactly at the cap', async () => {
    const h = harnessFor({ '/exact': { type: 'file', chunks: [Buffer.alloc(CAP, 1)] } });
    expect(await h.sftp.readBinary(h.connectionId, '/exact', CAP)).toHaveLength(CAP);
  });

  // --- refusals -----------------------------------------------------------

  it('rejects an oversized file off the stat, without opening a stream', async () => {
    const h = harnessFor({
      '/big': { type: 'file', chunks: [Buffer.alloc(CAP + 1)] },
    });

    await expect(h.sftp.readBinary(h.connectionId, '/big', CAP)).rejects.toThrow(
      /\/big is 0\.0 MB; the limit is 0\.0 MB/,
    );
    // The point of stat-ing first: nothing crossed the wire.
    expect(h.streamed).toEqual([]);
  });

  it('names both sizes in megabytes when refusing', async () => {
    const h = harnessFor({
      // Report a size without allocating it — the stat is what is checked.
      '/huge': { type: 'file', chunks: [], reportedSize: 4 * 1024 * 1024 },
    });
    await expect(
      h.sftp.readBinary(h.connectionId, '/huge', 1024 * 1024),
    ).rejects.toThrow(/is 4\.0 MB; the limit is 1\.0 MB/);
  });

  it('still refuses a file that grew after the stat', async () => {
    // The host under-reports (or the file is being appended to): the
    // running total has to hold the ceiling on its own.
    const h = harnessFor({
      '/growing': {
        type: 'file',
        chunks: [Buffer.alloc(CAP), Buffer.alloc(CAP)],
        reportedSize: 10,
      },
    });

    await expect(h.sftp.readBinary(h.connectionId, '/growing', CAP)).rejects.toThrow(
      /the limit is/,
    );
    expect(h.streamed).toEqual(['/growing']);
  });

  it('rejects a directory', async () => {
    const h = harnessFor({ '/home/me': { type: 'dir' } });
    await expect(h.sftp.readBinary(h.connectionId, '/home/me', CAP)).rejects.toThrow(
      /Not a regular file: \/home\/me/,
    );
    expect(h.streamed).toEqual([]);
  });

  it('rejects a missing file', async () => {
    const h = harnessFor({});
    await expect(h.sftp.readBinary(h.connectionId, '/nope.png', CAP)).rejects.toThrow(
      /No such file: \/nope\.png/,
    );
  });

  it('rejects an unknown connection', async () => {
    const h = harnessFor({ '/f': { type: 'file', chunks: [Buffer.from('x')] } });
    await expect(h.sftp.readBinary('conn-nope', '/f', CAP)).rejects.toThrow();
  });
});

/**
 * `createFile` — the create-only sibling of `writeFile`.
 *
 * The contract being pinned: a create can never truncate. `writeFile` may
 * overwrite because its caller is saving a buffer the user opened on purpose;
 * creation has no such prior read, so an existing name must be refused —
 * legibly, before anything is opened — and the exclusivity must hold even
 * when the stat and the open race, which is what the `wx` flag is for.
 */
describe('SftpService.createFile', () => {
  it('creates a file that is not there, asking for exclusive create', async () => {
    const h = harnessFor({});

    await h.sftp.createFile(h.connectionId, '/home/me/notes.md');

    // 'wx': create + fail-if-exists. A plain 'w' here would be the silent
    // truncation the whole method exists to prevent.
    expect(h.opened).toEqual([{ path: '/home/me/notes.md', flags: 'wx' }]);
  });

  it('delivers initial content', async () => {
    const h = harnessFor({});

    await h.sftp.createFile(h.connectionId, '/home/me/notes.md', '# hi\n');

    expect(h.written['/home/me/notes.md']).toBe('# hi\n');
  });

  it('creates an empty file by default, not "undefined"', async () => {
    const h = harnessFor({});

    await h.sftp.createFile(h.connectionId, '/home/me/notes.md');

    expect(h.written['/home/me/notes.md']).toBe('');
  });

  it('refuses an existing file before anything is opened, naming it', async () => {
    const h = harnessFor({ '/home/me/notes.md': { type: 'file' } });

    await expect(h.sftp.createFile(h.connectionId, '/home/me/notes.md')).rejects.toThrow(
      'Already exists: /home/me/notes.md',
    );
    // The refusal is ours, not a stream error discovered mid-write: nothing
    // was opened, so nothing was at risk.
    expect(h.opened).toEqual([]);
  });

  it('refuses a directory of the same name', async () => {
    const h = harnessFor({ '/home/me/notes.md': { type: 'dir' } });

    await expect(h.sftp.createFile(h.connectionId, '/home/me/notes.md')).rejects.toThrow(
      /Already exists/,
    );
    expect(h.opened).toEqual([]);
  });

  it('still refuses when a name appears between the stat and the open', async () => {
    // The stat-then-open gap: the server's own exclusivity is the backstop,
    // and the rejection travels rather than being swallowed.
    const h = harnessFor({}, { '/home/me/notes.md': 'Failure' });

    await expect(h.sftp.createFile(h.connectionId, '/home/me/notes.md')).rejects.toThrow(
      'Failure',
    );
  });
});

describe('SftpService — the local (self) connection', () => {
  // A real temp directory: the local backing IS node:fs, so a fake would only
  // restate it. Each test gets a fresh dir that outlives nothing.
  function localHarness(): { sftp: SftpService; id: string; root: string } {
    const registry = new ConnectionRegistry();
    const id = registry.register({
      kind: 'local',
      label: 'self',
      host: 'self',
      port: 0,
      user: 'me',
      knownHosts: null,
      connectedAt: 0,
    });
    const root = mkdtempSync(join(tmpdir(), 'ps-self-'));
    return { sftp: new SftpService(registry), id, root };
  }

  it('lists a directory with the shared entry shapes', async () => {
    const h = localHarness();
    writeFileSync(join(h.root, 'a.txt'), 'hi');
    mkdirSync(join(h.root, 'sub'));
    const entries = await h.sftp.list(h.id, h.root);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('a.txt')?.type).toBe('file');
    expect(byName.get('sub')?.type).toBe('dir');
    rmSync(h.root, { recursive: true, force: true });
  });

  it('round-trips read, write, rename, mkdir, delete', async () => {
    const h = localHarness();
    const p = join(h.root, 'notes.md');
    await h.sftp.writeFile(h.id, p, '# hello');
    expect(await h.sftp.readFile(h.id, p)).toBe('# hello');
    expect((await h.sftp.stat(h.id, p)).type).toBe('file');
    expect(await h.sftp.exists(h.id, p)).toBe(true);

    const dir = join(h.root, 'made');
    await h.sftp.mkdir(h.id, dir);
    const moved = join(dir, 'renamed.md');
    await h.sftp.rename(h.id, p, moved);
    expect(existsSync(p)).toBe(false);
    await h.sftp.deleteFile(h.id, moved);
    await h.sftp.rmdir(h.id, dir);
    expect(existsSync(dir)).toBe(false);
    rmSync(h.root, { recursive: true, force: true });
  });

  it('createFile refuses to overwrite, and realPath resolves', async () => {
    const h = localHarness();
    const p = join(h.root, 'new.md');
    await h.sftp.createFile(h.id, p, 'first');
    await expect(h.sftp.createFile(h.id, p, 'second')).rejects.toThrow(/Already exists/);
    expect(readFileSync(p, 'utf8')).toBe('first');
    // Forward slashes: the local realPath matches the spelling $HOME and
    // the renderer's crumb splitting use (see LocalHost/SftpService).
    expect(await h.sftp.realPath(h.id, p)).toBe(p.replace(/\\/g, '/'));
    rmSync(h.root, { recursive: true, force: true });
  });

  it('readBinary carries raw bytes under the ceiling', async () => {
    const h = localHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    const p = join(h.root, 'shot.png');
    writeFileSync(p, png);
    expect((await h.sftp.readBinary(h.id, p, 1024)).equals(png)).toBe(true);
    await expect(h.sftp.readBinary(h.id, p, 4)).rejects.toThrow(/the limit is/);
    rmSync(h.root, { recursive: true, force: true });
  });

  it('upload and download copy through the same machine', async () => {
    const h = localHarness();
    const src = join(h.root, 'src.txt');
    writeFileSync(src, 'payload');
    const uploaded = join(h.root, 'uploaded.txt');
    let progress = 0;
    await h.sftp.upload(h.id, src, uploaded, (p) => (progress = p.total ?? 0));
    expect(readFileSync(uploaded, 'utf8')).toBe('payload');
    expect(progress).toBe(Buffer.byteLength('payload'));
    const downloaded = join(h.root, 'downloaded.txt');
    await h.sftp.download(h.id, uploaded, downloaded);
    expect(readFileSync(downloaded, 'utf8')).toBe('payload');
    rmSync(h.root, { recursive: true, force: true });
  });
});
