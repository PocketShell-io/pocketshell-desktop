import { describe, expect, it } from 'vitest';
import {
  classifyByName,
  classifyBytes,
  looksLikeText,
  magicKind,
} from '@ui/app/fileKind';
import {
  extensionOfPath,
  mimeTypeForExtension,
} from '../../src/main/attachments/mimeTypes';

/**
 * The gate that stopped the Files tab freezing on an mp3.
 *
 * The property under test throughout is a NEGATIVE one, and it is the reason
 * the classifier exists: nothing that is not decodable text may be classified
 * `text`, because `text` is the only kind that reaches the editor. Every case
 * below is either "this really is text" or "this must not be called text".
 */

describe('extension -> mime', () => {
  it('returns the registered spelling, not a vendor alias', () => {
    // The forward table maps both `audio/mpeg` and `audio/mp3` to `mp3`; the
    // inverse has to pick one, and it must be the one browsers publish.
    expect(mimeTypeForExtension('mp3')).toBe('audio/mpeg');
    expect(mimeTypeForExtension('jpg')).toBe('image/jpeg');
    expect(mimeTypeForExtension('pdf')).toBe('application/pdf');
  });

  it('accepts a leading dot and any case', () => {
    expect(mimeTypeForExtension('.MP3')).toBe('audio/mpeg');
    expect(mimeTypeForExtension('WAV')).toBe('audio/wav');
  });

  it('says null rather than guessing octet-stream', () => {
    // "I do not know" and "I know it is opaque" are different answers and the
    // classifier acts on the difference.
    expect(mimeTypeForExtension('qqq')).toBeNull();
    expect(mimeTypeForExtension('')).toBeNull();
    expect(mimeTypeForExtension(null)).toBeNull();
  });

  it('treats a dotfile as having no extension', () => {
    expect(extensionOfPath('/home/u/.bashrc')).toBeNull();
    expect(extensionOfPath('/home/u/notes.md')).toBe('md');
    expect(extensionOfPath('/home/u/Makefile')).toBeNull();
    // A trailing dot is not an extension either.
    expect(extensionOfPath('/home/u/weird.')).toBeNull();
  });
});

describe('classifyByName', () => {
  it('routes audio to the player, never to the editor', () => {
    for (const name of ['/x/song.mp3', '/x/voice.m4a', '/x/clip.ogg', '/x/take.flac']) {
      expect(classifyByName(name).kind, name).toBe('audio');
    }
    expect(classifyByName('/x/song.mp3').mime).toBe('audio/mpeg');
  });

  it('routes a PDF to the viewer', () => {
    expect(classifyByName('/x/paper.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('routes images to the image view', () => {
    expect(classifyByName('/x/shot.PNG').kind).toBe('image');
    expect(classifyByName('/x/photo.jpeg').mime).toBe('image/jpeg');
  });

  it('keeps source files as text even when their mime is not text/*', () => {
    // `.ts` maps to `application/typescript`. A rule keyed on a `text/` prefix
    // would have sent every TypeScript file in this repo to the binary panel.
    expect(classifyByName('/x/store.ts').kind).toBe('text');
    expect(classifyByName('/x/main.rs').kind).toBe('text');
    expect(classifyByName('/x/config.yaml').kind).toBe('text');
  });

  it('treats dotfiles and conventional extension-less names as text', () => {
    expect(classifyByName('/home/u/.bashrc').kind).toBe('text');
    expect(classifyByName('/repo/Makefile').kind).toBe('text');
    expect(classifyByName('/repo/README').kind).toBe('text');
  });

  it('names known-opaque formats without reading them', () => {
    // Listing these is what lets a 2 GB tarball be refused from the listing
    // alone, rather than after dragging it across the wire.
    expect(classifyByName('/x/dump.zip').kind).toBe('binary');
    expect(classifyByName('/x/clip.mp4').kind).toBe('binary');
    expect(classifyByName('/x/report.docx').kind).toBe('binary');
  });

  it('routes a web page to the HTML view rather than to the plain editor', () => {
    for (const name of ['/x/index.html', '/x/page.HTM', '/x/doc.xhtml']) {
      expect(classifyByName(name).kind, name).toBe('html');
    }
    expect(classifyByName('/x/index.html').mime).toBe('text/html');
  });

  it('routes markdown to the preview view rather than to the plain editor', () => {
    for (const name of ['/x/README.md', '/x/notes.MARKDOWN', '/x/doc.mkd']) {
      expect(classifyByName(name).kind, name).toBe('markdown');
    }
    expect(classifyByName('/x/README.md').mime).toBe('text/markdown');
  });

  it('leaves the other prose formats as plain text', () => {
    // A markdown parser would render these into plausible-looking nonsense —
    // an `.rst` directive block silently becoming a paragraph is worse than
    // showing the source. `.mdx` is JSX in markdown: source for a page.
    for (const name of ['/x/index.rst', '/x/doc.adoc', '/x/notes.org', '/x/page.mdx']) {
      expect(classifyByName(name).kind, name).toBe('text');
    }
  });

  it('treats a dotfile named like markdown as a dotfile, not a document', () => {
    // A leading dot is not an extension anywhere else in this module either.
    expect(classifyByName('/x/.markdown').kind).toBe('text');
  });

  it('routes an SVG to the document view — a drawing and a source file', () => {
    // SVG was text-only for a long time on the argument that people edit it
    // more than they look at it. The toggle keeps that argument's second half
    // (the source is one click away and still highlights) while answering the
    // first: an `.svg` in a file browser is also, often, a picture someone
    // wants to SEE.
    expect(classifyByName('/x/logo.svg')).toEqual({ kind: 'svg', mime: 'image/svg+xml' });
    expect(classifyByName('/x/icon.SVG').kind).toBe('svg');
  });

  it('leaves page TEMPLATES as plain text, not as pages', () => {
    // A `.php` or a `.vue` contains markup but is source for a page rather
    // than a page: previewing one renders a broken document full of
    // unexecuted directives, which is strictly worse than showing the source
    // the user can actually reason about. Same for a stylesheet — it is
    // edited far more often than it is looked at here.
    expect(classifyByName('/x/index.php').kind).toBe('text');
    expect(classifyByName('/x/App.vue').kind).toBe('text');
    expect(classifyByName('/x/main.css').kind).toBe('text');
  });

  it('says "unknown" for a name it cannot place — never "text"', () => {
    // This is the case the whole module exists for. Falling through to the
    // editor here is precisely the bug that froze the app.
    expect(classifyByName('/x/blob.qqq').kind).toBe('unknown');
    expect(classifyByName('/x/no-extension-at-all').kind).toBe('unknown');
  });
});

describe('looksLikeText', () => {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('accepts UTF-8 prose, including non-ASCII and normal control bytes', () => {
    expect(looksLikeText(utf8('hello\tworld\r\n café — ✓\n'))).toBe(true);
  });

  it('accepts an empty file', () => {
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
  });

  it('rejects anything with a NUL', () => {
    expect(looksLikeText(new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69]))).toBe(false);
  });

  it('rejects invalid UTF-8 — the test that catches media bodies', () => {
    // An mp3 frame body is mostly high bytes with few NULs, so the NUL test
    // alone does not catch it. 0xC3 without a continuation byte is not UTF-8.
    expect(looksLikeText(new Uint8Array([0xc3, 0x28, 0xc3, 0x28, 0xc3, 0x28]))).toBe(false);
  });

  it('rejects a wall of wild control bytes', () => {
    expect(looksLikeText(new Uint8Array(64).fill(0x01))).toBe(false);
  });

  it('does not trip on a multi-byte character straddling the sniff window', () => {
    // The decoder runs in streaming mode precisely so a truncated tail is not
    // read as corruption.
    const big = 'a'.repeat(4095) + 'é';
    expect(looksLikeText(utf8(big))).toBe(true);
  });
});

