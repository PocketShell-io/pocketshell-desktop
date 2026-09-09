// @vitest-environment jsdom
//
// The Files store's open-file pipeline: what happens when a FILE opens, as
// opposed to the browsing in filesStore.test.ts. jsdom is required here, not
// a nicety: minting a preview resolves the app's design tokens out of
// `getComputedStyle(document.documentElement)` — the only way a palette can
// reach a frame that the cascade does not enter — and under `node` that call
// throws, `mintPreview` catches it, and the whole feature is silently off
// with nothing pointing at the cause. The ipc double is shared in
// helpers/filesApi, which also stubs the object URLs jsdom lacks.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  created,
  list,
  openHtml,
  openMarkdown,
  openSvg,
  readBinary,
  readFile,
  realPath,
  releasePreview,
  resetFilesApi,
  revoked,
  saveAs,
  stat,
  statsListener,
  writeFile,
} from './helpers/filesApi';

vi.mock('../../src/renderer/ipc', async () => ({
  api: (await import('./helpers/filesApi')).api,
}));

const { useFilesStore, MAX_TEXT_BYTES } = await import('../../src/renderer/stores/files');

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  resetFilesApi();
});

/**
 * The freeze: clicking an mp3 read it as UTF-8 and bound megabytes of
 * replacement characters to a textarea.
 *
 * The invariant these pin is that `openMode` is `text` only for bytes that
 * decoded as text, and that every other outcome — including every FAILURE —
 * ends in the binary panel rather than in the editor.
 */
