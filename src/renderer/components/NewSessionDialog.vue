<script setup lang="ts">
// NewSessionDialog: folder-first session creation.
//
// This replaces the bare "new session name" field that used to sit at the
// bottom of SessionTree. That field had the model backwards. A session is not
// named, it is PLACED: the user picks a project folder on the host and the
// session name is DERIVED from it (`~/git/pocketshell` -> `git-pocketshell`)
// by the same rule `tmuxctl` and the Android app use, so all three clients
// agree about which session belongs to which folder. The derived name is shown
// in the footer before anything is committed; it is never typed.
//
// Three routes, one destination:
//
//   existing  browse to a folder that is already there
//   new       create an empty folder under the folder you browsed to
//   clone     clone a GitHub repo (or reuse one already on the host)
//
// All three converge on `projects.startSession(folder)`.
//
// Browsing deliberately goes through the SFTP surface (`projects.home()` for
// the root, `sftp.list()` filtered to directories) rather than a folder
// channel of its own — see src/renderer/stores/projects.ts.
//
// ## The second question: which agent (docs/SESSIONLIST.md §13)
//
// This dialog used to answer only "which folder" and stop, on the reasoning
// that the folder's workspace asks "which agent" one click later. The user
// asked for the chain explicitly — "when I start a session in a folder I want
// to select the agent" — so `Start session…` now raises the SAME
// `LaunchSessionDialog` the workspace's `+` raises. Not a copy of its fields:
// `src/shared/agentLaunch.ts` is the only place that knows how to spell a
// flag, and one dialog in front of it is what keeps that true.
//
// **Nothing is created until BOTH questions are answered.** That is the
// property `LaunchSessionDialog` was built around (cancel costs nothing) and
// §13's real objection to chaining, so the chain is ordered to preserve it
// rather than to work around it: the agent step runs on the PREDICTED folder —
// `targetFolder`, which every route can name before it exists — and the whole
// commit path (mkdir, clone, `start`) runs on confirm. Cancelling at the agent
// step leaves no folder, no clone and no session, and returns to the picker
// with the browse intact. See {@link commit}.
//
// **The launch itself is not run here**, because it cannot be: typing the
// wrapper line needs a PTY and the panel has no terminal. The choice is PARKED
// (`src/renderer/pendingAgentLaunch.ts`) and `FolderWorkspaceView` collects it
// when the user opens the session. So "create" and "launch" are separated in
// time, and the launch rides the navigation this dialog asks for rather than
// this dialog growing a terminal of its own.
//
// A plain shell is untouched by all of this and stays ONE click: `Start shell`
// beside the primary button commits with no choice at all, exactly as `Start
// session` did before this change.
//
// A create that WORKS opens the session, immediately. There used to be a green
// "Started `git-dataqna`" banner with an `Open session` button under it, and it
// was a screen whose only content was the good news: the user had pressed
// Start, the host had done exactly what was asked, and the dialog answered with
// a receipt and a second click. Success is not news — it is the thing that was
// asked for — so `commit` emits `started` the moment the host names the session
// and the panel navigates. See {@link commit}.
//
// The outcome panel survives for the answers that are NOT simply "yes", because
// two of them cannot be read off the session row afterwards:
// `via: 'tmux-fallback'` means the session was created WITHOUT a memory cap,
// and `code: 'folder-missing'` guards a real helper trap where a `-c` at a
// missing directory exits 0 and silently lands the pane in `$HOME`. Both are
// worth a sentence, so in those cases the dialog stays put, says it, and the
// user presses Open (or goes round again) having read it.
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import LaunchSessionDialog from './LaunchSessionDialog.vue';
import PopupMenu from './PopupMenu.vue';
import { type Box } from '../../shared/popupPlacement';
import { useConnectionStore } from '../stores/connection';
import { displayPath, joinPosix, useProjectsStore } from '../stores/projects';
import { FILE_ROW_CAP, matchesQuery, viewFileRows } from '../fileListView';
import { parkAgentLaunch } from '../pendingAgentLaunch';
import { KIND_LABELS, launchBlocker, type LaunchChoice } from '../../shared/agentLaunch';
import type { RepoEntry } from '../../main/projects/repos';
import type { StartSessionResult } from '../../main/projects/ProjectsService';

const props = withDefaults(
  defineProps<{
    /**
     * An ABSOLUTE host directory to open the browser AT, instead of `$HOME`.
     *
     * Set by the session panel's `+` controls: the general one passes the
     * panel's FIRST root (the user asked for the picker to open there by
     * default), a root row's passes that root. Null is the fallback — no root
     * resolves on this host — and keeps the original behaviour: land on
     * `$HOME`, or stay wherever the browser was left.
     *
     * It must be absolute. The browse goes over SFTP, which runs no shell, so a
     * `~` in here would name a literal directory called `~`; the panel resolves
     * its root keys with `rootHostPath` before passing them down and passes
     * null instead when that resolution fails.
     */
    startIn?: string | null;
    /**
     * The project roots the panel knows, each as a display label (`~/git`) and
     * an ABSOLUTE path. They are the crumb bar's dropdown: the `+` lands the
     * browser in the first root by default, and this menu is how the user
     * selects a different one without walking up and down the crumbs.
     *
     * A prop rather than a store read so this dialog stays dumb about HOW roots
     * are derived — that is the panel's tree, with its drag order — and so a
     * root whose path failed to resolve is simply absent, decided once by the
     * caller instead of re-decided here.
     */
    roots?: { label: string; path: string }[];
  }>(),
  { startIn: null, roots: () => [] },
);

const emit = defineEmits<{
  /** The session is live on the host; open it. */
  started: [session: string];
  close: [];
}>();

type Route = 'existing' | 'new' | 'clone';

const connection = useConnectionStore();
const projects = useProjectsStore();

const route = ref<Route>('existing');
/** Name for the folder created by the `new` route. */
const newFolderName = ref('');
/** Filter over the merged repo list. */
const repoFilter = ref('');

