import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The preview's request handler, driven exactly the way Electron drives it.
 *
 * previewPaths.test.ts covers the string arithmetic. What is left — and what
 * this file is for — is everything the arithmetic cannot see:
 *
 *  - the SYMLINK escape, which passes every textual check there is. A page can
 *    ship an `assets/` entry that is a link to `/etc`, and the only thing that
 *    can tell is the host's own `realpath`. That is the second half of the
 *    traversal defence and it lives here, not in the pure module.
 *  - revocation. A token is a live channel to a remote host, so "closed the
 *    file" has to mean "the frame cannot read any more", not "the frame is not
 *    on screen".
 *  - the budgets, which are the only bound on a document that decides for
 *    itself how many files this app fetches over the user's SSH connection.
 *  - the response headers, because the CSP is not decoration here: it is the
 *    thing that stops a previewed page reaching the network, and a refactor
 *    that dropped it would look completely fine.
 *
 * `protocol.handle` is stubbed to capture the handler, so every case below
 * goes through the same entry point Chromium uses, with a real `Request`.
 */

const handlers = new Map<string, (request: Request) => Promise<Response>>();

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (scheme: string, handler: (r: Request) => Promise<Response>) => {
      handlers.set(scheme, handler);
    },
  },
}));

const { HtmlPreviewService, MAX_REQUESTS } = await import(
  '../../src/main/preview/HtmlPreviewService'
);
const { PREVIEW_SCHEME } = await import('../../src/main/preview/previewPaths');
type SftpService = import('../../src/main/sftp/SftpService').SftpService;

/**
 * A remote filesystem: path -> bytes, plus a symlink table `realpath` follows.
 *
 * Deliberately models the two things that matter and nothing else. `realpath`
 * resolving links is the whole subject of half these tests, and `readBinary`
 * rejecting on a missing path is what the handler turns into a 404.
 */
function fakeSftp(opts: {
  files: Record<string, string>;
  links?: Record<string, string>;
  dirs?: string[];
}) {
  const links = opts.links ?? {};
  const dirs = new Set(opts.dirs ?? []);
  const resolve = (path: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (path === from) return to;
      if (path.startsWith(from + '/')) return to + path.slice(from.length);
    }
    return path;
  };
  return {
    realPath: vi.fn(async (_c: string, path: string) => {
      const real = resolve(path);
      if (real in opts.files || dirs.has(real)) return real;
      throw new Error(`No such file: ${path}`);
    }),
    stat: vi.fn(async (_c: string, path: string) => {
      const real = resolve(path);
      if (dirs.has(real)) return { type: 'dir' as const, size: 0, modifyTime: 0, accessTime: 0 };
      if (real in opts.files) {
        return {
          type: 'file' as const,
          size: opts.files[real]!.length,
          modifyTime: 0,
          accessTime: 0,
        };
      }
      throw new Error(`No such file: ${path}`);
    }),
    readBinary: vi.fn(async (_c: string, path: string) => {
      const real = resolve(path);
      const body = opts.files[real];
      if (body == null) throw new Error(`No such file: ${path}`);
      return Buffer.from(body, 'utf8');
    }),
  };
}

const SITE = {
  '/home/u/site/index.html': '<link rel="stylesheet" href="style.css"><h1>hi</h1>',
  '/home/u/site/style.css': 'body { background: rgb(0, 128, 255) }',
  '/home/u/site/img/dot.png': 'PNGDATA',
  '/home/u/other/secret.txt': 'not yours',
  '/etc/passwd': 'root:x:0:0',
  '/home/u/.ssh/id_ed25519': 'PRIVATE KEY',
};
const DIRS = ['/home/u/site', '/home/u/site/img', '/home/u/other', '/home/u', '/etc'];

/**
 * The fake stands in for the three SftpService methods the preview touches.
 * The cast is through `unknown` rather than a partial mock type so the fake
 * stays readable — widening it into the real class would mean stubbing a
 * dozen methods no preview will ever call.
 */
