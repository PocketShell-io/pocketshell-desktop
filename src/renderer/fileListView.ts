/**
 * What the Files tab's tree actually renders: a capped, optionally filtered
 * slice of the directory listing, plus a breadcrumb that fits on one line.
 *
 * Pure on purpose — this is the whole of the logic and none of it needs a DOM
 * (`tests/unit/fileListView.test.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHERE THE COST IS — AND SO WHAT "LOAD FIRST 100" MEANS
 * ---------------------------------------------------------------------------
 *
 * It is a RENDER cap, not a fetch limit, and the difference decides the whole
 * design. `api.sftp.list` is one `sftp.readdir` (SftpService.list:96) — the
 * SFTP layer streams the directory to completion inside a single call and
 * hands back the whole array. There is no cursor, no per-entry round trip, and
 * nothing to page: a 4,000-entry folder costs one request whose reply is
 * proportional to N, which on a LAN is milliseconds and on a bad link is one
 * slow reply rather than forty.
 *
 * What is NOT cheap is the other end. Every entry becomes a row with an icon
 * component and three spans, and Vue diffs all of them on every listing
 * change; that is the part that makes a big folder feel bad. So the cap is
 * applied to what we RENDER, the store keeps the full listing it already
 * fetched, and {@link viewFileRows} filters over ALL of it. Searching
 * therefore never needs another round trip and never misses a file just
 * because it sits past the cap — which is the failure mode of capping the
 * fetch instead.
 *
 * (If a host ever does make `readdir` itself slow — a network filesystem, an
 * enormous directory — that is a different fix, in SftpService, and it would
 * need a paging API SFTP's `readdir` does not naturally expose. Nothing here
 * papers over it: the row count shown is the true total.)
 */

/** Rows rendered before "Load more" appears. */
export const FILE_ROW_CAP = 100;

/** The minimum a row must have to be viewed. Keeps this testable with plain objects. */
export interface NamedEntry {
  name: string;
}

export interface FileListView<T extends NamedEntry> {
  /** The rows to render, in the listing's own order. */
  rows: T[];
  /** How many entries survived the filter. */
  total: number;
  /** `total - rows.length`: how many the cap is holding back. */
  hidden: number;
  /** True when a query is narrowing the list. */
  filtered: boolean;
}

/**
 * Case-insensitive substring, and nothing more.
 *
 * Not fuzzy: a fuzzy matcher over a directory of `2026-02-27-*.yaml` files
 * matches essentially everything and ranks by a score the user cannot see,
 * which is worse than the plain answer. A blank query matches everything.
 */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

/**
 * Filter, then cap.
 *
 * That order is the point: filtering the CAPPED slice would search only what
 * you had already scrolled to, which is the most confusing behaviour available
 * — a file you can see in the terminal is simply absent from a search that
 * claims to cover the folder.
 *
 * Ordering is inherited, never re-derived. The store sorts once on load (dirs
 * first, then files, alphabetical — `stores/files.ts` `refresh`), and both the
 * filter and the slice preserve it, so a filtered view is the same list with
 * rows removed rather than a second, differently-ordered list.
 *
 * `..` is deliberately not this function's business. It is navigation, not
 * content, so it lives outside the `v-for` in the template and is therefore
 * never capped away and never filtered away.
 */