// ---------------------------------------------------------------------------
// Searching the folder listing
// ---------------------------------------------------------------------------
//
// `~/git` on the user's host is dozens of directories in a 260px box, which is
// a scroll-and-squint every time a session is created. The logic is NOT
// written here: `src/renderer/fileListView.ts` already solved this problem for
// the Files tab and its header carries the reasoning. Two of its properties
// are the whole reason to reuse it rather than to write `.includes()` again:
//
//   - **filter the FULL listing, then cap.** `projects.dirs` holds the entire
//     directory (one `sftp.readdir`, no paging), so a match past row 100 is
//     findable. Filtering what is rendered would search only what the user had
//     already scrolled to, which is the most confusing behaviour available.
//   - **the cap is a RENDER cap**, so "Show more" costs no round trip.
//
// ALWAYS VISIBLE here, where the Files tab summons its box with a button.
// That is not an inconsistency, it is the same rule reaching a different
// answer: the Files tree is a drag-narrow pane whose breadcrumb strip already
// carries three controls, so a fourth permanent one would take back the line
// the breadcrumb had just won. This is a fixed-width modal whose ONLY job is
// picking a folder out of that list — there is no competing content to crowd,
// and between `sessions.new` (Ctrl+Shift+N) and the caret this filter starts
// with, a search you cannot see would still be a search nobody uses.
// docs/SHORTCUTS.md §1.8 carries the chord's reasoning.
/** Filter over the browsed directory. Blank means "no filter". */
const folderQuery = ref('');
/** The filter input — where this dialog points the keyboard on open. */
const searchEl = ref<HTMLInputElement | null>(null);

/**
 * The caret starts IN the filter, because typing is the flow the `+` begins:
 * click `+`, type a few letters, click the row. Focusing the dialog's shell or
 * the first tab button instead would spend the first typed characters moving
 * focus that was never where the user's words were going.
 *
 * The input is disabled while a browse is in flight and a disabled element
 * cannot take focus, so the open browse (the `startIn` landings) swallows the
 * mount-time attempt; when the listing arrives and the input re-enables, focus
 * goes there after all. Landing it after every browse — entering a folder, up,
 * a crumb — keeps that same flow intact one level deeper: filter, descend,
 * filter again, with the caret never dropped on the floor.
 */
function focusSearch(): void {
  if (projects.browsing) return;
  searchEl.value?.focus();
}

watch(
  () => projects.browsing,
  (browsing, was) => {
    if (was && !browsing) focusSearch();
  },
);
onMounted(focusSearch);

// ---------------------------------------------------------------------------
// The keyboard flow: type, arrow, Enter
// ---------------------------------------------------------------------------
//
// The `+`/`Ctrl+Shift+N` ask was "my hands don't leave the keyboard": open the
// picker, type a few letters, press Enter, and a session exists in that
// folder. The filter alone only ever narrowed a list whose rows were
// click-only — the keyboard could search but not ANSWER.

/**
 * The highlighted row of {@link folderView}, or null when none is.
 *
 * Null is also the "let Enter mean the first match" state: after typing, the
 * palette contract is that Enter acts on the top hit without a preliminary
 * ArrowDown. With a BLANK query there is no such default — Enter would
 * otherwise start a session in whichever folder sorts first, which is nobody's
 * intent — so blank-query Enter does nothing until an arrow key has spoken.
 */
const activeRowIndex = ref<number | null>(null);

// Any of these replaces the rows the index was pointing into.
watch(
  [folderQuery, () => projects.dirs, () => projects.cwd, route],
  () => {
    activeRowIndex.value = null;
  },
);

const folderListEl = ref<HTMLElement | null>(null);

function revealActiveRow(): void {
  void nextTick(() => {
    folderListEl.value
      ?.querySelector('.folder-row.active')
      ?.scrollIntoView?.({ block: 'nearest' });
  });
}

/**
 * Enter on the filter: descend into the highlighted (or first matching)
 * folder and — on the `existing` route — start a shell in it, which is the
 * one-action commit `Start shell` performs. Descent runs first and is
 * verified, so the session targets the folder the row named, not whatever
 * `cwd` was last; a failed descent (folder gone) leaves nothing created and
 * `browseError` saying why.
 *
 * Ctrl+Enter descends WITHOUT starting — the keyboard's way to browse into a
 * nested folder on the way to a deeper match. On the `new` route Enter only
 * ever descends: that route's commit is the name field's own Enter.
 */
async function onFilterKeydown(e: KeyboardEvent): Promise<void> {
  if (route.value === 'clone') return;
  const rows = folderView.value.rows;
  const id = connId.value;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!rows.length) return;
    e.preventDefault();
    const down = e.key === 'ArrowDown';
    const from = activeRowIndex.value ?? (down ? -1 : 0);
    activeRowIndex.value = Math.min(rows.length - 1, Math.max(0, from + (down ? 1 : -1)));
    revealActiveRow();
    return;
  }

  if (e.key !== 'Enter' || busy.value || !id) return;
  const index = activeRowIndex.value ?? (folderQuery.value.trim() === '' ? null : 0);
  const row = index === null ? null : rows[index];
  if (!row) return;

  const parent = projects.cwd;
  await projects.enter(id, row.name);
  // A descent that did not land (the row's folder vanished under the list)
  // must not commit in the parent by accident.
  if (projects.cwd !== joinPosix(parent, row.name)) return;
  if (route.value === 'existing' && !e.ctrlKey && !e.metaKey) await commit(null);
}
/** Rows the browser will render. Grows by {@link FILE_ROW_CAP} per "Show more". */
const folderCap = ref(FILE_ROW_CAP);
/** `owner/repo` typed by hand, for a repo `gh` did not list. */
const manualRepo = ref('');
/** Which listed repo is selected, keyed by {@link repoKey}. */
const selectedRepo = ref<string | null>(null);
/** Clone destination root on the host. The helper's own default is `~/git`. */
const cloneRoot = ref('~/git');
/**
 * This dialog ALWAYS asks the host for a genuinely new session, walking
 * `-2`, `-3`… for the name.
 *
 * It used to offer "force a new session even if this folder has one" as an
 * opt-in checkbox, defaulting to reuse, on the reasoning that re-opening a
 * folder's existing session is the idempotent thing and what people want
 * almost every time. That reasoning was about opening a FOLDER. It does not
 * survive the button being called "New session": someone who has pressed that
 * has already said which one they want, and a checkbox asking whether they
 * meant it is a question with one sensible answer.
 *
 * Re-opening an existing session is not lost — it is what selecting the
 * folder in the panel does, and every session in it already has a tab.
 * FolderWorkspaceView's own `+` reached the same conclusion independently
 * (see its `unique` call): once the existing sessions are all on screen,
 * "new" can only mean new.
 */

