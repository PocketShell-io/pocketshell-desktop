import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AttachmentStager,
  MAX_IN_MEMORY_ATTACHMENT_BYTES,
  REMOTE_DIRECTORY,
  composeAttachmentName,
  formatAttachmentTimestamp,
  partialFailureMessage,
  safeScopePath,
  safeScopeSegment,
  sanitiseSource,
  type StagerSftp,
  type StagerSsh,
} from '@main/attachments/AttachmentStager';
import { renderSanitised, sanitiseFilename } from '@main/attachments/FilenameSanitiser';
import type { AttachmentSource } from '../../src/shared/types';

describe('safeScopeSegment', () => {
  it('lowercases and keeps the allow-listed characters', () => {
    expect(safeScopeSegment('Main-Session_1')).toBe('main-session_1');
  });

  it('folds everything else to a dash and collapses runs', () => {
    expect(safeScopeSegment('~/git/my project')).toBe('git-my-project');
    expect(safeScopeSegment('user@host:2222')).toBe('user-host-2222');
  });

  it('trims leading and trailing dashes', () => {
    expect(safeScopeSegment('///scope///')).toBe('scope');
  });

  it('falls back to "session" when nothing survives', () => {
    expect(safeScopeSegment('')).toBe('session');
    expect(safeScopeSegment('///')).toBe('session');
  });

  it('caps at 80 characters', () => {
    const scope = safeScopeSegment('a'.repeat(200));
    expect(scope).toHaveLength(80);
  });

  it('cannot produce a path separator', () => {
    expect(safeScopeSegment('../../etc')).not.toContain('/');
    expect(safeScopeSegment('../../etc')).toBe('etc');
  });
});

describe('safeScopePath', () => {
  it('keeps a nested scope as two sanitised segments', () => {
    expect(safeScopePath('DTC Site/main-2')).toBe('dtc-site/main-2');
  });

  it('sanitises each segment independently so `/` survives as a separator only', () => {
    expect(safeScopePath('my repo/~/..//x y/')).toBe('my-repo/x-y');
  });

  it('cannot traverse: `..` folds away and a leading slash is a dropped empty segment', () => {
    expect(safeScopePath('../../etc/passwd')).toBe('etc/passwd');
    expect(safeScopePath('/etc')).toBe('etc');
    expect(safeScopePath('..')).toBe('session');
  });

  it('falls back to "session" when no segment survives', () => {
    expect(safeScopePath('')).toBe('session');
    expect(safeScopePath('///')).toBe('session');
  });

  it('caps each segment at 80 characters', () => {
    const [a, b] = safeScopePath(`${'a'.repeat(200)}/${'b'.repeat(200)}`).split('/');
    expect(a).toHaveLength(80);
    expect(b).toHaveLength(80);
  });
});

describe('composeAttachmentName', () => {
  it('inserts a 1-based, zero-padded ordinal', () => {
    const sanitised = sanitiseFilename('shot.png');
    expect(composeAttachmentName('20260824-101500', 0, sanitised)).toBe(
      '20260824-101500-01-shot.png',
    );
    expect(composeAttachmentName('20260824-101500', 9, sanitised)).toBe(
      '20260824-101500-10-shot.png',
    );
  });

  it('keeps a multi-file paste from colliding within one second', () => {
    const names = [0, 1, 2].map((i) =>
      composeAttachmentName('20260824-101500', i, sanitiseFilename('image.png')),
    );
    expect(new Set(names).size).toBe(3);
  });
});

describe('formatAttachmentTimestamp', () => {
  it('renders yyyyMMdd-HHmmss in local time', () => {
    const local = new Date(2026, 7, 24, 9, 5, 3);
    expect(formatAttachmentTimestamp(local.getTime())).toBe('20260824-090503');
  });
});

describe('sanitiseSource', () => {
  it('derives the extension from the mime type when a paste has no name', () => {
    const source: AttachmentSource = {
      kind: 'bytes',
      data: new Uint8Array([1]),
      mimeType: 'image/png',
    };
    expect(renderSanitised(sanitiseSource(source))).toBe('shared.png');
  });

  it('prefers the extension a picked file already has over the mime default', () => {
    const source: AttachmentSource = {
      kind: 'file',
      path: '/home/me/docs/report.pdf',
      mimeType: 'image/png',
    };
    expect(renderSanitised(sanitiseSource(source))).toBe('report.pdf');
  });

  it('derives an audio extension for a nameless recording', () => {
    // A voice memo dragged out of a recorder applet arrives exactly like
    // a pasted screenshot — bytes plus a mime type, no filename — so the
    // agent's only clue to what it has been handed is this extension.
    const source: AttachmentSource = {
      kind: 'bytes',
      data: new Uint8Array([1]),
      mimeType: 'audio/mpeg',
    };
    expect(renderSanitised(sanitiseSource(source))).toBe('shared.mp3');
  });

  it('keeps a picked PDF or audio file its own extension', () => {
    const pdf: AttachmentSource = { kind: 'file', path: '/home/me/docs/spec.pdf' };
    const memo: AttachmentSource = { kind: 'file', path: '/home/me/rec/standup.m4a' };
    expect(renderSanitised(sanitiseSource(pdf))).toBe('spec.pdf');
    expect(renderSanitised(sanitiseSource(memo))).toBe('standup.m4a');
  });

  it('uses the basename of a picked file', () => {
    const source: AttachmentSource = { kind: 'file', path: '/home/me/a b/notes.md' };
    expect(renderSanitised(sanitiseSource(source))).toBe('notes.md');
  });
});

