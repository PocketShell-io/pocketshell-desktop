// @vitest-environment jsdom
//
// The suite's default is `node` and this file used to take it, because a store
// is state rather than DOM. Markdown changed that: minting a preview resolves
// the app's design tokens out of `getComputedStyle(document.documentElement)`
// — the only way a palette can reach a frame that the cascade does not enter —
// and under `node` that call throws, `mintPreview` catches it, and the whole
// feature is silently off with nothing pointing at the cause. A DOM here is
// cheaper than a store that has to pretend it might not have one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The Files tab's opening behaviour.
 *
 * The rule these pin is "open where the session is running, not where the user
 * logs in". Two things used to break it, and both are state rules rather than
 * layout ones, so they are driven through the store:
 *
 *  - a session cwd that tmux reports as a literal, unexpanded `~/git/...`,
 *    which an SFTP channel cannot resolve because it has no shell to expand
 *    the tilde;
 *  - a resolve that rejects, which escaped `open()` entirely and left `cwd`
 *    empty — and since `refresh()` early-returns on an empty cwd, nothing ever
 *    populated `entries` OR set `error`. The pane rendered an empty directory
 *    and said nothing, which reads as "the session's folder is empty" rather
 *    than "we never got there".
 */

const realPath = vi.fn<(connectionId: string, path: string) => Promise<string>>();
const list = vi.fn<(connectionId: string, path: string) => Promise<unknown[]>>();
const stat =
  vi.fn<(connectionId: string, path: string) => Promise<{ size: number; type?: string }>>();
const readBinary =
  vi.fn<(connectionId: string, path: string, maxBytes?: number) => Promise<Uint8Array>>();
const readFile = vi.fn<(connectionId: string, path: string) => Promise<string>>();
const writeFile =
  vi.fn<(connectionId: string, path: string, content: string) => Promise<boolean>>();
const saveAs =
  vi.fn<(opts: { connectionId: string; remotePath: string }) => Promise<string | null>>();
const openHtml =
  vi.fn<(connectionId: string, path: string) => Promise<{ token: string; url: string }>>();
const openMarkdown =
  vi.fn<
    (
      connectionId: string,
      path: string,
      style: { palette: Record<string, string>; appearance: string },
    ) => Promise<{ token: string; url: string }>
  >();
const openSvg =
  vi.fn<(connectionId: string, path: string) => Promise<{ token: string; url: string }>>();
const releasePreview = vi.fn<(token: string) => void>();
/** The store's own stats subscriber, captured so a test can push counts at it. */
let statsListener: ((stats: {
  token: string;
  loaded: number;
  blocked: number;
  missing: number;
  capped: boolean;
}) => void) | null = null;

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    sftp: {
      realPath: (connectionId: string, path: string) => realPath(connectionId, path),
      list: (connectionId: string, path: string) => list(connectionId, path),
      stat: (connectionId: string, path: string) => stat(connectionId, path),
      readBinary: (connectionId: string, path: string, maxBytes?: number) =>
        readBinary(connectionId, path, maxBytes),
      readFile: (connectionId: string, path: string) => readFile(connectionId, path),
      writeFile: (connectionId: string, path: string, content: string) =>
        writeFile(connectionId, path, content),
      saveAs: (opts: { connectionId: string; remotePath: string }) => saveAs(opts),
    },
    preview: {
      openHtml: (connectionId: string, path: string) => openHtml(connectionId, path),
      openMarkdown: (
        connectionId: string,
        path: string,
        style: { palette: Record<string, string>; appearance: string },
      ) => openMarkdown(connectionId, path, style),
      openSvg: (connectionId: string, path: string) => openSvg(connectionId, path),
      release: (token: string) => releasePreview(token),
      onStats: (handler: (stats: never) => void) => {
        statsListener = handler as typeof statsListener;
        return () => {
          statsListener = null;
        };
      },
    },
  },
}));

