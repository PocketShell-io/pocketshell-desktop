// @vitest-environment jsdom
//
// The Files store's browsing trail — the back/forward history behind the
// tree's Back and Forward buttons. The trail is one array plus one index, and
// what is worth pinning is not the array but the RULES around it:
//
//   - every user move records (`cd`, `goTo`), a bare `refresh` does not, and
//     `open()`'s re-landing on the remembered position must not either — or
//     commuting to the terminal would grow the trail by one every time;
//   - a move made from the middle abandons the forward half (the browser's
//     rule), and stepping does not;
//   - the trail is per TAB like the remembered position is, so two Files tabs
//     never walk each other's past, and `clear()` retires it on disconnect.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { list, realPath, resetFilesApi } from './helpers/filesApi';

vi.mock('@ui/app/ipc', async () => ({
  api: (await import('./helpers/filesApi')).api,
}));

const { useFilesStore } = await import('@ui/app/stores/files');

const CONN = 'conn-1' as never;

beforeEach(() => {
  setActivePinia(createPinia());
  resetFilesApi();
  realPath.mockImplementation((_c, p) => Promise.resolve(p));
});

describe('files store browsing trail', () => {
  it('starts with nowhere back or forward to go', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');

    expect(files.canGoBack).toBe(false);
    expect(files.canGoForward).toBe(false);
    // The buttons call the steps regardless of their disabled state in some
    // assistive paths; a step with no trail is a no-op, not a throw.
    await files.goBack(CONN);
    await files.goForward(CONN);
    expect(files.cwd).toBe('/home/u/a');
  });

  it('records a walk and steps back and forward through it', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');
    await files.cd(CONN, '/home/u/a/b');
    await files.cd(CONN, '/home/u/a/b/c');

    expect(files.canGoBack).toBe(true);
    expect(files.canGoForward).toBe(false);

    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u/a/b');
    expect(files.canGoForward).toBe(true);

    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u/a');
    expect(files.canGoBack).toBe(false);

    await files.goForward(CONN);
    expect(files.cwd).toBe('/home/u/a/b');
  });

  it('records the breadcrumb and the .. row, which are goTo and cd too', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a/b');

    await files.goTo(CONN, '/home/u');
    await files.cd(CONN, '/home/u/a');
    await files.cd(CONN, '..');
    expect(files.cwd).toBe('/home/u');

    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u/a');
  });

  it('a bare refresh records nothing', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');

    await files.refresh(CONN);
    await files.refresh(CONN);

    expect(files.canGoBack).toBe(false);
  });

  it('a move made after a back abandons the forward half', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');
    await files.cd(CONN, '/home/u/a/b');
    await files.cd(CONN, '/home/u/a/b/c');
    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u/a/b');

    // The click from the middle: c is gone from the trail, and Forward has
    // nothing to offer.
    await files.cd(CONN, '/home/u/a/other');
    expect(files.cwd).toBe('/home/u/a/other');
    expect(files.canGoForward).toBe(false);
    await files.goForward(CONN);
    expect(files.cwd).toBe('/home/u/a/other');
  });

  it('commuting to the terminal and back neither grows nor resets the trail', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');
    await files.cd(CONN, '/home/u/a/b');

    // The Files view unmounts on the way to the terminal and re-mounts on the
    // way back, so `open` runs again for the same tab and lands on the
    // remembered position. That landing is not a move: Back must still be one
    // step to `a`, not two, and must still be OFFERED at all.
    await files.open(CONN, '/home/u/a');
    expect(files.cwd).toBe('/home/u/a/b');
    expect(files.canGoBack).toBe(true);

    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u/a');
  });

  it('one tab’s trail is never another tab’s', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/one', 'tab-1');
    await files.cd(CONN, '/home/u/one/deep');

    await files.open(CONN, '/home/u/two', 'tab-2');
    expect(files.canGoBack).toBe(false);

    await files.open(CONN, '/home/u/one', 'tab-1');
    expect(files.canGoBack).toBe(true);
    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u/one');
  });

  it('records a landing the tab made on its own, so Back can undo it', async () => {
    // The not-chosen landing: the tab's first resolve fell back to the login
    // home, and the session's real working directory arrived later. The tab
    // moved without the user asking — Back is what lets them decline the move.
    const files = useFilesStore();
    const tab = 'recovered-tab';
    realPath.mockImplementation((_c, p) =>
      Promise.resolve(p === '.' ? '/home/u' : p),
    );

    await files.open(CONN, undefined, tab);
    expect(files.cwd).toBe('/home/u');
    expect(files.canGoBack).toBe(false);

    await files.open(CONN, '/home/u/recovered', tab);
    expect(files.cwd).toBe('/home/u/recovered');
    expect(files.canGoBack).toBe(true);

    await files.goBack(CONN);
    expect(files.cwd).toBe('/home/u');
  });

  it('clear() retires the trail with the rest of the connection', async () => {
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');
    await files.cd(CONN, '/home/u/a/b');

    files.clear(CONN);
    expect(files.canGoBack).toBe(false);

    await files.open(CONN, '/home/u/a');
    expect(files.canGoBack).toBe(false);
  });

  it('a superseded step commits no index move', async () => {
    // The nav pipeline's ticket guard already covers cwd; this pins the trail's
    // half of the same contract — a back whose listing was superseded by a
    // newer navigation must not leave the index pointing somewhere the screen
    // is not, or the next Forward would skip a directory.
    const files = useFilesStore();
    await files.open(CONN, '/home/u/a');
    await files.cd(CONN, '/home/u/a/b');
    await files.cd(CONN, '/home/u/a/b/c');

    let settleSlow: (value: unknown[]) => void = () => undefined;
    const slowList = new Promise<unknown[]>((resolve) => {
      settleSlow = resolve;
    });
    list.mockImplementation((_c, path) =>
      path === '/home/u/a/b' ? slowList : Promise.resolve([]),
    );

    const stale = files.goBack(CONN); // parked: its listing has not settled
    await files.cd(CONN, '/home/u/a/other');
    expect(files.cwd).toBe('/home/u/a/other');

    settleSlow([]);
    await stale;
    expect(files.cwd).toBe('/home/u/a/other');
    expect(files.canGoForward).toBe(false);
  });
});
