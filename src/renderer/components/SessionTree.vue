<script setup lang="ts">
// SessionTree: the live tmux session list for the active connection, as a
// FOLDER VIEW — TWO levels, root then folder, one row per folder
// (revising  revision 3):
//
//   git                          12
//     dtc-website           2       21h
//     pocketshell           3       21h
//     dataops                       22h
//   other                           3
//
// The root line carries no disclosure mark because it is not a node: it is a
// grouping HEADER over the folder rows beneath it, and there is nothing under
// it that hiding would spare the reader. See the root row in the template for
// why that is deliberate and what a future collapse must not do.
//
// It does carry a `+`, revealed on hover or focus, which creates a session
// under that root — and that is not a contradiction of the paragraph above. A
// chevron would promise a STATE the row does not have; a `+` promises an
// action, which it does. The panel's foot button went when this arrived; see
// the end of the template.
//
// ## Why the session level went, and why this is not revision 2 again
//
// Revision 3 made this `root -> folder -> session`, and the load-bearing
// sentence in it was "the directory row is no longer selectable: clicking it
// expands". The session leaf existed because it was the ONLY way to reach a
// session — selecting one was a panel operation, so the panel needed a row per
// session to select. That is no longer true. A folder row opens a folder
// WORKSPACE whose tab bar already carries every session in the folder, always
// visible, one click away, so the leaf now spends a row on a navigation step
// something else already performs.
//
// Revisions 1 and 2 removed the folder header CONDITIONALLY — when a folder
// held one session — which made the panel's shape depend on its contents and
// change under the refresh timer; a tree whose nodes collapse whenever they
// hold one child does not read as a tree. This is the opposite: there is no
// session level for ANY folder, whatever it holds, so the panel is always two
// deep and a reader can predict its shape without knowing what is running.
// The original measurement is not overturned — it said a level must earn
// its rows, and this one no longer does.
//
// An untracked session (`dir.untracked` — no reported cwd) still renders as a
// single row in the folder slot, and it is now selectable like
// any other folder: its workspace holds that one session. It must stay
// reachable rather than merely visible, and the sibling inference gives most
// of these a real folder before they ever get here.
//
// What survives from the flat design, unchanged:
//   - attached sessions pin to the top of their root with a green dot and a
//     semibold label. The `attached` text tag stays retired: position, weight
//     and colour already say it.
//   - the timestamp is relative (`12m`), absolute in the tooltip.
//   - labels end-truncate with the ordinary CSS ellipsis; the row tooltip
//     carries the full name and path on hover.
//   - the tooltip carries the full truth: session name, full path, absolute
//     time.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import NewSessionDialog from './NewSessionDialog.vue';
import HostPanelButtons from './HostPanelButtons.vue';
import OverlayPanel from './OverlayPanel.vue';
import PopupMenu from './PopupMenu.vue';
import { type HostPanel } from '../hostPanels';
import { pointAnchor, type Box } from '../../shared/popupPlacement';
import { useComposerStore } from '../stores/composer';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import { isShortcut } from '../../shared/shortcuts';
import { editingTarget } from '../editingTarget';
import { useFolderTree } from '../folderTree';
import { canDropFolderAt, reorderFolders } from '../folderOrder';
import { rootHostPath } from '../sessionRoots';
import { sessionIdentityKey } from '../sessionIdentity';
import { rootHeaderParts, type SessionDirectory, type SessionRootFolder } from '../sessionTree';
import type { SessionAgentKind, SessionSummary } from '../../shared/types';
import { errorMessage } from '../../shared/errors';
import { useStripDrag } from '../useStripDrag';

const props = defineProps<{
  /**
   * Key of the folder whose workspace is open, so its row can be marked.
   *
   * A `SessionDirectory.key`, not a session name: selection is a FOLDER fact
   * now, and a workspace holding four session tabs still highlights exactly
   * one row.
   */
  activeFolder?: string | null;
  /**
   * Whether auto-forward is running for this host, for the Ports button's
   * indicator. The workspace owns the value (the forwards store is only fresh
   * while the ports overlay is open); this tree is a relay, because the
   * buttons must read the same in this header as they do on the collapsed
   * rail.
   */
  autoForward?: boolean;
  /**
   * How many forwards are live for this host, for the Ports button's count
   * pill. Relayed for the same reason `autoForward` is: the workspace owns
   * the value (the forwards store is only fresh while the ports overlay is
   * open) and this header's buttons must read exactly like the rail's.
   */
  forwardCount?: number;
}>();

/**
 * `back` and `collapse` are panel chrome, emitted for the host workspace to
 * act on. They live in THIS header because the host topbar is gone (the host's
 * identity moved to the OS title bar) and the `SESSIONS` row is now the
 * workspace's top-left row: an arrow beside `SESSIONS` reads as "leave this
 * host's sessions", and the hide toggle sits on the thing it hides. The
 * workspace stays the owner of the route and of the collapsed flag — this
 * component only announces the clicks.
 */
const emit = defineEmits<{
  /** Open a host-scoped overlay. The workspace owns the overlays; this row
   *  only announces which one was asked for. */
  panel: [name: HostPanel];
  /**
   * Open a folder's workspace. The optional second argument names a session
   * tab to select on arrival — used when a session was just created, where
   * "open the folder" alone would land on whichever tab sorts first rather
   * than on the one the user asked for.
   */
  select: [folder: SessionDirectory, session?: string];
  back: [];
  collapse: [];
}>();

const composer = useComposerStore();
const connection = useConnectionStore();
const projects = useProjectsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();

/**
 * The folder-first creation dialog: null when shut, otherwise the directory it
 * opens the browser AT.
 *
 * One piece of state for TWO controls, because they are one flow entered at two
 * depths. The header's `+` is "a session in my first root" and starts where
 * {@link defaultStartIn} points — the first root the panel draws, which is the
 * user's own arrangement once they have dragged or registered one, and `$HOME`
 * (`startIn: null`) only when no root can be resolved at all. A root row's `+`
 * is "a session under `git`" and starts there. Neither guesses a folder — the
 * root is known and the folder is not, so the picker still opens; it just opens
 * one level in.
 *
 * A boolean plus a separate path ref would let the two disagree — dialog open,
 * path stale from the last root — which is precisely the class of bug that puts
 * a session in the wrong directory. Held as one object, they cannot.
 */
const creating = ref<{ startIn: string | null } | null>(null);

/**
 * The host overlays used to be an overflow menu — Ports and Usage parked behind
 * a `⋯` because unlabelled glyphs were called a memory test (ca79ae2) and the
 * strip had no room for their words. Reversed at the user's ask:
 * the kebab is gone and each overlay is its own icon, its words living in the
 * tooltip/accessible name. The buttons themselves come from
 * components/HostPanelButtons.vue so this header and the collapsed rail render
 * the same pair; what is left here is only the plumbing of announcing which
 * overlay was clicked to the workspace that owns them.
 */
function openPanel(name: HostPanel): void {
  emit('panel', name);
}

/**
 * `$HOME` and the tree, from the ONE derivation (../folderTree.ts).
 *
 * They used to be computed here, privately, and the move is not a tidy-up: the
 * `Ctrl+↑` / `Ctrl+↓` chords step between folder WORKSPACES and are owned by
 * `HostWorkspaceView`, which now needs the same rows in the same order, keyed
 * the same way. Two derivations of one key is a row that opens a workspace with
 * no tabs in it — see the header of `folderTree.ts` for the whole argument.
 */
const { home, host, roots } = useFolderTree();

/**
 * The roots, each paired with its header text already split for the muted `~/`.
 *
 * Paired here rather than called three times inside the `v-for` — once for the
 * `v-if`, once for the prefix, once for the rest. The cost is nothing (a handful
 * of roots, a four-line pure function), but the template is where this panel's
 * decisions are written down and a line that says `rootHeaderParts(root).prefix`
 * twice in a row reads as an accident rather than as a rule.
 */
const rootRows = computed(() =>
  roots.value.map((root) => ({ root, header: rootHeaderParts(root) })),
);