// jsdom does not implement object URLs; the store only ever mints and revokes
// them, so a counter is enough to assert it does not leak one per click.
const created: string[] = [];
const revoked: string[] = [];
globalThis.URL.createObjectURL = (): string => {
  const url = `blob:mock/${created.length}`;
  created.push(url);
  return url;
};
globalThis.URL.revokeObjectURL = (url: string): void => {
  revoked.push(url);
};

const { useFilesStore, stripTilde, resolveRemotePath, normaliseTypedPath, MAX_TEXT_BYTES } =
  await import('../../src/renderer/stores/files');

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  realPath.mockReset();
  list.mockReset();
  stat.mockReset();
  readBinary.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  saveAs.mockReset();
  openHtml.mockReset();
  openMarkdown.mockReset();
  openSvg.mockReset();
  releasePreview.mockReset();
  list.mockResolvedValue([]);
  writeFile.mockResolvedValue(true);
  // A fresh token per call: main mints one per preview, and a test that could
  // not tell two apart could not tell whether a save re-minted at all. All
  // three verbs share the counter so a test can assert which one was reached.
  let minted = 0;
  openHtml.mockImplementation((_c, path) =>
    Promise.resolve({ token: `tok${++minted}`, url: `psview://tok${path}` }),
  );
  openMarkdown.mockImplementation((_c, path) =>
    Promise.resolve({ token: `md${++minted}`, url: `psview://md${path}` }),
  );
  openSvg.mockImplementation((_c, path) =>
    Promise.resolve({ token: `svg${++minted}`, url: `psview://svg${path}` }),
  );
  created.length = 0;
  revoked.length = 0;
});

describe('stripTilde', () => {
  it('drops a leading ~/ so the path resolves relative to the login home', () => {
    // An SFTP session's relative root IS the home directory, so this reaches
    // the same place `~/git` names without costing a lookup to expand it.
    expect(stripTilde('~/git/pocketshell')).toBe('git/pocketshell');
  });

  it('maps a bare ~ and an empty path to the home directory', () => {
    expect(stripTilde('~')).toBe('.');
    expect(stripTilde('~/')).toBe('.');
    expect(stripTilde(undefined)).toBe('.');
    expect(stripTilde('')).toBe('.');
  });

  it('passes absolute paths through untouched', () => {
    expect(stripTilde('/home/alexey/git')).toBe('/home/alexey/git');
  });

  it("leaves another user's ~home alone rather than resolving it wrongly", () => {
    // `~other/x` is not our home; resolving it relatively would silently open
    // the wrong directory, and failing honestly is better than that.
    expect(stripTilde('~other/x')).toBe('~other/x');
  });
});

describe('files store open()', () => {
  it('opens the session directory, not the home directory', async () => {
    realPath.mockResolvedValue('/home/alexey/git/pocketshell');
    const files = useFilesStore();

    await files.open(CONN, '/home/alexey/git/pocketshell');

    expect(realPath).toHaveBeenCalledWith(CONN, '/home/alexey/git/pocketshell');
    expect(files.cwd).toBe('/home/alexey/git/pocketshell');
    expect(files.error).toBeNull();
  });

  it('resolves a tilde session cwd instead of failing on it', async () => {
    realPath.mockResolvedValue('/home/alexey/git');
    const files = useFilesStore();

    await files.open(CONN, '~/git');

    // The tilde never reaches SFTP.
    expect(realPath).toHaveBeenCalledWith(CONN, 'git');
    expect(files.cwd).toBe('/home/alexey/git');
    expect(files.error).toBeNull();
  });

  it('falls back to home AND says why when the session cwd will not resolve', async () => {
    realPath.mockRejectedValueOnce(new Error('No such file')).mockResolvedValueOnce('/home/alexey');
    const files = useFilesStore();

    await files.open(CONN, '/gone');

    expect(files.cwd).toBe('/home/alexey');
    // The note survives `refresh()`, which clears `error` on entry.
    expect(files.error).toContain('/gone');
    expect(files.error).toContain('No such file');
  });

  it('reports the failure rather than rendering a silent empty directory', async () => {
    realPath.mockRejectedValue(new Error('Channel closed'));
    const files = useFilesStore();

    await files.open(CONN, '~/git');

    expect(files.cwd).toBe('');
    expect(files.entries).toEqual([]);
    expect(files.error).toBe('Channel closed');
  });
});

