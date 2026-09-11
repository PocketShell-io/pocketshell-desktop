<script setup lang="ts">
// FolderWorkspaceView: everything scoped to ONE project FOLDER, rendered in
// the host workspace's right pane. It replaces SessionWorkspaceView, which was
// scoped to one session.
//
// The tab bar is the whole idea:
//
//   [ main ] [ import ] [ main 2 ] [ Files ] [+]
//
// one tab per tmux session in the folder, then one or more Files tabs, session
// tabs first. A session tab IS a terminal — there is no sub-navigation inside
// one, because the Conversation view that used to compete for that space has
// been deleted.
//
// Four structural notes, three of them inherited from the view this replaces
// because the reasons have not changed:
//
//   - ONE TerminalView PER SESSION TAB the user has visited, all of them left
//     mounted, only the active one shown. Main keeps a tmux client per session
//     and holds it for the life of the tab (src/main/ssh/TmuxClientPool.ts), so
//     each pane already holds its own session's screen and moving between tabs
//     is a `v-show` and nothing else — no SSH, no redraw, no bytes.
//
//     This is the reverse of what this file said until now, and the reason is
//     measured. One re-pointed TerminalView meant every tab click cost a
//     `tmux switch-client` exec plus a full-screen repaint over SSH: p50 210 ms
//     on the user's host when it worked, and it mostly did not, falling back to
//     a ~2 s re-join. A switch cannot be made to feel like changing tabs in an
//     editor, because an editor does not ask another machine for the tab.
//
//     Panes are mounted LAZILY — a tab gets its TerminalView the first time it
//     is selected, never before. Mounting one while hidden would have xterm's
//     FitAddon measure a 0x0 box and push its 2x1 minimum at the remote.
//   - The terminals stay mounted (`v-show`, not `v-if`) while a Files tab is
//     showing; unmounting one would close its SSH shell and drop the attach.
//   - Identity and tabs share ONE bar, for the 40px of window it gives back to
//     the pane.
//   - `.workspace-body` is the composer's stage: the card floats over the tab
//     content inside it rather than docking below, so no composer state can
//     change the terminal's row count.
//
// The composer is mounted ONCE, outside `.tab-body` and never behind a `v-if`,
// so a tab switch cannot cost a draft. It follows the ACTIVE SESSION TAB — its
// per-session record is keyed on the session name, so switching session tabs
// swaps the draft and switching back restores it.
//
// The bar itself — the strip, the rename field, the drag, the `+` and the tab
// menu — is components/WorkspaceTabBar.vue, with its styles carried alongside.
// The script clusters moved the same way: the tab model, panes, identities,
// selection and Files tabs to useWorkspaceTabs, and the window chords to
// useWorkspaceChords; the workspace memory, rename, launch, stop and reveal
// were already composables of their own.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type VNode } from 'vue';
import { useRoute } from 'vue-router';
import { registerWorkspaceFocus, unregisterWorkspaceFocus } from '../workspaceFocus';
import { useConnectionStore } from '../stores/connection';
import { useSessionsStore } from '../stores/sessions';
import { useProjectsStore } from '../stores/projects';
import { useFilesStore } from '../stores/files';
import { useComposerStore } from '../stores/composer';
import { useSettingsStore } from '../stores/settings';
import { useShellsStore } from '../stores/shells';
import AppIcon from '../components/AppIcon.vue';
import TerminalView from '../components/TerminalView.vue';
import PromptComposer from '../components/PromptComposer.vue';
import FilesView from './FilesView.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import LaunchSessionDialog from '../components/LaunchSessionDialog.vue';
import WorkspaceTabBar from '../components/WorkspaceTabBar.vue';
import type { Box } from '../../shared/popupPlacement';
import { composerAgentKind } from '../../shared/composerSend';
import { normalisePart } from '../../shared/sessionNameParts';
import { UNTRACKED_PATH } from '../sessionGrouping';
import { useFolderTree } from '../folderTree';
import { useWorkspaceMemory } from '../useWorkspaceMemory';
import { useSessionRename } from '../useSessionRename';
import { useSessionLaunch } from '../useSessionLaunch';
import { useSessionStop } from '../useSessionStop';
import { useWorkspaceReveal } from '../useWorkspaceReveal';
import { useWorkspaceTabs } from '../useWorkspaceTabs';
import { useWorkspaceChords } from '../useWorkspaceChords';

