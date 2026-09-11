<script setup lang="ts">
// NewSessionDialog: folder-first session creation.
//
// This replaces the bare "new session name" field that used to sit at the
// bottom of SessionTree. That field had the model backwards. A session is not
// named, it is PLACED: the user picks a project folder on the host and the
// backend names the session from there — on aplexer the workspace's next free
// tag (`main`, then `main-2`, …; the workspace half of `workspace:tag` does
// the grouping), on the tmux fallback a derivation from the folder path
// (`~/git/pocketshell` -> `git-pocketshell`, the rule `tmuxctl` and the
// Android app apply so all three clients agree about which session belongs to
// which folder). The name the create WILL ask for is previewed in the footer
// before anything is committed; it is never typed.
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
// ## The second question: which agent
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
// The old single-dialog objection to chaining, so the chain is ordered to preserve it
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
import { ref } from 'vue';
import AppIcon from './AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import LaunchSessionDialog from './LaunchSessionDialog.vue';
import PopupMenu from './PopupMenu.vue';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { KIND_LABELS } from '../../shared/agentLaunch';
import type { SessionSummary } from '../../shared/types';
import { displayPath } from '../stores/projects';
import { useNewSessionCommit, type SessionRoute } from '../useNewSessionCommit';
import { useNewSessionFolders } from '../useNewSessionFolders';

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
  /** The session is live on the host; open it. Carries the row to file. */
  started: [summary: SessionSummary];
  close: [];
}>();

const connection = useConnectionStore();
const projects = useProjectsStore();
const sessions = useSessionsStore();

const route = ref<SessionRoute>('existing');
// The commit pipeline — repo/clone state, the predicted target folder and its
// derived name, the agent step, and the one `commit` path every route ends in —
// is useNewSessionCommit.ts; the folder browsing that feeds it is
// useNewSessionFolders.ts. Both carry their decision records.
const {
  newFolderName,
  repoFilter,
  manualRepo,
  selectedRepo,
  cloneRoot,
  derivedName,
  preparing,
  stepError,
  outcome,
  agentStep,
  parkedKind,
  busy,
  working,
  filteredRepos,
  targetFolder,
  alreadyOnHost,
  repoLabel,
  repoKey,
  openAgentStep,
  closeAgentStep,
  commit,
  onOpen,
  onStartAnother,
} = useNewSessionCommit({
  connection,
  projects,
  sessions,
  route,
  startIn: () => props.startIn,
  onStarted: (summary) => emit('started', summary),
});

const {
  folderQuery,
  searchEl,
  folderListEl,
  activeRowIndex,
  crumbs,
  folderView,
  onFilterKeydown,
  showMoreFolders,
  onSearchEscape,
  onEnter,
  onUp,
  onCrumb,
  onHome,
  rootsAnchor,
  rootsBtnEl,
  toggleRootsMenu,
  onRoot,
} = useNewSessionFolders({ projects, connection, route, busy, commit });
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
  same call as FilesView's breadcrumb. */
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