/**
 * A folder click that the host refuses.
 *
 * `cd` used to let the realPath rejection escape, and nothing between the
 * tree and the window caught it — so a dead folder row surfaced as the global
 * diagnostics toast, raw IPC phrasing ("Error invoking remote method
 * 'sftp:realPath'") and all, while the tree itself looked untouched. Two
 * things are pinned here: the failure is a LISTING fact and lands in the
 * tree's footer channel with the path named; and a failed click re-lists
 * where the pane stands, because the ordinary cause is a readdir gone stale —
 * the row was rendered from a listing that has since stopped being true on
 * the host.
 */
describe('files store cd() failures', () => {
  const openAt = async (cwd: string, deadRow: string) => {
    realPath.mockImplementation((_c, p) =>
      p === `${cwd}/${deadRow}` ? Promise.reject(new Error('No such file')) : Promise.resolve(p),
    );
    list.mockResolvedValue([{ name: deadRow, type: 'dir' }]);
    const files = useFilesStore();
    await files.open(CONN, cwd);
    return files;
  };

  it('reports a dead row in the tree footer and stays where it was', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');

    await files.cd(CONN, 'faq-opik');

    expect(files.cwd).toBe('/home/u/git');
    expect(files.error).toContain('/home/u/git/faq-opik');
    expect(files.error).toContain('No such file');
  });

  it('re-lists the current directory, which is what retires the stale row', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');
    list.mockClear();

    await files.cd(CONN, 'faq-opik');

    // The failed click cost one readdir of where we still are — the refresh
    // that replaces the row the click came from.
    expect(list).toHaveBeenCalledWith(CONN, '/home/u/git');
  });

  it('lets the refresh speak when the directory itself is gone too', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');
    list.mockRejectedValue(new Error('No such file'));

    await files.cd(CONN, 'faq-opik');

    // cwd stopped existing between the listing and the click: the refresh's
    // verdict is the more immediate one, and stacking the cd's message on top
    // of it would be noise.
    expect(files.error).toBe('No such file');
  });

  it('still navigates past one failure', async () => {
    const files = await openAt('/home/u/git', 'faq-opik');
    await files.cd(CONN, 'faq-opik');
    expect(files.error).not.toBeNull();

    await files.cd(CONN, 'other');

    expect(files.cwd).toBe('/home/u/git/other');
    expect(files.error).toBeNull();
  });
});

/**
 * Leaving the Files tab must not cost the user their place.
 *
 * The tab is behind a `v-if`, so switching to Terminal unmounts the view.
 * That unmount used to call `clear()`, which reset `cwd` — so coming back
 * re-ran `open()` and dropped the user at the session's start directory (or,
 * while the session cwd was missing, at the login home) no matter how deep
 * they had navigated. The position is now remembered per connection AND per
 * session, which is what stops one session's directory becoming another's.
 */