describe('partialFailureMessage', () => {
  it('names the counts and the first failure detail', () => {
    expect(partialFailureMessage(2, 1, new Error('permission denied'))).toBe(
      'Attached 2 of 3 files; 1 failed (permission denied).',
    );
  });

  it('uses only the first line of a multi-line detail', () => {
    expect(partialFailureMessage(1, 1, new Error('boom\nstack frame\nmore'))).toBe(
      'Attached 1 of 2 files; 1 failed (boom).',
    );
  });
});

// ---------------------------------------------------------------------------
// stage() — the partial-failure contract (Android issue #570)
// ---------------------------------------------------------------------------

const HOME = '/home/testuser';

interface FakeRemote {
  ssh: StagerSsh;
  sftp: StagerSftp;
  /** remotePath -> uploaded bytes. */
  uploads: Map<string, Buffer>;
  commands: string[];
  /** Remote paths whose upload should reject. */
  failFor: (predicate: (remotePath: string) => boolean) => void;
}

function fakeRemote(opts: { mkdirExit?: number } = {}): FakeRemote {
  const uploads = new Map<string, Buffer>();
  const commands: string[] = [];
  let shouldFail: (remotePath: string) => boolean = () => false;

  return {
    uploads,
    commands,
    failFor: (predicate) => {
      shouldFail = predicate;
    },
    ssh: {
      async exec(_connectionId: string, command: string) {
        commands.push(command);
        const exitCode = command.startsWith('mkdir') ? (opts.mkdirExit ?? 0) : 0;
        return { stdout: '', stderr: exitCode === 0 ? '' : 'Permission denied', exitCode };
      },
    },
    sftp: {
      async realPath() {
        return HOME;
      },
      async list() {
        return [];
      },
      async upload(_connectionId: string, localPath: string, remotePath: string) {
        if (shouldFail(remotePath)) throw new Error('remote write failed');
        // Read the local file so the test also proves we streamed real bytes.
        uploads.set(remotePath, readFileSync(localPath));
      },
    },
  };
}

const bytes = (name: string, body: string): AttachmentSource => ({
  kind: 'bytes',
  data: new TextEncoder().encode(body),
  name,
  mimeType: 'image/png',
});

const stagerFor = (remote: FakeRemote): AttachmentStager =>
  new AttachmentStager({
    ssh: remote.ssh,
    sftp: remote.sftp,
    now: () => new Date(2026, 7, 24, 10, 15, 0).getTime(),
  });