function makeService(sftp: ReturnType<typeof fakeSftp>): InstanceType<typeof HtmlPreviewService> {
  const service = new HtmlPreviewService(sftp as unknown as SftpService);
  service.install();
  return service;
}

const handle = (url: string): Promise<Response> => {
  const handler = handlers.get(PREVIEW_SCHEME);
  if (!handler) throw new Error('handler not installed');
  return handler(new Request(url));
};

beforeEach(() => {
  handlers.clear();
});

describe('HtmlPreviewService.open', () => {
  it('scopes the preview to the previewed file’s own directory', async () => {
    const sftp = fakeSftp({ files: SITE, dirs: DIRS });
    const service = makeService(sftp);

    const { url, token } = await service.open('c1', '/home/u/site/index.html');

    expect(url).toBe(`psview://${token}/home/u/site/index.html`);
    // The root is realpath'd rather than taken as spelled, so that a request
    // whose realpath lands in the physical directory compares equal to it.
    expect(sftp.realPath).toHaveBeenCalledWith('c1', '/home/u/site');
  });

  it('refuses to preview something that is not a regular file', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    await expect(service.open('c1', '/home/u/site')).rejects.toThrow(/Not a regular file/);
  });
});

describe('HtmlPreviewService request handling', () => {
  it('serves the document and the relative assets it names', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const { url } = await service.open('c1', '/home/u/site/index.html');

    const doc = await handle(url);
    expect(doc.status).toBe(200);
    expect(doc.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await doc.text()).toContain('<h1>hi</h1>');

    // This is the mechanism in one line: the browser joins `style.css` onto
    // the document URL and the join lands back here as a real path.
    const css = await handle(new URL('style.css', url).href);
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toContain('rgb(0, 128, 255)');

    // Nested, which is the case an inline-the-same-directory approach misses.
    const png = await handle(new URL('img/dot.png', url).href);
    expect(png.status).toBe(200);
    expect(png.headers.get('Content-Type')).toBe('image/png');
  });

  it('carries a policy that permits no network and no script, on every response', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const { url } = await service.open('c1', '/home/u/site/index.html');

    for (const target of [url, new URL('style.css', url).href, new URL('nope.css', url).href]) {
      const csp = (await handle(target)).headers.get('Content-Security-Policy') ?? '';
      expect(csp, target).toContain("default-src 'none'");
      expect(csp, target).toContain("script-src 'none'");
      expect(csp, target).toContain("connect-src 'none'");
      expect(csp, target).toContain("form-action 'none'");
      // A `<base href="https://evil/">` would re-point every relative URL in
      // the document off this scheme, undoing the policy from inside it.
      expect(csp, target).toContain("base-uri 'none'");
      expect(csp, target).toContain('sandbox');
      // No directive may name a remote scheme. This is the assertion that
      // fails if someone "fixes" a page by allowing its CDN.
      expect(csp, target).not.toMatch(/https?:/);
    }
  });

  it('refuses an absolute path the page asserted, and says nothing about it', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const { token } = await service.open('c1', '/home/u/site/index.html');

    for (const path of ['/etc/passwd', '/home/u/.ssh/id_ed25519', '/home/u/other/secret.txt']) {
      const res = await handle(`psview://${token}${path}`);
      expect(res.status, path).toBe(403);
      expect(await res.text()).not.toContain('root:x');
    }
  });

  it('refuses a symlink that walks out of the root, which no string check can see', async () => {
    // The page ships `assets` as a link to /etc. Every textual check passes:
    // the requested path really is inside the root.
    const sftp = fakeSftp({
      files: SITE,
      dirs: DIRS,
      links: { '/home/u/site/assets': '/etc' },
    });
    const service = makeService(sftp);
    const { url } = await service.open('c1', '/home/u/site/index.html');

    const res = await handle(new URL('assets/passwd', url).href);

    expect(res.status).toBe(403);
    // And crucially: the bytes were never read. The refusal happens on the
    // realpath, before readBinary is reached.
    expect(sftp.readBinary).not.toHaveBeenCalledWith('c1', '/etc/passwd', expect.anything());
  });

  it('allows a symlink that stays inside the root', async () => {
    // The check is about WHERE a link points, not that links are suspicious.
    const sftp = fakeSftp({
      files: SITE,
      dirs: DIRS,
      links: { '/home/u/site/theme.css': '/home/u/site/style.css' },
    });
    const service = makeService(sftp);
    const { url } = await service.open('c1', '/home/u/site/index.html');

    const res = await handle(new URL('theme.css', url).href);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('rgb(0, 128, 255)');
  });

  it('404s an unknown token, so a released preview is really revoked', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const { url, token } = await service.open('c1', '/home/u/site/index.html');
    expect((await handle(url)).status).toBe(200);

    service.release(token);

    // Not 403: the refusal must not distinguish "wrong token" from "token you
    // are allowed to use but a path you are not", and it must say nothing at
    // all about whether the file exists.
    expect((await handle(url)).status).toBe(404);
  });

  it('drops every preview belonging to a connection that went away', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const mine = await service.open('c1', '/home/u/site/index.html');
    const theirs = await service.open('c2', '/home/u/site/index.html');

    service.evict('c1');

    expect((await handle(mine.url)).status).toBe(404);
    expect((await handle(theirs.url)).status).toBe(200);
  });

  it('refuses anything but a read', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const { url } = await service.open('c1', '/home/u/site/index.html');
    const handler = handlers.get(PREVIEW_SCHEME)!;

    const res = await handler(new Request(url, { method: 'POST' }));

    expect(res.status).toBe(405);
  });

  it('caps how many files one document can make the app fetch', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const { url } = await service.open('c1', '/home/u/site/index.html');

    for (let i = 0; i < MAX_REQUESTS; i++) await handle(new URL('style.css', url).href);
    const res = await handle(new URL('style.css', url).href);

    expect(res.status).toBe(429);
  });

  it('reports what it loaded, blocked and could not find', async () => {
    const service = makeService(fakeSftp({ files: SITE, dirs: DIRS }));
    const seen: { loaded: number; blocked: number; missing: number }[] = [];
    service.setStatsListener((s) =>
      seen.push({ loaded: s.loaded, blocked: s.blocked, missing: s.missing }),
    );
    const { url, token } = await service.open('c1', '/home/u/site/index.html');

    await handle(url); // the document itself is not counted as an asset
    await handle(new URL('style.css', url).href);
    await handle(new URL('img/dot.png', url).href);
    await handle(`psview://${token}/etc/passwd`);
    await handle(new URL('missing.css', url).href);

    const last = seen.at(-1);
    // These four numbers are the whole difference between an honest degraded
    // render and a page that silently looks broken.
    expect(last).toEqual({ loaded: 2, blocked: 1, missing: 1 });
  });

  it('labels an unknown extension opaquely rather than promoting it to HTML', async () => {
    const service = makeService(
      fakeSftp({ files: { ...SITE, '/home/u/site/thing.qqq': '<h1>x</h1>' }, dirs: DIRS }),
    );
    const { url } = await service.open('c1', '/home/u/site/index.html');

    const res = await handle(new URL('thing.qqq', url).href);

    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

/**
 * Markdown, through the SAME pipeline.
 *
 * The point of these cases is what they do NOT have to re-establish. Traversal,
 * symlinks, revocation, budgets, the CSP — all of it is the machinery above,
 * unchanged, and converting in main rather than in the renderer is what makes
 * that true. What is genuinely new is only:
 *
 *   - the entry document arrives as HTML rather than as its source bytes;
 *   - so does every OTHER `.md` inside the root, which is what makes a relative
 *     link between two documents work;
 *   - and none of that happens under an HTML preview, where a `.md` is a file
 *     the page referenced rather than a document the user chose to read.
 */
const DOCS = {
  '/home/u/docs/README.md': '# Title\n\nSee [design](DESIGN.md) and ![shot](img/shot.png).\n',
  '/home/u/docs/DESIGN.md': '## The design\n',
  '/home/u/docs/img/shot.png': 'PNGDATA',
  '/home/u/docs/notes.txt': 'plain',
  '/home/u/other/secret.md': '# not yours',
  '/etc/passwd': 'root:x:0:0',
};
const DOC_DIRS = ['/home/u/docs', '/home/u/docs/img', '/home/u/other', '/home/u', '/etc'];

const PALETTE = { '--bg': '#101010', '--fg': '#f0f0f0' };

describe('HtmlPreviewService.openMarkdown', () => {
  it('serves the document as rendered HTML, not as its source', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { url } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'dark',
    });

    const res = await handle(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<h1 id="title">Title</h1>');
    // The source markers must be gone — a preview showing `# Title` would mean
    // the conversion silently did not happen.
    expect(html).not.toContain('# Title');
  });

  it('paints the document in the palette it was minted with', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { url } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'light',
    });

    const html = await (await handle(url)).text();

    expect(html).toContain('--bg:#101010;');
    expect(html).toContain('color-scheme:light;');
  });

  it('refuses a palette value that would escape the style block', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { url } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: { '--bg': 'red</style><script>fetch("https://evil")</script>' },
      appearance: 'dark',
    });

    const html = await (await handle(url)).text();

    expect(html).not.toContain('</style><script>');
    expect(html).toContain('--bg:Canvas;');
  });

  /**
   * The rule that makes a folder of docs browsable: a relative link between two
   * markdown files navigates, because the linked file is rendered too. Without
   * it, `[design](DESIGN.md)` would hand the frame a `text/markdown` response
   * and dead-end.
   */
  it('renders every markdown file the frame navigates to, not only the entry', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { url } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'dark',
    });

    const res = await handle(new URL('DESIGN.md', url).href);

    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<h2 id="the-design">The design</h2>');
  });

  /**
   * A markdown preview answers for the HOST, not one folder — that is what
   * makes `[../README](../README.md)` and absolute links between docs open
   * instead of dead-ending on "Outside the previewed folder". The bound is
   * still the SSH account: a path that account cannot read 404s exactly as an
   * in-folder miss does.
   */
  it('renders a markdown file outside the entry folder, and misses like any read', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { token } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'dark',
    });

    const other = await handle(`psview://${token}/home/u/other/secret.md`);
    expect(other.status).toBe(200);
    expect(other.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await other.text()).toContain('<h1 id="not-yours">not yours</h1>');

    // An absolute image a `../` climb names loads as an asset like any other.
    const png = await handle(`psview://${token}/home/u/docs/img/shot.png`);
    expect(png.status).toBe(200);

    // The host bound: nothing may be read that the account itself cannot.
    const missing = await handle(`psview://${token}/root/nope.md`);
    expect(missing.status).toBe(404);
  });

  it('leaves the assets a rendered document names exactly as they were', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { url } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'dark',
    });

    // A relative image in a README resolves exactly as one in a real page does
    // — which is the entire reuse argument, in one assertion.
    const png = await handle(new URL('img/shot.png', url).href);
    expect(png.status).toBe(200);
    expect(png.headers.get('Content-Type')).toBe('image/png');

    const txt = await handle(new URL('notes.txt', url).href);
    expect(txt.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await txt.text()).toBe('plain');
  });

  it('carries the same no-network, no-script policy the HTML preview does', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const { url } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'dark',
    });

    const csp = (await handle(url)).headers.get('Content-Security-Policy') ?? '';

    // The whole reason raw HTML may be passed through by the converter. If this
    // assertion is ever relaxed, markdownDocument.ts's decision has to be
    // revisited with it — the two are one argument.
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toMatch(/https?:/);
  });

  it('does not render markdown that an HTML page merely referenced', async () => {
    // An ordinary HTML preview in the same folder as the docs.
    const page = { ...DOCS, '/home/u/docs/index.html': '<h1>page</h1>' };
    const html = makeService(fakeSftp({ files: page, dirs: DOC_DIRS }));
    const { url } = await html.open('c1', '/home/u/docs/index.html');

    const res = await handle(new URL('README.md', url).href);

    // Mode is a property of the PREVIEW: the user opened a page, not a
    // document, so a `.md` it names is a file rather than something to render.
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toContain('# Title');
  });

  it('counts a rendered sub-document as a loaded asset like any other', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    const seen: { loaded: number; blocked: number }[] = [];
    service.setStatsListener((s) => seen.push({ loaded: s.loaded, blocked: s.blocked }));
    const { url, token } = await service.openMarkdown('c1', '/home/u/docs/README.md', {
      palette: PALETTE,
      appearance: 'dark',
    });

    await handle(url);
    await handle(new URL('img/shot.png', url).href);
    // A host-wide root means this absolute path LOADS rather than blocks;
    // what still counts as blocked is a request that cannot even be folded
    // into a path (`%2e%2e` escaping above `/`).
    await handle(`psview://${token}/etc/passwd`);
    await handle(`psview://${token}/%2e%2e%2fetc`);

    expect(seen.at(-1)).toEqual({ loaded: 2, blocked: 1 });
  });

  it('refuses to preview a directory, exactly as the HTML verb does', async () => {
    const service = makeService(fakeSftp({ files: DOCS, dirs: DOC_DIRS }));
    await expect(
      service.openMarkdown('c1', '/home/u/docs', { palette: PALETTE, appearance: 'dark' }),
    ).rejects.toThrow(/Not a regular file/);
  });
});