describe('files store remembers where each session was left', () => {
  it('returns to the directory the user navigated to, not the start path', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p === 'git/app' ? '/home/u/git/app' : p));
    const files = useFilesStore();

    await files.open(CONN, '~/git/app');
    await files.cd(CONN, '/home/u/git/app/src/deep');
    expect(files.cwd).toBe('/home/u/git/app/src/deep');

    // Terminal tab -> Files tab: the view unmounts and re-mounts, so `open`
    // runs again with the same start path.
    await files.open(CONN, '~/git/app');

    expect(files.cwd).toBe('/home/u/git/app/src/deep');
  });

  it('is NOT pinned to a home it merely fell back to', async () => {
    // The reported bug: "we should always open the files for that specific
    // folder and not in ~".
    //
    // A workspace whose session has no working directory yet opens its Files
    // tab with no start path, so the store resolves `.` and lands at the login
    // home. That is correct at the time. What was not correct is that the
    // landing was recorded as this tab's remembered position — under a key that
    // is the TAB ID and therefore never changes — so when the session's real
    // directory arrived and `FilesView` re-opened with it, the remembered home
    // outranked it and the tab stayed at `~` for good.
    //
    // The tab id is passed explicitly here because that is what the real caller
    // passes; keying on the start path (as an earlier version of this file did)
    // hides the bug by changing the key exactly when the path is recovered.
    realPath.mockImplementation((_c: unknown, p: string) =>
      Promise.resolve(p === '.' ? '/home/u' : `/home/u/${p}`),
    );
    const files = useFilesStore();
    const tab = '~/git/red-stamp::files:1';

    await files.open(CONN, undefined, tab);
    expect(files.cwd).toBe('/home/u');

    // The probe recovers the session's directory and the view re-opens.
    await files.open(CONN, '~/git/red-stamp', tab);

    expect(files.cwd).toBe('/home/u/git/red-stamp');
  });

  it('still prefers a directory the user actually navigated to', async () => {
    // The other half of the same rule: a REAL choice must still outrank the
    // start path, or the fix above would undo the memory this file exists for.
    realPath.mockImplementation((_c: unknown, p: string) =>
      Promise.resolve(p === '.' ? '/home/u' : p.startsWith('/') ? p : `/home/u/${p}`),
    );
    const files = useFilesStore();
    const tab = '~/git/red-stamp::files:1';

    await files.open(CONN, undefined, tab);
    await files.cd(CONN, '/home/u/notes');
    expect(files.cwd).toBe('/home/u/notes');

    await files.open(CONN, '~/git/red-stamp', tab);

    expect(files.cwd).toBe('/home/u/notes');
  });

  it('does not leak one session\u2019s directory into another\u2019s', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.cd(CONN, '/home/u/git/app/src');

    // A different session, with its own working directory.
    await files.open(CONN, '/home/u/git/other');
    expect(files.cwd).toBe('/home/u/git/other');

    // ...and going back to the first still lands where it was left.
    await files.open(CONN, '/home/u/git/app');
    expect(files.cwd).toBe('/home/u/git/app/src');
  });

  it('uses a newly recovered session path on the first visit after the fix', async () => {
    // Before the cwd bug was fixed this session had `path: null`, so the tab
    // opened at the login home. Once tmux's answer comes through, the FIRST
    // visit must honour it rather than a home remembered from before.
    realPath.mockImplementation((_c, p) => Promise.resolve(p === '.' ? '/home/u' : p));
    const files = useFilesStore();

    await files.open(CONN, undefined);
    expect(files.cwd).toBe('/home/u');

    await files.open(CONN, '/home/u/git/red-stamp-sound');

    expect(files.cwd).toBe('/home/u/git/red-stamp-sound');
  });

  it('keeps an unsaved edit across a tab switch instead of discarding it', async () => {
    // A clean buffer is a cache and is cheap to rebuild; an unsaved edit
    // exists nowhere else, so throwing it away silently would be worse than
    // the bug this whole mechanism fixes.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 12 });
    readBinary.mockResolvedValue(new TextEncoder().encode('hello world\n'));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.openFile(CONN, 'notes.md');
    files.setContent('edited, not saved');

    await files.open(CONN, '/home/u/git/other');
    expect(files.openPath).toBeNull();

    await files.open(CONN, '/home/u/git/app');
    expect(files.openContent).toBe('edited, not saved');
    expect(files.dirty).toBe(true);
  });

  it('forgets a connection on disconnect, which is what clear() is for', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();

    await files.open(CONN, '/home/u/git/app');
    await files.cd(CONN, '/home/u/git/app/src');
    files.clear(CONN);

    expect(files.cwd).toBe('');
    await files.open(CONN, '/home/u/git/app');
    expect(files.cwd).toBe('/home/u/git/app');
  });
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