/** Live preview of the name the host would derive. Never user-entered. */
const derivedName = ref('');
/** Set while a route's own slow step (mkdir, clone) is running. */
const preparing = ref<string | null>(null);
/** Anything that stopped us BEFORE `startSession` ran. */
const stepError = ref<string | null>(null);
/** The host's answer, kept on screen until the user acts on it. */
const outcome = ref<StartSessionResult | null>(null);
/**
 * True while the AGENT step is on screen instead of the folder picker.
 *
 * A swap, not a stack. Two `OverlayPanel`s at once would share a z-index and,
 * worse, would both hear the same Escape on `document` — one keypress closing
 * two dialogs and losing the browse. Swapping also reads as what it is: a
 * two-step wizard with one modal in front of the user at a time, where Escape
 * means "back one step" rather than "throw the whole thing away".
 *
 * The folder picker's state survives the swap untouched: `route`, the typed
 * folder name and the repo selection are refs on THIS component, which stays
 * mounted, and the browse position lives in the projects store.
 */
const agentStep = ref(false);
/**
 * The agent parked for the session named in the banner, if any.
 *
 * Held only so the banner can say what will happen next. The launch itself is
 * in `pendingAgentLaunch`; this is a label.
 */
const parkedKind = ref<LaunchChoice['kind'] | null>(null);
/**
 * WHICH of the two commit buttons started the work that is running.
 *
 * `busy` says that something is happening; this says whose it is, and the two
 * are read together — see {@link working}. It is set by {@link commit} and
 * never cleared, deliberately: the value is only ever consulted while `busy`,
 * so a stale one is invisible, and clearing it would mean finding every one of
 * that function's early returns and getting them all right for a ref whose
 * lifetime is already bounded by a flag beside it.
 */
const committing = ref<'shell' | 'agent' | null>(null);

const connId = computed(() => connection.connectionId);
const busy = computed(() => preparing.value !== null || projects.starting);
/**
 * The commit button currently doing work, or null when nothing is.
 *
 * The busy mark used to be a loose `AppIcon` between `Cancel` and `Start
 * shell`, on the reasoning that with TWO commit buttons an in-button spinner
 * would have to pick one and might pick the wrong one — so "working" was given
 * to the bar instead. The user's verdict on that: "the loader here seems
 * strange … you can have a loader there but in that place it's super weird",
 * and they are right. A glyph floating in the gap between two buttons is
 * attached to neither, so it reads as a stray mark rather than as the state of
 * the thing that was just pressed.
 *
 * The premise was the part that was wrong: the dialog knows perfectly well
 * which button was pressed, because `commit` is told — a null choice IS `Start
 * shell` and a choice is the agent chain, which only `Start session…` can
 * raise. Recording that is one ref, and it puts the mark on the control it
 * describes.
 *
 * Unlike the old mark this stays lit through the mkdir and the clone as well as
 * the `start`. The progress bar above says WHAT is happening ("Cloning
 * owner/repo…"); the button says that the press landed and that this control is
 * the one you are waiting on. Those are different sentences, and the old
 * `busy && !preparing` split left the button looking untouched for the longest
 * step of the three.
 */
const working = computed<'shell' | 'agent' | null>(() =>
  busy.value ? committing.value : null,
);

/** Breadcrumb segments for the browsed path, `~` collapsed. */
const crumbs = computed(() => {
  const shown = displayPath(projects.cwd, projects.home);
  const parts = shown.split('/').filter((p) => p.length > 0);
  const out: { label: string; path: string }[] = [];
  let acc = shown.startsWith('~') ? (projects.home ?? '') : '';
  for (const part of parts) {
    if (part === '~') continue;
    acc = joinPosix(acc || '/', part);
    out.push({ label: part, path: acc });
  }
  return out;
});

/**
 * The browsed directory, filtered then capped.
 *
 * `projects.dirs` entries already carry a `name`, which is the whole of
 * `NamedEntry`, so no adapter is needed — the generalisation `viewFileRows`
 * needed to serve a second caller was done when it was written.
 */
const folderView = computed(() =>
  viewFileRows(projects.dirs, { query: folderQuery.value, cap: folderCap.value }),
);

/**
 * A `cd` clears the filter and the cap.
 *
 * The filter because a query that survives navigation renders the next folder
 * as empty and reads as a broken listing — the single most baffling state this
 * feature can produce. The cap because otherwise it stops meaning anything
 * after a few folders: it is "the first hundred rows of what I am looking at",
 * not a running total.
 */
watch(
  () => projects.cwd,
  () => {
    folderQuery.value = '';
    folderCap.value = FILE_ROW_CAP;
  },
);

// Typing resets the cap too, so the box shows the first hundred MATCHES rather
// than the matches among the first hundred rows.
watch(folderQuery, () => {
  folderCap.value = FILE_ROW_CAP;
});

function showMoreFolders(): void {
  folderCap.value += FILE_ROW_CAP;
}

/**
 * Escape in the search box clears the filter — but ONLY when there is one.
 *
 * `OverlayPanel` closes on Escape from a `document` listener, so a box that
 * swallowed the key unconditionally would make Escape mean nothing at all once
 * the filter was empty: the user presses it, the dialog stays, they press it
 * again, the dialog stays. Conditional swallowing gives the two meanings a
 * natural order — undo the filter, then leave — which is the same ladder the
 * composer's Escape uses (docs/COMPOSER.md §12).
 *
 * This is field-local and therefore NOT a registry chord: `shared/shortcuts.ts`
 * arbitrates keys that several surfaces could claim, and Escape inside a text
 * input that is on screen for as long as this modal is has no one to collide
 * with. The Files tree's search box makes the same call.
 */
function onSearchEscape(e: KeyboardEvent): void {
  if (folderQuery.value === '') return;
  e.stopPropagation();
  e.preventDefault();
  folderQuery.value = '';
}