/**
 * Clock for the relative timestamps. The activity values only change when the
 * store refreshes, so this tick is cosmetic: it is what turns `59s` into `1m`
 * without a store round-trip.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

/**
 * How often the panel re-reads the host's session list.
 *
 * ## Why this exists at all
 *
 * Because the rest of the app already believed it did. 
 * refers to "the refresh timer" a dozen times over — the
 * argument against keying a row's shape off `directories.length`, the
 * rule that expansion state must never watch the root list, the tab order
 * being stored as a RANKING because "sessions arrive on the refresh timer, and
 * vanish when they are killed here, from the phone or from the user's own
 * terminal", and the repo-root cache recording negatives so it does not put a
 * git process on the host "every few seconds forever". Every one of those is a
 * decision taken to survive a poll. The poll was not here. The only
 * `setInterval` in the whole renderer was the cosmetic clock above.
 *
 * The symptom is precisely the one reported: a session that goes away leaves
 * its folder row sitting in the panel. The store is only re-read on mount, on
 * the Refresh button, and at the few call sites that follow their own write —
 * so a session stopped from the phone, from a terminal, by an agent exiting,
 * or by a stop whose follow-up refresh did not land, stays on screen until the
 * user hits Refresh or navigates somewhere that happens to re-read it. The
 * folder row is not wrong about anything; nothing ever told it.
 *
 * ## Why five seconds
 *
 * It is the "every few seconds" the repo-root cache was already designed
 * against, and it is the interval the port dashboard settled on for the same
 * kind of question. It has to be well under a minute for "I stopped it and it
 * is still there" to stop being a bug report, and well over one second for the
 * two execs a listing costs not to be a load on someone's box.
 */
const POLL_MS = 5_000;
let poll: ReturnType<typeof setInterval> | null = null;
/**
 * Guards against a second listing being issued while the first is still out.
 *
 * A slow host is the case this is for: five seconds is shorter than a round
 * trip over a bad link, and without the guard each tick would stack another
 * pair of execs on a connection that is already struggling — the classic way a
 * poll turns a slow host into an unusable one.
 */
let polling = false;

/**
 * One tick of the poll.
 *
 * Four things are skipped rather than merely tolerated:
 *
 *   - no connection, because there is nothing to ask;
 *   - `document.hidden`, because a window in the background has no reader and
 *     a laptop in a bag should not be holding an SSH connection busy;
 *   - a listing already in flight (see {@link polling});
 *   - a transport main has reported dead (`connection.state === 'lost'`),
 *     because the failure has already been surfaced once and a poll cannot
 *     revive a dead link — only the reconnect can. Ticking on would fail
 *     every five seconds forever, rewriting `sessions.error` with a raw IPC
 *     message each time, over the top of the one report that explains it.
 *
 * `quiet` keeps the Refresh glyph still: `loading` means "the user asked", and
 * a poll did not. See the store for the half of that decision that matters —
 * the error message is deliberately NOT quietened, because a stale tree with
 * no explanation is the state this whole timer exists to prevent.
 */
async function pollSessions(): Promise<void> {
  const connectionId = connection.connectionId;
  if (!connectionId || polling || document.hidden || connection.state === 'lost') return;
  polling = true;
  try {
    await sessions.refresh(connectionId, { quiet: true });
  } finally {
    polling = false;
  }
}

onMounted(async () => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
  // Two timers, not one, because they answer to different costs. The clock
  // above is free and only has to be fast enough to turn `59s` into `1m`; the
  // poll below costs two execs on the user's host and has to be fast enough
  // that a stopped session stops being on screen. Folding them together would
  // force one of those two numbers to be wrong.
  poll = setInterval(() => void pollSessions(), POLL_MS);
  if (!connection.connectionId) return;
  await sessions.refresh(connection.connectionId);
  // A failure is not worth surfacing: the panel still groups, just from the
  // shape of the paths. The dialog is where a missing `$HOME` is an error,
  // because there it blocks creating anything.
  await projects.ensureHome(connection.connectionId);
});

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock);
  if (poll !== null) clearInterval(poll);
});

/** `1 session` / `3 sessions` — the phrase form, which lives only in tooltips. */
function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}

/**
 * Header tooltip: the root's real path plus its size. `~/git` rather than the
 * absolute form, because the key IS home-relative — the two spellings tmux
 * reports for one directory are deliberately folded into it.
 *
 * A registered root holding nothing says so in words. It is the one header
 * that can be empty, and "0" alone would read as a bug rather than as the
 * setting doing exactly what it was told.
 */
function rootTooltip(root: SessionRootFolder): string {
  const count = sessionCountLabel(root.sessionCount);
  if (root.other) return `sessions outside every root, or with no known folder\n${count}`;
  if (root.configured && root.sessionCount === 0) {
    return `${root.key}\nregistered in Settings — nothing running here`;
  }
  return `${root.key}\n${count}`;
}

/**
 * The absolute host directory a root's `+` would start the picker in, or null
 * when the root names no directory we can resolve.
 *
 * Null has two causes and they are not the same. `other` is a BUCKET — the
 * sessions that matched no root — so there is no place to create anything in;
 * the template does not render a `+` on it at all. The second is a `~`-keyed
 * root on a host whose `$HOME` never resolved and could not be inferred from
 * the paths either, and there the `+` renders DISABLED rather than vanishing:
 * the control is real, the host is temporarily unable to answer, and a button
 * that disappears on a failed fetch reads as a feature that is not there.
 */
function rootAddPath(root: SessionRootFolder): string | null {
  return rootHostPath(root.key, home.value);
}

/**
 * Where the general `+` opens the picker: the FIRST root the panel draws, as
 * the user asked for it — "by default + creates a workspace in the first
 * configured project root". First in the panel's order, not the registered
 * list's, because the panel's order is the one the user arranged (a drag wins
 * over registration order) and the one their eye is on when they reach for the
 * button. `other` is skipped — a bucket is not a place to create in.
 *
 * Null, the dialog's own `$HOME` behaviour, only when no real root resolves:
 * no sessions and nothing registered, or `$HOME` unresolved so even the
 * derived roots have no absolute path. The picker still opens either way —
 * the default is a starting point, never a gate.
 */
const defaultStartIn = computed<string | null>(() => {
  const first = roots.value.find((root) => !root.other);
  return first ? rootAddPath(first) : null;
});

// ---------------------------------------------------------------------------
// The keyboard door to the same flow: `sessions.new` (Ctrl+Shift+N)
// ---------------------------------------------------------------------------
//
// The chord is the header `+`'s, on the keyboard — the registry carries the
// reasoning and Settings renders it. Like the tab arrows this runs on `window`
// in CAPTURE, because the picker must open with focus wherever it happens to
// be: the pane, the tree, a tab strip. The panel is `v-show`'d rather than
// unmounted when collapsed, so the listener stays live with the panel hidden —
// right, since the `+` is also on screen only as a matter of layout, and a
// collapsed panel does not mean "no longer wants sessions".

function onWindowKeydown(e: KeyboardEvent): void {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey) return;
  if (!isShortcut(settings.shortcutBindings, 'sessions.new', e)) return;
  // Not while prose is being typed — the picker's own filter included, where
  // Ctrl+Shift+P would otherwise close nothing and re-open the caret elsewhere.
  if (editingTarget(e.target)) return;
  // Already open: the dialog is the palette, and the second press must not
  // reset the browse the user is mid-way through. Escape closes it.
  if (creating.value) return;
  e.preventDefault();
  e.stopPropagation();
  creating.value = { startIn: defaultStartIn.value };
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, { capture: true }));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, { capture: true }));

/**
 * The roots the creation picker's dropdown offers, resolved to absolute paths
 * and stripped of anything that did not resolve — `other` because a bucket is
 * not a place to create in, null paths because a menu item that cannot be
 * followed is a broken promise on screen. The LABEL stays the panel's
 * home-relative key (`~/git`), which is the spelling every root row above the
 * dialog already teaches the user to recognise.
 */
const createRoots = computed<{ label: string; path: string }[]>(() =>
  roots.value
    .filter((root) => !root.other)
    .map((root) => ({ label: root.key, path: rootAddPath(root) }))
    .filter((r): r is { label: string; path: string } => r.path !== null),
);

/**
 * Folder tooltip: the full path, the session count, and the session NAMES.
 *
 * The names are here because they are no longer on screen — the workspace's
 * tab bar carries them, which is behind a click. One hover is the cheapest
 * place to answer "what is actually in here" without spending a row per
 * session again, and it is capped so a folder with a dozen sessions produces a
 * tooltip rather than a wall.
 *
 * An untracked folder says so instead of printing a path it does not have, and
 * one whose path was adopted from a sibling says THAT, because a guess
 * presented as a reported cwd is the kind of thing that wastes an hour
 *
 */
const TOOLTIP_NAME_LIMIT = 6;