/**
 * Resolving a path that was PRINTED, not browsed to.
 *
 * The rule here is the one the Files tab already fought for once: a session's
 * relative path is relative to where that SESSION runs, which is neither the
 * login home nor wherever this tab happens to be pointing. The second half is
 * that the session's own cwd can be an unexpanded `~/git/foo`, so the base has
 * to go through the same `stripTilde` the tab's own opening does.
 */
describe('resolveRemotePath', () => {
  it('joins a relative path onto the session cwd, not the login home', () => {
    expect(resolveRemotePath('tmp/a.mp3', '/home/alexey/git/foo')).toBe(
      '/home/alexey/git/foo/tmp/a.mp3',
    );
  });

  it('strips a tilde session cwd so the join stays SFTP-resolvable', () => {
    // `~/git/foo` + `tmp/a.mp3` must not become a directory literally named `~`.
    expect(resolveRemotePath('tmp/a.mp3', '~/git/foo')).toBe('git/foo/tmp/a.mp3');
  });

  it('leaves an absolute path exactly as printed', () => {
    expect(resolveRemotePath('/srv/media/a.mp3', '/home/alexey')).toBe('/srv/media/a.mp3');
  });

  it('anchors a tilde path on the home, ignoring the session cwd', () => {
    expect(resolveRemotePath('~/notes.md', '/home/alexey/git/foo')).toBe('notes.md');
  });

  it('falls back to home-relative when the session reported no path', () => {
    // Same fallback `open()` makes for the same missing fact.
    expect(resolveRemotePath('tmp/a.mp3', null)).toBe('tmp/a.mp3');
    expect(resolveRemotePath('tmp/a.mp3', undefined)).toBe('tmp/a.mp3');
  });

  it('drops a leading ./ rather than embedding it in the join', () => {
    expect(resolveRemotePath('./tmp/a.mp3', '/home/alexey')).toBe('/home/alexey/tmp/a.mp3');
  });

  it('leaves .. for the remote realpath to fold', () => {
    // Folding it here would mean guessing about symlinks only the host knows.
    expect(resolveRemotePath('../b.txt', '/home/alexey/git')).toBe('/home/alexey/git/../b.txt');
  });
});

describe('files store reveal', () => {
  it('parks the resolved path for the Files tab to take exactly once', () => {
    const files = useFilesStore();

    files.requestReveal('tmp/a.mp3', '~/git/foo');

    expect(files.reveal).toBe('git/foo/tmp/a.mp3');
    expect(files.takeReveal()).toBe('git/foo/tmp/a.mp3');
    expect(files.reveal).toBeNull();
    expect(files.takeReveal()).toBeNull();
  });

  it('opens a file and moves the listing to its directory', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 3, type: 'file' });
    readBinary.mockResolvedValue(new Uint8Array([0x49, 0x44, 0x33]));
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey/git/foo');

    await files.revealPath(CONN, '/home/alexey/git/foo/tmp/a.mp3');

    expect(files.cwd).toBe('/home/alexey/git/foo/tmp');
    expect(files.openPath).toBe('/home/alexey/git/foo/tmp/a.mp3');
    expect(files.openMode).toBe('audio');
    expect(files.error).toBeNull();
  });

  it('enters a directory rather than trying to open it as a file', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 0, type: 'dir' });
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');

    await files.revealPath(CONN, '/home/alexey/git');

    expect(files.cwd).toBe('/home/alexey/git');
    expect(files.openPath).toBeNull();
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('says so when the optimistically-linked path does not exist', async () => {
    // Terminal output is linkified without ever being stat'ed, so a dead link
    // is a NORMAL outcome and has to arrive as a message rather than silence.
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockRejectedValue(new Error('No such file'));
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');
    const before = files.cwd;

    await files.revealPath(CONN, '/home/alexey/gone.mp3');

    expect(files.error).toContain('gone.mp3');
    expect(files.error).toContain('No such file');
    // And the user is left where they were, not somewhere half-navigated.
    expect(files.cwd).toBe(before);
    expect(files.openPath).toBeNull();
  });

  it('reports a path that will not even resolve', async () => {
    realPath.mockImplementation((_c, p) =>
      p === '/home/alexey' ? Promise.resolve(p) : Promise.reject(new Error('Permission denied')),
    );
    const files = useFilesStore();
    await files.open(CONN, '/home/alexey');

    await files.revealPath(CONN, '/root/secret.txt');

    expect(files.error).toContain('/root/secret.txt');
    expect(files.error).toContain('Permission denied');
  });
});