const filteredRepos = computed(() => {
  const rows = [...projects.repos].sort((a, b) => repoLabel(a).localeCompare(repoLabel(b)));
  // Same matcher as the folder list and the Files tab — case-insensitive
  // substring, blank matches everything — so the two boxes in this one dialog
  // cannot answer "does this match" differently.
  return rows.filter((r) => matchesQuery(repoLabel(r), repoFilter.value));
});

const selectedRepoEntry = computed(
  () => projects.repos.find((r) => repoKey(r) === selectedRepo.value) ?? null,
);

/**
 * The folder the Start button would act on, or null when the route is not
 * ready. For `new` and `clone` this is the folder that WILL exist — it is
 * what the name preview is derived from, and the host re-derives it for real
 * once the folder is on disk.
 */
const targetFolder = computed<string | null>(() => {
  if (route.value === 'existing') return projects.cwd || null;
  if (route.value === 'new') {
    const name = newFolderName.value.trim();
    return name && projects.cwd ? joinPosix(projects.cwd, name) : null;
  }
  const repo = selectedRepoEntry.value;
  if (repo?.local) return repo.local.path;
  const slug = repo ? repoLabel(repo) : manualRepo.value.trim();
  if (!slug) return null;
  const leaf = slug.replace(/\.git$/, '').split('/').filter(Boolean).pop();
  return leaf ? joinPosix(cloneRootAbsolute.value, leaf) : null;
});

/** `~/git` -> `/home/me/git`, so the name preview matches what the host sees. */
const cloneRootAbsolute = computed(() => {
  const root = cloneRoot.value.trim() || '~/git';
  if (root.startsWith('~') && projects.home) return joinPosix(projects.home, root.slice(1));
  return root;
});

/** True when the selected repo is already on the host — no clone needed. */
const alreadyOnHost = computed(() => selectedRepoEntry.value?.local != null);

onMounted(async () => {
  if (!connId.value) return;
  if (props.startIn) {
    // `$HOME` is still resolved, because the name preview and every displayed
    // path are written relative to it — but the browser lands on the ROOT the
    // user pressed `+` on rather than on home, which is the whole point of the
    // prop.
    //
    // `cwd` is cleared FIRST, and that is not tidiness. The browser's cwd lives
    // in the projects STORE, so it survives this dialog closing: without the
    // clear, a browse that fails — a registered root that is not on this host,
    // which is a state the panel renders deliberately — would leave the picker
    // pointed at wherever it was left last time, and `Start session` would
    // cheerfully create a session in a folder the user never chose. Cleared, a
    // failed browse leaves no target at all, the Start button stays dead, and
    // `browseError` says why.
    projects.cwd = '';
    await projects.ensureHome(connId.value);
    await projects.browse(connId.value, props.startIn);
  } else {
    await projects.loadHome(connId.value);
  }
  await projects.loadRepos(connId.value);
});

// The preview is the whole point of the derivation being visible, so it
// re-resolves on every change of target. `deriveName` reads the cached $HOME
// and does no host round-trip of its own.
watch(
  [targetFolder, connId],
  async ([folder, id]) => {
    if (!folder || !id) {
      derivedName.value = '';
      return;
    }
    derivedName.value = await projects.deriveName(id, folder);
  },
  { immediate: true },
);

function repoLabel(repo: RepoEntry): string {
  return repo.fullName ?? repo.name;
}

/** Stable row identity: `fullName` when GitHub knows it, else the path. */
function repoKey(repo: RepoEntry): string {
  return repo.fullName ?? repo.local?.path ?? repo.name;
}

async function onEnter(name: string): Promise<void> {
  if (connId.value) await projects.enter(connId.value, name);
}

async function onUp(): Promise<void> {
  if (connId.value) await projects.up(connId.value);
}

async function onCrumb(path: string): Promise<void> {
  if (connId.value) await projects.browse(connId.value, path);
}

async function onHome(): Promise<void> {
  if (connId.value && projects.home) await projects.browse(connId.value, projects.home);
}

// ---------------------------------------------------------------------------
// The roots dropdown
// ---------------------------------------------------------------------------
//
// The crumb bar's home / up / crumb trail answers "where am I relative to this
// directory"; the roots menu answers "which of my roots am I in" — a jump one
// level above the crumbs, from `~/git/proj` to `~/work` in one click instead
// of walking up past `$HOME` and back down. The `+` already lands the browser
// in the panel's first root; this menu is the "but select a different one"
// half of that ask.

/** Viewport box of the dropdown trigger, when the menu is open. */
const rootsAnchor = ref<Box | null>(null);
const rootsBtnEl = ref<HTMLElement | null>(null);

function toggleRootsMenu(): void {
  if (rootsAnchor.value) {
    rootsAnchor.value = null;
    return;
  }
  const box = rootsBtnEl.value?.getBoundingClientRect();
  if (box) rootsAnchor.value = { left: box.left, top: box.top, width: box.width, height: box.height };
}

/** Jump the browser to a root, and close the menu that offered it. */
async function onRoot(path: string): Promise<void> {
  rootsAnchor.value = null;
  if (connId.value) await projects.browse(connId.value, path);
}

/**
 * Raise the agent step, having created NOTHING.
 *
 * The ordering is the whole point (docs/SESSIONLIST.md §13): every route can
 * NAME its folder before that folder exists — `targetFolder` predicts the
 * mkdir's path and the clone's leaf — so the agent question can be asked on a
 * prediction and the mkdir, the clone and the session can all wait behind the
 * confirm. Cancelling here therefore costs exactly what cancelling
 * `LaunchSessionDialog` in a folder workspace costs: nothing.
 */
function openAgentStep(): void {
  if (busy.value || !targetFolder.value) return;
  stepError.value = null;
  agentStep.value = true;
}

/** Back to the folder picker with the browse intact. */
function closeAgentStep(): void {
  agentStep.value = false;
}

/**
 * The one commit path. Each route resolves a real folder on the host first,
 * then every route ends in the same `startSession` call.
 *
 * [choice] is the agent to launch once the session has a terminal, or null for
 * a plain shell. It is the LAST thing collected and the first thing checked,
 * so a launch that could not have worked stops the flow while the host is
 * still untouched — the same rule `FolderWorkspaceView.createSession` follows,
 * and the reason `launchBlocker` exists as a function rather than as a
 * disabled button.
 */
