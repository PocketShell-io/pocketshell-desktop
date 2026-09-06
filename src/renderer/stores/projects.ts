import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '../../shared/types';
import type { DirEntry } from '../../main/sftp/SftpService';
import type { RepoEntry, ReposScopeState } from '../../main/projects/repos';
import { errorMessage } from '../../shared/errors';
import type {
  AplexerSessionRef,
  CloneResult,
  CreateFolderResult,
  KillSessionResult,
  RenameSessionResult,
  SessionNamePolicy,
  StartSessionResult,
} from '../../main/projects/ProjectsService';

/**
 * Projects store — the folder-first session-creation flow.
 *
 * A session is not named, it is *placed*: the user picks a project folder by
 * one of three routes (an existing folder, a new empty folder, a fresh GitHub
 * clone) and the session name is DERIVED from that folder by the host, never
 * typed. This store owns the data-fetching half of that flow;
 * `NewSessionDialog.vue` owns the form state.
 *
 * Two deliberate shapes here, both inherited from the backend contract:
 *
 *  - **Folder browsing goes through SFTP.** There is no folder-listing channel
 *    and there should not be one: `projects.home()` supplies the root and
 *    `sftp.list()` filtered to `type === 'dir'` supplies the children, which is
 *    the same wrapper the Files tab already uses.
 *  - **Nothing here throws.** Every `projects.*` call resolves a result object
 *    with an `ok` flag, so the failures that matter (a folder that vanished, a
 *    host with no `gh`) arrive as data the UI can react to rather than as an
 *    exception it can only print.
 */
