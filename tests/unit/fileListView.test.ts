import { describe, it, expect } from 'vitest';
import {
  buildCrumbs,
  FILE_ROW_CAP,
  matchesQuery,
  viewFileRows,
} from '@ui/app/fileListView';

/** A listing in the order the store leaves it: dirs first, then files, A-Z. */
function listing(count: number, prefix = 'file'): { name: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${String(i).padStart(4, '0')}.yaml`,
  }));
}

describe('matchesQuery', () => {
  it('is a case-insensitive substring', () => {
    expect(matchesQuery('Report-2026.CSV', 'report')).toBe(true);
    expect(matchesQuery('Report-2026.CSV', '2026')).toBe(true);
    expect(matchesQuery('Report-2026.CSV', 'xlsx')).toBe(false);
  });

  it('treats a blank query as "everything", not "nothing"', () => {
    expect(matchesQuery('anything', '')).toBe(true);
    expect(matchesQuery('anything', '   ')).toBe(true);
  });
});

describe('viewFileRows', () => {
  it('caps the rendered rows and reports the true total', () => {
    const view = viewFileRows(listing(3946));
    expect(view.rows).toHaveLength(FILE_ROW_CAP);
    expect(view.total).toBe(3946);
    expect(view.hidden).toBe(3946 - FILE_ROW_CAP);
    expect(view.filtered).toBe(false);
  });

  it('shows everything when the folder fits under the cap', () => {
    const view = viewFileRows(listing(8));
    expect(view.rows).toHaveLength(8);
    expect(view.hidden).toBe(0);
  });

  it('grows with the cap, which is what "Load more" does', () => {
    const entries = listing(250);
    expect(viewFileRows(entries, { cap: 100 }).rows).toHaveLength(100);
    expect(viewFileRows(entries, { cap: 200 }).rows).toHaveLength(200);
    expect(viewFileRows(entries, { cap: 300 }).hidden).toBe(0);
  });

  it('FILTERS THE WHOLE LISTING, not the capped slice', () => {
    // The match sits at index 3000 — far past any cap. Filtering the slice
    // first would make it unreachable, which is the bug this asserts against.
    const entries = listing(4000);
    entries[3000] = { name: 'needle.txt' };
    const view = viewFileRows(entries, { query: 'needle' });
    expect(view.rows.map((r) => r.name)).toEqual(['needle.txt']);
    expect(view.total).toBe(1);
    expect(view.hidden).toBe(0);
    expect(view.filtered).toBe(true);
  });

  it('caps the filtered result too, and counts the matches not the folder', () => {
    const entries = [...listing(500, 'alpha'), ...listing(500, 'beta')];
    const view = viewFileRows(entries, { query: 'beta', cap: 100 });
    expect(view.rows).toHaveLength(100);
    expect(view.total).toBe(500);
    expect(view.hidden).toBe(400);
    expect(view.rows.every((r) => r.name.startsWith('beta'))).toBe(true);
  });

  it('preserves the listing order inside both the filter and the cap', () => {
    const entries = [
      { name: 'src' },
      { name: 'tests' },
      { name: 'a.ts' },
      { name: 'b.ts' },
      { name: 'c.ts' },
    ];
    expect(viewFileRows(entries, { cap: 3 }).rows.map((r) => r.name)).toEqual([
      'src',
      'tests',
      'a.ts',
    ]);
    expect(viewFileRows(entries, { query: 't' }).rows.map((r) => r.name)).toEqual([
      'tests',
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('reports an empty filter result honestly rather than falling back', () => {
    const view = viewFileRows(listing(50), { query: 'zzz' });
    expect(view.rows).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.filtered).toBe(true);
  });

  it('does not mutate the listing it was given', () => {
    const entries = listing(5);
    const before = entries.map((e) => e.name);
    viewFileRows(entries, { query: 'file-0001' });
    expect(entries.map((e) => e.name)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// buildCrumbs
// ---------------------------------------------------------------------------
//
// The widths below are the real ones. `.crumbs` gets the pane minus its
// `--sp-3` padding on both sides (24), minus the three 24px strip buttons and
// the 2px gaps between them (76), minus the strip's own `--sp-1` (4) — so a
// pane of N pixels gives the crumb strip N - 104. The three that matter:
//
//   180px pane (the drag floor, MIN_TREE_WIDTH)  ->  76px
//   260px pane (the default)                     -> 156px
//   640px pane (MAX_TREE_WIDTH)                  -> 536px
//
// A layout is asserted as `cells()` — the visible text, with the collapsed
// cell as `…` — plus, where it is the point, which cell is `current`.

const FLOOR_W = 76;
const DEFAULT_W = 156;
const WIDE_W = 536;

/** The strip as a reader sees it. */
function cells(crumbs: ReturnType<typeof buildCrumbs>): string[] {
  return crumbs.map((c) => (c.kind === 'gap' ? '…' : c.name));
}

/** The user's reported path, and the one the screenshot was taken of. */
const REPORTED = '/home/alexey/git/red-stamp/tmp/voice-previews/olya-merin';
const HOME = '/home/alexey';

describe('buildCrumbs', () => {
  it('collapses the home prefix into a single ~ rather than repeating it', () => {
    expect(buildCrumbs(HOME, HOME)).toEqual([{ kind: 'current', name: '~', path: HOME }]);
  });

  it('roots at / outside the home', () => {
    expect(cells(buildCrumbs('/srv/www', HOME))).toEqual(['/', 'srv', 'www']);
  });

  it('falls back to the absolute form when the home is not resolved yet', () => {
    expect(cells(buildCrumbs('/home/alexey/git', ''))).toEqual(['/', 'home', 'alexey', 'git']);
  });

  it('tolerates a trailing slash and repeated separators', () => {
    expect(cells(buildCrumbs('/a//b/', ''))).toEqual(['/', 'a', 'b']);
  });

  it('builds cumulative paths for every cell', () => {
    const crumbs = buildCrumbs('/a/b/c/d/e', '');
    expect(crumbs.map((c) => (c.kind === 'gap' ? '' : c.path))).toEqual([
      '/',
      '/a',
      '/a/b',
      '/a/b/c',
      '/a/b/c/d',
      '/a/b/c/d/e',
    ]);
  });

  // -------------------------------------------------------------------------
  // Where you are
  // -------------------------------------------------------------------------

  it('marks the last cell as the current one, at every depth and width', () => {
    for (const width of [FLOOR_W, DEFAULT_W, WIDE_W, Number.POSITIVE_INFINITY]) {
      for (const depth of [0, 1, 2, 3, 8, 20]) {
        const cwd = HOME + Array.from({ length: depth }, (_, i) => `/segment-${i}`).join('');
        const crumbs = buildCrumbs(cwd, HOME, { width });
        const last = crumbs[crumbs.length - 1]!;
        expect(last.kind).toBe('current');
        expect(last.kind === 'current' && last.path).toBe(cwd);
        // And it is the ONLY one: `current` is what the template keys the
        // "not a link" and "may truncate its own text" rules off.
        expect(crumbs.filter((c) => c.kind === 'current')).toHaveLength(1);
      }
    }
  });

  it('never collapses the current folder away, however narrow the strip', () => {
    // Zero and one pixel are not real widths; they are the assertion that the
    // ladder bottoms out at "where you are" rather than at nothing. This is
    // the state VS Code exposes deliberately as `breadcrumbs.filePath: "last"`.
    for (const width of [0, 1, 20]) {
      const crumbs = buildCrumbs(REPORTED, HOME, { width });
      expect(cells(crumbs)).toEqual(['…', 'olya-merin']);
    }
  });

  // -------------------------------------------------------------------------
  // The reported failure
  // -------------------------------------------------------------------------

  it('shows whole names or none, never a shortened one, at the default width', () => {
    // Was: `~ / … / v…previews / olya-…` — the middle collapsed AND every
    // survivor cut. Now the collapse does all the work and no name is touched.
    expect(cells(buildCrumbs(REPORTED, HOME, { width: DEFAULT_W }))).toEqual([
      '~',
      '…',
      'olya-merin',
    ]);
  });

  it('degrades to the ellipsis and the current folder at the drag floor', () => {
    // 180px, MIN_TREE_WIDTH. Carbon's prescription for the narrowest viewport
    // is exactly this shape: "start with the overflow first, followed by one
    // breadcrumb". The `~` is the first thing to go, which is Spectrum's rule
    // that the root collapses into the menu "regardless of showRoot".
    expect(cells(buildCrumbs(REPORTED, HOME, { width: FLOOR_W }))).toEqual(['…', 'olya-merin']);
  });

  it('shows the whole path when the pane is dragged wide', () => {
    expect(cells(buildCrumbs(REPORTED, HOME, { width: WIDE_W }))).toEqual([
      '~',
      'git',
      'red-stamp',
      'tmp',
      'voice-previews',
      'olya-merin',
    ]);
  });

  it('grows the trail monotonically as the pane is dragged wider', () => {
    // The property that makes a resizable pane feel like one control: widening
    // never takes a folder away. Compared on the SET of names, because the `…`
    // legitimately appears and disappears.
    let previous = new Set<string>();
    for (let width = 40; width <= 600; width += 4) {
      const shown = new Set(cells(buildCrumbs(REPORTED, HOME, { width })).filter((n) => n !== '…'));
      for (const name of previous) expect(shown.has(name)).toBe(true);
      previous = shown;
    }
  });

  it('keeps the visible cells contiguous with the current folder', () => {
    // `~ / … / tmp / olya-merin` would be a readable lie: it names a parent
    // that is not the parent. Whatever survives on the right must be an
    // unbroken run ending at the current folder.
    for (let width = 40; width <= 600; width += 3) {
      const crumbs = buildCrumbs(REPORTED, HOME, { width });
      const gapAt = crumbs.findIndex((c) => c.kind === 'gap');
      if (gapAt < 0) continue;
      const tail = crumbs.slice(gapAt + 1);
      const joined = tail.map((c) => (c.kind === 'gap' ? '' : c.name)).join('/');
      expect(REPORTED.endsWith('/' + joined)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // The ellipsis
  // -------------------------------------------------------------------------

  it('carries every hidden folder on the gap, as a real destination', () => {
    const crumbs = buildCrumbs(REPORTED, HOME, { width: DEFAULT_W });
    const gap = crumbs.find((c) => c.kind === 'gap');
    expect(gap!.kind === 'gap' && gap!.hidden.map((h) => h.name)).toEqual([
      'git',
      'red-stamp',
      'tmp',
      'voice-previews',
    ]);
    expect(gap!.kind === 'gap' && gap!.hidden[1]!.path).toBe('/home/alexey/git/red-stamp');
  });

  it('accounts for every segment of the path, shown or hidden, at any width', () => {
    // Nothing may be silently dropped: a folder is on the strip or it is in
    // the menu. This is what makes collapsing safe where cutting characters
    // was not — the collapsed name still exists somewhere clickable.
    for (const width of [FLOOR_W, 100, DEFAULT_W, 200, 300, WIDE_W]) {
      const crumbs = buildCrumbs(REPORTED, HOME, { width });
      const seen = crumbs.flatMap((c) => (c.kind === 'gap' ? c.hidden.map((h) => h.name) : [c.name]));
      expect(seen).toEqual(['~', 'git', 'red-stamp', 'tmp', 'voice-previews', 'olya-merin']);
    }
  });

  it('shows exactly one gap, or none', () => {
    for (let width = 20; width <= 600; width += 2) {
      for (const depth of [1, 2, 3, 5, 12, 30]) {
        const cwd = HOME + Array.from({ length: depth }, (_, i) => `/dir-${i}`).join('');
        const gaps = buildCrumbs(cwd, HOME, { width }).filter((c) => c.kind === 'gap');
        expect(gaps.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not collapse anything when there is nothing to collapse', () => {
    // A gap that hides no folders is a control with an empty menu.
    for (let width = 20; width <= 600; width += 2) {
      for (const cwd of [HOME, HOME + '/git', HOME + '/git/site']) {
        const gap = buildCrumbs(cwd, HOME, { width }).find((c) => c.kind === 'gap');
        if (gap && gap.kind === 'gap') expect(gap.hidden.length).toBeGreaterThan(0);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Unmeasured, and pathological
  // -------------------------------------------------------------------------

  it('shows the whole path when the width is not known yet', () => {
    // First paint, before the ResizeObserver has run. Expanding into place is
    // better than collapsing out of it, and it is also what VS Code does
    // permanently — its breadcrumb never collapses at all.
    expect(cells(buildCrumbs(REPORTED, HOME))).toEqual([
      '~',
      'git',
      'red-stamp',
      'tmp',
      'voice-previews',
      'olya-merin',
    ]);
  });

  it('survives a single directory name longer than the whole strip', () => {
    // Nothing structural can help here; the template hands this one name to
    // `splitLabel`, which is the app's one truncation rule and the ONLY place
    // it is still applied on this strip.
    const long = 'a-directory-name-nobody-should-have-typed-but-here-we-are';
    const crumbs = buildCrumbs(`${HOME}/git/${long}`, HOME, { width: FLOOR_W });
    expect(cells(crumbs)).toEqual(['…', long]);
    expect(crumbs[crumbs.length - 1]!.kind).toBe('current');
  });

  it('handles a path deeper than any strip can hold', () => {
    const cwd = HOME + Array.from({ length: 40 }, (_, i) => `/level-${i}`).join('');
    const crumbs = buildCrumbs(cwd, HOME, { width: DEFAULT_W });
    expect(cells(crumbs)).toEqual(['~', '…', 'level-39']);
    const gap = crumbs.find((c) => c.kind === 'gap');
    // 40 levels minus the one on the strip; the `~` kept its own slot and so
    // is not among them.
    expect(gap!.kind === 'gap' && gap!.hidden).toHaveLength(39);
  });

  it('fits inside the width it was given', () => {
    // The estimate is the contract: `char x 7 + 9` per cell, `…` at 13 + 9.
    // If this drifts the strip starts clipping, which is the failure the whole
    // redesign exists to remove.
    const cost = (crumbs: ReturnType<typeof buildCrumbs>): number =>
      crumbs.reduce((w, c) => w + (c.kind === 'gap' ? 13 : c.name.length * 7) + 9, 0);
    for (let width = 60; width <= 600; width += 1) {
      const crumbs = buildCrumbs(REPORTED, HOME, { width });
      // The current folder is allowed to exceed it — that is rung 5, where
      // `splitLabel` takes over. Everything to its left must fit.
      expect(cost(crumbs.slice(0, -1))).toBeLessThanOrEqual(width);
    }
  });
});