function dirTooltip(dir: SessionDirectory): string {
  const lines: string[] = [];
  if (dir.untracked) {
    lines.push(
      dir.inferredRoot
        ? 'no reported folder — root read back from the name'
        : 'no reported folder',
    );
  } else {
    lines.push(dir.path);
    if (dir.rows.some((row) => row.session.pathInferred)) {
      lines.push('folder inferred from the session name, not reported by tmux');
    }
  }
  lines.push(sessionCountLabel(dir.rows.length));
  const names = dir.rows.slice(0, TOOLTIP_NAME_LIMIT).map((row) => `  ${row.session.name}`);
  lines.push(...names);
  if (dir.rows.length > TOOLTIP_NAME_LIMIT) {
    lines.push(`  … and ${dir.rows.length - TOOLTIP_NAME_LIMIT} more`);
  }
  return lines.join('\n');
}

/* ── Dragging a folder row up and down ───────────
 * > "but I can also pull them up and down to rearraange"
 *
 * The same native HTML5 drag the workspace's tab bar uses, turned ninety
 * degrees. It is deliberately the same family and not a
 * pointer-events implementation of its own: the two are one gesture in the
 * user's hands — drag a thing along the strip it lives in — and a panel that
 * felt different from the tab bar would be a second thing to learn for nothing.
 *
 * All three of the rules the tab drag obeys carry over unchanged:
 *
 *   - **the drag does not fight the click.** A row is a `<button>` that
 *     navigates, and native DnD suppresses the `click` that would otherwise
 *     follow a drag — which is exactly what the tab bar already relies on for
 *     its own `<button class="tab" draggable>`. So dragging a row does not open
 *     its workspace, and nothing here has to guess at a threshold or swallow a
 *     click after the fact. The row's other behaviours are untouched for the
 *     same reason: the context menu is a right-button gesture and a drag is a
 *     left-button one, and `draggable` changes nothing about the keyboard, so
 *     Enter/Space still activate the row and `Ctrl+↑`/`Ctrl+↓` still walk it.
 *   - **the dragged row fades but stays in place.** Removing it from the flow
 *     would shift every row below it the instant the drag began, moving the
 *     target the user is aiming at at precisely the wrong moment.
 *   - **the landing place is drawn**, as a 2px accent rule in the gap. Without
 *     it a reorder is "let go and find out", and the one rule this drag
 *     enforces — a row cannot leave its root — is invisible unless something
 *     draws it. A refused drop draws nothing, and that absence IS the refusal.
 */
const FOLDER_DRAG_TYPE = 'application/x-pocketshell-folder';

// The drag MECHANICS (payload, midpoint rule, drop-target marking) live in
// useStripDrag, the tab bar's composable; the folder list keeps its own
// indicator shape — root plus gap, because the panel renders one indicator per
// root — and its own policy in the handlers below.
const { dragging, startDrag, gapFor, markDroppable, endDrag } = useStripDrag({
  dragType: FOLDER_DRAG_TYPE,
  axis: 'y',
});
/** The folder key being dragged, and the gap the drop indicator is sitting in. */
const dropTarget = ref<{ root: string; gap: number } | null>(null);

function onRowDragStart(dir: SessionDirectory, e: DragEvent): void {
  startDrag(dir.key, e);
  dropTarget.value = null;
}

/**
 * The pointer is over row [index] of [root].
 *
 * `root` is the root the pointer is IN, not the one the drag started in, and
 * that is what refuses a cross-root drag without this handler knowing anything
 * about roots: `canDropFolderAt` asks whether the dragged key is one of THIS
 * root's rows, and a key from `git` is not one of `tmp`'s. A root is a real
 * directory on the host, so a row that moved out of it would be a claim about
 * where the folder lives — see `folderOrder.ts` for the whole argument.
 */
function onRowDragOver(root: SessionRootFolder, index: number, e: DragEvent): void {
  const from = dragging.value;
  if (from === null) return;
  const gap = gapFor(index, e);
  // REFUSED VISIBLY: no indicator, and no `preventDefault`, so the pointer
  // keeps its `no-drop` cursor. A drop that is accepted and then snaps back
  // reads as a bug; one that never lights up reads as a rule.
  if (!canDropFolderAt(root, from, gap)) {
    dropTarget.value = null;
    return;
  }
  markDroppable(e);
  dropTarget.value = { root: root.key, gap };
}

/**
 * Commit the drag.
 *
 * `reorderFolders` is handed `roots.value` — the list as the panel is drawing it
 * THIS instant, poll and all — and returns the whole panel's keys in draw
 * order, which is what gets stored. It returns null for a move that ended where
 * it started, and writing then would persist an arrangement for nothing.
 *
 * Nothing here re-sorts anything. The store holds a ranking, `folderTree.ts`
 * applies it to whatever the next refresh brings, and this handler's only job is
 * to write the ranking down — which is why a drag survives the five-second poll
 * instead of racing it.
 */
function onRowDrop(): void {
  const from = dragging.value;
  const target = dropTarget.value;
  endDrag();
  dropTarget.value = null;
  if (from === null || target === null) return;
  const next = reorderFolders(roots.value, from, target.gap);
  if (next) settings.setFolderOrder(host.value, next);
}

function onRowDragEnd(): void {
  endDrag();
  dropTarget.value = null;
}

/* ── The folder row's context menu ─────────────────────────────────────────
 * A root row has a `+` and the header has a `+`, and between them they cover
 * "a session under `git`" and "a session anywhere". What neither covers is the
 * case the user actually hit: standing in front of the row that says
 * `dataqna`, wanting another session IN `dataqna`, and having to open the
 * picker at `~/git` and browse back down to the folder already under the
 * cursor. The row knows its own directory; the only thing missing was a way to
 * ask it.
 *
 * A right-click rather than another revealed `+`. The row is already tight —
 * dot, label, up to two badges, a count and a timestamp, in a panel that drags
 * down to 232px, where the container query has already had to drop the
 * timestamp — and the `+` on the root above it is the mark whose whole
 * justification (see `.root-add`) was that one per ROOT is a tolerable number
 * of identical marks to run down a scannable panel. One per FOLDER is not.
 *
 * `PopupMenu` rather than an absolute dropdown, for the reason that component
 * exists: `.folder-list` is `overflow-y: auto`, so a menu laid out inside a row
 * is clipped at the list's edge and a row near the bottom would open a menu
 * nobody can see. It teleports to `body` and positions from a measured
 * viewport rect, which is what a menu on a scrolling list needs.
 */
const folderMenu = ref<{
  label: string;
  startIn: string | null;
  /**
   * The sessions in the folder, snapshotted at open time.
   *
   * Same rule as `startIn` below, and it matters more here: this is the list a
   * confirmed Stop kills. Re-read at click time it could have grown on the
   * poll, and the folder would lose a session the user was never shown and
   * never agreed to lose. Each entry carries the row's aplexer address with
   * it, because a tag alone does not address an aplexer session.
   */
  sessions: { name: string; workspace: string | null; aplexerId: string | null; backend: 'tmux' | 'aplexer' }[];
  anchor: Box;
} | null>(null);

/**
 * Right-click a folder row.
 *
 * The absolute directory is resolved HERE, at open time, and parked in the
 * menu's own state rather than re-derived when the item is clicked. Same
 * reasoning as `creating` holding one object instead of a boolean and a path:
 * the poll re-reads the session list every few seconds, so `home` and the row
 * set can both move between the right-click and the click on the item. Resolved
 * once, the enabled/disabled state the user SAW and the folder the dialog gets
 * cannot disagree; re-derived, they could, and the way that failure presents is
 * a session created somewhere the user did not point at.
 *
 * `rootHostPath` is named for the root row's `+` but it is not root-specific —
 * it is the inverse of `directoryKey`, and `dir.path` is exactly what
 * `directoryKey` produced (`~/git/dataqna`). Reusing it is what keeps one rule
 * for turning a grouping key back into a real host directory, rather than a
 * second expansion free to drift from the first. It answers null for an
 * untracked folder, which is the case the item is disabled for.
 *
 * Nothing here selects the row, and that is deliberate — the workspace's tab
 * menu takes the same position. A right-click the user then dismisses would
 * otherwise have already navigated them somewhere else.
 */
function openFolderMenu(dir: SessionDirectory, e: MouseEvent): void {
  folderMenu.value = {
    label: dir.label,
    startIn: rootHostPath(dir.path, home.value),
    sessions: dir.rows.map((row) => ({
      name: row.session.name,
      workspace: row.session.workspace ?? null,
      aplexerId: row.session.aplexerId ?? null,
      backend: row.session.backend ?? 'tmux',
    })),
    anchor: pointAnchor(e.clientX, e.clientY),
  };
}