/**
 * SVG: the third input format, and the one that needs nothing done to it.
 *
 * The assertions that matter are the two that would make serving an SVG
 * dangerous if either broke: it is served at its OWN content type (a drawing,
 * not a page), and it is served under the same response policy as a page —
 * because an SVG rendered as a document can carry `<script>` and remote
 * references, and the CSP plus sandbox are the only things standing between
 * those and the renderer process.
 */
describe('HtmlPreviewService.openSvg', () => {
  const ART = {
    ...SITE,
    '/home/u/art/logo.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
    '/home/u/art/texture.png': 'PNGDATA',
  };
  const ART_DIRS = ['/home/u/art', '/home/u', '/etc'];

  it('serves the bytes untouched, as an SVG document', async () => {
    const service = makeService(fakeSftp({ files: ART, dirs: ART_DIRS }));
    const { url } = await service.openSvg('c1', '/home/u/art/logo.svg');

    const res = await handle(url);

    expect(res.status).toBe(200);
    // Not `text/html`: the frame must render a drawing, and the charset must
    // travel for the same reason it travels on a page.
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(await res.text()).toContain('<rect width="16" height="16"/>');
  });

  it('carries the same no-network, no-script policy the page preview does', async () => {
    // The assertion that makes "it is only a logo" fail as an argument: an
    // SVG document can carry `<script>`, and the response policy is what
    // refuses it — not the file extension.
    const service = makeService(fakeSftp({ files: ART, dirs: ART_DIRS }));
    const { url } = await service.openSvg('c1', '/home/u/art/logo.svg');

    const csp = (await handle(url)).headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toMatch(/https?:/);
  });

  it('resolves the assets the drawing names inside its folder', async () => {
    // A texture or an external sprite sheet referenced relatively is the case
    // that kills the blob-URL alternative: a blob has no path to resolve
    // against, so `<image href="texture.png">` would silently not paint.
    const service = makeService(fakeSftp({ files: ART, dirs: ART_DIRS }));
    const { url } = await service.openSvg('c1', '/home/u/art/logo.svg');

    const png = await handle(new URL('texture.png', url).href);

    expect(png.status).toBe(200);
    expect(png.headers.get('Content-Type')).toBe('image/png');
  });
});