const route = useRoute();
const connection = useConnectionStore();
const sessions = useSessionsStore();
const projects = useProjectsStore();
const files = useFilesStore();
const composer = useComposerStore();
const settings = useSettingsStore();
const shells = useShellsStore();
const { folders } = useFolderTree();

/**
 * The folder key from the route — `~/git/dtc-website`.
 */
const folderKey = computed(() => String(route.params['folder'] ?? ''));

/** The host alias from the route — the stable identity the tab state keys on. */
const hostAlias = computed(() => String(route.params['name'] ?? ''));

/**
 * The remembered tab state — Files tabs, selection, selection history, the
 * hand-arranged order — and the persistence and restore machinery behind it.
 * The state and its why-comments live in useWorkspaceMemory.ts; the bar below
 * derives from these refs.
 */
const memory = useWorkspaceMemory({
  folderKey,
  hostAlias,
  routedTab: () => route.query['tab'] as string | undefined,
  // Lazy by contract: only the commands read these, never setup — the bar they
  // resolve through is derived from the refs this call returns.
  getActiveTab: () => activeTab.value,
  focusActiveTab,
});
const { selected, mru, tabOrder, writeTabOrder, loadFolderState, persist } = memory;

/**
 * The folder node this workspace is showing, out of the same grouping the
 * panel renders.
 *
 * Read from the same projection as the session panel rather than filtering
 * sessions on `path`. The shared projection is where `~/git/foo` and
 * `/home/me/git/foo` are folded into one key, where a session with no cwd
 * becomes a folder of its own, and where a sibling-inferred path has already
 * been applied. Keeping one computed list for both surfaces prevents the
 * panel from showing a folder whose workspace has a different set of tabs.
 */
const folder = computed(() => {
  return folders.value.find((dir) => dir.key === folderKey.value) ?? null;
});

/** The folder's real path, or null for an untracked session's pseudo-folder. */
const folderPath = computed(() => {
  const path = folder.value?.path ?? folderKey.value;
  return path === UNTRACKED_PATH ? null : path;
});

/**
 * The tab model — the bar, the panes behind the session tabs, the identities
 * that key them, selection, and the Files tabs — moved whole, comments and
 * all, to ../useWorkspaceTabs.ts.
 */
const {
  tabs,
  activeTab,
  activeSession,
  sessionTabTitle,
  tabMark,
  terminalSession,
  terminalIdentity,
  openPanes,
  sessionPanes,
  summary,
  activeSessionMeta,
  sessionMeta,
  aplexerRefFor,
  identityFor,
  terminalRefs,
  setTerminalRef,
  selectTab,
  goToTab,
  selectAfterClose,
  addFilesTab,
  onOpenInNewTab,
  closeFilesTab,
} = useWorkspaceTabs({
  folder,
  folderKey,
  folderPath,
  sessions,
  files,
  memory,
  focusActiveTab,
});

/**
 * The engine recorded host-side for the active session, narrowed to what the
 * composer can route to. An agent session gets the slash-command catalog, a
 * shell never does.
 */
const agentKind = computed(() => composerAgentKind(summary.value?.agentKind));

onMounted(async () => {
  loadFolderState();
  // Deep-linking straight to a folder (or a reload) can leave the stores empty,
  // and both matter here: without the session list there are no tabs at all,
  // and the home value feeds the panel's path labels.
  if (connection.connectionId) {
    if (!sessions.sessions.length) await sessions.refresh(connection.connectionId);
    await projects.ensureHome(connection.connectionId);
  }
});