export function viewFileRows<T extends NamedEntry>(
  entries: readonly T[],
  options: { query?: string; cap?: number } = {},
): FileListView<T> {
  const query = options.query ?? '';
  const cap = options.cap ?? FILE_ROW_CAP;
  const filtered = query.trim().length > 0;
  const matching = filtered ? entries.filter((e) => matchesQuery(e.name, query)) : [...entries];
  const limit = cap > 0 ? cap : matching.length;
  return {
    rows: matching.slice(0, limit),
    total: matching.length,
    hidden: Math.max(0, matching.length - limit),
    filtered,
  };
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

/** A place the breadcrumb can send you: a directory and the name to call it. */
interface CrumbTarget {
  name: string;
  path: string;
}

/**
 * One breadcrumb cell.
 *
 * `current` is a separate kind from `segment` rather than "the last segment",
 * because almost every rule below treats it differently: it is the only cell
 * that is never collapsed, the only one allowed to truncate its own text, and
 * the only one that is not a link. Making the template ask `i === last` for
 * each of those is how the three rules drift apart.
 */
export type Crumb =
  | { kind: 'segment'; name: string; path: string }
  | { kind: 'current'; name: string; path: string }
  | { kind: 'gap'; hidden: CrumbTarget[] };

// ---------------------------------------------------------------------------
// WHAT THE RESEARCH SAID, AND WHY THIS FUNCTION HAS THE SHAPE IT HAS
// ---------------------------------------------------------------------------
//
// The predecessor of this code collapsed the middle of the path to a fixed
// four cells and then ran each SURVIVING cell through `splitLabel`, so a
// 250px pane rendered `~ / … / v…previews / olya-…` — two different
// truncations of the same fact stacked on top of each other, with the folder
// the user is actually standing in the one that got cut. That is the identical
// failure `b841362` deleted from the session rows. It came back because the
// collapse rule was STRUCTURAL (always four cells, whatever the width), so it
// could not do the work at a narrow width and character truncation had to
// finish the job.
//
// Every implementation that was read does the two operations in a fixed order,
// and it is the opposite of what we shipped:
//
//   COLLAPSE WHOLE SEGMENTS FIRST; CUT CHARACTERS ONLY OUT OF WHAT SURVIVES.
//
//   - IBM Carbon, Breadcrumb usage: "When space becomes limited, use an
//     overflow menu to truncate the breadcrumbs" — and for the narrowest
//     viewports, "start with the overflow first, followed by one breadcrumb",
//     i.e. literally `… / current`.
//     https://carbondesignsystem.com/components/breadcrumb/usage/
//   - Microsoft WinUI BreadcrumbBar (what Windows 11's address bar is):
//     "the breadcrumbs collapse and an ellipsis replaces the leftmost nodes.
//     Clicking the ellipsis opens a flyout to show the collapsed nodes." No
//     intra-node trimming is documented at all.
//     https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/breadcrumbbar
//   - Adobe Spectrum is the explicit prohibition on what we were doing:
//     "Don't truncate multiple labels simultaneously."
//     https://spectrum.adobe.com/page/breadcrumbs/
//   - Grafana's nested-folder breadcrumb spec is the most complete published
//     ladder and is the one this function follows: collapse the centre items,
//     then the first-level item, then the parent of the current page, and only
//     THEN centre-truncate the current page itself. Their stated reason for
//     centre rather than end is ours exactly: "a simple end truncation isn't
//     all that useful given the types of naming schemes people use."
//     https://github.com/grafana/grafana/issues/62266
//
// SO THE COLLAPSE HAS TO BE MEASURED, not structural. The predecessor's own
// comment argued the opposite ("measuring would let a wide pane show more, at
// the cost of a layout pass") and that reasoning is what produced the bug: a
// cell count tuned for one width is wrong at every other width, and this pane
// is drag-resizable from 180px to 640px. A single ResizeObserver on the strip
// (FileTree.vue) is the whole cost, and it fires on splitter drags, not on
// navigation.
//
// WHY THE LAST SEGMENT IS PROTECTED BUT NOT SACRED. The formal breadcrumb
// systems forbid touching it (Fluent 2's last item is non-interactive and
// never truncated; GitLab Pajamas truncates "all but the last breadcrumb item
// ... to 128px"). But those live in containers that can grow or wrap, and this
// one cannot. The systems that render real filesystem paths in a box that
// genuinely cannot grow protect the tail by BUDGET instead: GNOME Nautilus's
// path bar gives ancestors 7 characters and the current directory 4x that
// (`nautilus-pathbar.c`, `NAUTILUS_PATH_BAR_BUTTON_ELLISPIZE_MINIMUM_CHARS`),
// and Grafana reaches the current page only after three collapse stages have
// failed. Here the budget is "everything that is left", which is the same idea
// at its limit: the current folder is cut only when it alone does not fit, and
// nothing else is ever cut at all.
//
// WHY THE ELLIPSIS IS A MENU AND NOT A TOOLTIP. NN/g's tooltip guidance rules
// tooltips out as the SOLE route to something you need: "is the information in
// the tooltip necessary for users in order to complete a task? If the answer
// is no, a tooltip is well-suited. Otherwise, the information should be present
// on the screen" — and a hidden path segment is a navigation target, not a
// nicety. Carbon, Fluent, Primer, Spectrum and Atlassian all put the collapsed
// items in a menu. https://www.nngroup.com/articles/tooltip-guidelines/
//
// WHAT WAS REJECTED, AND WHY:
//
//   - VS Code's answer (`breadcrumbsWidget.ts` wraps the items in a
//     `DomScrollableElement` and calls `reveal(items[items.length - 1])`) is a
//     horizontally scrolling strip with the tail pinned: nothing is ever
//     collapsed and nothing is ever ellipsized. It is the cleanest design in
//     the survey and it does not fit here — a 250px strip that scrolls needs
//     an affordance saying so, NN/g #9-#10 and LogRocket both flag horizontal
//     scroll as a dexterity cost, and the ancestors would be reachable only by
//     a gesture. Note that VS Code itself concedes the narrow case with
//     `breadcrumbs.filePath: "last"` — "Only show the last element of the file
//     path" — which is exactly the terminal state this ladder reaches.
//   - Nautilus's per-ancestor middle ellipsis (7 chars) is the closest thing
//     to a licence for the old behaviour, but it is paid for by a path bar
//     that scrolls and by a tooltip on every button; dropping the ancestor
//     whole and putting it in the menu says the same thing without inventing a
//     name like `v…previews` that matches no directory on the host.
//   - A per-item character cap (Fluent's 30, Pajamas' 128px) needs a container
//     where 30 characters is a small fraction of the width. Here the entire
//     strip is about 22 characters.
//
// Everything hidden stays reachable three ways regardless: the `…` menu, the
// `title` on the strip, and the editable path bar (the pencil, or Ctrl+L).

/**
 * Average advance of one character of `--fs-200` in `--font-ui` (Inter 12px),
 * rounded UP.
 *
 * An estimate, deliberately, and deliberately generous. The alternative is
 * measuring each candidate string in a canvas or a hidden element, which buys
 * exactness we cannot spend: the fit decision is "does this whole segment
 * survive", so being a few pixels pessimistic drops one more ancestor into a
 * menu that is one click away, while being optimistic pushes the current
 * folder under `overflow: hidden`. Round the error towards the harmless side.
 */
const CRUMB_CHAR_PX = 7;

/** The `/` between two cells, plus its margins. */
const CRUMB_SEP_PX = 9;

/** The `…` button, plus its padding. */
const CRUMB_GAP_PX = 13;

/** What a cell showing `name` costs, separator included. */
function cellWidth(name: string): number {
  return name.length * CRUMB_CHAR_PX + CRUMB_SEP_PX;
}

/**
 * Turn an absolute path into breadcrumb cells that fit `width` pixels on one
 * line, collapsing whole segments — never characters — until they do.
 *
 * See the block above for the sources; the ladder it implements is:
 *
 *   1. Everything fits, so show everything. (VS Code's whole design, and
 *      Carbon's "The full breadcrumb path should remain visible when there's
 *      enough horizontal space".)
 *   2. Otherwise reserve the `…` FIRST. It is the only route back to what is
 *      about to be hidden, so it outranks every segment it stands for.
 *   3. Reserve the root next, BEFORE any ancestor competes for the space. It
 *      is one character wide and it is the only cell that says which
 *      machine-relative anchor you are under; Grafana's ladder likewise keeps
 *      `Home` through every stage. Reserving it first is also what makes the
 *      strip monotonic under a splitter drag — if ancestors were filled first
 *      they could eat the 16px the root wanted, so widening the pane by four
 *      pixels could take the `~` AWAY. Spectrum lets even the root fall into
 *      the menu when it truly does not fit ("regardless of showRoot"), and so
 *      does this, but only at the very bottom.
 *   4. Fill ancestors right-to-left with what is left, whole names only. A
 *      name that does not fit goes into the menu; it is never shortened, and
 *      what survives is always an unbroken run ending at the current folder —
 *      a gap between two shown cells would name a parent that is not the
 *      parent.
 *   5. Only now, and only for the current folder, does text get cut — by
 *      `splitLabel` in the template, which keeps the tail. That is the last
 *      rung of Grafana's ladder and it applies to exactly one label.
 *
 * @param cwd     absolute remote directory
 * @param home    the login home, or '' when it is not resolved yet
 * @param options `width` is the pixels available to the crumb strip. Omitted
 *                (or non-finite) means "not measured yet", and an unmeasured
 *                strip shows the whole path rather than guessing — a first
 *                paint that collapses and then expands is worse than one that
 *                clips for a frame.
 */
export function buildCrumbs(cwd: string, home: string, options: { width?: number } = {}): Crumb[] {
  const width = options.width ?? Number.POSITIVE_INFINITY;

  // `~` REPLACES the home prefix rather than sitting in front of the absolute
  // spelling of it — otherwise the login home renders as `~ / home / alexey`,
  // the same location said twice with the first copy linking elsewhere.
  const inHome = home !== '' && (cwd === home || cwd.startsWith(home + '/'));
  const root: CrumbTarget = inHome ? { name: '~', path: home } : { name: '/', path: '/' };
  const rest = inHome ? cwd.slice(home.length) : cwd;

  const trail: CrumbTarget[] = [root];
  let acc = inHome ? home : '';
  for (const part of rest.split('/').filter(Boolean)) {
    acc += '/' + part;
    trail.push({ name: part, path: acc });
  }

  // Where you are. Always shown, never collapsed, not a link.
  const current: Crumb = { kind: 'current', ...trail[trail.length - 1]! };
  const ancestors = trail.slice(0, -1);
  const link = (t: CrumbTarget): Crumb => ({ kind: 'segment', ...t });

  // (1) The whole trail, if it fits. `cellWidth` charges the current a
  // separator it does not have, which is the pessimism this wants.
  const full = trail.reduce((w, t) => w + cellWidth(t.name), 0);
  if (ancestors.length === 0 || full <= width) {
    return [...ancestors.map(link), current];
  }

  // (2) The `…` is reserved before anything it could hide, and the current
  // folder's own width comes off the top with it. `left` can go negative —
  // that is the case where the current folder alone overflows, and rung 5
  // handles it in the template.
  let left = width - CRUMB_GAP_PX - CRUMB_SEP_PX - cellWidth(current.name);

  // (3) Then the root, ahead of every ancestor.
  const head: Crumb[] = [];
  if (cellWidth(root.name) <= left) {
    head.push(link(root));
    left -= cellWidth(root.name);
  }

  // (4) Then ancestors, right to left, until one does not fit.
  const shown: CrumbTarget[] = [];
  let firstShown = ancestors.length;
  for (let i = ancestors.length - 1; i >= 1; i--) {
    const cost = cellWidth(ancestors[i]!.name);
    if (cost > left) break;
    left -= cost;
    shown.unshift(ancestors[i]!);
    firstShown = i;
  }
  const hidden = ancestors.slice(head.length, firstShown);

  // A formality with these constants rather than a live branch, and kept so
  // the function stays total if they ever change. It cannot fire today: every
  // cell that got added was checked against a `left` that already had the `…`
  // deducted, so reaching here with nothing hidden would mean the whole trail
  // plus the `…` fit — and step (1) would have returned it.
  if (hidden.length === 0) return [...head, ...shown.map(link), current];

  // Baymard's "never truncate a single value" — don't spend a control to hide
  // one item — needs no code for the same reason: showing a lone hidden folder
  // instead of the `…` means showing the entire trail, which step (1) already
  // priced and rejected. The accounting decides it, not a special case.
  return [...head, { kind: 'gap', hidden }, ...shown.map(link), current];
}
