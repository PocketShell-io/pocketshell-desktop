import { vi } from 'vitest';

/**
 * The Files store's ipc double, shared by the filesStore*.test.ts files split
 * along the store's own seams (browsing, the open-file pipeline, pure path
 * helpers).
 *
 * `src/renderer/ipc` reads `window.api` at module scope, so every file that
 * imports the store module has to mock it — under `node` too, where `window`
 * does not exist at all. Each test file registers the mock with a factory
 * that pulls `api` from here; the fns live here so the assertions and the
 * reset share one home.
 *
 * The object-URL stub lives here as well: jsdom does not implement object
 * URLs, and the store only ever mints and revokes them, so a counter is
 * enough to assert it does not leak one per click. Assigning the two methods
 * is inert under `node`, where nothing mints.
 */

export const realPath = vi.fn<(connectionId: string, path: string) => Promise<string>>();
export const list = vi.fn<(connectionId: string, path: string) => Promise<unknown[]>>();
export const stat =
  vi.fn<(connectionId: string, path: string) => Promise<{ size: number; type?: string }>>();
export const readBinary =
  vi.fn<(connectionId: string, path: string, maxBytes?: number) => Promise<Uint8Array>>();
export const readFile = vi.fn<(connectionId: string, path: string) => Promise<string>>();
export const writeFile =
  vi.fn<(connectionId: string, path: string, content: string) => Promise<boolean>>();
export const createFile =
  vi.fn<(connectionId: string, path: string, content?: string) => Promise<boolean>>();
export const mkdir = vi.fn<(connectionId: string, path: string) => Promise<boolean>>();
export const saveAs =
  vi.fn<(opts: { connectionId: string; remotePath: string }) => Promise<string | null>>();
export const openHtml =
  vi.fn<(connectionId: string, path: string) => Promise<{ token: string; url: string }>>();
export const openMarkdown = vi.fn<
  (
    connectionId: string,
    path: string,
    style: { palette: Record<string, string>; appearance: string },
  ) => Promise<{ token: string; url: string }>
>();
export const openSvg =
  vi.fn<(connectionId: string, path: string) => Promise<{ token: string; url: string }>>();
export const releasePreview = vi.fn<(token: string) => void>();

/** The store's own stats subscriber, captured so a test can push counts at it. */
export let statsListener: ((stats: {
  token: string;
  loaded: number;
  blocked: number;
  missing: number;
  capped: boolean;
}) => void) | null = null;

export const api = {
  sftp: {
    realPath: (connectionId: string, path: string) => realPath(connectionId, path),
    list: (connectionId: string, path: string) => list(connectionId, path),
    stat: (connectionId: string, path: string) => stat(connectionId, path),
    readBinary: (connectionId: string, path: string, maxBytes?: number) =>
      readBinary(connectionId, path, maxBytes),
    readFile: (connectionId: string, path: string) => readFile(connectionId, path),
    writeFile: (connectionId: string, path: string, content: string) =>
      writeFile(connectionId, path, content),
    createFile: (connectionId: string, path: string, content?: string) =>
      createFile(connectionId, path, content),
    mkdir: (connectionId: string, path: string) => mkdir(connectionId, path),
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
};

const created: string[] = [];
const revoked: string[] = [];
export { created, revoked };

globalThis.URL.createObjectURL = (): string => {
  const url = `blob:mock/${created.length}`;
  created.push(url);
  return url;
};
globalThis.URL.revokeObjectURL = (url: string): void => {
  revoked.push(url);
};

export function resetFilesApi(): void {
  realPath.mockReset();
  list.mockReset();
  stat.mockReset();
  readBinary.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFile.mockReset();
  mkdir.mockReset();
  saveAs.mockReset();
  openHtml.mockReset();
  openMarkdown.mockReset();
  openSvg.mockReset();
  releasePreview.mockReset();
  list.mockResolvedValue([]);
  writeFile.mockResolvedValue(true);
  createFile.mockResolvedValue(true);
  mkdir.mockResolvedValue(true);
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
}