/**
 * "New session…" from the row's menu: the same folder-first dialog both `+`s
 * open, handed the folder the user right-clicked.
 *
 * The dialog still opens its picker rather than skipping to a confirmation,
 * because `startIn` is where the browse LANDS and not a folder already chosen.
 * That is the honest shape for it: a folder row is a strong hint about where
 * the session goes, not a commitment, and the one step the user is spared —
 * browsing back down to a directory they had already pointed at — is the whole
 * of the complaint.
 *
 * The null guard is a second line rather than the only one: the item renders
 * disabled in that case, so this is unreachable through the UI. It stays
 * because "disabled in the template" and "cannot start" are two statements of
 * one fact, and the one that must not be skippable is this one — a `startIn`
 * of null does not fail, it silently means "$HOME", which is the wrong folder
 * rather than no folder.
 */
function createInFolder(): void {
  const target = folderMenu.value;
  folderMenu.value = null;
  if (!target || target.startIn === null) return;
  creating.value = { startIn: target.startIn };
}

/* ── Stopping every session in a folder ───────────────────────────────
 * The row's second item, and the mirror of the first: `New session…` exists
 * because the row knows a folder the picker would otherwise make the user
 * browse back down to, and this exists because the row stands in for a SET of
 * sessions that has no other single lever. The workspace's tab menu can stop
 * one session; stopping a folder's four means opening
 * that workspace and confirming four times.
 *
 * It is called Stop, not Close, and that is not a synonym chosen at random.
 * `Close` in this app closes a TAB and leaves the session running; the word for
 * killing the tmux session is `Stop`, on the tab menu and in its dialog. Two
 * words for one destructive act, in two menus a click apart, is how a user ends
 * up believing one of them is the safe one.
 *
 * Everything the single-kill rule says holds here and is multiplied: no
 * undo, and each session is usually an agent mid-task. So the item is
 * separated, tinted, and behind a confirmation that NAMES the sessions — which
 * matters more from this panel than from the tab bar, because a folder row does
 * not show them. The one thing the user can see is a count.
 */
const stopping = ref<{
  label: string;
  sessions: { name: string; workspace: string | null; aplexerId: string | null; backend: 'tmux' | 'aplexer' }[];
} | null>(null);
const stopBusy = ref(false);
/**
 * A refused batch, reported under the tree beside the store's own error.
 *
 * Separate from `sessions.error` on purpose: that ref belongs to the listing
 * and the poll rewrites it every five seconds, so a kill's refusal parked there
 * would be erased by the next successful tick — seconds after the user asked
 * for something that did not happen.
 */
const stopError = ref<string | null>(null);

/** `Stop session…` / `Stop all 3 sessions…` — the menu item's words. */
function stopFolderLabel(count: number): string {
  return count === 1 ? 'Stop session…' : `Stop all ${count} sessions…`;
}

function askStopFolder(): void {
  const target = folderMenu.value;
  folderMenu.value = null;
  if (!target || !target.sessions.length) return;
  stopError.value = null;
  stopping.value = { label: target.label, sessions: target.sessions };
}

/**
 * Kill the folder's sessions, one at a time, and report what survived.
 *
 * SEQUENTIAL rather than `Promise.all`, for two reasons that both point the
 * same way. Each kill is an ssh exec on the user's host, and firing a folder's
 * worth at once is the load the session poll is already guarded against; and a
 * partial failure has to be reportable by NAME, which a settled array can give
 * but which is much easier to get wrong when the failures interleave.
 *
 * `not-found` counts as success, exactly as the single kill treats it
 *: the panel refreshes on a timer, so a session that
 * went away between the right-click and the confirm is the ordinary case, and
 * the state the user asked for is the state that exists.
 *
 * The refusal is worded as the tab bar words its own (`createError`): the
 * session in double quotes, and the host's sentence carried rather than
 * replaced. It names the sessions instead of counting them — `1 of 2` says how
 * much of the folder is still up, but not WHICH, and the name is the only half
 * of that the user can act on.
 *
 * The local teardown is per session too, and only for the ones that actually
 * died. The row leaves the store through `sessions.removeLocal` the moment
 * its kill resolves: the host's listing can lag the kill by seconds (`a kill`
 * answers ok once the worker accepts the stop, and the record leaves the
 * snapshot only when the worker has finished terminating the workload), and
 * until it catches up, a dead session that still looks live keeps its tab on
 * the bar and its "[process exited]" pane mounted underneath — precisely the
 * state a confirmed Stop exists to end. The composer record is dropped with
 * it, the third step of the stop sequence. The pool's client goes main-side from
 * the ipc handler whatever the caller is, and the workspace's mounted pane
 * unmounts as a consequence of the row: `sessionPanes` is filtered against
 * the live tabs, so a session that leaves the store takes its terminal with
 * it this tick, not on the listing's.
 *
 * The refresh runs even when everything failed. The list is what the user is
 * looking at, and it has to agree with the host whichever way the batch went.
 */
async function confirmStopFolder(): Promise<void> {
  const target = stopping.value;
  const connectionId = connection.connectionId;
  if (!target || !connectionId) {
    stopping.value = null;
    return;
  }
  stopBusy.value = true;
  const failed: string[] = [];
  let reason: string | null = null;
  try {
    for (const entry of target.sessions) {
      const { name } = entry;
      const killRef =
        entry.backend === 'aplexer'
          ? {
              backend: 'aplexer' as const,
              ...(entry.workspace ? { workspace: entry.workspace } : {}),
              ...(entry.aplexerId ? { aplexerId: entry.aplexerId } : {}),
            }
          : undefined;
      let result: Awaited<ReturnType<typeof projects.killSession>>;
      try {
        result = await projects.killSession(connectionId, name, killRef);
      } catch (e) {
        // A rejected invoke counts as a failed session and the batch moves
        // on — aborting the loop used to leave the remaining sessions
        // untouched with no report of any kind.
        failed.push(name);
        if (reason === null) reason = errorMessage(e);
        continue;
      }
      if (!result.ok && result.code !== 'not-found') {
        failed.push(name);
        if (reason === null) reason = result.error ?? null;
        continue;
      }
      // The row goes now, not when the refresh lands — the listing the
      // refresh asks for can still carry the session for a while after the
      // kill (see this function's doc comment).
      sessions.removeLocal(name, entry.workspace ?? undefined);
      composer.forget(
        composer.targetKey(
          connectionId,
          name,
          sessionIdentityKey(name, { backend: entry.backend, workspace: entry.workspace ?? undefined }),
        ),
      );
    }
  } finally {
    // Whatever the batch did, the latch must lift: a `stopBusy` left true
    // disables the Stop action until the component remounts.
    stopBusy.value = false;
    stopping.value = null;
  }
  if (failed.length) {
    const names = failed.map((name) => `"${name}"`).join(', ');
    stopError.value = `Could not stop ${names} in ${target.label}.` + (reason ? ` ${reason}` : '');
  }
  await sessions.refresh(connectionId);
}

async function onRefresh(): Promise<void> {
  if (connection.connectionId) await sessions.refresh(connection.connectionId);
}

/**
 * A folder-first session just came up on the host: file it and open its
 * folder, with the new session selected.
 *
 * There is deliberately NO refresh here. The dialog's emit carries the full
 * row — name, folder, backend, aplexer id (`StartSessionResult` projected by
 * `summaryFromStartResult`) — so {@link sessions.addPending} puts it in the
 * tree immediately and the lookup below finds the folder on the same tick.
 * The refresh used to stand right here, awaited, and it is the slowest call
 * in the app (`pocketshell sessions list` is a Python program under a login
 * shell); standing between the click and the workspace it put the whole cost
 * of a listing on the create path. The panel's five-second poll — and any
 * other refresh — later replaces the optimistic row with the authoritative
 * one; until then the row already knows everything the tree and the workspace
 * ask of it.
 *
 * When the lookup misses — the grouping filed the row somewhere else, or not
 * at all — nothing is emitted and the panel simply shows what it has. That is
 * a deliberate downgrade from the old behaviour, which synthesised a summary
 * and routed to it: a session route only needed a name, and a folder route
 * needs a folder we do not have. Inventing one would put the user in a
 * workspace for a directory that does not exist.
 *
 * This navigation now carries a second job it does not know about, and that is
 * the point of it not knowing: when the dialog collected an AGENT as well as a
 * folder, the choice is parked in
 * `renderer/pendingAgentLaunch.ts` and `FolderWorkspaceView` collects it on
 * arrival, because typing the wrapper line needs a PTY and this panel has
 * none. So the launch rides the route change the panel was already making,
 * rather than the panel growing a terminal-shaped responsibility.
 */