async function commit(choice: LaunchChoice | null): Promise<void> {
  const id = connId.value;
  agentStep.value = false;
  if (!id || busy.value) return;
  // Which button the user is waiting on. A null choice is `Start shell`; a
  // choice can only have come from the agent step, which only `Start session…`
  // raises. See {@link working}.
  committing.value = choice ? 'agent' : 'shell';
  stepError.value = null;
  outcome.value = null;
  parkedKind.value = null;

  // Before the mkdir, before the clone, before the session. The dialog would
  // not have let a broken choice be confirmed, but this is the last moment at
  // which nothing exists to clean up.
  const blocker = choice ? launchBlocker(choice) : null;
  if (blocker) {
    stepError.value = blocker;
    return;
  }

  let folder: string | null = null;

  if (route.value === 'existing') {
    folder = projects.cwd || null;
    if (!folder) {
      stepError.value = 'Browse to a folder first.';
      return;
    }
  } else if (route.value === 'new') {
    const name = newFolderName.value.trim();
    if (!name) {
      stepError.value = 'Enter a name for the new folder.';
      return;
    }
    preparing.value = `Creating ${name}…`;
    const made = await projects.createFolder(id, projects.cwd, name);
    preparing.value = null;
    if (!made.ok || !made.path) {
      stepError.value = made.error ?? 'Could not create the folder.';
      return;
    }
    folder = made.path;
  } else {
    const repo = selectedRepoEntry.value;
    if (repo?.local) {
      // Already cloned. Nothing to fetch — go straight on.
      folder = repo.local.path;
    } else {
      const repository = repo ? repoLabel(repo) : manualRepo.value.trim();
      if (!repository) {
        stepError.value = 'Pick a repository, or type an owner/repo.';
        return;
      }
      // Indeterminate on purpose: git's progress meter goes to stderr and the
      // exec buffers to completion, so the host can only say started/finished.
      preparing.value = `Cloning ${repository}…`;
      const cloned = await projects.clone(id, { repository, root: cloneRoot.value.trim() });
      preparing.value = null;
      if (!cloned.ok || !cloned.path) {
        stepError.value = cloneMessage(cloned.error, cloned.state);
        return;
      }
      // `alreadyExists` is NOT a failure: the target was on disk and the host
      // handed us its path. Carry straight on.
      folder = cloned.path;
    }
  }

  const result = await projects.start(
    id,
    folder,
    undefined,
    'unique',
  );

  if (!result.ok) {
    outcome.value = result;
    return;
  }

  newFolderName.value = '';
  if (choice && result.sessionName) {
    // Parked against the folder the HOST resolved, not the one we predicted.
    // The clone route in particular can land somewhere else — a repo already
    // on disk comes back at its real path, and `alreadyExists` returns the
    // host's spelling — and `--dir` pointing at a directory that does not
    // exist is the exact failure `agentLaunch.ts` was written to make
    // unrepeatable.
    //
    // BEFORE the emit, always. The parking and the navigation are two halves
    // of one handoff: `FolderWorkspaceView` reads the slot as it mounts, and
    // `started` is what mounts it.
    const dir = result.folder ?? folder;
    // The workspace rides along so the collecting folder can prove the launch
    // is its own: a bare tag repeats across workspaces. `result.folder` is the
    // canonical path the host resolved — the same string the session row will
    // carry as its workspace.
    parkAgentLaunch(id, result.sessionName, { ...choice, dir }, Date.now(), result.folder ?? folder);
    parkedKind.value = choice.kind;
  }

  // One successful create still stops here instead of opening, and it is the
  // one whose good news has a caveat attached. `via: 'tmux-fallback'` means the
  // helper could not be used and the session was made with raw `tmux`, so it
  // carries NO memory cap — a fact about this session that is true for as long
  // as it lives and is visible nowhere else in the app. Navigating away the
  // instant it is created is exactly how a warning goes unread, so this one
  // keeps the panel and costs the user the click it takes to have seen it.
  //
  // A missing `sessionName` on an `ok` result holds too, for the blunter
  // reason that there is nothing to emit: the panel says what happened rather
  // than the dialog closing onto no navigation at all.
  if (result.via === 'tmux-fallback' || !result.sessionName) {
    outcome.value = result;
    // Land the browser on the folder we just used, so "Start another" is
    // already pointed somewhere sensible. Only worth doing on this path — on
    // every other success the dialog is already gone.
    if (result.folder && route.value !== 'existing') await projects.browse(id, result.folder);
    return;
  }

  emit('started', result.sessionName);
}

/** A clone failure the host classified — say which, not just "git failed". */
function cloneMessage(error: string | null, state?: string): string {
  if (state === 'gh-missing') return 'This host has no GitHub CLI (`gh`), so it cannot clone for you.';
  if (state === 'gh-unauthenticated') return 'The host has `gh` but is not logged in — run `gh auth login` there.';
  if (state === 'helper-missing') return 'This host has no `pocketshell` helper installed.';
  return error ?? 'The clone failed.';
}

/**
 * Open the session named in the banner.
 *
 * The button this belongs to is no longer the ordinary way out of a create —
 * `commit` emits `started` itself now. It survives for the raw-`tmux` hold
 * above, where the panel is on screen so that a warning gets read, and the
 * user still has to be able to carry on to the session they just made.
 */
function onOpen(): void {
  const name = outcome.value?.sessionName;
  if (name) emit('started', name);
}

/**
 * Clear the banner and go round again.
 *
 * Both panels that remain reach this: the failure one, where it is the only way
 * back to the picker that does not throw the browse away, and the raw-`tmux`
 * hold, where it is a genuine "start another" — a session was created.
 *
 * The parked launch is deliberately NOT cleared. The user chose an agent for
 * that session and the session exists; it is still the right thing to run when
 * they open it, whether they open it now or after creating a second one. The
 * slot expires on its own (`LAUNCH_HANDOFF_TTL_MS`), and a second create with
 * an agent simply replaces it — which is correct, because the session they are
 * about to open is the one they just made.
 */
function onStartAnother(): void {
  outcome.value = null;
  stepError.value = null;
  parkedKind.value = null;
}
</script>

