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
//
// The rows themselves — root sections, folder rows, the drag, the empty state
// — are components/SessionTreeRows.vue, which carries their styles with it;
// this component is the panel chrome around them: the header strip, the row
// menu, the stop flow and the creation dialog. The panel's script clusters
// moved the same way: the timers to useSessionTreePoll, the row drag to
// useFolderDrag, the row menu to useFolderMenu, the folder stop to
// useFolderStop, and the row text (tooltips, badges, ages) to sessionTreeText.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import NewSessionDialog from './NewSessionDialog.vue';
import HostPanelButtons from './HostPanelButtons.vue';
import OverlayPanel from './OverlayPanel.vue';
import PopupMenu from './PopupMenu.vue';
import SessionTreeRows from './SessionTreeRows.vue';
import { type HostPanel } from '../hostPanels';
import { useComposerStore } from '../stores/composer';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import { isShortcut } from '../../shared/shortcuts';
import { editingTarget } from '../editingTarget';
import { useFolderTree } from '../folderTree';
import { rootHostPath } from '../sessionRoots';
import { type SessionDirectory } from '../sessionTree';
import type { SessionSummary } from '../../shared/types';
import { useFolderMenu } from '../useFolderMenu';
import { useFolderStop } from '../useFolderStop';
import { useSessionTreePoll } from '../useSessionTreePoll';
import { sessionCountLabel } from '../sessionTreeText';

defineProps<{
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
const { home, roots } = useFolderTree();

/**
 * The panel's two timers — the cosmetic minute clock and the five-second poll
 * — moved whole, comments and all, to ../useSessionTreePoll.ts. `now` feeds
 * the rows' relative ages as a prop.
 */
const { now } = useSessionTreePoll({ connection, sessions });

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
  return first ? rootHostPath(first.key, home.value) : null;
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
    .map((root) => ({ label: root.key, path: rootHostPath(root.key, home.value) }))
    .filter((r): r is { label: string; path: string } => r.path !== null),
);

/**
 * The row's right-click menu and the stop-everything-in-a-folder flow it arms
 * moved whole, comments and all, to ../useFolderMenu.ts and ../useFolderStop.ts;
 * this component binds them to the menu and the confirm sheet in its template.
 */
const { folderMenu, openFolderMenu, createInFolder } = useFolderMenu({ home, creating });
const { stopping, stopBusy, stopError, stopFolderLabel, askStopFolder, confirmStopFolder } =
  useFolderStop({ folderMenu, connection, projects, sessions, composer });

onMounted(async () => {
  if (!connection.connectionId) return;
  await sessions.refresh(connection.connectionId);
  // A failure is not worth surfacing: the panel still groups, just from the
  // shape of the paths. The dialog is where a missing `$HOME` is an error,
  // because there it blocks creating anything.
  await projects.ensureHome(connection.connectionId);
});

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

    <!-- The rows — root sections, folder rows, the drag and its indicator,
         the empty state — are SessionTreeRows.vue now, and their styles went
         with them (scoped styles do not cross the component boundary). The
         rows announce through it: a select for a click, a menu payload for a
         right-click, and the folder each `+` resolved for the ONE creation
         flow, which stays here with the dialog. -->
    <SessionTreeRows
      :active-folder="activeFolder"
      :now="now"
      :default-start-in="defaultStartIn"
      @select="emit('select', $event)"
      @menu="openFolderMenu"
      @create="creating = { startIn: $event }"
    />

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
  /* Query container for the narrow-panel rule that hides the rows' timestamps
     — it lives at the bottom of SessionTreeRows.vue's block, beside the rows
     it draws; container resolution follows the DOM, not the scope. */
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
</style>