function onSessionStarted(summary: SessionSummary): void {
  creating.value = null;
  sessions.addPending(summary);
  for (const root of roots.value) {
    const dir = root.directories.find((d) => d.rows.some((r) => r.session.name === summary.name));
    if (dir) {
      emit('select', dir, summary.name);
      return;
    }
  }
}

/**
 * Row badge for the host-recorded `@ps_agent_kind` (types.ts:103). Null,
 * undefined and `unknown` are all the phone's "Unknown" and get NO badge — a
 * foreign session we did not launch should not be labelled as if we had.
 * `shell` gets none either: a shell is the unremarkable case.
 */
function agentBadge(kind: SessionAgentKind | null | undefined): string | null {
  switch (kind) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'grok':
      return 'grok';
    case 'probing':
      return 'probing…';
    case 'exited':
      return 'exited';
    case 'shell':
    case 'unknown':
    case null:
    case undefined:
      return null;
    default:
      return null;
  }
}

/**
 * The distinct agent kinds running in a folder, in row order, deduped.
 *
 * A folder row stands in for several sessions now, so a single badge would
 * have to pick one arbitrarily. Deduping and capping is the honest compromise:
 * a folder running claude and codex says both, a folder running three claudes
 * says `claude` once, and a folder running four different engines says the
 * first two and stops rather than pushing the timestamp off the row.
 */
const FOLDER_BADGE_LIMIT = 2;

function agentBadges(dir: SessionDirectory): string[] {
  const out: string[] = [];
  for (const row of dir.rows) {
    const badge = agentBadge(row.session.agentKind);
    if (badge !== null && !out.includes(badge)) out.push(badge);
    if (out.length === FOLDER_BADGE_LIMIT) break;
  }
  return out;
}

/**
 * Compact relative age: `now`, `12m`, `3h`, `2d`, then an absolute date past a
 * week. Six characters at the very worst, against ~90px for the absolute form
 * this replaced — and that width is exactly what the label needed back.
 *
 * There is no absolute-form companion any more. It existed for the session
 * row's tooltip, and the session rows are gone; a folder row's tooltip names
 * the folder and its sessions, which is what a folder is asked about.
 */
function fmtRelative(epochSeconds: number): string {
  if (!epochSeconds) return '';
  const seconds = Math.max(0, Math.floor(now.value / 1000) - epochSeconds);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}


</script>