describe('files store openFile() type gating', () => {
  const openIn = async (name: string, bytes?: Uint8Array, size?: number) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: size ?? bytes?.length ?? 0 });
    if (bytes) readBinary.mockResolvedValue(bytes);
    const files = useFilesStore();
    await files.open(CONN, '/home/u');
    await files.openFile(CONN, name);
    return files;
  };

  it('plays audio instead of decoding it', async () => {
    const files = await openIn('song.mp3', new Uint8Array([0x49, 0x44, 0x33, 0x04, 0xff, 0xfb]));

    expect(files.openMode).toBe('audio');
    expect(files.openMime).toBe('audio/mpeg');
    expect(files.openUrl).toBeTruthy();
    expect(files.openContent).toBe('');
  });

  it('renders a PDF instead of decoding it', async () => {
    const files = await openIn('paper.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));

    expect(files.openMode).toBe('pdf');
    expect(files.openMime).toBe('application/pdf');
    expect(files.openUrl).toBeTruthy();
  });

  it('never uses readFile — the UTF-8 path is gone entirely', async () => {
    await openIn('song.mp3', new Uint8Array([0x49, 0x44, 0x33]));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('opens ordinary text in the editor', async () => {
    // Deliberately NOT a `.md` any more: markdown grew a preview, so it is no
    // longer the example of a file that goes straight to the editor.
    const files = await openIn('notes.txt', new TextEncoder().encode('# hi\n'));

    expect(files.openMode).toBe('text');
    expect(files.openContent).toBe('# hi\n');
    expect(files.openUrl).toBeNull();
  });

  it('refuses an oversized text file without transferring it', async () => {
    const files = await openIn('huge.log', undefined, MAX_TEXT_BYTES + 1);

    expect(files.openMode).toBe('binary');
    expect(files.openNote).toContain('limit');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('refuses a known-binary type from the listing alone', async () => {
    const files = await openIn('dump.zip', undefined, 4096);

    expect(files.openMode).toBe('binary');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('shows the binary panel, not text, when the read fails', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 10 });
    readBinary.mockRejectedValue(new Error('Permission denied'));
    const files = useFilesStore();
    await files.open(CONN, '/home/u');

    await files.openFile(CONN, 'thing.mp3');

    expect(files.openMode).toBe('binary');
    expect(files.openContent).toBe('');
    expect(files.openNote).toContain('Permission denied');
  });

  it('revokes the previous object URL when another file is opened', async () => {
    const files = await openIn('a.mp3', new Uint8Array([0x49, 0x44, 0x33]));
    const first = files.openUrl;

    readBinary.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await files.openFile(CONN, 'b.pdf');

    expect(revoked).toContain(first);
  });
});

/**
 * WHERE a failure is reported is part of what the failure means.
 *
 * `save()` and `download()` used to write into the same `error` ref the
 * directory listing uses, and that ref renders in exactly one place: the
 * footer of the file tree, in the LEFT pane. A failed Ctrl+S therefore put
 * its reason in the far corner of a pane the user was not looking at — or
 * off-screen entirely, below a short listing — while on the right the Save
 * button merely stopped saying "Saving…" and the file stayed dirty. That
 * reads as a save that silently did nothing. These pin the split: open-file
 * failures land in `fileError`, which FilesView renders beside the editor
 * bar, and the listing keeps `error` to itself.
 */
describe("files store fileError — the open file's own channel", () => {
  const openText = async (name = 'notes.txt') => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 6 });
    readBinary.mockResolvedValue(new TextEncoder().encode('hello\n'));
    const files = useFilesStore();
    await files.open(CONN, '/home/u');
    await files.openFile(CONN, name);
    return files;
  };

  it('lands a failed save beside the editor, not in the tree footer', async () => {
    const files = await openText();
    files.setContent('edited');
    writeFile.mockRejectedValue(new Error('Permission denied'));

    expect(await files.save(CONN)).toBe(false);

    expect(files.fileError).toBe('Permission denied');
    // The listing channel stays silent — the tree has nothing to confess.
    expect(files.error).toBeNull();
    // And the buffer is still the user's: a failed save must leave it dirty.
    expect(files.dirty).toBe(true);
  });

  it('retires the verdict when a new save attempt starts', async () => {
    const files = await openText();
    files.setContent('edited');
    writeFile.mockRejectedValueOnce(new Error('Permission denied'));
    expect(await files.save(CONN)).toBe(false);
    expect(files.fileError).toBe('Permission denied');

    writeFile.mockResolvedValue(true);
    expect(await files.save(CONN)).toBe(true);

    // The retry succeeded, so the failure message comes down with it.
    expect(files.fileError).toBeNull();
  });

  it('clears when the file is closed', async () => {
    const files = await openText();
    files.setContent('edited');
    writeFile.mockRejectedValue(new Error('Permission denied'));
    await files.save(CONN);
    expect(files.fileError).toBe('Permission denied');

    files.closeFile();

    expect(files.fileError).toBeNull();
  });

  it('clears when another file replaces the one that failed', async () => {
    const files = await openText();
    files.setContent('edited');
    writeFile.mockRejectedValue(new Error('Permission denied'));
    await files.save(CONN);
    expect(files.fileError).toBe('Permission denied');

    readBinary.mockResolvedValue(new TextEncoder().encode('other\n'));
    await files.openFile(CONN, 'other.txt');

    // A verdict on one file must not hang over the next.
    expect(files.fileError).toBeNull();
  });

  it('lands a failed download in the same channel', async () => {
    // A zip goes to the binary panel, whose ONLY action is the Download…
    // button — which sits in the editor area, so its failure belongs beside
    // it too.
    const files = await openText('dump.zip');
    saveAs.mockRejectedValue(new Error('EACCES: permission denied'));

    expect(await files.download(CONN)).toBeNull();

    expect(files.fileError).toContain('EACCES');
    expect(files.error).toBeNull();
  });

  it('keeps a listing failure in the listing channel', async () => {
    // The other direction of the split: the tree's own failures must not
    // start appearing beside the editor just because a file is open.
    const files = await openText();
    list.mockRejectedValue(new Error('Channel closed'));

    await files.refresh(CONN);

    expect(files.error).toBe('Channel closed');
    expect(files.fileError).toBeNull();
  });
});

/**
 * HTML: the one kind that is a viewer AND an editor at the same time.
 *
 * Two properties are pinned here, and they pull in opposite directions, which
 * is why both need tests. The first is that a preview happens at all — an
 * HTML file must not quietly stay in the editor the way it did before. The
 * second is that adding the preview did not cost the editing that was already
 * there: the buffer, the dirty flag, the save and the unsaved-edit stash all
 * have to behave exactly as they do for a `.md`, because "we added a preview
 * and you can no longer fix a typo" is not a feature.
 *
 * The third group is about the preview being a REVOCABLE capability rather
 * than a URL. A token that outlives the file it was minted for is a live
 * channel from a frame to the remote host, so every way out of a file has to
 * hand it back.
 */