<template>
  <!-- Step two, INSTEAD of step one rather than on top of it. See `agentStep`.
       It is handed the PREDICTED folder, which is what lets it be answered
       before anything is created; `commit` re-points the choice at the folder
       the host actually resolved before parking it. -->
  <LaunchSessionDialog
    v-if="agentStep"
    :folder-path="targetFolder"
    :folder-label="derivedName || 'this folder'"
    @confirm="commit"
    @close="closeAgentStep"
  />

  <OverlayPanel v-else title="New session" size="md" @close="emit('close')">
    <div class="new-session">
      <!-- ================= outcome =================
           Only the answers that are not simply "yes" get this far: a plain
           success has already emitted `started` and this dialog is unmounting.
           What is left is a failure, or the raw-`tmux` create whose warning is
           the reason it holds. `reused` is not among them and never was from
           here — this dialog asks for `unique`, which walks `-2`, `-3`… rather
           than handing back an open session (see the note beside
           `derivedName`), so the host's `reused` flag is always false on this
           path and the banner does not offer to explain a state it cannot
           produce. -->
      <section v-if="outcome" class="result">
        <div :class="['result-banner', outcome.ok ? 'ok' : 'bad']">
          <AppIcon :name="outcome.ok ? 'check' : 'alert-triangle'" />
          <div class="result-text">
            <p class="result-title">
              <template v-if="outcome.ok">
                Started <code>{{ outcome.sessionName }}</code>
              </template>
              <template v-else-if="outcome.code === 'folder-missing'">
                That folder is not on the host
              </template>
              <template v-else>Could not start the session</template>
            </p>
            <p v-if="outcome.ok" class="result-sub muted">
              in <code>{{ displayPath(outcome.folder ?? '', projects.home) }}</code>
            </p>
            <p v-else-if="outcome.code === 'folder-missing'" class="result-sub muted">
              {{ outcome.error }}. Nothing was created — a session started in a missing
              directory would silently land in <code>$HOME</code> instead.
            </p>
            <p v-else class="result-sub muted">{{ outcome.error }}</p>
          </div>
        </div>

        <!-- The agent is armed, not started. Saying so here is what keeps the
             banner honest about a launch that happens after a navigation the
             user has not made yet — "I picked Claude and got a shell" is not a
             bug anyone can report usefully. It reads as true as it ever did,
             because the only successful create that still shows this panel is
             the one the user must press Open on: everywhere else the
             navigation happens on its own and there is no instruction to
             give. -->
        <p v-if="outcome.ok && parkedKind" class="launch-note">
          <AppIcon name="terminal" :size="12" />
          {{ KIND_LABELS[parkedKind] }} starts when this session's terminal opens — press
          <strong>Open session</strong>.
        </p>

        <!-- Said plainly rather than hidden: the raw-tmux path cannot apply the
             helper's systemd memory cap, so this session has no limit on it. -->
        <p v-if="outcome.ok && outcome.via === 'tmux-fallback'" class="fallback-note">
          <AppIcon name="alert-triangle" :size="12" />
          Created with raw <code>tmux</code> — the <code>pocketshell</code> helper was
          not usable here, so this session has <strong>no memory cap</strong>.
        </p>

        <div class="result-actions">
          <button class="btn-secondary" @click="onStartAnother">Start another</button>
          <button v-if="outcome.ok" class="btn-primary" autofocus @click="onOpen">
            Open session
          </button>
        </div>
      </section>

      <!-- ================= picker ================= -->
      <template v-else>
        <nav class="routes" role="tablist">
          <button
            v-for="r in ([
              { id: 'existing', label: 'Existing folder', icon: 'folder' },
              { id: 'new', label: 'New folder', icon: 'folder-plus' },
              { id: 'clone', label: 'Clone from GitHub', icon: 'download' },
            ] as const)"
            :key="r.id"
            class="route"
            :class="{ on: route === r.id }"
            role="tab"
            :aria-selected="route === r.id"
            @click="route = r.id"
          >
            <AppIcon :name="r.icon" :size="14" />
            {{ r.label }}
          </button>
        </nav>

        <!-- ---- routes 1 + 2: the folder browser ---- -->
        <section v-if="route !== 'clone'" class="browser">
          <div class="crumbbar">
            <button class="icon-btn sm" title="Home folder" @click="onHome">
              <AppIcon name="home" :size="14" />
            </button>
            <button
              class="icon-btn sm"
              title="Up one folder"
              :disabled="projects.cwd === '/' || !projects.cwd"
              @click="onUp"
            >
              <AppIcon name="arrow-up" :size="14" />
            </button>
            <span class="crumbs">
              <button class="crumb" @click="onHome">~</button>
              <template v-for="c in crumbs" :key="c.path">
                <span class="crumb-sep">/</span>
                <button class="crumb" @click="onCrumb(c.path)">{{ c.label }}</button>
              </template>
            </span>
            <!-- The roots dropdown, parked at the far end of the crumb bar:
                 navigation, like everything else on this row, so it sits with
                 the home/up controls rather than in the filtered list below.
                 Only when the panel knows a root — with none, the crumbs and
                 home are the whole story. -->
            <button
              v-if="roots.length > 0"
              ref="rootsBtnEl"
              class="icon-btn sm roots-btn"
              title="Project roots"
              aria-haspopup="menu"
              :aria-expanded="rootsAnchor !== null"
              @click="toggleRootsMenu"
            >
              <AppIcon name="chevron-down" :size="14" />
            </button>
            <PopupMenu
              v-if="rootsAnchor"
              :anchor="rootsAnchor"
              :ignore="[rootsBtnEl]"
              label="Project roots"
              @close="rootsAnchor = null"
            >
              <ul>
                <li v-for="r in roots" :key="r.path">
                  <button class="menu-item" :title="r.path" @click="onRoot(r.path)">
                    {{ r.label }}
                  </button>
                </li>
              </ul>
            </PopupMenu>
          </div>

          <!-- Permanently on screen, unlike the Files tab's summoned box —
               the reasoning is beside `folderQuery`. It sits BELOW the crumb
               bar and above the list, so the home/up/breadcrumb controls stay
               where they were and are never filterable: they are navigation,
               not content, which is the same line `viewFileRows` draws around
               `..`. -->
          <div class="filter">
            <AppIcon name="search" :size="14" class="filter-mark" />
            <input
              ref="searchEl"
              v-model="folderQuery"
              class="text-input"
              spellcheck="false"
              autocomplete="off"
              :placeholder="`Search ${projects.dirs.length} folders here`"
              aria-label="Search folders in this directory"
              :aria-activedescendant="
                activeRowIndex === null ? undefined : `folder-row-${activeRowIndex}`
              "
              :disabled="projects.browsing"
              @keydown="onFilterKeydown"
              @keydown.esc="onSearchEscape"
            />
          </div>

          <ul ref="folderListEl" class="folder-rows" role="listbox" aria-label="Folders here">
            <li
              v-for="(d, i) in folderView.rows"
              :key="d.name"
              :id="`folder-row-${i}`"
              class="folder-row"
              :class="{ active: i === activeRowIndex }"
              role="option"
              :aria-selected="i === activeRowIndex"
              @click="onEnter(d.name)"
            >
              <AppIcon name="folder" :size="14" class="folder-mark" />
              <span class="folder-name">{{ d.name }}</span>
              <AppIcon name="chevron-right" :size="12" class="into" />
            </li>

            <!-- The count is the useful half: "Show more" alone does not say
                 whether it is four rows away or four hundred. -->
            <li v-if="folderView.hidden > 0" class="more">
              <button class="more-btn" @click="showMoreFolders">
                Show more — {{ folderView.rows.length }} of {{ folderView.total }}
              </button>
            </li>

            <li v-if="folderView.filtered && folderView.total === 0" class="empty muted">
              nothing matches “{{ folderQuery }}”
            </li>
            <li v-else-if="!projects.dirs.length && !projects.browsing" class="empty muted">
              no sub-folders here
            </li>
          </ul>

          <p v-if="projects.browseError" class="error">{{ projects.browseError }}</p>
          <p v-if="projects.homeError" class="error">{{ projects.homeError }}</p>

          <label v-if="route === 'new'" class="field">
            <span class="field-label">New folder name</span>
            <input
              v-model="newFolderName"
              class="text-input"
              placeholder="my-project"
              :disabled="busy"
              @keyup.enter="openAgentStep"
            />
          </label>
        </section>

        <!-- ---- route 3: clone ---- -->
        <section v-else class="repos">
          <!-- A host with no `gh`, or one that is logged out, is a NORMAL
               state: the local clones still list and the panel still works.
               A hint, never a dialog. -->
          <p v-if="projects.remoteUnavailable" class="hint muted">
            <AppIcon name="alert-triangle" :size="12" />
            <template v-if="projects.remoteState === 'gh-missing'">
              This host has no GitHub CLI, so only repos already on disk are listed.
              You can still type an <code>owner/repo</code> below.
            </template>
            <template v-else>
              The host's GitHub CLI is not logged in (<code>gh auth login</code>), so
              only repos already on disk are listed.
            </template>
          </p>
          <p
            v-else-if="projects.remoteState === 'failed' || projects.remoteState === 'helper-missing'"
            class="hint muted"
          >
            <AppIcon name="alert-triangle" :size="12" />
            Could not list GitHub repos{{ projects.remoteError ? `: ${projects.remoteError}` : '' }}.
          </p>

          <div class="filter">
            <AppIcon name="search" :size="14" class="filter-mark" />
            <input
              v-model="repoFilter"
              class="text-input"
              placeholder="filter repositories"
              :disabled="projects.reposLoading"
            />
          </div>

          <ul class="repo-rows">
            <li
              v-for="r in filteredRepos"
              :key="repoKey(r)"
              class="repo-row"
              :class="{ on: selectedRepo === repoKey(r) }"
              @click="selectedRepo = repoKey(r); manualRepo = ''"
            >
              <AppIcon name="git-branch" :size="14" class="repo-mark" />
              <span class="repo-name">{{ repoLabel(r) }}</span>
              <span v-if="r.local" class="tag on-host">on host</span>
              <span v-if="r.local?.head" class="tag">{{ r.local.head }}</span>
              <span v-else-if="r.remote?.defaultBranch" class="tag">
                {{ r.remote.defaultBranch }}
              </span>
            </li>
            <li v-if="!filteredRepos.length && !projects.reposLoading" class="empty muted">
              no repositories listed
            </li>
          </ul>

          <label class="field">
            <span class="field-label">Or clone by name</span>
            <input
              v-model="manualRepo"
              class="text-input"
              placeholder="owner/repo"
              :disabled="busy"
              @input="selectedRepo = null"
            />
          </label>
          <label class="field">
            <span class="field-label">Clone into</span>
            <input v-model="cloneRoot" class="text-input" :disabled="busy || alreadyOnHost" />
          </label>
          <p v-if="alreadyOnHost" class="hint muted">
            Already on the host — this will start a session in the existing clone
            instead of fetching it again.
          </p>
        </section>

        <!-- ---- commit bar ---- -->
        <footer class="commit">
          <div class="preview">
            <span class="preview-label muted">session name</span>
            <code class="preview-name">{{ derivedName || '—' }}</code>
            <span class="preview-label muted">in</span>
            <code class="preview-path" :title="targetFolder ?? ''">
              {{ targetFolder ? displayPath(targetFolder, projects.home) : '—' }}
            </code>
          </div>

          <!-- Indeterminate by construction: the host emits started/finished
               and nothing between them, so a percentage here would be a lie. -->
          <div v-if="preparing" class="progress">
            <span class="progress-label muted">{{ preparing }}</span>
            <span class="progress-track"><span class="progress-bar" /></span>
          </div>

          <p v-if="stepError" class="error">{{ stepError }}</p>

          <!-- TWO commits, and the split is the answer to "do not force an
               agent choice on every session". `Start shell` is the button this
               dialog has always had, unchanged and still one click: it commits
               with no choice at all. `Start session…` chains to the agent step,
               and its ellipsis is this app's usual promise that a dialog
               follows (the workspace `+`'s "New session…" says it the same
               way). -->
          <!-- The busy mark rides INSIDE the button that is doing the work
               (see `working`), and each commit button reserves its 14px
               whether or not it is the one running: the mark is hidden, not
               absent. A spinner that appeared would widen the button under a
               cursor that is still resting on it and shove its neighbour
               sideways at the exact moment the user might click again, which
               is a worse bug than the stray glyph this replaced. -->
          <div class="commit-actions">
            <button class="btn-secondary" @click="emit('close')">Cancel</button>
            <button
              class="btn-secondary"
              :disabled="busy || !targetFolder"
              title="Create the session and leave it at a plain shell"
              @click="commit(null)"
            >
              <AppIcon
                name="refresh"
                :size="14"
                :class="working === 'shell' ? 'spin' : 'idle-mark'"
              />
              Start shell
            </button>
            <button
              class="btn-primary"
              :disabled="busy || !targetFolder"
              title="Choose an agent for this session"
              @click="openAgentStep"
            >
              <AppIcon
                name="refresh"
                :size="14"
                :class="working === 'agent' ? 'spin' : 'idle-mark'"
              />
              Start session…
            </button>
          </div>
        </footer>
      </template>
    </div>
  </OverlayPanel>