watch(folderKey, () => {
  cancelRename();
  addAnchor.value = null;
  createError.value = null;
  // The dialog is bound to the OUTGOING folder's path; leaving it open would
  // let a confirm create a session in the folder we just left.
  launching.value = false;
  // A launch armed for the folder we are leaving must not fire a message into
  // the folder we are arriving at.
  cancelPendingLaunch();
  loadFolderState();
});

// The terminal-reveal half of the workspace: watching the files store's parked
// request and routing it to the right Files tab, with a dedicated tab for a
// target outside the folder. The decision records live in
// useWorkspaceReveal.ts; the handlers it closes over are declared below.
useWorkspaceReveal({
  files,
  projects,
  folderKey,
  folderPath,
  tabs,
  getActiveTab: () => activeTab.value,
  selected,
  persist,
  onOpenInNewTab,
  addFilesTab,
});

/**
 * Put the keyboard where the user just looked.
 *
 * Clicking a tab left focus on the tab BUTTON, so the first keystroke went to
 * the button and the user had to click a second time, into the pane, before
 * typing worked. That is the same defect bc86cf7 fixed for the composer, whose
 * comment says it plainly: without it "the feature would have looked broken
 * from the first try". It matters more here because `typingOpensComposer`
 * means a keystroke in a focused terminal is supposed to OPEN the composer with
 * that character in it — a feature that simply never fires if the terminal was
 * not focused, which is exactly the case the user hits first.
 *
 * `nextTick` because the pane that should take focus may not be rendered yet:
 * a session tab visited for the first time is mounted by this very selection.
 *
 * A FILES tab hands focus to its own surface rather than to nothing, so arrow
 * keys work on the tree without a second click — but only through the same
 * ref-and-ask shape used for terminals, so there is ONE path here and the
 * hotkeys below cannot diverge from the click. The Files pane declines the
 * focus when an editor is open with unsaved content: moving the caret out of a
 * dirty buffer to a tree the user did not ask for would be worse than doing
 * nothing, and that judgement belongs to the pane that knows it is dirty.
 */
async function focusActiveTab(): Promise<void> {
  await nextTick();
  const tab = activeTab.value;
  if (!tab) return;
  if (tab.kind === 'session') {
    terminalRefs.get(identityFor(tab.session))?.focus();
    return;
  }
  filesRef.value?.focus?.();
}

/**
 * The host workspace asks for this when the user clicks THIS folder's row in
 * the panel while already inside it: there is no navigation to arrive with
 * (same folder, same route), but the click is still "take me to this
 * workspace", so the keyboard lands the way a fresh arrival's does. Registered
 * for the mount's lifetime (workspaceFocus.ts) — the one channel the host may
 * use, and unmounting it must revoke. The wrapper is one function handed to
 * both ends so the slot can tell its own registration from any other, and it
 * stays `void`: the registry's contract is a synchronous ask.
 */
const requestFocus = (): void => {
  void focusActiveTab();
};
onMounted(() => registerWorkspaceFocus(requestFocus));
onBeforeUnmount(() => unregisterWorkspaceFocus(requestFocus));

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------
// The field state, the commit, and adoptRenamedSession's one-tick move live in
// useSessionRename.ts. What stays here is the field's DOM: focusing it once on
// mount, and the live character normalisation on input.

const {
  renaming,
  renameText,
  renameError,
  beginRename,
  cancelRename,
  commitRename,
} = useSessionRename({
  connection,
  sessions,
  projects,
  composer,
  aplexerRefFor,
  identityFor,
  openPanes,
  terminalRefs,
  selected,
  terminalSession,
  terminalIdentity,
  mru,
  tabOrder,
  writeTabOrder,
  persist,
});

/**
 * Focus the rename field, once, as it mounts.
 *
 * The `autofocus` attribute is no good here — the browser honours it only for
 * an element present at page load and silently ignores one a framework inserts
 * later — but a FUNCTION ref is no good either: Vue invokes it on every
 * re-render of its owner, not only at mount, and this component re-renders on
 * every keystroke (`renameText` feeds the field). A re-invoked `focus()` is a
 * harmless no-op, but the `select()` that makes typing replace the old name
 * would re-select the whole field after every character, and the next
 * keystroke would overwrite it — one letter per keystroke, the last one
 * winning. `@vnode-mounted` runs exactly once per mount, which is the whole
 * behaviour wanted: the keyboard lands with the old name pre-picked, and
 * typing from there on is the user's.
 */