<template>
  <div class="tree">
    <!-- The `SESSIONS` word is gone, and its width is what paid for the host
         actions arriving here. See the header strip below. -->
    <div class="tree-header">
      <button class="icon-btn" title="Back to hosts" @click="emit('back')">
        <AppIcon name="arrow-left" :size="14" />
      </button>
      <!-- ORDER: `+`, ports, usage, refresh, settings, hide.
           The last four are the user's, given as "here have ... then refresh
           then settings then hide" against a screenshot of this strip; the current order
           expanded their `⋯` into its two contents at the same user's ask. The
           `+` leads because it is the panel's primary action and the others are
           chrome.

           WIDTH, at the 232px drag floor, because this strip is again full:
           seven --control-h squares (7×28 = 196) plus six --sp-1 gaps (24) is
           220px, in a content box of 232 − 8 − 4 = 220. It fits EXACTLY, with
           no shrink and nothing clipped, and that is why the right padding is
           --sp-1 against the left's --sp-2 (see .tree-header). There is no room
           for an eighth: the next control added here has to displace one or
           move the floor again — MIN_PANEL_WIDTH in HostWorkspaceView.vue and
           .tree's min-width below pin it together. -->
      <div class="header-actions">
        <!-- The general `+`: a session starting in the panel's first root
             (defaultStartIn), still free to browse anywhere from there. It is
             what replaced the panel's full-width foot button, and it is the
             reason that removal is safe — this control is on screen whatever
             the panel holds, including when it holds nothing at all, so there
             is never a window with no way to create a session. -->
        <button
          class="icon-btn"
          title="New session in any folder"
          @click="creating = { startIn: defaultStartIn }"
        >
          <AppIcon name="plus" :size="14" />
        </button>
        <!-- Ports and Usage as their own buttons. Their words live in
             the tooltips — which double as accessible names — exactly where the
             retired `⋯` trigger kept "Ports, Usage". `auto-forward` drives the
             Ports button's on-air indicator and `forward-count` its live-ports
             pill; the workspace owns both states. -->
        <HostPanelButtons
          :auto-forward="autoForward"
          :forward-count="forwardCount"
          @select="openPanel"
        />
        <button class="icon-btn" :disabled="sessions.loading" title="Refresh" @click="onRefresh">
          <AppIcon name="refresh" :size="14" :class="{ spin: sessions.loading }" />
        </button>
        <!-- The gear, back out of the overflow menu at the user's request. It
             is the one of the three that can be icon-only without becoming a
             memory test: this exact mark opens settings on the host picker and
             everywhere else in the app, so it is recognised rather than
             remembered. -->
        <button class="icon-btn" title="Settings" @click="openPanel('settings')">
          <AppIcon name="settings" :size="14" />
        </button>
        <button class="icon-btn" title="Hide session panel" @click="emit('collapse')">
          <!-- VS Code's "toggle sidebar" mark: truer to the action than a
               hamburger, which promises a menu. -->
          <AppIcon name="panel-left" :size="14" />
        </button>
      </div>
    </div>

    <!-- `dragend` sits on the LIST, not on the row: it fires on the source
         element and bubbles, so one listener here covers every row and — more
         to the point — covers the cancelled drag, where the pointer was
         released over something that is not a row at all. Without it a drag
         abandoned over the header would leave the dragged row faded forever.
         Same placement, same reason, as the tab strip's `<nav @dragend>`. -->
    <div class="folder-list" @dragend="onRowDragEnd">
      <section v-for="{ root, header } in rootRows" :key="root.key" class="folder">
        <!-- A plain element, not a <button>, and no disclosure mark: now that
             sessions live in workspace tabs the panel is root -> folder, and a
             root row is a grouping HEADER over its folders rather than a node
             with something hidden under it. A chevron here would advertise an
             interaction that does not exist, so the row is not interactive at
             all — the tooltip is the only thing it still offers, and it carries
             real information (the root's path and its size).

             ROOT ROWS ARE DELIBERATELY ALWAYS OPEN. If collapsing ever comes
             back, it must NOT be driven off the root list: `roots` recomputes
             every time the sessions store refreshes on its timer, so anything
             that reopens roots on recompute would reopen one the instant the
             user closed it. The state removed here dodged that by watching the
             ACTIVE FOLDER instead, so a deliberate collapse survived until the
             user navigated somewhere else. That is the trap, written down. -->
        <div class="folder-header" :title="rootTooltip(root)">
          <!-- The dot is how a root reports attachment in ONE mark: a reader
               scanning the headers sees which roots have something live in them
               without reading the folder rows underneath, and on a registered
               root with nothing running it is the difference between "quiet"
               and "not loaded". -->
          <span class="dot" :class="{ active: root.active }" />
          <!-- The header names the real directory — `~/git`, not `git` — with
               the `~/` in its own span so it can recede. It is the part every
               root repeats, so it is the part worth toning down; see
               `rootHeaderParts` for the three keys that carry no `~/` at all
               and must not be given one. -->
          <span class="folder-label" :class="{ bucket: root.other }">
            <!-- No whitespace between the two: a newline here is a text node,
                 and the header would read `~/ git`. -->
            <span v-if="header.prefix" class="path-prefix">{{ header.prefix }}</span>{{ header.text }}
          </span>
          <!-- Beside the label, not pinned to the right edge. A count thrown to
               the far end of the row reads as its own column — "10" floating
               level with `git` but nowhere near it — and the user asked for it
               back: "move 10 closer to git". The `+` takes over the
               `margin-left: auto` and keeps the right end of the row. -->
          <span class="folder-count muted">{{ root.sessionCount }}</span>
          <!-- Per-root `+`: create a session UNDER THIS ROOT. It opens the same
               folder picker the header's `+` does, one level in — the root is
               known, the folder is not, and guessing a directory from a root is
               how you get a session in the wrong place.

               NOT on `other`. That row is a bucket for paths that matched no
               root, not a directory, so there is nowhere for the picker to
               start; the header's `+` already covers "somewhere else".

               `@click.stop` even though the row takes no click today. The row
               is deliberately inert (see the comment above), but "deliberately"
               is a decision that can be revisited, and a `+` that also selects
               the row it sits on is a bug that would arrive silently the moment
               it were. One modifier now, or a mystery later.

               `:title` carries the destination, because the mark alone cannot
               say WHICH root it belongs to once the eye is on the right of the
               row rather than the left. -->
          <button
            v-if="!root.other"
            class="icon-btn sm root-add"
            :disabled="rootAddPath(root) === null"
            :title="
              rootAddPath(root) === null
                ? `cannot resolve $HOME on this host, so ${root.label} has no directory to start in`
                : `New session in ${root.key}`
            "
            @click.stop="creating = { startIn: rootAddPath(root) }"
          >
            <AppIcon name="plus" :size="12" />
          </button>
        </div>

        <ul class="dir-list">
          <!-- Only a REGISTERED root can be empty; a derived one exists because
               a session is in it. Saying so beats a header with nothing under
               it, which reads as a failed load — and there is no collapsed
               state left to blame it on. -->
          <li v-if="!root.directories.length" class="empty-root muted">no sessions here yet</li>

          <!-- ONE ROW PER FOLDER. Not a header over a list any more: the row
               IS the destination, and what used to be its children are the
               tabs in the workspace it opens. Rendered as a <button> because
               it is a control that navigates, and marked `current` by the
               folder key so a workspace holding four session tabs still
               highlights exactly one row. -->
          <!-- The drop indicator lives on the `<li>`, not on the button: the
               button already spends its left border on the selection rail, and
               a landing rule drawn on the same element would have to fight it
               for the one border the row has. -->
          <li
            v-for="(dir, i) in root.directories"
            :key="dir.key"
            :class="{
              'drop-above': dropTarget?.root === root.key && dropTarget.gap === i,
              'drop-below':
                dropTarget?.root === root.key &&
                dropTarget.gap === root.directories.length &&
                i === root.directories.length - 1,
            }"
          >
            <!-- `draggable` for the "pull them up and down" drag. It changes
                 nothing about the click, the context menu or the keyboard —
                 see the drag section in the script for why each of those is
                 safe rather than merely untested. -->
            <button
              class="dir-header"
              :class="{
                current: dir.key === props.activeFolder,
                orphan: dir.untracked,
                attached: dir.active,
                dragging: dragging === dir.key,
              }"
              :title="dirTooltip(dir)"
              draggable="true"
              @click="emit('select', dir)"
              @contextmenu.prevent="openFolderMenu(dir, $event)"
              @dragstart="onRowDragStart(dir, $event)"
              @dragover="onRowDragOver(root, i, $event)"
              @drop.prevent="onRowDrop"
            >
              <!-- The dot says "something live is in here". It used to be an
                   aggregate standing in for a collapsed branch; now it is the
                   only place the panel reports attachment at all, because the
                   sessions it belonged to are no longer rows. -->
              <span class="dot" :class="{ active: dir.active }" />
              <!-- One span, one CSS ellipsis: when the row runs out of width
                   the label degrades to `course-managemen…` and the tooltip
                   carries the full name (the full path) on hover. An untracked
                   folder is labelled by its session name, which is the only
                   label it has. -->
              <span class="label" :class="{ mono: dir.untracked }">{{ dir.label }}</span>
              <!-- Counted only from 2 up. The `1` is the dead field the original measurement ruled out — see
                   SESSIONLIST measured: every folder row stands for at least
                   one session, so saying so on most of them is noise.
                   IMMEDIATELY AFTER THE LABEL, ahead of the badges, for the
                   same reason the root's count moved: a reader scans ONE column
                   of rows, and a count that hugs its label on the header row
                   and floats to the right edge on the rows underneath would be
                   two conventions in one list. The badges follow, and the time
                   keeps the right edge. -->
              <span v-if="dir.rows.length > 1" class="folder-count muted">
                {{ dir.rows.length }}
              </span>
              <span
                v-for="badge in agentBadges(dir)"
                :key="badge"
                class="agent-badge"
                :class="{ dim: badge === 'probing…' || badge === 'exited' }"
              >
                {{ badge }}
              </span>
              <!-- The folder's age is its NEWEST session's, and it is now
                   INDEPENDENT of where the row sits: the list is in the host's
                   order plus the user's own arrangement, so times run in
                   no particular direction down a root. That is a cost of the
                   change and it is paid deliberately — an order you can predict
                   is worth more than one that happened to double as a sort key
                   — and it makes this field carry MORE than it used to rather
                   than less, since position no longer says any of it. -->
              <span class="row-time">{{ fmtRelative(dir.mostRecentActivity) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <!-- Nothing running anywhere on this host. The sentence used to stand
           alone, which made this the one empty state with no way forward: the
           header's `+` covers it in principle, but it is an unlabelled 14px
           mark in a strip of five, and an empty panel is exactly when a user
           has no habits to find it by. The folder workspace's own empty state
           set the pattern ("nothing is running in this folder" + a worded
           "Start a session here" button, FolderWorkspaceView.vue): say what is
           empty AND offer the one useful action. The button opens the same
           dialog the header `+` does, nothing pre-filled — a second door into
           the ONE creation flow, not a second flow. -->
      <div v-if="!roots.length && !sessions.loading" class="empty">
        <p class="muted">no sessions</p>
        <button class="btn-ghost" @click="creating = { startIn: defaultStartIn }">
          New session…
        </button>
      </div>
    </div>

    <!-- The full-width `New session` button that used to sit here is GONE. It
         was the panel's one primary action and it spent a bordered 44px foot
         row saying so, permanently, for a flow that now has two better doors:
         the `+` in the header (the first root, browsable anywhere) and the `+`
         on each root (this root). Both are always on screen, so nothing was
         traded away — and the foot row's real cost was that it answered
         "where?" with a browse starting at `$HOME` even when the user had just
         pointed at `git`.

         Folder-first, not name-first, still: the dialog opens a picker rather
         than a text field, because the session name is DERIVED from the folder
         and typing one produced sessions that no other client could group. -->
    <p v-if="sessions.error" class="error">{{ sessions.error }}</p>
    <!-- A refused batch, with its own dismiss because nothing else clears it:
         the listing's error is rewritten by the poll, and this one has to
         outlive the refresh that runs immediately after the kills. -->
    <p v-if="stopError" class="error stop-error">
      <span>{{ stopError }}</span>
      <button class="icon-btn sm" title="Dismiss" @click="stopError = null">
        <AppIcon name="close" :size="12" />
      </button>
    </p>

    <!-- Right-clicking a folder row. Two items, and both are things the ROW can
         offer that nothing else can: it knows the folder, so the picker opens
         IN it instead of at `$HOME` with the user browsing back down to where
         they were already pointing; and it stands in for the whole SET of
         sessions in that folder, which is the only lever that stops them
         together rather than one workspace tab at a time.

         Separated and tinted, the tab menu's rule: the
         separator says "another group", the `--error` colour says "another KIND
         of thing", and the one item here that can lose work must not look like
         the one that cannot.

         `.prevent` on the handler, not a global suppression: in a packaged
         Electron app the default here is Chromium's own menu, which carries
         nothing that applies to a session row. It is the same `.prevent` the
         file tree's rows and the workspace's session tabs use — the
         application MENU BAR is a separate thing, nulled in main (169cf60),
         and neither disarms the other.

         DISABLED rather than absent when the folder has no directory we can
         resolve — an untracked session, or a `~`-keyed folder on a host whose
         `$HOME` never came back. Same rule the root `+` follows and for the
         same reason: the action is real and the host is temporarily unable to
         answer, so the title says which of those it is. An item that quietly
         vanishes reads as a feature that was never there. -->
    <PopupMenu
      v-if="folderMenu"
      :anchor="folderMenu.anchor"
      :label="`Actions for ${folderMenu.label}`"
      @close="folderMenu = null"
    >
      <ul>
        <li class="menu-head">{{ folderMenu.label }}</li>
        <li>
          <button
            class="menu-item"
            :disabled="folderMenu.startIn === null"
            :title="
              folderMenu.startIn === null
                ? `${folderMenu.label} has no directory on this host to start a session in`
                : `Start a session in ${folderMenu.startIn}`
            "
            @click="createInFolder"
          >
            <AppIcon name="plus" :size="14" />
            New session…
          </button>
        </li>
        <li class="menu-sep" />
        <li>
          <!-- Never disabled in practice — a folder row exists because sessions
               are in it — but the count is read from the same snapshot the
               confirm kills, so an empty one would offer to stop nothing. -->
          <button
            class="menu-item danger"
            :disabled="!folderMenu.sessions.length"
            :title="`Stop ${sessionCountLabel(folderMenu.sessions.length)} on the host`"
            @click="askStopFolder"
          >
            {{ stopFolderLabel(folderMenu.sessions.length) }}
          </button>
        </li>
      </ul>
    </PopupMenu>

    <!-- The confirm, the tab menu's dialog with the
         one change the plural forces: it LISTS the sessions.

         A folder row shows a dot, a label and a count — never the session
         names — so "Stop all 3 sessions in dataqna?" would ask the user to
         agree to three things they cannot see. The tab menu could name one
         session because the tab was under the cursor; here the names have to be
         put on screen before the question means anything. The list scrolls
         rather than growing the sheet, so a folder with a dozen sessions
         produces a dialog rather than a page.

         Cancel is the quiet button and Stop carries the error fill, so the
         dangerous half is the half that has to be aimed at. -->
    <OverlayPanel
      v-if="stopping"
      :title="stopping.sessions.length === 1 ? 'Stop session' : 'Stop sessions'"
      size="sm"
      @close="stopping = null"
    >
      <div class="stop-confirm">
        <!-- One session: the tab menu's sentence, word for word, naming the
             session rather than counting it — and no list, which could only
             repeat the name the question already carries. -->
        <p v-if="stopping.sessions.length === 1">Stop <code>{{ stopping.sessions[0]?.name }}</code> ?</p>
        <template v-else>
          <p>
            Stop {{ sessionCountLabel(stopping.sessions.length) }} in
            <code>{{ stopping.label }}</code> ?
          </p>
          <ul class="stop-list">
            <li v-for="entry in stopping.sessions" :key="entry.name"><code>{{ entry.name }}</code></li>
          </ul>
        </template>
        <p v-if="stopping.sessions.length === 1" class="muted">
          This kills the session on the host. Anything running in it stops, its scrollback
          goes, and there is no undo.
        </p>
        <p v-else class="muted">
          This kills each session on the host. Anything running in them stops, their
          scrollback goes, and there is no undo.
        </p>
        <footer class="actions">
          <button class="btn-secondary" @click="stopping = null">Cancel</button>
          <button class="btn-danger" :disabled="stopBusy" @click="confirmStopFolder">
            {{
              stopBusy
                ? 'Stopping…'
                : stopping.sessions.length === 1
                  ? 'Stop session'
                  : `Stop ${stopping.sessions.length} sessions`
            }}
          </button>
        </footer>
      </div>
    </OverlayPanel>

    <NewSessionDialog
      v-if="creating"
      :start-in="creating.startIn"
      :roots="createRoots"
      @started="onSessionStarted"
      @close="creating = null"
    />
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  /* Flex-sized, not height:100%: the host panel is a flex column now, with
     the workspace's host-actions row below this component. The tree takes
     everything above it. Surface and the panel's right hairline moved to the
     aside for the same reason — a border on this element alone would stop
     short of that row. */
  flex: 1 1 auto;
  min-height: 0;
  /* Matches HostWorkspaceView's MIN_PANEL_WIDTH (232px since the header strip forced the
     strip its seventh square; before that both were 200, and before THAT this
     was 240, silently contradicting the drag clamp of the day). */
  min-width: 232px;
  /* Query container for the narrow-panel rule at the bottom of this block. */
  container-type: inline-size;
}
/* The workspace's top-left row, same --topbar-h as the session bar across the
   splitter, so the two headers read as one line.

   The LEFT padding is --sp-2, not --sp-3: ghost icon buttons carry their own
   inner inset, and the old padding plus theirs pushed the back arrow visibly
   off the panel's left rhythm.

   The RIGHT padding is --sp-1, and the asymmetry is doing work rather than
   drifting. The left end is a single arrow whose glyph lines up with the dots
   and labels below it; the right end is a RUN of seven ghost squares, each
   already carrying ~7px of its own optical inset, so a further 8px there is
   inset on top of inset. Halving it is also exactly what makes the strip fit
   the 232px drag floor with nothing shrunk — the arithmetic is in the template,
   above `.header-actions`. The alignment argument and the width arithmetic want
   the same thing, which is the only reason to spend an asymmetry on it. */
.tree-header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-1) 0 var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
}
.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.folder {
  margin-bottom: var(--sp-1);
}
/* A <div>, so the button reset this used to carry — background, border, color,
   text-align, cursor, font-family/size/line-height — is all gone: everything in
   that list is either the element's own default or inherited from `body`. Only
   the weight is a real decision and it stays.

   The row still gets no BACKGROUND on hover: a lift under the cursor advertises
   a click, and this row does not take one. The `:hover` rule it does have
   reveals the `+` inside it and touches nothing else, which says the opposite
   of a lift — the row is inert, and the one thing in it that is not says so by
   appearing. */