describe('magicKind', () => {
  const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

  it('recognises a PDF by its header', () => {
    expect(magicKind(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31))).toEqual({
      kind: 'pdf',
      mime: 'application/pdf',
    });
  });

  it('recognises ID3-tagged and bare MPEG audio', () => {
    expect(magicKind(bytes(0x49, 0x44, 0x33, 0x04))?.kind).toBe('audio');
    expect(magicKind(bytes(0xff, 0xfb, 0x90))?.kind).toBe('audio');
  });

  it('splits RIFF containers on the type at byte 8', () => {
    const riff = (tag: string): Uint8Array =>
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, ...tag.split('').map((c) => c.charCodeAt(0))]);
    expect(magicKind(riff('WAVE'))).toEqual({ kind: 'audio', mime: 'audio/wav' });
    expect(magicKind(riff('WEBP'))).toEqual({ kind: 'image', mime: 'image/webp' });
  });

  it('splits ISO-BMFF on the brand so an m4a plays and an mp4 does not', () => {
    const ftyp = (brand: string): Uint8Array =>
      new Uint8Array([
        0,
        0,
        0,
        0x20,
        0x66,
        0x74,
        0x79,
        0x70,
        ...brand.split('').map((c) => c.charCodeAt(0)),
      ]);
    expect(ftyp('M4A ').length).toBe(12);
    expect(magicKind(ftyp('M4A '))).toEqual({ kind: 'audio', mime: 'audio/mp4' });
    expect(magicKind(ftyp('isom'))?.kind).toBe('binary');
  });

  it('returns null when nothing matches', () => {
    expect(magicKind(new TextEncoder().encode('just some words'))).toBeNull();
  });
});

describe('classifyBytes', () => {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('lets a text file with a weird extension into the editor', () => {
    // The case the extension list can never cover: the bytes are the evidence.
    const named = classifyByName('/x/notes.qqq');
    expect(named.kind).toBe('unknown');
    expect(classifyBytes(named, utf8('#!/bin/sh\necho hi\n')).kind).toBe('text');
  });

  it('keeps a mislabelled binary out of the editor', () => {
    const named = classifyByName('/x/archive.qqq');
    expect(classifyBytes(named, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14])).kind).toBe('binary');
  });

  it('promotes an extension-less file to a player when its magic says audio', () => {
    const named = classifyByName('/x/recording');
    expect(classifyBytes(named, new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]))).toEqual({
      kind: 'audio',
      mime: 'audio/mpeg',
    });
  });

  it('never overrides a decisive name with the bytes', () => {
    // A `.mp3` whose header we do not happen to recognise is still an mp3 the
    // browser may well play, and the user's own extension is a statement of
    // intent worth more than our signature table.
    const named = classifyByName('/x/odd.mp3');
    expect(classifyBytes(named, utf8('not really audio')).kind).toBe('audio');
  });

  it('falls to binary, not text, for unrecognised undecodable bytes', () => {
    const named = classifyByName('/x/thing');
    expect(classifyBytes(named, new Uint8Array([0xc3, 0x28, 0xc3, 0x28])).kind).toBe('binary');
  });
});