function onRenameFieldMounted(vnode: VNode): void {
  const el = vnode.el;
  if (el instanceof HTMLInputElement) {
    el.focus();
    el.select();
  }
}

/**
 * Rewrite the characters a session name could not keep AS THE USER TYPES —
 * but only those: `normalisePart`, not the full `sanitisePart`, because the
 * edge trim cannot run per keystroke. A `-` is typed at the END of the field
 * first, and a live trailing-strip ate it on landing, which made `foo-bar`
 * untypable (it arrived as `foobar`). The commit still sanitises through
 * `renamedSessionName`'s `sanitisePart`, so a name that merely ends in `-`
 * commits trimmed — visible on the tab the moment the field closes — and
 * every other keystroke leaves on screen exactly what will be committed.
 */
function onRenameInput(event: Event): void {
  const el = event.target as HTMLInputElement;
  const cleaned = normalisePart(el.value);
  if (cleaned !== el.value) el.value = cleaned;
  renameText.value = cleaned;
}


// ---------------------------------------------------------------------------
// Creating a session in this folder
// ---------------------------------------------------------------------------
// The launch pipeline — the dialog state, the wait for the new session's PTY,
// the deadline, the session panel's parked hand-off, and the create itself —
// lives in useSessionLaunch.ts. What stays here is the `+` menu's anchor,
// which the create and the Files-tab item share, and the error strip, which
// this cluster and the rename's fill.

/**
 * The `+` menu's anchor box, or null when it is shut.
 *
 * A measured rect rather than a boolean, because the menu is teleported out of
 * the tab strip and positioned `fixed`. It has to be: the strip scrolls
 * horizontally, which makes it clip vertically too, and the original
 * `position: absolute; top: 100%` dropdown was laid out exactly at that clip
 * edge — invisible, which is why the user reported that clicking `+` did
 * nothing. See src/shared/popupPlacement.ts for the measurement.
 */
const addAnchor = ref<Box | null>(null);

const { launching, createError, openLaunchDialog, cancelPendingLaunch, createSession } =
  useSessionLaunch({
    connection,
    projects,
    sessions,
    shells,
    tabs,
    getActiveTab: () => activeTab.value,
    sessionMeta,
    folderPath,
    selected,
    persist,
    goToTab,
    focusActiveTab,
    addAnchor,
  });

/**
 * The window chords — `Ctrl+[` / `Ctrl+]` and `Ctrl+N` — moved whole, comments
 * and all, to ../useWorkspaceChords.ts; the listener registers itself here for
 * the mount's lifetime, exactly where the view's handler used to.
 */
useWorkspaceChords({ renaming, tabs, activeTab, settings, goToTab, createSession });

/**
 * What the strip under the tab bar shows: the rename's refusal when there is
 * one, otherwise the create's.
 *
 * A refused rename used to surface only as a tooltip on the field and a 1px
 * border tint — a user who pressed Enter and got a host-side refusal saw a
 * field that just stayed there, subtly red, with nothing on screen saying why.
 * Worst on the `@blur` commit, where the field is not even focused any more,
 * so there was nothing to hover and nothing to read. A refused CREATE has been
 * a visible sentence in this strip all along ("a failed create is a sentence,
 * not a dialog" — see `.bar-error` below), and a refused rename is the same
 * shape of news about the same bar, so it borrows the strip rather than
 * growing a second one. The field keeps its `.invalid` tint — the strip says
 * WHY, the tint says WHERE.
 *
 * Rename wins when both are somehow set (a failed create left its sentence up
 * and the user then started a rename that also failed): the rename field is
 * the edit that is open NOW, so its complaint is the one the user can act on.
 */