</template>

<style scoped>
.new-session {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--sp-3);
  padding: var(--sp-4);
}

/* ---- route selector: one segmented control, VS Code register ---------- */
.routes {
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.route {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: var(--control-h);
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.route:hover:not(.on) {
  background: var(--state-hover);
  color: var(--fg);
}
.route.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---- browser --------------------------------------------------------- */
.browser,
.repos {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}
.crumbbar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: var(--tabbar-h);
}
/* The roots dropdown sits at the end of the row, past wherever the crumb
   trail stops — auto-margin, the same pattern the root header's `+` uses to
   hold the right edge of its row. */
.roots-btn {
  margin-left: auto;
  flex: none;
}
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
/* Wayfinding, not selection: accent stays reserved for the selected row
   (DESIGN.md §5.2), same call as FilesView's breadcrumb. */
.crumb {
  background: transparent;
  border: none;
  padding: 0 var(--sp-1);
  color: var(--fg-secondary);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  border-radius: var(--r-sm);
}
.crumb:hover {
  color: var(--fg);
  background: var(--state-hover);
}
.crumb-sep {
  color: var(--fg-muted);
}

.folder-rows,
.repo-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  /* The list is the only thing allowed to grow: the commit bar must stay
     visible, because the derived name lives in it. */
  flex: 1 1 auto;
  min-height: 140px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
}
.folder-row,
.repo-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: var(--row-h);
  padding: var(--row-pad-y) var(--row-pad-x);
  cursor: pointer;
  border-left: 2px solid transparent;
  font-size: var(--fs-300);
}
.folder-row:hover,
.repo-row:hover {
  background: var(--state-hover);
}
/* The keyboard's hover: what ArrowUp/ArrowDown highlight is what the mouse
   would, so Enter's target is never a guess about which row is meant. */