describe('files store openFile() on HTML', () => {
  const openHtmlFile = async (name: string, source: string) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: source.length });
    readBinary.mockResolvedValue(new TextEncoder().encode(source));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');
    await files.openFile(CONN, name);
    return files;
  };

  it('previews a page AND keeps its source in the editor buffer', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');

    expect(files.openMode).toBe('html');
    expect(files.openMime).toBe('text/html');
    // Both halves are populated from ONE read: the frame needs a URL, the
    // Source toggle needs the text, and a second SFTP round trip to get the
    // text back would be paid on every open for a tab most users never press.
    expect(files.openContent).toBe('<h1>hi</h1>');
    expect(files.previewUrl).toBe('psview://tok/home/u/site/index.html');
    expect(files.docView).toBe('preview');
  });

  it('mints the preview against the ABSOLUTE path, never the clicked name', async () => {
    await openHtmlFile('index.html', '<h1>hi</h1>');
    // The name from the tree is relative to the browsed directory; main scopes
    // the whole preview to the file's own folder, so handing it a bare
    // basename would scope it to wherever main happened to resolve it.
    expect(openHtml).toHaveBeenCalledWith(CONN, '/home/u/site/index.html');
  });

  it('never sends the file bytes to the frame — the URL is all the renderer has', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    // No object URL. This is the difference from every other viewer, and the
    // reason relative assets resolve at all: a blob has no path to resolve
    // `href="style.css"` against.
    expect(files.openUrl).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('says so when the page contains scripts, because they will not run', async () => {
    const files = await openHtmlFile('app.html', '<div id="root"></div><script src="a.js"></script>');
    expect(files.openHasScripts).toBe(true);
  });

  it('does not cry script on a page that has none', async () => {
    const files = await openHtmlFile('page.html', '<p>plain</p>');
    expect(files.openHasScripts).toBe(false);
  });

  it('flags remote sub-resources, which main can never count', async () => {
    // A remote `<img>` is refused inside the renderer by the FRAME's own CSP,
    // so the request never reaches main and never appears in the blocked
    // count. Derived from the source or it is not reported at all.
    const cdn = await openHtmlFile('cdn.html', '<img src="https://cdn.example/x.png">');
    expect(cdn.openHasRemoteRefs).toBe(true);

    const styled = await openHtmlFile('s.html', '<link rel=stylesheet href="//cdn/x.css">');
    expect(styled.openHasRemoteRefs).toBe(false); // protocol-relative is not http(s)-spelled

    const linked = await openHtmlFile('l.html', '<link rel=stylesheet href="http://cdn/x.css">');
    expect(linked.openHasRemoteRefs).toBe(true);
  });

  it('does not call a plain hyperlink a remote resource', async () => {
    // An `<a href="https://…">` loads nothing; claiming a resource was
    // refused because a page cites a source would be its own small lie.
    const files = await openHtmlFile('links.html', '<a href="https://example.com/">docs</a>');
    expect(files.openHasRemoteRefs).toBe(false);
  });

  it('falls back to the source view, with a reason, when the preview cannot be minted', async () => {
    openHtml.mockRejectedValue(new Error('No such file'));
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');

    // Not the binary panel: the file IS text and the editor has it. What was
    // lost is the render, and only the render.
    expect(files.openMode).toBe('html');
    expect(files.docView).toBe('source');
    expect(files.previewUrl).toBeNull();
    expect(files.openNote).toContain('No such file');
    expect(files.openContent).toBe('<h1>hi</h1>');
  });

  it('refuses an oversized page without transferring it', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: MAX_TEXT_BYTES + 1 });
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    await files.openFile(CONN, 'huge.html');

    expect(files.openMode).toBe('binary');
    expect(readBinary).not.toHaveBeenCalled();
    expect(openHtml).not.toHaveBeenCalled();
  });

  it('still edits and saves, and re-mints the preview so it shows the new bytes', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    const firstToken = files.previewToken;

    files.setContent('<h1>edited</h1>');
    expect(files.dirty).toBe(true);

    expect(await files.save(CONN)).toBe(true);

    expect(writeFile).toHaveBeenCalledWith(CONN, '/home/u/site/index.html', '<h1>edited</h1>');
    expect(files.dirty).toBe(false);
    // The old capability is handed back and a new one taken out, which is what
    // makes the frame navigate to fresh bytes without a cache to defeat.
    expect(releasePreview).toHaveBeenCalledWith(firstToken);
    expect(files.previewToken).not.toBe(firstToken);
  });

  it('re-mints on an explicit reload, which is how an emptied frame is recovered', async () => {
    // A remote link inside the page is refused by the app's CSP, and Chromium
    // replaces the frame with its error document; with no scripts in the frame
    // there is nothing to intercept the click. Reload is the way back.
    const files = await openHtmlFile('index.html', '<a href="https://x/">go</a>');
    const first = files.previewToken;

    await files.reloadPreview(CONN);

    expect(releasePreview).toHaveBeenCalledWith(first);
    expect(files.previewToken).not.toBe(first);
    expect(files.docView).toBe('preview');
  });

  it('does nothing on reload when the open file has no preview at all', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 5 });
    readBinary.mockResolvedValue(new TextEncoder().encode('x = 1'));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');
    await files.openFile(CONN, 'script.py');

    await files.reloadPreview(CONN);

    expect(openHtml).not.toHaveBeenCalled();
    expect(openMarkdown).not.toHaveBeenCalled();
  });

  it('releases the preview when the file is closed', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    const token = files.previewToken;

    files.closeFile();

    expect(releasePreview).toHaveBeenCalledWith(token);
    expect(files.previewUrl).toBeNull();
    expect(files.previewToken).toBeNull();
  });

  it('releases the preview when another file replaces it', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    const token = files.previewToken;

    readBinary.mockResolvedValue(new TextEncoder().encode('x = 1'));
    await files.openFile(CONN, 'script.py');

    expect(releasePreview).toHaveBeenCalledWith(token);
    expect(files.openMode).toBe('text');
    expect(files.previewUrl).toBeNull();
  });

  it('releases the preview on disconnect', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    const token = files.previewToken;

    files.clear(CONN);

    expect(releasePreview).toHaveBeenCalledWith(token);
  });

  it('restores an unsaved page as HTML on the source side, not as flat text', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    files.setContent('<h1>unsaved</h1>');

    await files.open(CONN, '/home/u/other');
    await files.open(CONN, '/home/u/site');

    expect(files.openContent).toBe('<h1>unsaved</h1>');
    expect(files.dirty).toBe(true);
    // Still an HTML file — the Preview/Source toggle must survive a tab
    // switch. And the SOURCE is what is showing, because the preview would
    // render the host's copy, which is not what this buffer says.
    expect(files.openMode).toBe('html');
    expect(files.docView).toBe('source');
  });

  it('takes asset counts only for the preview currently on screen', async () => {
    const files = await openHtmlFile('index.html', '<h1>hi</h1>');
    const token = files.previewToken as string;

    statsListener?.({ token, loaded: 3, blocked: 1, missing: 0, capped: false });
    expect(files.previewStats).toEqual({ loaded: 3, blocked: 1, missing: 0, capped: false });

    // A straggling request from a preview the user has moved on from must not
    // write counts into the page they are looking at now.
    statsListener?.({ token: 'someone-else', loaded: 99, blocked: 0, missing: 0, capped: true });
    expect(files.previewStats).toEqual({ loaded: 3, blocked: 1, missing: 0, capped: false });
  });
});