const barError = computed(() => renameError.value ?? createError.value);

/**
 * Clear the strip by hand. Until now the sentence persisted until the next
 * action or a folder switch — tolerable for the short refusals, but the
 * launch-timeout remedy runs to three lines and otherwise sat there for the
 * life of the folder. Both sources are cleared, not just the one showing:
 * the button's promise is "make this strip go away", and leaving the other
 * message queued behind the first would have the strip survive its own
 * dismissal.
 */
function dismissBarError(): void {
  createError.value = null;
  renameError.value = null;
}

/**
 * The `+`'s click, relayed from the bar with the button's measured rect. The
 * open/close decision stays in this file because the anchor state does — the
 * launch composable closes the menu through the same ref.
 */
function toggleAddMenu(box: Box | null): void {
  if (addAnchor.value) {
    addAnchor.value = null;
    return;
  }
  if (box) addAnchor.value = { left: box.left, top: box.top, width: box.width, height: box.height };
}

/**
 * The bar menu's Redraw, relayed: the pane handles live in this file's
 * `terminalRefs`, keyed by the identity the menu resolved while the row stood.
 */
function redrawFromIdentity(identity: string): void {
  terminalRefs.get(identity)?.resyncDisplay();
}

/** "New Files tab" from the `+` menu: shut the menu, then mint the tab. */
function addFilesFromMenu(): void {
  addAnchor.value = null;
  addFilesTab();
}

// ---------------------------------------------------------------------------
// The session tab's context menu, and stopping a session
// ---------------------------------------------------------------------------

/**
 * The kill machinery — the named confirmation, the busy latch, and
 * confirmStop's three-piece teardown — lives in useSessionStop.ts. The menu
 * and the `×` (in the bar component) only ever arm it.
 */
const { stopping, stopBusy, confirmStop } = useSessionStop({
  connection,
  projects,
  sessions,
  composer,
  aplexerRefFor,
  identityFor,
  sessionMeta,
  openPanes,
  createError,
  selectAfterClose,
});

/**
 * Whether the terminal should withhold printable keystrokes instead of sending
 * them to the shell. The halves of the condition live
 * here rather than in either component: the SETTING is app-level, and "only
 * while the composer is closed" is a fact about the composer.
 *
 * `terminalOwnsTyping` is the short-draft hand-off: the composer just
 * put its draft at the shell prompt, so typing belongs to the pane until the
 * composer is summoned again — re-catching the next keystroke would fight the
 * text it just put there. Opening the panel clears the flag in the store, so
 * this returns on its own.
 */
const interceptTyping = computed(
  () =>
    settings.typingOpensComposer &&
    composer.mode === 'hidden' &&
    !composer.terminalOwnsTyping &&
    activeTab.value?.kind === 'session',
);

/** A keystroke the terminal withheld: it belongs in the draft, not the shell. */
function onTyped(text: string): void {
  composerRef.value?.typeInto(text);
}

/**
 * Ctrl+V at the terminal: the clipboard belongs in the composer, not the shell.
 *
 * The terminal has already cancelled the chord and withheld the bytes; what is
 * on the clipboard, whether it can be staged, and whether it is worth opening
 * the panel for are the composer's questions, because the composer is where the
 * answer is acted on. Routing an EVENT rather than the clipboard's contents is
 * what keeps a second clipboard-to-attachment path out of TerminalView — the
 * composer's own `onPaste` already owns that path.
 *
 * Unlike `interceptTyping` this is deliberately NOT gated on the composer being
 * closed or unsuppressed. An explicit Ctrl+V is a summons, like Ctrl+`, so it
 * lifts a dismissal rather than deferring to one.
 */
function onPasteIntoComposer(): void {
  void composerRef.value?.pasteFromSystemClipboard();
}

/**
 * A file dropped on the terminal pane routes to the composer for staging, the
 * same join the paste chords use. The File objects must ride the event — a
 * DataTransfer is dead once the drop event returns, so the composer cannot
 * re-read them the way it re-reads a clipboard — but nothing else crosses:
 * opening, naming, mime fallback and the single-flight upload are all the
 * composer's, through the one `stageFiles` path every other entry point uses.
 */