/**
 * What the path bar accepts.
 *
 * The cleanup in front of the resolver exists because of how paths reach a
 * clipboard, not because of anything about paths themselves: a shell quotes
 * what it had to quote, and a log or a chat message brings whitespace with it.
 * Refusing either would be a needless "invalid path" for something perfectly
 * unambiguous.
 */
describe('normaliseTypedPath', () => {
  it('takes an absolute path as typed', () => {
    expect(normaliseTypedPath('/tmp/olya-v3tts.mp3', '/home/alexey')).toBe('/tmp/olya-v3tts.mp3');
  });

  it('never joins an absolute path onto the browsed directory', () => {
    // The classic bug in this shape of code: `/home/alexey//tmp/x.mp3`.
    expect(normaliseTypedPath('/tmp/x.mp3', '/home/alexey/git/foo')).toBe('/tmp/x.mp3');
    expect(normaliseTypedPath('/', '/home/alexey/git/foo')).toBe('/');
  });

  it('resolves a tilde path against the login home, not the browsed directory', () => {
    expect(normaliseTypedPath('~/git/foo', '/srv/media')).toBe('git/foo');
    expect(normaliseTypedPath('~', '/srv/media')).toBe('.');
  });

  it('resolves a bare relative path against the directory on screen', () => {
    // The Files tab's base is where the USER is looking, which is what makes
    // typing `tmp/a.mp3` mean the same thing as clicking through to it.
    expect(normaliseTypedPath('tmp/a.mp3', '/home/alexey/git/foo')).toBe(
      '/home/alexey/git/foo/tmp/a.mp3',
    );
    expect(normaliseTypedPath('./tmp/a.mp3', '/home/alexey')).toBe('/home/alexey/tmp/a.mp3');
    expect(normaliseTypedPath('../sibling', '/home/alexey/git')).toBe('/home/alexey/git/../sibling');
  });

  it('trims whitespace from a pasted path', () => {
    expect(normaliseTypedPath('  /tmp/x.mp3  ', '/home/alexey')).toBe('/tmp/x.mp3');
    expect(normaliseTypedPath('\t/tmp/x.mp3\n', '/home/alexey')).toBe('/tmp/x.mp3');
  });

  it('strips the quotes a shell put around a path with a space in it', () => {
    expect(normaliseTypedPath("'/tmp/my file.mp3'", '/home/alexey')).toBe('/tmp/my file.mp3');
    expect(normaliseTypedPath('"/tmp/my file.mp3"', '/home/alexey')).toBe('/tmp/my file.mp3');
    expect(normaliseTypedPath('  "/tmp/x.mp3"  ', '/home/alexey')).toBe('/tmp/x.mp3');
  });

  it('keeps a space inside the path, unlike the terminal-output detector', () => {
    // The detector refuses these because a space in a LINE of output may or may
    // not end the path. In a field that is nothing but the path there is no
    // such ambiguity, so the space is just a character.
    expect(normaliseTypedPath('/tmp/my file.mp3', '/home/alexey')).toBe('/tmp/my file.mp3');
    expect(normaliseTypedPath('my file.mp3', '/home/alexey')).toBe('/home/alexey/my file.mp3');
  });

  it('leaves an unmatched or interior quote alone', () => {
    // A filename may legitimately contain one; only a matched surrounding pair
    // is shell quoting.
    expect(normaliseTypedPath(`/tmp/it's.mp3`, '/home/alexey')).toBe(`/tmp/it's.mp3`);
    // An unmatched leading quote stays a literal character, so the path is not
    // absolute and resolves relatively — and then fails honestly at stat time.
    // Guessing that the user meant `/tmp/x.mp3` would be the same class of
    // silent correction as opening a "nearest existing ancestor".
    expect(normaliseTypedPath(`"/tmp/x.mp3`, '/home/alexey')).toBe(`/home/alexey/"/tmp/x.mp3`);
  });

  it('returns null for an empty field, which is not an error', () => {
    expect(normaliseTypedPath('', '/home/alexey')).toBeNull();
    expect(normaliseTypedPath('   ', '/home/alexey')).toBeNull();
    expect(normaliseTypedPath('""', '/home/alexey')).toBeNull();
  });

  it('falls back to home-relative when nothing is browsed yet', () => {
    expect(normaliseTypedPath('tmp/a.mp3', '')).toBe('tmp/a.mp3');
  });
});