.folder-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--row-pad-x) 0 var(--sp-3);
  font-weight: var(--fw-semibold);
  overflow: hidden;
}
.folder-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The `~/` every root header repeats, receding so the part that IDENTIFIES the
   root is what the eye lands on. A colour rather than an opacity, and on its
   own span rather than on the label: `opacity` on the label would fade `git`
   too, which is the one word in the row that has to stay crisp.

   `--fg-muted` rather than `--fg-secondary` — one step further down than the
   `other` bucket below, because that row's whole label is toned to say what
   KIND of row it is, whereas this tones a fragment inside an ordinary one. */
.path-prefix {
  color: var(--fg-muted);
}
/* `other` is a bucket, not a directory: lowered so it does not read as a
   folder the user could navigate to. */
.folder-label.bucket {
  font-weight: var(--fw-regular);
  color: var(--fg-secondary);
}
/* Bare count, no `· 3 sessions`: the number is the whole message, and the
   header is the one row per root this design is allowed to spend.

   NEXT TO THE LABEL, not pinned right. It carried `margin-left: auto`, which
   threw it to the far end of the row where `10` sat level with `git` and
   related to nothing — "move 10 closer to git". The `auto` moved to the two
   elements that genuinely want the right edge: the root row's `+` and the
   folder row's timestamp, each of which is a column in its own right. */