function onDropIntoComposer(dropped: File[]): void {
  void composerRef.value?.acceptDroppedFiles(dropped);
}

/** Put the keyboard back in the pane after a key or button closed the composer. */
function onFocusTerminal(): void {
  if (activeTab.value?.kind !== 'session') return;
  const identity = terminalIdentity.value;
  if (identity) terminalRefs.get(identity)?.focus();
}

/** Same reasoning as `terminalRefs`, for the composer, whose `typeInto` the terminal feeds. */
const composerRef = ref<{
  typeInto: (text: string) => void;
  pasteFromSystemClipboard: () => Promise<void>;
  acceptDroppedFiles: (files: File[]) => Promise<void>;
} | null>(null);
/**
 * The Files pane, for {@link focusActiveTab}.
 *
 * Optional `focus` in the type rather than required: this is a `.vue` default
 * export, so the instance type is `any` at the call site and a required member
 * would be checked against nothing anyway. Written as optional so the call
 * reads as what it is — an ask, which the pane may decline.
 */
const filesRef = ref<{ focus?: () => void } | null>(null);

</script>

<template>
  <div class="folder-workspace">
    <!-- The bar — strip, rename field, drag, the `+` menu and the tab menu —
         is WorkspaceTabBar.vue, styles carried with it. Everything it renders
         announces through events; everything it needs arrived as props. -->
    <WorkspaceTabBar
      :tabs="tabs"
      :active-tab-id="activeTab?.id ?? null"
      :renaming="renaming"
      :rename-text="renameText"
      :rename-error="renameError"
      :add-anchor="addAnchor"
      :session-tab-title="sessionTabTitle"
      :tab-mark="tabMark"
      :identity-for="identityFor"
      @select="selectTab"
      @begin-rename="beginRename"
      @commit-rename="commitRename"
      @cancel-rename="cancelRename"
      @rename-field-mounted="onRenameFieldMounted"
      @rename-input="onRenameInput"
      @stop="stopping = $event"
      @close-files="closeFilesTab"
      @launch="openLaunchDialog"
      @add-files="addFilesFromMenu"
      @add-toggle="toggleAddMenu"
      @add-menu-close="addAnchor = null"
      @redraw="redrawFromIdentity"
      @reorder="writeTabOrder"
    />

    <!-- Create and rename refusals share this one strip; see `barError` in the
         script for why. The dismiss is the app's ghost `.icon-btn sm` register
         (App.vue) and nothing louder: the strip is already error-tinted, and a
         button that outshouted the sentence would make the remedy read like a
         second problem. `@mousedown.prevent` is load-bearing, not tidiness:
         while a rename field is open, an unprevented mousedown here would blur
         the field, the blur would re-run the failing commit, and the message
         would be re-set moments after the click cleared it — a dismiss button
         that un-dismisses itself. -->
    <p v-if="barError" class="bar-error">
      <span class="bar-error-text">{{ barError }}</span>
      <button
        class="icon-btn sm bar-error-dismiss"
        title="Dismiss"
        aria-label="Dismiss this message"
        @mousedown.prevent
        @click="dismissBarError"
      >
        <AppIcon name="close" :size="12" />
      </button>
    </p>

    <div class="workspace-body">
      <div class="tab-body">
        <!-- One terminal per visited session tab, all kept mounted. Hiding
             rather than re-pointing is what makes a tab switch instant, and
             keeping them mounted while a Files tab shows is what stops a tab
             switch dropping an attach. The v-for is over the PANE RECORDS, not
             the tabs, and the key is the record's stable id: a tab's own id is
             the session name, so keying on it would read a rename as "one pane
             gone, another appeared" and pay a full re-join for a relabel.
             `sessionPanes` filters the records against the live identities, so
             a pane whose session is killed on the host — or left behind on the
             folder just navigated away from — stops rendering. The match is by
             the workspace-qualified identity, never the bare name: two
             workspaces' `main` tabs must not show each other's terminal. -->
        <div class="terminal-area" v-show="activeTab?.kind === 'session'">
          <div
            v-for="pane in sessionPanes"
            :key="pane.id"
            v-show="pane.identity === terminalIdentity"
            class="terminal-slot"
          >
            <TerminalView
              v-if="connection.connectionId"
              :ref="(el) => setTerminalRef(pane.identity, el)"
              :connection-id="connection.connectionId"
              :session-key="pane.identity"
              :session-name="pane.session"
              :backend="sessionMeta.get(pane.session)?.backend"
              :workspace="sessionMeta.get(pane.session)?.workspace"
              :aplexer-id="sessionMeta.get(pane.session)?.aplexerId"
              :intercept-typing="interceptTyping && pane.identity === terminalIdentity"
              @typed="onTyped"
              @paste-into-composer="onPasteIntoComposer"
              @drop-into-composer="onDropIntoComposer"
            />
          </div>
        </div>

        <FilesView
          ref="filesRef"
          v-if="activeTab?.kind === 'files' && connection.connectionId"
          :key="activeTab.id"
          :start-path="activeTab.path ?? undefined"
          :session-key="activeTab.id"
          @open-in-new-tab="onOpenInNewTab"
        />

        <!-- No tabs at all. Most often this is just a folder with nothing in
             it — the ordinary entry state now that no Files tab is seeded —
             and it is also where a killed-off session list or an outlived deep
             link lands. There is exactly one useful thing to do here, so the
             empty state IS the create affordance. It opens the same dialog the
             `+` does rather than starting a bare shell, so there is ONE way to
             create a session in a folder and it is the one that can also start
             an agent; browsing files without a session stays on the `+` menu.
             Held off while the session list is still loading, so a deep link
             does not announce "nothing is running" a beat before the tabs
             arrive. -->
        <div v-if="!tabs.length && !sessions.loading" class="empty">
          <p class="muted">{{ folderPath ?? folderKey }}</p>
          <p class="muted">nothing is running in this folder</p>
          <button class="btn-ghost" @click="openLaunchDialog">Start a session here</button>
        </div>
      </div>

      <!-- The prompt composer FLOATS over the tab content rather than docking
           below it. Mounted once, v-show (never v-if) so a tab switch cannot
           cost the user a draft. It follows the ACTIVE SESSION TAB. -->
      <div
        v-if="connection.connectionId && activeSession"
        v-show="activeTab?.kind === 'session'"
        class="composer-dock"
      >
        <PromptComposer
          ref="composerRef"
          :connection-id="connection.connectionId"
          :session-name="activeSession"
          :backend="activeSessionMeta?.backend"
          :workspace="activeSessionMeta?.workspace"
          :agent-kind="agentKind"
          :connected="connection.state === 'connected'"
          @focus-terminal="onFocusTerminal"
        />
      </div>
    </div>

    <!-- THE ONLY DESTRUCTIVE CONFIRMATION IN THIS APP.

         It names the SESSION — the same string the tab reads, verbatim, so
         what is being destroyed is spelled out in full and a tab called
         `main` never leaves the user guessing which workspace's `main` it
         is. It also says what goes, because "Stop" undersells it — a session
          is usually an agent mid-task, and its scrollback and process
          tree go with it.

         Escape and the backdrop cancel, and Cancel is the DEFAULT-looking
         button while Stop carries the error tint, so the dangerous half of the
         dialog is the half that has to be aimed at. -->
    <OverlayPanel v-if="stopping" title="Stop session" size="sm" @close="stopping = null">
      <div class="stop-confirm">
        <p>Stop <code>{{ stopping }}</code> ?</p>
        <p class="muted">
          This kills the session on the host. Anything running in it stops, its scrollback goes,
          and there is no undo.
        </p>
        <footer class="actions">
          <button class="btn-secondary" @click="stopping = null">Cancel</button>
          <button class="btn-danger" :disabled="stopBusy" @click="confirmStop">
            {{ stopBusy ? 'Stopping…' : 'Stop session' }}
          </button>
        </footer>
      </div>
    </OverlayPanel>

    <!-- Nothing is created until `confirm` fires, so Escape, the backdrop and
         Cancel all cost the user exactly nothing. -->
    <LaunchSessionDialog
      v-if="launching"
      :folder-path="folderPath"
      :folder-label="folder?.label ?? folderKey"
      @confirm="createSession"
      @close="launching = false"
    />
  </div>
