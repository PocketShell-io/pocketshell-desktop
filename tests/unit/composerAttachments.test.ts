import { describe, expect, it } from 'vitest';
import {
  absoluteAttachmentPath,
  attachmentScopeKey,
  doodleAttachmentName,
  replaceStagedAttachment,
} from '../../src/shared/composerAttachments';

/**
 * The arithmetic behind "annotate the image I already attached".
 *
 * All three of these look trivial and all three are the parts that would be
 * wrong in a way nobody noticed. The ordering rule is invisible until a prompt
 * that says "the second screenshot" means the wrong file; the tilde expansion
 * is invisible until an attachment that came from the paperclip refuses to
 * open; the naming is invisible until a filename has grown four timestamps.
 */

interface Tile {
  remotePath: string;
  displayName: string;
}

const tile = (remotePath: string): Tile => ({
  remotePath,
  displayName: remotePath.slice(remotePath.lastIndexOf('/') + 1),
});

describe('replaceStagedAttachment', () => {
  it('keeps the replacement in the position the original held', () => {
    const list = [tile('~/a/one.png'), tile('~/a/two.png'), tile('~/a/three.png')];
    const next = replaceStagedAttachment(list, '~/a/two.png', tile('~/a/annotated.png'));
    expect(next?.map((a) => a.remotePath)).toEqual([
      '~/a/one.png',
      '~/a/annotated.png',
      '~/a/three.png',
    ]);
  });

  it('holds the position for the FIRST tile as well as a middle one', () => {
    const list = [tile('~/a/one.png'), tile('~/a/two.png')];
    const next = replaceStagedAttachment(list, '~/a/one.png', tile('~/a/annotated.png'));
    expect(next?.map((a) => a.remotePath)).toEqual(['~/a/annotated.png', '~/a/two.png']);
  });

  it('does not mutate the list it was given', () => {
    const list = [tile('~/a/one.png'), tile('~/a/two.png')];
    replaceStagedAttachment(list, '~/a/one.png', tile('~/a/annotated.png'));
    expect(list.map((a) => a.remotePath)).toEqual(['~/a/one.png', '~/a/two.png']);
  });

  it('reports null when the target is gone, rather than appending', () => {
    // The user removed the tile (or discarded the draft) while the annotated
    // PNG was still uploading. Re-adding it would be worse than losing it.
    const list = [tile('~/a/one.png')];
    expect(replaceStagedAttachment(list, '~/a/missing.png', tile('~/a/new.png'))).toBeNull();
  });

  it('leaves an empty list empty', () => {
    expect(replaceStagedAttachment([], '~/a/one.png', tile('~/a/new.png'))).toBeNull();
  });

  it('keeps remote paths unique when the incoming path is already staged', () => {
    // Unreachable in practice — remote names carry a timestamp and an ordinal
    // — but the store's dedupe-by-remotePath invariant has to survive this
    // function, or removing one tile would delete two.
    const list = [tile('~/a/one.png'), tile('~/a/two.png'), tile('~/a/three.png')];
    const next = replaceStagedAttachment(list, '~/a/one.png', tile('~/a/three.png'));
    expect(next?.map((a) => a.remotePath)).toEqual(['~/a/three.png', '~/a/two.png']);
  });
});

describe('absoluteAttachmentPath', () => {
  it('expands the tilde form the stager hands back', () => {
    expect(
      absoluteAttachmentPath('~/.pocketshell/attachments/main/20260825-101500-01-a.png', '/home/al'),
    ).toBe('/home/al/.pocketshell/attachments/main/20260825-101500-01-a.png');
  });

  it('does not double the separator when home already ends in one', () => {
    expect(absoluteAttachmentPath('~/x/y.png', '/')).toBe('/x/y.png');
  });

  it('leaves an absolute path exactly as it found it', () => {
    expect(absoluteAttachmentPath('/srv/shot.png', '/home/al')).toBe('/srv/shot.png');
  });

  it('leaves a relative path alone — the server resolves it against the same home', () => {
    expect(absoluteAttachmentPath('shot.png', '/home/al')).toBe('shot.png');
  });

  it('resolves a bare tilde to the home directory', () => {
    expect(absoluteAttachmentPath('~', '/home/al')).toBe('/home/al');
  });

  it('does not treat `~user` as an abbreviation it understands', () => {
    // Tilde-user expansion is a shell feature with no SFTP equivalent, and
    // guessing at it would produce a path that silently reads the wrong file.
    expect(absoluteAttachmentPath('~root/secret', '/home/al')).toBe('~root/secret');
  });
});

describe('doodleAttachmentName', () => {
  const STAMP = '20260825-120000';

  it('names a blank sheet a doodle, not an annotation of nothing', () => {
    expect(doodleAttachmentName(null, STAMP)).toBe(`doodle-${STAMP}.png`);
  });

  it('wraps a plain source name once', () => {
    expect(doodleAttachmentName('shot.png', STAMP)).toBe(`annotated-shot-${STAMP}.png`);
  });

  it('folds spaces and punctuation the remote name could not carry', () => {
    expect(doodleAttachmentName('Screen Shot (2).png', STAMP)).toBe(
      `annotated-Screen-Shot-2-${STAMP}.png`,
    );
  });

  it('strips the stager prefix, so a staged attachment does not re-carry it', () => {
    expect(doodleAttachmentName('20260825-101500-01-shot.png', STAMP)).toBe(
      `annotated-shot-${STAMP}.png`,
    );
  });

  it('is stable under repeated annotation', () => {
    // The second pass starts from the FLATTENED first pass, whose name has by
    // then been through this function and through AttachmentStager. Without
    // the stripping, every pass would add a prefix and a timestamp forever.
    const first = doodleAttachmentName('shot.png', '20260825-101459');
    const staged = `20260825-101500-01-${first}`;
    expect(doodleAttachmentName(staged, STAMP)).toBe(`annotated-shot-${STAMP}.png`);
    const stagedAgain = `20260825-101501-01-annotated-shot-${STAMP}.png`;
    expect(doodleAttachmentName(stagedAgain, '20260825-130000')).toBe(
      'annotated-shot-20260825-130000.png',
    );
  });

  it('falls back to `doodle-` when stripping leaves nothing behind', () => {
    expect(doodleAttachmentName('20260825-101500-01-annotated-.png', STAMP)).toBe(
      `doodle-${STAMP}.png`,
    );
  });
});

describe('attachmentScopeKey', () => {
  it('nests <workspace-basename>/<tag> for a session with a workspace', () => {
    expect(attachmentScopeKey('main', '/home/dev/git/dtc-site')).toBe('dtc-site/main');
    expect(attachmentScopeKey('main-2', '/home/dev/git/dtc-site/')).toBe('dtc-site/main-2');
  });

  it('scopes a workspaceless session to the bare name', () => {
    expect(attachmentScopeKey('main')).toBe('main');
    expect(attachmentScopeKey('main', null)).toBe('main');
    expect(attachmentScopeKey('main', '')).toBe('main');
  });

  it('still scopes to the bare name when the workspace has no basename', () => {
    expect(attachmentScopeKey('main', '/')).toBe('main');
    expect(attachmentScopeKey('main', '//')).toBe('main');
  });
});
