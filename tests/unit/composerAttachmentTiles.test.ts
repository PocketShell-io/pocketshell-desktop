// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ComposerAttachmentTiles from '@ui/app/components/ComposerAttachmentTiles.vue';
import type { StagedAttachment } from '@ui/app/stores/composer';

/**
 * Which tiles offer to be annotated.
 *
 * The gate is the interesting part, and it is easy to get wrong in a way that
 * looks fine on the day it lands. The obvious rule — "the tile has a
 * thumbnail" — passes for the pasted screenshot everyone tests with and fails
 * for exactly the same file attached through the paperclip, because attaching
 * by PATH never mints a preview. It also fails for every attachment after a
 * restart, since previews are deliberately not persisted (they can be
 * megabytes). Keying off the remote NAME, through the same classifier the
 * Files tab uses, is what makes those three cases agree.
 */

const staged = (remotePath: string, extra: Partial<StagedAttachment> = {}): StagedAttachment => ({
  remotePath,
  displayName: remotePath.slice(remotePath.lastIndexOf('/') + 1),
  ...extra,
});

function annotateButtons(attachments: StagedAttachment[]): string[] {
  const wrapper = mount(ComposerAttachmentTiles, { props: { attachments } });
  return wrapper
    .findAll('button.annotate')
    .map((b) => b.attributes('aria-label') ?? '');
}

describe('the annotate affordance', () => {
  it('is offered on an image', () => {
    expect(annotateButtons([staged('~/.pocketshell/attachments/main/shot.png')])).toEqual([
      'Annotate shot.png',
    ]);
  });

  it('is offered on an image that never carried a thumbnail', () => {
    // The paperclip picker stages by path, so this tile shows a generic glyph.
    // It is still an image and the host still has its bytes.
    expect(annotateButtons([staged('~/a/20260825-101500-01-photo.jpg')])).toHaveLength(1);
  });

  it('is offered on an image restored from a previous run', () => {
    // `previewDataUrl` is absent by design after a restart; the name is not.
    expect(annotateButtons([staged('~/a/diagram.webp')])).toHaveLength(1);
  });

  it('is not offered on a PDF, an mp3 or a zip', () => {
    expect(
      annotateButtons([staged('~/a/spec.pdf'), staged('~/a/take.mp3'), staged('~/a/logs.zip')]),
    ).toEqual([]);
  });

  it('is not offered on an SVG, which is a document rather than pixels', () => {
    expect(annotateButtons([staged('~/a/icon.svg')])).toEqual([]);
  });

  it('is not offered on a file whose name says nothing', () => {
    expect(annotateButtons([staged('~/a/Makefile')])).toEqual([]);
  });

  it('emits the remote path, which is what identifies the tile', async () => {
    const attachments = [staged('~/a/one.png'), staged('~/a/two.png')];
    const wrapper = mount(ComposerAttachmentTiles, { props: { attachments } });
    await wrapper.findAll('button.annotate')[1]?.trigger('click');
    expect(wrapper.emitted('annotate')).toEqual([['~/a/two.png']]);
  });

  it('keeps the remove control in its usual corner on both kinds of tile', () => {
    // A tile whose rightmost button changed meaning with the file type is how a
    // muscle-memory click ends up deleting an attachment.
    const wrapper = mount(ComposerAttachmentTiles, {
      props: { attachments: [staged('~/a/shot.png'), staged('~/a/spec.pdf')] },
    });
    for (const tile of wrapper.findAll('li.tile')) {
      const buttons = tile.findAll('button');
      expect(buttons[buttons.length - 1]?.classes()).toContain('remove');
    }
  });

  it('disables annotation while a send is in flight, exactly as removal is', () => {
    const wrapper = mount(ComposerAttachmentTiles, {
      props: { attachments: [staged('~/a/shot.png')], disabled: true },
    });
    expect(wrapper.get('button.annotate').attributes('disabled')).toBeDefined();
  });
});