/**
 * Markdown: the second kind with two presentations.
 *
 * These cases exist to pin the ONE thing the store decides differently — which
 * open verb a preview goes through, and therefore whether the palette travels.
 * Everything else (the buffer, the dirty flag, the save, the revocation, the
 * stash) is the same code the HTML cases above already exercise, because the
 * store treats both through `hasPreview`; a markdown-shaped copy of all of it
 * would assert the same branches twice and rot at half the rate.
 */
describe('files store openFile() on markdown', () => {
  const openMd = async (name: string, source: string) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: source.length });
    readBinary.mockResolvedValue(new TextEncoder().encode(source));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/docs');
    await files.openFile(CONN, name);
    return files;
  };

  it('previews a document AND keeps its source in the editor buffer', async () => {
    const files = await openMd('README.md', '# Title\n');

    expect(files.openMode).toBe('markdown');
    expect(files.openMime).toBe('text/markdown');
    expect(files.openContent).toBe('# Title\n');
    expect(files.previewUrl).toBe('psview://md/home/u/docs/README.md');
    expect(files.docView).toBe('preview');
  });

  it('mints through the markdown verb, carrying the app’s palette', async () => {
    await openMd('README.md', '# Title\n');

    expect(openHtml).not.toHaveBeenCalled();
    const [, path, style] = openMarkdown.mock.calls[0]!;
    expect(path).toBe('/home/u/docs/README.md');
    // The tokens cannot cascade into the frame, so their VALUES have to
    // travel. What they are is jsdom's business; that the set is complete and
    // the appearance is stated is ours.
    expect(Object.keys(style.palette)).toContain('--bg');
    expect(Object.keys(style.palette)).toContain('--font-mono');
    expect(['dark', 'light']).toContain(style.appearance);
  });

  it('flags a remote badge row, which is what a README usually opens with', async () => {
    const files = await openMd('README.md', '![build](https://img.shields.io/x.svg)\n');
    expect(files.openHasRemoteRefs).toBe(true);
  });

  it('does not call a markdown hyperlink a remote resource', async () => {
    // `[spec](https://…)` loads nothing. Same line the HTML patterns draw.
    const files = await openMd('README.md', 'see [the spec](https://example.com/s)\n');
    expect(files.openHasRemoteRefs).toBe(false);
  });

  it('reports raw script markup, which the converter passes through inert', async () => {
    const files = await openMd('README.md', 'text\n\n<script>x</script>\n');
    expect(files.openHasScripts).toBe(true);
  });

  it('edits, saves and re-mints, exactly as an HTML file does', async () => {
    const files = await openMd('README.md', '# Title\n');
    const first = files.previewToken;

    files.setContent('# Edited\n');
    expect(files.dirty).toBe(true);
    expect(await files.save(CONN)).toBe(true);

    expect(writeFile).toHaveBeenCalledWith(CONN, '/home/u/docs/README.md', '# Edited\n');
    expect(releasePreview).toHaveBeenCalledWith(first);
    expect(files.previewToken).not.toBe(first);
  });

  it('restores an unsaved document as markdown on the source side', async () => {
    const files = await openMd('README.md', '# Title\n');
    files.setContent('# Unsaved\n');

    await files.open(CONN, '/home/u/elsewhere');
    await files.open(CONN, '/home/u/docs');

    expect(files.openMode).toBe('markdown');
    expect(files.docView).toBe('source');
    expect(files.openContent).toBe('# Unsaved\n');
    expect(files.dirty).toBe(true);
  });

  /**
   * The preview is a snapshot with the palette baked in: the frame is a
   * separate document on a separate origin, runs no scripts, and cannot be
   * told about a repaint. Re-minting is the only mechanism there is.
   */
  it('re-mints on a theme change so the render follows the app', async () => {
    const files = await openMd('README.md', '# Title\n');
    const first = files.previewToken;

    await files.restylePreview(CONN);

    expect(releasePreview).toHaveBeenCalledWith(first);
    expect(files.previewToken).not.toBe(first);
    expect(openMarkdown).toHaveBeenCalledTimes(2);
  });

  it('does not re-mint an HTML preview on a theme change', async () => {
    // A page brings its own styling. Repainting it in the app's colours would
    // be a lie about what the file looks like.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 11 });
    readBinary.mockResolvedValue(new TextEncoder().encode('<h1>hi</h1>'));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');
    await files.openFile(CONN, 'index.html');
    const token = files.previewToken;

    await files.restylePreview(CONN);

    expect(files.previewToken).toBe(token);
    expect(openHtml).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a theme change with no file open', async () => {
    const files = useFilesStore();
    await files.restylePreview(CONN);
    expect(openMarkdown).not.toHaveBeenCalled();
  });

  /**
   * Found by running the app, not by reading it: releasing a preview used to
   * clear `openHasScripts`, so the "scripts are not run" line vanished on every
   * Reload and on every theme re-mint — leaving a document that renders as an
   * empty shell with nothing on screen saying why. Those two flags describe the
   * SOURCE, which is still open; only the asset counts belong to the render
   * being thrown away.
   */
  it('keeps saying scripts are not run after a re-mint', async () => {
    const files = await openMd('README.md', 'text\n\n<script>x</script>\n\n![b](https://x/b.svg)\n');
    expect(files.openHasScripts).toBe(true);
    expect(files.openHasRemoteRefs).toBe(true);

    await files.restylePreview(CONN);
    expect(files.openHasScripts).toBe(true);
    expect(files.openHasRemoteRefs).toBe(true);

    await files.reloadPreview(CONN);
    expect(files.openHasScripts).toBe(true);
    expect(files.openHasRemoteRefs).toBe(true);
  });

  it('still clears both flags when the file is actually closed', async () => {
    const files = await openMd('README.md', '<script>x</script>\n');
    files.closeFile();
    expect(files.openHasScripts).toBe(false);
    expect(files.openHasRemoteRefs).toBe(false);
  });
});