</template>

<style scoped>
.folder-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;

  /* The gap between the floating composer and this pane's edges — what makes
     it read as hovering rather than as a bar welded to the window. Declared
     here rather than in App.vue's :root because it describes THIS pane's
     relationship with the composer, and custom properties inherit, so
     PromptComposer reads the same number without being handed it. */
  --composer-inset: var(--sp-3);
}
/* The confirm sheet. `sm` OverlayPanel, two paragraphs and two buttons — the
   dialog is short because the decision is, and a longer one would bury the
   session's name. */
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
/* Solid error, not a tinted ghost. This is the button that destroys the
   session, and a confirm dialog whose dangerous option is the quieter of the
   two is a trap. */
.stop-confirm .btn-danger {
  background: var(--error);
  border: 1px solid var(--error);
  color: var(--on-accent);
}
.stop-confirm .btn-danger:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* A failed create is a sentence, not a dialog: the tab bar is still usable and
   the message is about the one action that did not happen. A failed rename
   rents the same line now, for the same reason (see `barError` in the script).
   Flex, so the dismiss button sits at the end of the strip; the TEXT is the
   flexible child, so the three-line launch-timeout remedy wraps under itself
   rather than under the button. */
.bar-error {
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--error);
  background: var(--error-soft);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
.bar-error-text {
  flex: 1;
  min-width: 0;
}
/* The shared `.icon-btn` is square by construction; pinned rigid here so a
   long message cannot squeeze it below its tap target. */