export const useProjectsStore = defineStore('projects', () => {
  /**
   * This store is shared by every workspace in the renderer, but its remote
   * paths are not. A connection id is the boundary: `/home/alexey` from one
   * host must never become the SFTP path sent to another host.
   *
   * The explicit scope also covers callers that replace a connection without
   * first visiting the picker (and makes the invariant local to this store,
   * rather than relying on every connection transition to remember a clear).
   */
  let scopedConnectionId: ConnectionId | null = null;
  let scopeGeneration = 0;
  let browseRequest = 0;

  /** Remote `$HOME`: the browse root and the input to name derivation. */
  const home = ref<string | null>(null);
  const homeError = ref<string | null>(null);

  /** Folder browser (route 1 and the parent picker for route 2). */
  const cwd = ref<string>('');
  const dirs = ref<DirEntry[]>([]);
  const browsing = ref(false);
  const browseError = ref<string | null>(null);

  /** Repo list (route 3). Local clones + GitHub repos, merged by the host. */
  const repos = ref<RepoEntry[]>([]);
  const reposLoading = ref(false);
  /**
   * Why the GitHub half of the list is empty, when it is.
   *
   * `gh-missing` and `gh-unauthenticated` are NORMAL host states — `ok` stays
   * true, the local list still renders, and the UI owes the user a quiet hint,
   * never a dialog. Only `failed` / `helper-missing` are worth an error tone.
   */
  const remoteState = ref<ReposScopeState | null>(null);
  const remoteError = ref<string | null>(null);
  const localState = ref<ReposScopeState | null>(null);
  const localError = ref<string | null>(null);

  /**
   * Repository currently being cloned, or null. There is no percentage and
   * there cannot be one: git writes its progress meter to stderr and the exec
   * buffers to completion, so the host emits `started`/`finished` and nothing
   * in between. The UI shows indeterminate progress rather than a fake number.
   */
  const cloning = ref<string | null>(null);
  /** Set while `startSession` is in flight. */
  const starting = ref(false);

  /** True when the GitHub scope came back empty for a benign reason. */
  const remoteUnavailable = computed(
    () => remoteState.value === 'gh-missing' || remoteState.value === 'gh-unauthenticated',
  );

  /** True while the state still belongs to the connection that started work. */
  function isCurrent(connectionId: ConnectionId, generation: number): boolean {
    return scopedConnectionId === connectionId && scopeGeneration === generation;
  }

  /** Reset renderer-side remote state when a different SSH connection takes over. */
  function clearState(): void {
    scopeGeneration += 1;
    browseRequest += 1;
    home.value = null;
    homeError.value = null;
    cwd.value = '';
    dirs.value = [];
    browsing.value = false;
    browseError.value = null;
    repos.value = [];
    reposLoading.value = false;
    remoteState.value = null;
    remoteError.value = null;
    localState.value = null;
    localError.value = null;
    cloning.value = null;
    starting.value = false;
  }

  /** Enter a connection scope, invalidating any paths/results from another host. */
  function scopeTo(connectionId: ConnectionId): number {
    if (scopedConnectionId !== connectionId) {
      clearState();
      scopedConnectionId = connectionId;
    }
    return scopeGeneration;
  }

  /**
   * Resolve the remote `$HOME` and nothing else.
   *
   * Split out of {@link loadHome} because `$HOME` has two consumers with very
   * different appetites. The DIALOG wants the browser landed on it. The session
   * PANEL and the folder WORKSPACE want only the string — it is the input to
   * `directoryKey` and to `sessionBaseName`, and an SFTP directory listing they
   * will never render is a round trip spent for nothing.
   *
   * Both of them reading it from HERE is the point, and it is a fix rather than
   * a tidy-up: the panel used to resolve `$HOME` into a ref of its own while
   * the workspace read the store, so for one render they could hold different
   * answers — and `$HOME` is what decides whether a folder is keyed `~/git/foo`
   * or `/home/me/git/foo`. Two spellings of one key is a panel row that opens a
   * workspace with no tabs in it.
   *
   * Cached, and a failure is not cached: the panel degrades gracefully without
   * `$HOME` (grouping infers one from the paths), so a transient failure should
   * be retried by the next caller rather than remembered.
   */
  async function ensureHome(connectionId: ConnectionId): Promise<string | null> {
    const generation = scopeTo(connectionId);
    if (home.value !== null) return home.value;
    const result = await api.projects.home(connectionId);
    if (!isCurrent(connectionId, generation)) return null;
    if (!result.ok || !result.home) {
      homeError.value = result.error ?? 'could not resolve $HOME on the host';
      return null;
    }
    homeError.value = null;
    home.value = result.home;
    return result.home;
  }

  /** Resolve the remote `$HOME` and land the browser there on first open. */
  async function loadHome(connectionId: ConnectionId): Promise<void> {
    const generation = scopeTo(connectionId);
    const resolved = await ensureHome(connectionId);
    if (resolved === null || !isCurrent(connectionId, generation)) return;
    if (!cwd.value) await browse(connectionId, resolved);
  }

  /**
   * List the folders under `path`. Directories only — this picker chooses a
   * project folder, and a file row in it would be an affordance that does
   * nothing. Symlinks to directories are reported as `symlink` by SFTP, so
   * they are not offered either: `startSession` canonicalises with `pwd -P`,
   * and a link whose target is elsewhere would derive a name from a folder the
   * user never saw.
   *
   * Dot-prefixed directories STAY. The desktop convention that a leading dot
   * means "hidden" belongs to local file managers; the picker browses a remote
   * host, where `.agents` is an ordinary repo folder, and filtering it made
   * the search box swear nothing matched a folder the host demonstrably has.
   */
  async function browse(connectionId: ConnectionId, path: string): Promise<void> {
    const generation = scopeTo(connectionId);
    const request = ++browseRequest;
    browsing.value = true;
    browseError.value = null;
    try {
      const resolved = await api.sftp.realPath(connectionId, path);
      const entries = await api.sftp.list(connectionId, resolved);
      if (!isCurrent(connectionId, generation) || request !== browseRequest) return;
      cwd.value = resolved;
      dirs.value = entries
        .filter((e) => e.type === 'dir')
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      if (isCurrent(connectionId, generation) && request === browseRequest) {
        browseError.value = errorMessage(e);
      }
    } finally {
      if (isCurrent(connectionId, generation) && request === browseRequest) {
        browsing.value = false;
      }
    }
  }

  /** Enter a child folder of the current directory. */
  async function enter(connectionId: ConnectionId, name: string): Promise<void> {
    await browse(connectionId, joinPosix(cwd.value, name));
  }

  /** Go up one level. A no-op at `/`. */
  async function up(connectionId: ConnectionId): Promise<void> {
    if (cwd.value === '/' || cwd.value === '') return;
    await browse(connectionId, parentPosix(cwd.value));
  }

  /**
   * Load local clones + GitHub repos.
   *
   * `ok: false` from the call is reserved for a scope that genuinely failed;
   * a host with no `gh` still resolves ok with an empty remote scope, so the
   * two are recorded separately and neither clears the local rows.
   */
  async function loadRepos(connectionId: ConnectionId): Promise<void> {
    const generation = scopeTo(connectionId);
    reposLoading.value = true;
    try {
      const result = await api.projects.reposList(connectionId, { scope: 'both' });
      if (!isCurrent(connectionId, generation)) return;
      repos.value = result.repos;
      remoteState.value = result.remote?.state ?? null;
      remoteError.value = result.remote?.error ?? null;
      localState.value = result.local?.state ?? null;
      localError.value = result.local?.error ?? null;
    } finally {
      if (isCurrent(connectionId, generation)) reposLoading.value = false;
    }
  }

  /**
   * Preview the session name a folder would get. Base name only: under
   * `namePolicy: 'unique'` the host may append `-2`, and only the host can
   * know that.
   */
  async function deriveName(
    connectionId: ConnectionId,
    folder: string,
    customName?: string,
  ): Promise<string> {
    return api.projects.deriveName(connectionId, folder, customName);
  }

  /** Create a new empty project folder under `parent`. */
  async function createFolder(
    connectionId: ConnectionId,
    parent: string,
    name: string,
  ): Promise<CreateFolderResult> {
    return api.projects.createFolder(connectionId, { parent, name });
  }

  /**
   * Clone a repo, holding `cloning` for the life of the request so the UI can
   * run an indeterminate bar. An already-cloned target resolves
   * `{ ok: true, alreadyExists: true, path }` — a re-clone is not a failure and
   * the caller carries straight on to {@link start}.
   */
  async function clone(
    connectionId: ConnectionId,
    request: { repository: string; root?: string; folder?: string; protocol?: 'ssh' | 'https' },
  ): Promise<CloneResult> {
    const requestId = `clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cloning.value = request.repository;
    // The lifecycle events carry no bytes, so this subscription exists purely
    // to keep the indicator honest if the host finishes before the invoke
    // resolves. The `finally` below is the real guarantee.
    const unsubscribe = api.projects.onCloneProgress((progress) => {
      if (progress.requestId !== requestId) return;
      if (progress.phase === 'finished') cloning.value = null;
    });
    try {
      return await api.projects.reposClone(connectionId, { ...request, requestId });
    } finally {
      unsubscribe();
      cloning.value = null;
    }
  }

  /** Start (or re-open) the session for a folder. */
  async function start(
    connectionId: ConnectionId,
    folder: string,
    customName?: string,
    namePolicy?: SessionNamePolicy,
  ): Promise<StartSessionResult> {
    starting.value = true;
    try {
      return await api.projects.startSession(connectionId, {
        folder,
        ...(customName ? { customName } : {}),
        ...(namePolicy ? { namePolicy } : {}),
      });
    } finally {
      starting.value = false;
    }
  }

  /**
   * Rename a session.
   *
   * Thin on purpose. Every guard that matters — the alphabet, the
   * host-answered uniqueness check — runs in the main process, because a guard
   * the renderer owns is a guard a second caller can forget. What the CALLER
   * still owes, and this store deliberately does not do for it, is migrating
   * the two pieces of desktop state keyed by session name: the composer's
   * per-session record and whichever tab is selected. Doing that here would
   * mean this store importing the composer store to fix up a key it does not
   * own.
   *
   * Pass the row's aplexer ref when it is aplexer-backed — a tag alone does
   * not address such a row.
   */
  async function renameSession(
    connectionId: ConnectionId,
    from: string,
    to: string,
    sessionRef?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
  ): Promise<RenameSessionResult> {
    return api.projects.renameSession(connectionId, from, to, sessionRef);
  }

  /**
   * Stop a session — kill it on the host, whichever runtime owns it.
   *
   *
   * Thin for the same reason `renameSession` is, and the debt the caller owes is
   * LARGER here: a rename moves the three pieces of desktop state keyed by
   * session name, a kill has to drop them. The pool's client is dropped
   * main-side by the ipc handler; the mounted pane and the composer's record
   * belong to the workspace, which is the only place that knows about either.
   *
   * **This store does not confirm.** The confirmation is a UI question and it
   * has to be asked where the session's NAME is on screen — a modal raised from
   * a store could only name it by string, and this is the one action in the app
   * that cannot be undone.
   */
  async function killSession(
    connectionId: ConnectionId,
    name: string,
    sessionRef?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
  ): Promise<KillSessionResult> {
    return api.projects.killSession(connectionId, name, sessionRef);
  }

  /** Drop everything on disconnect: none of it is valid for another host. */
  function clear(): void {
    scopedConnectionId = null;
    clearState();
  }

  return {
    home,
    homeError,
    cwd,
    dirs,
    browsing,
    browseError,
    repos,
    reposLoading,
    remoteState,
    remoteError,
    localState,
    localError,
    remoteUnavailable,
    cloning,
    starting,
    loadHome,
    ensureHome,
    browse,
    enter,
    up,
    loadRepos,
    deriveName,
    createFolder,
    clone,
    start,
    renameSession,
    killSession,
    clear,
  };
});

/** `/a/b` + `c` -> `/a/b/c`. POSIX only: the remote host is always POSIX. */
export function joinPosix(base: string, child: string): string {
  if (child.startsWith('/')) return child;
  return base.endsWith('/') ? `${base}${child}` : `${base}/${child}`;
}

/** `/a/b/c` -> `/a/b`; `/a` -> `/`. */
export function parentPosix(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');
  if (cut <= 0) return '/';
  return path.slice(0, cut);
}

/**
 * `/home/me/git/x` -> `~/git/x` when it is under `home`. Purely cosmetic — the
 * absolute path is what gets sent to the host, because `~` expansion is the
 * shell's job and the shell is not in this loop.
 */
export function displayPath(path: string, home: string | null): string {
  if (!home || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === '' ? '~' : `~${rest}`;
}