.folder-row.active {
  background: var(--state-hover);
}
.repo-row.on {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
.folder-mark {
  color: var(--accent);
}
.repo-mark {
  color: var(--fg-muted);
}
.folder-name,
.repo-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.into {
  color: var(--fg-muted);
}

/* "Show more" is a ROW in the list, not a control beside it: it belongs to the
   scroll position the user has just reached, and a button outside the box
   would sit still while the thing it acts on moved. Same shape as the Files
   tab's. */
.more {
  padding: var(--row-pad-y) var(--row-pad-x);
}
.more-btn {
  width: 100%;
  height: var(--control-h);
  background: transparent;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-200);
}
.more-btn:hover {
  color: var(--fg);
  background: var(--state-hover);
}

/* One badge metric across the app. */
.tag {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
}
.tag.on-host {
  color: var(--success);
  background: var(--success-soft);
  border-color: transparent;
}

/* ---- fields ---------------------------------------------------------- */
.field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-200);
}
.field-label {
  flex: 0 0 auto;
  color: var(--fg-secondary);
  min-width: 7.5rem;
}
.text-input {
  flex: 1;
  min-width: 0;
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: --border is 1.49:1 and cannot be a control's sole boundary. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  padding: 0 var(--sp-2);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
}
.text-input::placeholder {
  color: var(--fg-muted);
  font-family: var(--font-ui);
}
.text-input:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.filter {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.filter-mark {
  color: var(--fg-muted);
}
.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  font-size: var(--fs-200);
  margin: 0;
}
.hint .app-icon {
  margin-top: 3px;
  color: var(--warning);
}

/* ---- commit bar ------------------------------------------------------ */
.commit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.preview {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  font-size: var(--fs-200);
}
.preview-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: var(--fs-100);
}
.preview-name {
  font-family: var(--font-mono);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
  color: var(--accent);
}
.preview-path {
  font-family: var(--font-mono);
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.commit-actions,
.result-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
/* Hidden, not gone: `visibility` keeps the box and its share of the button's
   `gap`, so the commit bar has exactly one width whether or not something is
   running. `.spin` and its reduced-motion guard are global (App.vue) — the
   mark inherits the button's `currentColor` rather than the muted grey the old
   free-floating one wore, because inside a filled primary button a grey glyph
   reads as a disabled control rather than as progress. */
.commit-actions .idle-mark {
  visibility: hidden;
}
.btn-primary,
.btn-secondary {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.btn-primary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg-secondary);
  font-weight: var(--fw-medium);
}
.btn-secondary:hover {
  color: var(--fg);
}

/* Indeterminate: a band that sweeps, with no number attached to it. */
.progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.progress-label {
  font-size: var(--fs-200);
}
.progress-track {
  position: relative;
  display: block;
  height: 3px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  overflow: hidden;
}
.progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 35%;
  border-radius: var(--r-sm);
  background: var(--accent);
  animation: sweep 1200ms var(--ease) infinite;
}
@keyframes sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(340%);
  }
}

/* ---- outcome --------------------------------------------------------- */
.result {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.result-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border);
}
.result-banner.ok {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}
.result-banner.bad {
  background: var(--error-soft);
  border-color: transparent;
  color: var(--error);
}
.result-text {
  min-width: 0;
}
.result-title {
  margin: 0;
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
  color: var(--fg);
}
.result-sub {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-200);
}
/* Accent-toned, not warning-toned: nothing has gone wrong, this is the next
   step of what the user asked for. */
.launch-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-200);
}
.launch-note .app-icon {
  margin-top: 3px;
}
.fallback-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: var(--fs-200);
}
.fallback-note .app-icon {
  margin-top: 3px;
}
code {
  font-family: var(--font-mono);
}
</style>