.folder-count {
  flex: none;
  font-weight: var(--fw-regular);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* ── The per-root `+`: revealed, not persistent ────────────────────────────
   HOVER- AND FOCUS-REVEALED, and this is the decision the control turned on.

   Persistent was the alternative and it is affordable on width — the root
   labels are short words (`git`, `tmp`) and a 24px square leaves plenty at the
   232px floor. What it is not affordable on is NOISE: one `+` per root is a
   column of identical marks running down a panel whose entire job is to be
   scanned, repeating an affordance that is identical on every row. VS Code's
   tree-row actions reach the same conclusion for the same reason.

   Two rules make the reveal honest rather than merely quiet:

     - it is `opacity`, never `display`. The square is always laid out, so the
       root label never reflows when the cursor arrives — a row that changes
       width under the pointer is worse than a mark that was always there.
     - `:focus-visible` reveals it too, so it is fully reachable by keyboard and
       VISIBLE once reached. A hover-only affordance is one a keyboard user can
       tab into and not see, which is the failure mode this pattern usually
       ships with.

   `@media (hover: none)` shows it unconditionally: a pointer that cannot hover
   would otherwise never reveal it at all.

   What it is deliberately NOT conditioned on is whether the root is empty. An
   empty registered root is the `+`'s most useful case, but `directories.length`
   changes under the sessions store's refresh timer, so keying visibility off it
   would make the control appear and disappear as sessions come and go — the
   same trap the root rows' own comment records about expansion state. Every
   root row carries the same mark, always, in the same place. */
/* `margin-left: auto` is what keeps the `+` on the right edge now that the
   count no longer holds it there. It is the one control in this row rather
   than a field, so it is the one that belongs in the right column — and
   because the square is always LAID OUT (only its opacity changes), the label
   and count never reflow when the cursor arrives. */
.root-add {
  flex: none;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.folder-header:hover .root-add,
.root-add:focus-visible {
  opacity: 1;
}
/* `.folder-header` clips (`overflow: hidden`), which would eat a +2px ring. */
.root-add:focus-visible {
  outline-offset: -2px;
}
@media (hover: none) {
  .root-add {
    opacity: 1;
  }
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* ---- dragging a folder row ---------------------
 *
 * The tab bar's three rules, turned ninety degrees (FolderWorkspaceView's
 * `.tab.dragging`): the carried row FADES BUT STAYS IN
 * PLACE, because removing it from the flow would shift every row below it the
 * instant the drag began and move the target the user is aiming at; the landing
 * place is a 2px accent rule in the gap, because without one a reorder is "let
 * go and find out"; and a REFUSED drop draws nothing at all, which is how the
 * one rule this drag enforces — a row cannot leave its root — is made visible
 * while the drag is still in the air.
 *
 * `inset` box-shadow rather than a real border, exactly as the tabs do it: a
 * border would change the row's height and shove the whole list down by 2px as
 * the indicator moved between gaps, which is the same "target moves under the
 * cursor" failure the fade is avoiding. The shadow is drawn on the `<li>`
 * because the button's own left border is already spent on the selection rail.
 */
.dir-header.dragging {
  opacity: var(--disabled-opacity);
}
.dir-list li.drop-above {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.dir-list li.drop-below {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}
/* ── The indent budget, in one place ───────────────────────────────────────
   TWO levels, and no chevron column on either of them now that a root row is a
   header rather than a node. The column both rows share is the DOT, because it
   is the one element every row type has; the labels follow it at a constant
   16px (8px dot + an --sp-2 gap).

     level        dot    label
     root          12      28
     folder        20      36

   The root's 12px is --sp-3 rather than the --sp-2 the chevron used to start
   at: with the mark gone, an 8px inset put the dot hard against the panel edge
   and the root read as unindented rather than as the outer level. The folder
   step stays 8px — 18px of padding plus its 2px selection rail — which is the
   whole of the nesting this panel expresses.

   Dropping the chevron gives every row 18px back. At the 232px panel floor the
   timestamp is already gone (see the container query at the bottom of this
   block) and a folder row has 232 - 36 - 10 = 186px for its label, badges and
   count. Truncation is the ordinary end ellipsis; the row tooltip carries the
   full name. */
/* Sits in the folder slot, but is prose rather than a row: no dot, so
   it starts where a directory LABEL starts (36) instead of where its dot
   does. */
.empty-root {
  height: var(--row-h);
  display: flex;
  align-items: center;
  padding: 0 var(--row-pad-x) 0 36px;
  font-size: var(--fs-200);
  font-style: italic;
}
/* One step in from the root header: 18px of padding plus the 2px rail puts the
   dot at 20, 8px right of the root's. */
.dir-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--row-pad-x) 0 18px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
}
.dir-header:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed; hover is a neutral lift. The two used
   to be the same cyan at two alphas, which read as one state. */
.dir-header.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* A folder that is only a session — no reported cwd — is labelled by that
   session's NAME, so it is set in the mono face the name deserves and toned
   down, because it is a row we could not place rather than a folder the user
   organised. */
.dir-header.orphan .label {
  color: var(--fg-secondary);
}
.dir-header:hover {
  background: var(--state-hover);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex-shrink: 0;
}
.dot.active {
  background: var(--success);
}
/* The label wins the width fight; everything else shrinks first.

   `flex: 0 1 auto`, not `1 1 auto`: it may still SHRINK before the badges and
   the count do, but it no longer GROWS to eat the free space — growing is what
   pushed the count away from the label it belongs to. The right edge is held
   by `.row-time`'s `auto` margin instead, so the timestamps still line up in a
   column down the panel. */
.label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.label.mono {
  font-family: var(--font-mono);
}
/* A folder holding an attached session is semibold, so weight and colour (the
   green dot) say the same thing. This is what replaced the `attached` tag —
   and it now carries the whole of that job, because attachment is no longer a
   SORT key: a row that jumped to the top of its root the moment you opened it
   was the list rearranging itself in response to being used. The mark stays; the movement went. */
.dir-header.attached .label {
  font-weight: var(--fw-semibold);
}
/* Badge metric, shared by every --r-sm chip in the app:
   inline-flex, 0 var(--sp-1) padding, --lh-100. */
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  font-weight: var(--fw-medium);
  color: var(--agent);
  background: var(--agent-soft);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  white-space: nowrap;
}
/* Transient detector states read as "not settled yet", not as a live agent. */
.agent-badge.dim {
  color: var(--fg-secondary);
  background: transparent;
  border-color: var(--border);
}
/* Holds the right edge, which the count used to. It is a column the eye reads
   down — ages only compare against each other — so it is the field that has to
   stay aligned. When the container query below hides it, the `auto` goes with
   it and the row simply hugs the left, which is the right shape for a row that
   has run out of width. */
.row-time {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
/* Sentence over action, left on the panel's own indent rather than centred:
   the workspace's empty state centres in a whole pane, and centring in a strip
   that drags down to 232px would just ragged-edge two short lines. */
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}
.empty p {
  margin: 0;
}
.error {
  padding: 0 var(--sp-3) var(--sp-2);
}
/* The batch's refusal, which unlike the listing's error has a dismiss: flex so
   the button sits at the end of the strip, with the TEXT as the flexible child
   so a sentence naming three sessions wraps under itself rather than squeezing
   the button. `align-items: flex-start` keeps the mark on the first line. */
.stop-error {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
}
.stop-error span {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The confirm sheet, deliberately the tab menu's
   (FolderWorkspaceView `.stop-confirm`): the two dialogs ask the same question
   about the same kind of thing, from two menus a click apart, so they must not
   look like two different features. */
.stop-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.stop-confirm p {
  margin: 0;
}
.stop-confirm code {
  font-family: var(--font-mono);
  word-break: break-all;
}
/* Scrolls rather than growing the sheet. Six rows of a ~28px line is the point
   where the muted warning and the buttons would start leaving the viewport on a
   short window — and those are the two things the dialog cannot afford to push
   off screen. */
.stop-list {
  list-style: none;
  margin: 0;
  padding: var(--sp-2);
  max-height: 168px;
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.stop-list li + li {
  margin-top: var(--sp-1);
}
.stop-confirm .actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.stop-confirm .btn-secondary,
.stop-confirm .btn-danger {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition: background var(--dur-fast) var(--ease);
}
.stop-confirm .btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg);
}
.stop-confirm .btn-secondary:hover {
  background: var(--state-hover);
}
/* Solid error, not a tinted ghost: a confirm dialog whose dangerous option is
   the quieter of the two is a trap. */
.stop-confirm .btn-danger {
  background: var(--error);
  border: 1px solid var(--error);
  color: var(--on-accent);
}
.stop-confirm .btn-danger:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

/* The menu's destructive item. `:deep` because PopupMenu's items arrive through
   its slot and so carry THIS component's scope id, not the menu's — the same
   reason PopupMenu publishes `.menu-item` with `:deep` from its side. The hover
   fill is the error tint rather than the ordinary grey, so the row confirms
   what it is as the cursor lands on it and before it is clicked. */
.popup-menu :deep(.menu-item.danger) {
  color: var(--error);
}
.popup-menu :deep(.menu-item.danger:hover) {
  background: var(--error-soft);
}
.popup-menu :deep(.menu-item.danger:disabled) {
  color: var(--fg-muted);
}
.popup-menu :deep(.menu-item.danger:disabled:hover) {
  background: transparent;
}

/* Below ~270px the row cannot hold every field. The timestamp goes first: it
   is still the least operational of them, though the ORIGINAL reason for
   picking it — "a recency-sorted list already carries most of what it says" —
   died with the recency sort. What survives the
   revision is the comparison rather than the absolute: at the 232px floor
   something has to go, and every other field on the row either identifies it
   (label), locates it (dot) or says what is running in it (badge), and an age
   answers none of those. It is a genuine loss at that width now rather than a
   redundancy, and it is recorded as one. Dot, label and badge survive to the
   232px floor. The
   rule is unscoped on purpose, so a directory header drops its aggregate age
   at the same width its children drop theirs — a header still showing a time
   above rows that had theirs removed would read as its own, separate fact.
   270 rather than revision 2's 250, by the same arithmetic that set 250: the
   leaf row is 16px deeper than the single-session row it replaces, and it now
   carries a full session name rather than a short directory basename, so it
   runs out of width that much sooner. */
@container (width < 270px) {
  .row-time {
    display: none;
  }
}
</style>