.bar-error-dismiss {
  flex: 0 0 auto;
}
.workspace-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* Containing block for .composer-dock, which is positioned against it. */
  position: relative;
}
/*
 * NO ROOM IS RESERVED FOR THE COMPOSER, and the terminal is sized once by the
 * pane. That is what keeps opening, closing, dragging and resizing the card
 * free of an SSH window-change and a remote tmux reflow. See the same block in
 * the view this replaced; the reasoning is unchanged.
 */
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.terminal-area {
  flex: 1;
  min-width: 0;
  display: flex;
}
/*
 * One of these per live session pane. They are siblings in the same flex row
 * and all but one are `display: none`, so the visible one takes the whole area
 * exactly as the single terminal used to. `min-width: 0` for the usual reason —
 * a flex item defaults to `min-width: auto` and would refuse to shrink below
 * its content, which for an xterm canvas means the pane can grow but not shrink.
 */
.terminal-slot {
  flex: 1;
  min-width: 0;
  display: flex;
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-size: var(--fs-300);
}
.empty p {
  margin: 0;
}

/* ---- the composer floats over the tab content --------------------------- */
/*
 * Why an overlay and not a docked row: docked, the composer was a flex sibling
 * of the tab body, so every open, close and resize changed the terminal's pixel
 * height — which changes its ROW COUNT, which is an SSH window-change the
 * remote tmux has to redraw and reflow for. Typing a prompt should not reflow
 * the session behind it.
 *
 * Why the dock is the WHOLE body and not a strip at the bottom: because the
 * card MOVES. Every clamp in src/shared/composerGeometry.ts is measured against
 * this element.
 */
.composer-dock {
  position: absolute;
  /* INSET rather than padded. An absolutely positioned child resolves its
     offsets against its containing block's PADDING box, so padding here would
     not have held the card off the pane's edges — and insetting the dock itself
     makes `right: 0; bottom: 0` mean "the resting corner". */
  inset: var(--composer-inset);
  z-index: 5;
  pointer-events: none;
}
</style>
