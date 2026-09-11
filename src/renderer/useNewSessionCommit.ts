import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { joinPosix } from './stores/projects';
import { matchesQuery } from './fileListView';
import { parkAgentLaunch } from './pendingAgentLaunch';
import { launchBlocker, type LaunchChoice } from '../shared/agentLaunch';
import type { RepoEntry } from '../main/projects/repos';
import type { StartSessionResult } from '../main/projects/ProjectsService';
import type { SessionSummary } from '../shared/types';
import type { useConnectionStore } from './stores/connection';
import type { useProjectsStore } from './stores/projects';
import type { useSessionsStore } from './stores/sessions';

export type SessionRoute = 'existing' | 'new' | 'clone';

export interface NewSessionCommitDeps {
  connection: ReturnType<typeof useConnectionStore>;
  projects: ReturnType<typeof useProjectsStore>;
  sessions: ReturnType<typeof useSessionsStore>;
  /** The active route, owned by the dialog's tab bar. */
  route: Ref<SessionRoute>;
  startIn: () => string | null | undefined;
  onStarted: (summary: SessionSummary) => void;
}

/**
 * The new-session dialog's commit pipeline: the repo/clone state for the
 * clone route, the predicted target folder and its derived name, the agent
 * step, and the one `commit` path every route ends in.
 *
 * Extracted from NewSessionDialog.vue; every decision record below travelled
 * with its code. The folder browsing that FEEDS this pipeline lives in
 * `useNewSessionFolders`.
 */
export function useNewSessionCommit(deps: NewSessionCommitDeps): {
  newFolderName: Ref<string>;
  repoFilter: Ref<string>;
  manualRepo: Ref<string>;
  selectedRepo: Ref<string | null>;
  cloneRoot: Ref<string>;
  derivedName: Ref<string>;
  preparing: Ref<string | null>;
  stepError: Ref<string | null>;
  outcome: Ref<StartSessionResult | null>;
  agentStep: Ref<boolean>;
  parkedKind: Ref<LaunchChoice['kind'] | null>;
  busy: ComputedRef<boolean>;
  working: ComputedRef<'shell' | 'agent' | null>;
  filteredRepos: ComputedRef<RepoEntry[]>;
  selectedRepoEntry: ComputedRef<RepoEntry | null>;
  targetFolder: ComputedRef<string | null>;
  cloneRootAbsolute: ComputedRef<string>;
  alreadyOnHost: ComputedRef<boolean>;
  repoLabel: (repo: RepoEntry) => string;
  repoKey: (repo: RepoEntry) => string;
  openAgentStep: () => void;
  closeAgentStep: () => void;
  commit: (choice: LaunchChoice | null) => Promise<void>;
  onOpen: () => void;
  onStartAnother: () => void;
} {
  const { projects, sessions, connection } = deps;
  const route = deps.route;

  /** Name for the folder created by the `new` route. */
  const newFolderName = ref('');
  /** Filter over the merged repo list. */
  const repoFilter = ref('');
  /** `owner/repo` typed by hand, for a repo `gh` did not list. */
  const manualRepo = ref('');
  /** Which listed repo is selected, keyed by {@link repoKey}. */
  const selectedRepo = ref<string | null>(null);
  /** Clone destination root on the host. The helper's own default is `~/git`. */
  const cloneRoot = ref('~/git');

  /** Live preview of the name the create will ask the host for. Never user-entered. */
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
   * The folder picker's state survives the swap untouched: the route, the typed
   * folder name and the repo selection are refs shared with the dialog, which
   * stays mounted, and the browse position lives in the projects store.
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
   * ready. For `new` and `clone` this is the folder that WILL exist — the name
   * preview reads the same path, and the host resolves the name for real once
   * the folder is on disk.
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
    if (deps.startIn()) {
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
      await projects.browse(connId.value, deps.startIn() as string);
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

  /**
   * Raise the agent step, having created NOTHING.
   *
   * The ordering is the whole point: every route can
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

    const result = await projects.start(id, folder, undefined, 'unique');

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

    // The session row rides the emit, not just the name: the panel files it as
    // a pending row (`sessions.addPending`) and navigates WITHOUT a listing
    // round trip first, which is what used to sit between the click and the
    // terminal. The workspace reads the row's backend, workspace and aplexer
    // id straight off the tab bar, so the join attaches by UUID with no
    // snapshot lookup of its own.
    const summary = sessions.summaryFromStartResult(result, folder);
    if (summary) deps.onStarted(summary);
  }

  /** A clone failure the host classified — say which, not just "git failed". */
  function cloneMessage(error: string | null, state?: string): string {
    if (state === 'gh-missing') return 'This host has no GitHub CLI (`gh`), so it cannot clone for you.';
    if (state === 'gh-unauthenticated') {
      return 'The host has `gh` but is not logged in — run `gh auth login` there.';
    }
    if (state === 'helper-missing') return 'This host has no `pocketshell` helper installed.';
    return error ?? 'The clone failed.';
  }

  /**
   * Open the session named in the banner.
   *
   * The button this belongs to is no longer the ordinary way out of a create —
   * `commit` emits `started` itself now. It survives for the raw-`tmux` hold
   * above, where the panel is on screen so that a warning gets read, and the
   * user still has to be able to carry on to the session they just made. The
   * banner's full result is in hand, so the row rides along exactly as it does
   * on the direct path.
   */
  function onOpen(): void {
    const outcome_ = outcome.value;
    if (!outcome_?.sessionName) return;
    const summary = sessions.summaryFromStartResult(outcome_, null);
    if (summary) deps.onStarted(summary);
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

  return {
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
    selectedRepoEntry,
    targetFolder,
    cloneRootAbsolute,
    alreadyOnHost,
    repoLabel,
    repoKey,
    openAgentStep,
    closeAgentStep,
    commit,
    onOpen,
    onStartAnother,
  };
}