describe('AttachmentStager.stage', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stager-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns no paths for an empty batch without touching the remote', async () => {
    const remote = fakeRemote();
    const result = await stagerFor(remote).stage('conn-1', 'main', []);
    expect(result).toEqual({ ok: true, paths: [], failedCount: 0 });
    expect(remote.commands).toEqual([]);
  });

  it('uploads a paste and returns the tilde-form display path', async () => {
    const remote = fakeRemote();
    const result = await stagerFor(remote).stage('conn-1', 'My Session', [
      bytes('shot.png', 'PNGDATA'),
    ]);

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/my-session/20260824-101500-01-shot.png`,
    ]);
    // The path handed to the composer stays in tilde form; the SFTP write
    // uses the absolute one.
    expect([...remote.uploads.keys()]).toEqual([
      `${HOME}/${REMOTE_DIRECTORY}/my-session/20260824-101500-01-shot.png`,
    ]);
    expect(remote.uploads.values().next().value?.toString('utf8')).toBe('PNGDATA');
    expect(remote.commands[0]).toBe(
      `mkdir -p "$HOME/${REMOTE_DIRECTORY}/my-session"`,
    );
  });

  it('nests a workspace-scoped upload under <workspace-name>/<tag>', async () => {
    const remote = fakeRemote();
    const result = await stagerFor(remote).stage('conn-1', 'dtc-site/main', [
      bytes('shot.png', 'PNGDATA'),
    ]);

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/dtc-site/main/20260824-101500-01-shot.png`,
    ]);
    expect(remote.uploads.has(
      `${HOME}/${REMOTE_DIRECTORY}/dtc-site/main/20260824-101500-01-shot.png`,
    )).toBe(true);
    // One `mkdir -p` builds both levels.
    expect(remote.commands[0]).toBe(
      `mkdir -p "$HOME/${REMOTE_DIRECTORY}/dtc-site/main"`,
    );
  });

  it('streams a picked file straight from disk', async () => {
    const remote = fakeRemote();
    const localPath = join(dir, 'notes.md');
    await writeFile(localPath, '# hello');

    const result = await stagerFor(remote).stage('conn-1', 'main', [
      { kind: 'file', path: localPath },
    ]);

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-01-notes.md`,
    ]);
    expect(remote.uploads.values().next().value?.toString('utf8')).toBe('# hello');
  });

  it('streams a picked file of ANY size — the in-memory ceiling does not apply', async () => {
    const remote = fakeRemote();
    const localPath = join(dir, 'export.zip');
    // Truncate up to a sparse 101 MiB: `stat` reports a size over the
    // in-memory branch's ceiling without those bytes existing on disk.
    const handle = await open(localPath, 'w');
    await handle.truncate(101 * 1024 * 1024);
    await handle.close();

    const result = await stagerFor(remote).stage('conn-1', 'main', [
      { kind: 'file', path: localPath },
    ]);

    expect(result.ok).toBe(true);
    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-01-export.zip`,
    ]);
    expect(remote.uploads.has(
      `${HOME}/${REMOTE_DIRECTORY}/main/20260824-101500-01-export.zip`,
    )).toBe(true);
  });

  it('gives pastes and picked files an identical remote layout', async () => {
    const remote = fakeRemote();
    const localPath = join(dir, 'twin.txt');
    await writeFile(localPath, 'same');

    const result = await stagerFor(remote).stage('conn-1', 'main', [
      { kind: 'file', path: localPath },
      bytes('twin.txt', 'same'),
    ]);

    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-01-twin.txt`,
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-02-twin.txt`,
    ]);
  });

  it('keeps the successes when a sibling fails (issue #570)', async () => {
    const remote = fakeRemote();
    remote.failFor((p) => p.endsWith('-02-b.png'));

    const result = await stagerFor(remote).stage('conn-1', 'main', [
      bytes('a.png', 'A'),
      bytes('b.png', 'B'),
      bytes('c.png', 'C'),
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    // The survivors are STILL attached — never discarded because a sibling
    // failed — and they keep their own ordinals.
    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-01-a.png`,
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-03-c.png`,
    ]);
    expect(result.error).toBe('Attached 2 of 3 files; 1 failed (remote write failed).');
  });

  it('reports a total failure with no paths', async () => {
    const remote = fakeRemote();
    remote.failFor(() => true);

    const result = await stagerFor(remote).stage('conn-1', 'main', [bytes('a.png', 'A')]);

    expect(result.ok).toBe(false);
    expect(result.paths).toEqual([]);
    expect(result.failedCount).toBe(1);
    expect(result.error).toContain('remote write failed');
  });

  it('fails the whole batch cleanly when mkdir fails', async () => {
    const remote = fakeRemote({ mkdirExit: 1 });
    const result = await stagerFor(remote).stage('conn-1', 'main', [
      bytes('a.png', 'A'),
      bytes('b.png', 'B'),
    ]);

    expect(result.ok).toBe(false);
    expect(result.paths).toEqual([]);
    expect(result.failedCount).toBe(2);
    expect(result.error).toContain('Could not create attachment directory');
    expect(remote.uploads.size).toBe(0);
  });

  it('rejects an oversized paste through the per-file path', async () => {
    const remote = fakeRemote();
    const oversized: AttachmentSource = {
      kind: 'bytes',
      // Fake the length rather than allocating 100 MiB in a unit test.
      data: { byteLength: MAX_IN_MEMORY_ATTACHMENT_BYTES + 1 } as unknown as Uint8Array,
      name: 'huge.bin',
    };

    const result = await stagerFor(remote).stage('conn-1', 'main', [
      bytes('small.png', 'ok'),
      oversized,
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    // The small sibling still landed.
    expect(result.paths).toEqual([
      `~/${REMOTE_DIRECTORY}/main/20260824-101500-01-small.png`,
    ]);
    expect(result.error).toContain('the limit is 100.0 MB');
  });

  it('rejects empty clipboard bytes', async () => {
    const remote = fakeRemote();
    const result = await stagerFor(remote).stage('conn-1', 'main', [
      { kind: 'bytes', data: new Uint8Array(0), name: 'empty.png' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('is empty');
  });

  it('rejects a missing local file without wedging the batch', async () => {
    const remote = fakeRemote();
    const result = await stagerFor(remote).stage('conn-1', 'main', [
      bytes('a.png', 'A'),
      { kind: 'file', path: join(dir, 'does-not-exist.txt') },
    ]);
    expect(result.paths).toHaveLength(1);
    expect(result.failedCount).toBe(1);
  });
});