/**
 * The race guards.
 *
 * cwd/entries and openPath/openContent are single slots shared by every
 * navigation and every open. Two rapid actions used to race, and whichever
 * transfer resolved LAST won — file A's bytes under file B's path, or the
 * listing of a directory the pane had already left. The store now tickets each
 * pipeline (the same shape as the projects store's `browseRequest`), and a
 * superseded call commits nothing.
 *
 * Each test holds one transfer in flight on a manually-resolved promise,
 * completes a newer one, then lets the stale transfer land and pins that it
 * changed nothing.
 */
describe('files store race guards', () => {
  /** A promise the test resolves by hand, to park one store call in flight. */
  const parked = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('a slow openFile cannot paint its file over a newer one', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    stat.mockResolvedValue({ size: 16 });
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    const staleRead = parked<Uint8Array>();
    readBinary.mockImplementation((_c, path) =>
      path === '/home/u/site/a.txt'
        ? staleRead.promise
        : Promise.resolve(new TextEncoder().encode('B')),
    );

    const stale = files.openFile(CONN, 'a.txt');
    await files.openFile(CONN, 'b.txt');
    expect(files.openPath).toBe('/home/u/site/b.txt');
    expect(files.openContent).toBe('B');

    staleRead.resolve(new TextEncoder().encode('A'));
    await stale;
    expect(files.openPath).toBe('/home/u/site/b.txt');
    expect(files.openContent).toBe('B');
    // The stale open must not park or clear the spinner out from under the
    // current one.
    expect(files.opening).toBe(false);
  });

  it('a slow cd cannot move cwd after a newer navigation', async () => {
    const staleResolve = parked<string>();
    realPath.mockImplementation((_c, p) =>
      p === '/home/u/slow' ? staleResolve.promise : Promise.resolve(p),
    );
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    const stale = files.cd(CONN, '/home/u/slow');
    await files.cd(CONN, '/home/u/fast');
    expect(files.cwd).toBe('/home/u/fast');

    staleResolve.resolve('/home/u/slow');
    await stale;
    expect(files.cwd).toBe('/home/u/fast');
    expect(files.error).toBeNull();
  });

  it('a superseded refresh cannot overwrite the newer listing', async () => {
    realPath.mockImplementation((_c, p) => Promise.resolve(p));
    const files = useFilesStore();
    await files.open(CONN, '/home/u/site');

    const staleList = parked<unknown[]>();
    let call = 0;
    list.mockImplementation(() => {
      call += 1;
      return call === 1
        ? staleList.promise
        : Promise.resolve([{ name: 'fresh.txt', type: 'file' }]);
    });

    const stale = files.refresh(CONN);
    await files.refresh(CONN);
    expect(files.entries).toEqual([{ name: 'fresh.txt', type: 'file' }]);

    staleList.resolve([{ name: 'stale.txt', type: 'file' }]);
    await stale;
    expect(files.entries).toEqual([{ name: 'fresh.txt', type: 'file' }]);
    expect(files.loading).toBe(false);
  });
});