/**
 * SVG: the third kind with two presentations, and the first to join after
 * the pipeline was built.
 *
 * What the store actually decides for SVG is the open verb (its own, no
 * palette) and the remote-resource spelling (`href` on `<image>`/`<use>`
 * rather than `src` on `<img>`). Everything else — buffer, dirty flag, save,
 * revocation — is the `hasPreview` code the HTML cases exercise, so it is
 * asserted here only where SVG plausibly differs.
 */
describe('files store openFile() on SVG', () => {
  const openSvgFile = async (name: string, source: string) => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: source.length });
    readBinary.mockResolvedValue(new TextEncoder().encode(source));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/art');
    await files.openFile(CONN, name);
    return files;
  };

  it('previews a drawing AND keeps its source in the editor buffer', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>';
    const files = await openSvgFile('logo.svg', source);

    expect(files.openMode).toBe('svg');
    expect(files.openMime).toBe('image/svg+xml');
    expect(files.openContent).toBe(source);
    expect(files.previewUrl).toBe('psview://svg/home/u/art/logo.svg');
    expect(files.docView).toBe('preview');
    // The palette travels for markdown only; an SVG brings its own styling.
    expect(openSvg).toHaveBeenCalledWith(CONN, '/home/u/art/logo.svg');
    expect(openHtml).not.toHaveBeenCalled();
    expect(openMarkdown).not.toHaveBeenCalled();
  });

  it('stays editable: an edit saves and re-mints the drawing', async () => {
    const files = await openSvgFile('logo.svg', '<svg></svg>');
    const firstToken = files.previewToken;

    files.setContent('<svg><!-- touched --></svg>');
    expect(await files.save(CONN)).toBe(true);

    expect(writeFile).toHaveBeenCalledWith(CONN, '/home/u/art/logo.svg', '<svg><!-- touched --></svg>');
    expect(releasePreview).toHaveBeenCalledWith(firstToken);
    expect(files.previewToken).not.toBe(firstToken);
    expect(openSvg).toHaveBeenCalledTimes(2);
  });

  it("flags an SVG's own spelling of remote resources", async () => {
    // `<image>` and `<use>` carry their reference in `href` — which none of
    // the HTML/markdown patterns read — and a drawing whose bitmap lives on
    // a CDN renders with exactly the hole the note exists to explain.
    const image = await openSvgFile('i.svg', '<image href="https://cdn.example/t.png"/>');
    expect(image.openHasRemoteRefs).toBe(true);

    const xlink = await openSvgFile('x.svg', '<use xlink:href="https://cdn.example/i.svg"/>');
    expect(xlink.openHasRemoteRefs).toBe(true);

    // An `<a>` is a citation, the same line the HTML cases draw.
    const link = await openSvgFile('l.svg', '<a href="https://example.com/"><text>docs</text></a>');
    expect(link.openHasRemoteRefs).toBe(false);
  });

  it('says scripts are not run when the SVG carries any', async () => {
    // SVG rendered as a document (not through <img>) can carry executable
    // script; the frame refuses it, and the toolbar is what says so.
    const files = await openSvgFile('busy.svg', '<svg><script>alert(1)</script></svg>');
    expect(files.openHasScripts).toBe(true);
  });

  it('refuses an oversized SVG without transferring it', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: MAX_TEXT_BYTES + 1 });
    const files = useFilesStore();
    await files.open(CONN, '/home/u/art');

    await files.openFile(CONN, 'huge.svg');

    expect(files.openMode).toBe('binary');
    expect(readBinary).not.toHaveBeenCalled();
    expect(openSvg).not.toHaveBeenCalled();
  });
});
