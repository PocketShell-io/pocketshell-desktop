/**
 * Project-folder-first session creation — the desktop half of the flow the
 * Android app already ships.
 *
 * A session is not named, it is *placed*. The user picks a project folder on
 * the remote host by one of three routes — an existing folder, a new empty
 * folder, or a fresh GitHub clone — and the session name is DERIVED from that
 * folder (see ./sessionName.ts). That derivation is the same one `tmuxctl` and
 * the phone use, so `~/git/pocketshell` is `git-pocketshell` everywhere and
 * the three clients agree about which session belongs to which folder.
 *
 * ## Browsing folders is NOT here
 *
 * The renderer picks the existing folder with the SFTP surface that already
 * exists: `sftp:list` for the entries (filter `type === 'dir'`), `sftp:stat`,
 * `sftp:realPath`. Re-exposing a "list remote folders" channel here would be a
 * second, thinner path to the same ssh2 SFTP wrapper — one more thing to keep
 * in sync for no capability gained. The only thing this service adds for
 * browsing is {@link home}, because `$HOME` is where a picker starts and it is
 * also an input to the name derivation.
 */

import type { SshService } from '../ssh/SshService.js';
import type { PocketshellClient } from '../helper/PocketshellClient.js';
import type { AplexerClient } from '../helper/AplexerClient.js';
import type { CreateSessionVia } from '../helper/PocketshellClient.js';
import type { AplexerSessionRecord } from '../../shared/aplexer.js';
import { pathAwareCommand } from '../helper/bootstrap.js';
import { firstNonEmptyLine, lastNonEmptyLine } from '../helper/parsers.js';
import {
  HOME_COMMAND,
  freeSessionNameCommand,
  FREE_SESSION_NAME_MAX_SUFFIX,
  killSessionCommand,
  mkdirCommand,
  renameSessionCommand,
  resolveDirectoryCommand,
  sessionExistsCommand,
  sessionTakenAnywhereCommand,
  type ReposCloneOptions,
  type ReposListOptions,
} from './commands.js';
import {
  childPath,
  normaliseProjectFolderName,
  resolveAplexerTag,
  resolveSessionName,
  sanitiseName,
} from './sessionName.js';
import {
  mergeRepos,
  type ReposListResult,
  type ReposScopeResult,
  type ReposScopeState,
} from './repos.js';

/** Resolved remote home. */
export interface HomeResult {
  ok: boolean;
  home: string | null;
  error: string | null;
}

/** Result of creating a new empty project folder. */
export interface CreateFolderResult {
  ok: boolean;
  /** Canonical absolute path of the created folder. */
  path: string | null;
  error: string | null;
}

/** Result of a clone request. */
export interface CloneResult {
  ok: boolean;
  path: string | null;
  /** True when the clone target was already on disk and we reused it. */
  alreadyExists: boolean;
  error: string | null;
  /**
   * On failure, WHY — so the UI can say "this host has no pocketshell" rather
   * than dumping a git error. Absent on success.
   */
  state?: Exclude<ReposScopeState, 'ok'>;
}

/** Progress event pushed while a clone runs. */
export interface CloneProgress {
  requestId: string;
  phase: 'started' | 'finished';
  repository: string;
  path?: string;
  error?: string;
}

/**
 * What `sessionName` means for a start request.
 *
 *  - `reuse` (default): the derived name is the EXACT name to use. If a
 *    session for this folder is already open, re-open it. This is the
 *    idempotent attach-or-create semantics `create-detached` provides and the
 *    folder-first flow depends on.
 *  - `unique`: give me a genuinely NEW session for this folder, walking
 *    `<base>`, `<base>-2`, `<base>-3`… The walk runs on the host, in one exec,
 *    immediately before the create (see {@link freeSessionNameCommand}) — the
 *    phone learned the hard way that a client-side session cache answers this
 *    question wrongly.
 */
export type SessionNamePolicy = 'reuse' | 'unique';

/** Request for {@link ProjectsService.startSession}. */
export interface StartSessionRequest {
  /** Remote folder to start in. Absolute, or `~`-relative. */
  folder: string;
  /** Optional user label; blank/punctuation-only falls back to the derived name. */
  customName?: string;
  /** Defaults to `reuse`. */
  namePolicy?: SessionNamePolicy;
}

/**
 * Why a start request failed, for a UI that wants to react rather than print.
 *
 * `name-unavailable` belongs only to the `unique` policy and only to the two
 * ways that policy can be defeated without anything having gone wrong on the
 * host: the free-name probe could not be read at all, or the create came back
 * under a different name than the one it was asked for. Both used to resolve
 * `ok: true` carrying the name of a session that was ALREADY OPEN — see
 * {@link ProjectsService.startSession} for why that is the worst answer this
 * call can give.
 */
export type StartSessionFailure = 'folder-missing' | 'create-failed' | 'name-unavailable';

/** Result of {@link ProjectsService.startSession}. Never thrown. */
export interface StartSessionResult {
  ok: boolean;
  /** The session name on the host — what to attach to. */
  sessionName: string | null;
  /** The canonical folder the session was started in. */
  folder: string | null;
  /** True when a session for this folder was already open and got reused. */
  reused: boolean;
  /** Which create path ran; `tmux-fallback` means no memory cap. */
  via: CreateSessionVia | null;
  /**
   * The aplexer UUID of the created session, when the host handed one over
   * (`a start --json` echoes the record). The renderer needs it to join by id
   * WITHOUT waiting for the next snapshot — the optimistic row it builds from
   * this result would otherwise cost the join its exact selector and push a
   * workspace+tag lookup onto the attach. Null whenever the create did not go
   * through aplexer, or the host's answer was unreadable.
   */
  aplexerId: string | null;
  error: string | null;
  code: StartSessionFailure | null;
}

/** Why a rename was refused, for a UI that wants to react rather than print. */
export type RenameSessionFailure = 'illegal-name' | 'name-taken' | 'rename-failed';

/** Result of {@link ProjectsService.renameSession}. Never thrown. */
export interface RenameSessionResult {
  ok: boolean;
  /** The name the session now has on the host. */
  sessionName: string | null;
  error: string | null;
  code: RenameSessionFailure | null;
}

/** Why a kill was refused. `not-found` is the one a stale tab bar produces. */
export type KillSessionFailure = 'not-found' | 'kill-failed';

/** Result of {@link ProjectsService.killSession}. Never thrown. */
export interface KillSessionResult {
  ok: boolean;
  error: string | null;
  code: KillSessionFailure | null;
}

/** Request for {@link ProjectsService.createFolder}. */
export interface CreateFolderRequest {
  /** Existing parent directory. */
  parent: string;
  /** Single folder name to create under it. */
  name: string;
}

/** Request for {@link ProjectsService.reposList}. */
export interface ReposListRequest {
  /** Which scopes to run. Defaults to `both`. */
  scope?: 'local' | 'remote' | 'both';
  /** Local scan roots (replaces the helper default `~/git`). */
  roots?: string[];
  /** Local scan depth. */
  maxDepth?: number;
  /** Cap on remote rows. */
  limit?: number;
}

/**
 * What the renderer knows about an aplexer-backed session, carried alongside
 * a name-addressed kill/rename so main can aim at the right runtime.
 *
 * A tag alone is unique only within its workspace, so a bare name cannot
 * address an aplexer session the way it addresses a tmux one. The renderer
 * passes what the row already carries; main falls back to a snapshot lookup
 * when it must (a stale caller, a deep link) and refuses rather than guesses
 * when the name is ambiguous.
 */
export interface AplexerSessionRef {
  /** Canonical workspace the session lives in. */
  workspace?: string | null;
  /** Immutable session UUID. Preferred: survives renames. */
  aplexerId?: string | null;
}

export class ProjectsService {
  /**
   * Remote `$HOME` per connection. It cannot change for the life of a
   * connection, and it is read on every name derivation, so caching it keeps
   * the picker from spending a round-trip per keystroke.
   */
  private readonly homes = new Map<string, string>();

  constructor(
    private readonly ssh: SshService,
    private readonly helper: PocketshellClient,
    /**
     * The aplexer client, when the app was wired with one. Start/kill/rename
     * prefer it on hosts where `a` is installed; without it every call takes
     * the tmux path it always took. Optional so existing constructions keep
     * compiling.
     */
    private readonly aplexer?: AplexerClient,
  ) {}

  /** Drop cached per-connection state. Call on disconnect. */
  evict(connectionId: string): void {
    this.homes.delete(connectionId);
  }

  /** Resolve (and cache) the remote `$HOME`. */
  async home(connectionId: string): Promise<HomeResult> {
    const cached = this.homes.get(connectionId);
    if (cached != null) return { ok: true, home: cached, error: null };
    const res = await this.ssh.exec(connectionId, pathAwareCommand(HOME_COMMAND));
    const home = res.stdout.trim();
    if (res.exitCode !== 0 || home.length === 0) {
      return {
        ok: false,
        home: null,
        error: res.stderr.trim() || 'could not resolve $HOME on the host',
      };
    }
    this.homes.set(connectionId, home);
    return { ok: true, home, error: null };
  }

  /**
   * The session name a folder WOULD get, for previewing in the picker.
   *
   * Backend-dependent, because the two backends name differently: on a host
   * with aplexer the create will tag the session `main` (or the user's
   * label), so that — not the folder derivation — is what a preview may
   * promise. This is still the BASE name only: it does not walk the live
   * tags, so it carries no `-2` suffix even under a `unique` policy.
   * Resolving that suffix requires the host and belongs at create time.
   */
  async deriveSessionName(
    connectionId: string,
    folder: string,
    customName?: string,
  ): Promise<string> {
    if (this.aplexer && (await this.aplexer.isAvailable(connectionId))) {
      return resolveAplexerTag(customName);
    }
    const { home } = await this.home(connectionId);
    return resolveSessionName(customName ?? null, folder, home);
  }

  /**
   * Create a new empty project folder under [parent] and return its canonical
   * path. Does not start a session — the renderer chains
   * {@link startSession} on the returned path.
   */
  async createFolder(
    connectionId: string,
    request: CreateFolderRequest,
  ): Promise<CreateFolderResult> {
    const safeName = normaliseProjectFolderName(request.name);
    if (safeName === null) {
      return { ok: false, path: null, error: 'Enter a single folder name (no "/" or "..").' };
    }
    const target = childPath(request.parent, safeName);
    const made = await this.ssh.exec(connectionId, pathAwareCommand(mkdirCommand(target)));
    if (made.exitCode !== 0) {
      return {
        ok: false,
        path: null,
        error: made.stderr.trim() || made.stdout.trim() || `mkdir exited ${made.exitCode}`,
      };
    }
    // The folder was created one exec ago; if `pwd -P` still cannot resolve
    // it, the path we asked for is the honest answer to report.
    return { ok: true, path: (await this.canonicalise(connectionId, target)) ?? target, error: null };
  }

  /**
   * Run `repos list` for the requested scopes and merge them.
   *
   * The two scopes are independent execs on one connection, so they are issued
   * together: the local scan touches the filesystem and the remote one calls
   * the GitHub API, and serialising them would add the slower of the two to
   * every picker open for nothing.
   *
   * A missing or unauthenticated `gh` leaves `remote.state` set to
   * `gh-missing` / `gh-unauthenticated` with no rows, and `ok` stays true for
   * the local scope — the picker still lists local clones. Only a genuine
   * failure of a requested scope clears `ok`.
   */
  async reposList(connectionId: string, request: ReposListRequest = {}): Promise<ReposListResult> {
    const scope = request.scope ?? 'both';
    const wantLocal = scope === 'local' || scope === 'both';
    const wantRemote = scope === 'remote' || scope === 'both';

    const localOptions: ReposListOptions = {
      scope: 'local',
      roots: request.roots,
      maxDepth: request.maxDepth,
    };
    const remoteOptions: ReposListOptions = { scope: 'remote', limit: request.limit };

    const [local, remote] = await Promise.all([
      wantLocal ? this.helper.reposList(connectionId, localOptions) : Promise.resolve(null),
      wantRemote ? this.helper.reposList(connectionId, remoteOptions) : Promise.resolve(null),
    ]);

    return {
      ok: scopeOk(local) && scopeOk(remote),
      repos: mergeRepos(local?.repos ?? [], remote?.repos ?? []),
      local,
      remote,
    };
  }

  /**
   * Clone a GitHub repo and return the created path.
   *
   * A clone is the one slow step in this flow — tens of seconds for a large
   * repo — so it emits lifecycle events through [onProgress] the way SFTP
   * transfers do: `started` as soon as the exec is issued, `finished` when it
   * lands. The renderer keys them by its own `requestId`, exactly as it keys
   * `sftp:event:progress` by `transferId`.
   *
   * They are lifecycle events, not byte counts, and deliberately so: `git`
   * writes its progress meter to stderr, and `SshService.exec` buffers a
   * channel to completion. Streaming real percentages would mean a new
   * raw-channel exec API on SshService for one call site. What the renderer
   * needs from this is "it started, it is still going, it finished" — which
   * these give — rather than a progress bar the helper cannot feed anyway.
   */
  async cloneRepo(
    connectionId: string,
    request: ReposCloneOptions & { requestId?: string },
    onProgress?: (progress: CloneProgress) => void,
  ): Promise<CloneResult> {
    const requestId = request.requestId ?? '';
    const repository = request.repository;
    onProgress?.({ requestId, phase: 'started', repository });
    const outcome = await this.helper.reposClone(connectionId, {
      repository,
      root: request.root,
      folder: request.folder,
      protocol: request.protocol,
    });
    const result: CloneResult = {
      ok: outcome.ok,
      path: outcome.path,
      alreadyExists: outcome.alreadyExists,
      error: outcome.error,
      ...(outcome.state ? { state: outcome.state } : {}),
    };
    onProgress?.({
      requestId,
      phase: 'finished',
      repository,
      ...(result.path ? { path: result.path } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  /**
   * Start a session in [folder] — the single entry point all three routes
   * converge on.
   *
   * Sequence:
   *  1. resolve `$HOME` (cached) and canonicalise the folder — one exec whose
   *     failure IS the missing-folder answer (`cd` cannot land in a directory
   *     that is not there), so the old separate `[ -d ]` pre-flight is folded
   *     into it;
   *  2. derive the name from the folder;
   *  3. ask the host whether that session is already open, and — under the
   *     `unique` policy — for the first free `-N` variant;
   *  4. create, idempotently.
   *
   * Every exec here is a login shell (`/bin/sh -lc`), so it costs the user's
   * profile startup as well as a round trip — the create is the latency-critical
   * path of the whole app (the user's bar: click to a working agent inside a
   * second), and serial round trips are what stood between the two. Two of the
   * reads below are therefore issued TOGETHER: the canonicalisation and the
   * aplexer snapshot (the free-name walk's input) are independent, and on an
   * aplexer host the create waits on both.
   *
   * ## Why the `unique` policy fails CLOSED and `reuse` does not
   *
   * The create underneath both policies is attach-or-create: `pocketshell
   * sessions create` is a no-op success when the name is already running, which
   * is exactly what `reuse` wants and exactly what makes `unique` dangerous when
   * anything upstream of it is uncertain. If the free-name walk cannot be read,
   * or if the helper answers with a name other than the one we asked for, the
   * name we hand back may be a session that is ALREADY OPEN in the caller's UI —
   * and the caller has no way to tell, because `ok` is true and `reused` is
   * false.
   *
   * That is not a hypothetical. It is the `+` -> New session bug: the walk asked
   * a bare `tmux has-session`, which on this host denies sessions the helper
   * lists (see {@link freeSessionNameCommand}), so `unique` answered with the
   * folder's existing session. The workspace then re-selected the tab that was
   * already selected — "nothing happened" — and, when an agent had been chosen,
   * typed its launch line into the terminal the user was already working in.
   *
   * So a `unique` request that cannot be SHOWN to have produced a new name is
   * refused with `name-unavailable` and nothing is created. The same failure
   * under `reuse` is harmless and stays harmless: re-opening a session that is
   * already open is what `reuse` means.
   */
  async startSession(
    connectionId: string,
    request: StartSessionRequest,
  ): Promise<StartSessionResult> {
    const { home } = await this.home(connectionId);
    const folder = request.folder.trim();

    // One builder for the failure exits below — the seven-field result spelled
    // out per branch was the shape a new branch would copy wrong.
    const failed = (
      code: StartSessionFailure,
      error: string | null,
      opts: { folder?: string | null; via?: CreateSessionVia | null } = {},
    ): StartSessionResult => ({
      ok: false,
      sessionName: null,
      folder: opts.folder ?? null,
      reused: false,
      via: opts.via ?? null,
      aplexerId: null,
      error,
      code,
    });

    // The snapshot the aplexer branch will read, fetched CONCURRENTLY with the
    // canonicalisation rather than after it — the two execs are independent,
    // and the create behind them is the latency-critical path. On a tmux-only
    // host this is one speculative exec that answers "command not found" and
    // is discarded; it rides beside the canonicalise, so it costs no wall
    // time there either.
    const snapshot = this.aplexer
      ? this.aplexer.snapshotRecords(connectionId)
      : null;

    // Canonicalise FIRST and read its failure as the missing-folder answer:
    // `cd` cannot land in a directory that is not there. This exec used to be
    // preceded by a separate `[ -d ]` probe making exactly the same claim, one
    // login-shell round trip later — see {@link canonicalise} for why the
    // probe is gone and this one carries the guard alone.
    const canonical = await this.canonicalise(connectionId, folder);
    if (canonical === null) {
      return failed('folder-missing', `Start folder does not exist on the host: ${folder}`);
    }
    const base = resolveSessionName(request.customName ?? null, canonical, home);

    const policy = request.namePolicy ?? 'reuse';

    // aplexer is the main session manager wherever `a` is installed: the
    // create, the reuse check, and the free-name walk all run against the
    // snapshot rather than against tmux. The tmux path below stays for hosts
    // without it. The snapshot fetched above feeds the whole branch; `null`
    // records only mean "no pre-fetch happened" (no aplexer client wired) and
    // the callee reads the host itself.
    if (this.aplexer && (await this.aplexer.isAvailable(connectionId))) {
      const records = (await snapshot) ?? undefined;
      // The tag is NOT the folder-derived `base`: a tag is namespaced per
      // workspace, so the default tag can be `main` and its successors
      // `main-2`, `main-3` — the tag the user sees on `a ls` is the tag the
      // tab bar shows. `base` stays the tmux path's answer, where the name
      // IS the grouping and must carry the folder.
      return this.startAplexerSession(
        connectionId,
        canonical,
        resolveAplexerTag(request.customName),
        policy,
        failed,
        records,
      );
    }

    let name = base;
    let reused = false;
    if (policy === 'unique') {
      const free = await this.freeSessionName(connectionId, base);
      if (free === null) {
        return failed(
          'name-unavailable',
          `Could not ask the host for a free session name, so nothing was created. ` +
            `Starting another session here would have re-opened "${base}" instead of ` +
            `making a new one.`,
          { folder: canonical },
        );
      }
      name = free;
    } else {
      // The per-session-server world: the helper's tmuxctl puts each create on
      // its own `tmuxctl-<name>` server, so a bare `has-session` on the default
      // socket answers "no" for a session that is alive and open on screen —
      // the exact premise the kill path's locator was built on (Stop spent
      // days answering "already gone" that way). Ask the locator instead:
      // `found` is reused wherever the session lives. `unknown` — the sweep
      // itself died — degrades to the bare default-socket probe, which was the
      // whole answer before this existed and is still the best one available.
      const located = await this.helper.locateSession(connectionId, base);
      if (located.status === 'found') {
        reused = true;
      } else if (located.status === 'unknown') {
        const has = await this.ssh.exec(
          connectionId,
          pathAwareCommand(sessionExistsCommand(base)),
        );
        reused = has.exitCode === 0;
      } else {
        reused = false;
      }
    }

    const created = await this.helper.createSession(connectionId, { name, cwd: canonical });
    if (!created.ok) {
      return failed('create-failed', created.error, { folder: canonical, via: created.via });
    }
    // The helper echoes the resolved name and we normally trust it over ours
    // (../helper/PocketshellClient.ts). Under `unique` that trust has to be
    // checked rather than extended: the whole request was "a name nothing else
    // is using", and a name we did not ask for is a name nothing walked the
    // suffix chain for. It is also the shape a chatty login shell produces — the
    // echo is read as the first non-empty line of stdout, so a `.profile` that
    // greets would put its greeting here — and answering with that would be
    // worse than answering with nothing.
    if (policy === 'unique' && created.name !== name) {
      return failed(
        'name-unavailable',
        `Asked the host for a new session called "${name}" and it answered with ` +
          `"${created.name ?? ''}", so it is not clear a new session was made. Nothing ` +
          `here has been selected; check the host before trying again.`,
        { folder: canonical, via: created.via },
      );
    }
    // The durable tree registry (SESSIONLIST.md §11): record the new session's
    // folder so a future refresh whose cwd probe has gone quiet can place it
    // from the RECORD instead of the name heuristic. Best-effort and
    // fire-and-forget — the session exists either way, and a slow or absent
    // registry must not hold the create path (or fail it) hostage.
    if (created.name) {
      void this.helper
        .treeRecordSession(connectionId, created.name, canonical)
        .catch(() => undefined);
    }
    return {
      ok: true,
      sessionName: created.name,
      folder: canonical,
      reused,
      via: created.via,
      aplexerId: null,
      error: null,
      code: null,
    };
  }

  /**
   * Start a session through aplexer — the main path on hosts with `a`.
   *
   * The tag comes from {@link resolveAplexerTag}: the user's label when there
   * is one, else `main`, walking `main-2`, `main-3`… per workspace when a
   * unique one is wanted. It is deliberately NOT the folder derivation the
   * tmux path runs (`base` in {@link startSession}) — a tag needs no folder
   * in it, because the workspace half of `workspace:tag` does the grouping,
   * and the tag is the only name the session has, so it is named for the
   * person reading `a ls` rather than for the grouper.
   *
   * Liveness and uniqueness are read from one snapshot (no per-name exec
   * probes), and the free-name walk is client-side over that snapshot rather
   * than a shell loop over tmux sockets.
   *
   * A finished record holding the pair is NOT a conflict: `a start` reclaims
   * it (archives the corpse, creates the session), so only a LIVE holder
   * counts for reuse and for the walk. The snapshot parser already drops dead
   * records, which is what makes both reads correct without a second filter.
   */
  private async startAplexerSession(
    connectionId: string,
    folder: string,
    base: string,
    policy: SessionNamePolicy,
    failed: (
      code: StartSessionFailure,
      error: string | null,
      opts?: { folder?: string | null; via?: CreateSessionVia | null },
    ) => StartSessionResult,
    /** A snapshot fetched by the caller, sparing this branch its own exec. */
    records?: AplexerSessionRecord[],
  ): Promise<StartSessionResult> {
    const aplexer = this.aplexer!;
    if (policy === 'unique') {
      const free = await this.freeAplexerTag(connectionId, folder, base, records);
      if (free === null) {
        return failed(
          'name-unavailable',
          `Could not ask the host for a free session name, so nothing was created. ` +
            `Starting another session here would have re-opened "${base}" instead of ` +
            `making a new one.`,
          { folder },
        );
      }
      return this.createAplexerSession(connectionId, folder, free, policy, failed);
    }
    const live = records
      ? (records.find((r) => r.workspace === folder && r.tag === base) ?? null)
      : await aplexer.findSession(connectionId, folder, base);
    if (live) {
      return {
        ok: true,
        sessionName: base,
        folder,
        reused: true,
        via: 'aplexer',
        aplexerId: live.id,
        error: null,
        code: null,
      };
    }
    return this.createAplexerSession(connectionId, folder, base, policy, failed);
  }

  /** Run `a start` and translate its three answers (created / refused-live / failed). */
  private async createAplexerSession(
    connectionId: string,
    folder: string,
    tag: string,
    policy: SessionNamePolicy,
    failed: (
      code: StartSessionFailure,
      error: string | null,
      opts?: { folder?: string | null; via?: CreateSessionVia | null },
    ) => StartSessionResult,
  ): Promise<StartSessionResult> {
    const aplexer = this.aplexer!;
    const created = await aplexer.startSession(connectionId, { workspace: folder, tag });
    if (created.ok) {
      // Same guard as the tmux path: under `unique` the host must answer with
      // the name it was asked for, or nothing is shown to have been made.
      if (policy === 'unique' && created.tag !== tag) {
        return failed(
          'name-unavailable',
          `Asked the host for a new session called "${tag}" and it answered with ` +
            `"${created.tag ?? ''}", so it is not clear a new session was made. Nothing ` +
            `here has been selected; check the host before trying again.`,
          { folder, via: 'aplexer' },
        );
      }
      if (created.tag) {
        void this.helper
          .treeRecordSession(connectionId, created.tag, folder)
          .catch(() => undefined);
      }
      return {
        ok: true,
        sessionName: created.tag,
        folder,
        reused: false,
        via: 'aplexer',
        aplexerId: created.id,
        error: null,
        code: null,
      };
    }
    if (created.liveRefusal) {
      // Lost the race: the pair went live between the snapshot check and the
      // exec. Re-read; a live holder turns this into the reuse `reuse` means,
      // and only a vanished one is a failure.
      const live = await aplexer.findSession(connectionId, folder, tag);
      if (live) {
        return {
          ok: true,
          sessionName: tag,
          folder,
          reused: true,
          via: 'aplexer',
          aplexerId: live.id,
          error: null,
          code: null,
        };
      }
    }
    return failed('create-failed', created.error, { folder, via: 'aplexer' });
  }

  /**
   * The first free `<base>`, `<base>-2`, … among a workspace's LIVE aplexer
   * tags, or null when the host did not answer.
   *
   * Null fails closed upstream (see the tmux `freeSessionName` note for why
   * inventing `[base]` would silently convert `unique` into `reuse`). An
   * exhausted walk is the same answer: a folder with 200 live sessions is not
   * a real state, and the bound stops a pathological host, not a real one.
   */
  private async freeAplexerTag(
    connectionId: string,
    workspace: string,
    base: string,
    records?: AplexerSessionRecord[],
  ): Promise<string | null> {
    const tags = records
      ? new Set(records.filter((r) => r.workspace === workspace).map((r) => r.tag))
      : await this.aplexer!.liveTags(connectionId, workspace);
    if (tags === null) return null;
    if (!tags.has(base)) return base;
    for (let i = 2; i <= FREE_SESSION_NAME_MAX_SUFFIX; i += 1) {
      const candidate = `${base}-${i}`;
      if (!tags.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Rename a live tmux session.
   *
   * ## Why this is a service call and not a `send-keys`
   *
   * The session name is the JOIN KEY — but not the way this doc used to argue.
   * It used to claim `sessionAttachCommand`'s `tmuxctl '<name>'` needed only a
   * spellable name to keep the session reachable, making `sanitiseName` the
   * whole of guard one. In the per-session-server world that was quietly
   * false: tmuxctl's join resolves a name against the socket DERIVED from it
   * (`tmuxctl-<name>`) plus the default socket, so the first raw rename left
   * session `beta` on `tmuxctl-alpha` and BOTH names stopped joining — the
   * rename committed at the tmux level and orphaned the session out of the
   * join path. The join now locates its own server by sweeping the sockets
   * for `has-session -t '=<name>'` (see `sessionAttachCommand`), which is what
   * makes a rename REAL rather than a trap, and two guards remain:
   *
   *  1. **The alphabet.** `sanitiseName` is the port of tmuxctl's own
   *     normalisation, so a name this accepts is a name `tmuxctl <name>` can
   *     still normalise to. A name with nothing alphanumeric left is refused
   *     outright rather than silently replaced — the caller asked for a
   *     specific name and deserves to be told it cannot have it.
   *     (`resolveSessionName` uses the same predicate to decide whether a
   *     typed label is usable at all.)
   *  2. **Uniqueness is the HOST's answer, across EVERY server.** The
   *     namespace a rename collides in is the join's, and the join's is not
   *     one server: tmuxctl derives a socket from the name, the enrichment
   *     map, the tab bar and the composer records are all keyed by name
   *     host-wide. So the check is {@link sessionTakenAnywhereCommand} — the
   *     same sweep predicate the free-name walk uses before a create — and
   *     not a probe of the session being renamed. A failed sweep reads as
   *     "free", the create walk's own degrade direction: a rename that
   *     slips past it costs a duplicate tab, never a lost session.
   *
   * A same-name rename is a SUCCESS, not an error: committing an unchanged tab
   * label is the commonest thing a rename field does, and making the user see a
   * failure for it would be absurd.
   *
   * What this does NOT do is move anything. tmux session options — including
   * `@ps_agent_kind`, the authoritative agent classification — are keyed to the
   * session and not to its name, so the recorded engine survives. Attached
   * clients follow the session by id and stay attached (and the pool's record
   * of the session's SERVER outlives the rename, because a rename happens ON
   * that server). The caller is responsible for the two pieces of state the
   * DESKTOP keys by name: the composer's per-session record, and
   * TmuxClientPool's note of which session its client is showing.
   */
  async renameSession(
    connectionId: string,
    from: string,
    to: string,
    ref?: AplexerSessionRef,
  ): Promise<RenameSessionResult> {
    const target = sanitiseName(to);
    if (!/[A-Za-z0-9]/.test(target)) {
      return {
        ok: false,
        sessionName: null,
        error: `"${to.trim()}" cannot be a session name: only letters, digits, "_" and "-" survive.`,
        code: 'illegal-name',
      };
    }
    // Idempotent, and deliberately BEFORE the taken probe — otherwise
    // committing an unchanged label would find the session itself and report
    // its own name as taken.
    if (target === from) return { ok: true, sessionName: from, error: null, code: null };

    // An aplexer-backed row renames its TAG within its workspace. The
    // sanitised alphabet above is a subset of the tag alphabet (which adds
    // `.`), so a name this accepts is a tag `a rename` accepts.
    const aplexerId = await this.resolveAplexerId(connectionId, from, ref);
    if (aplexerId !== null) {
      return this.renameAplexerSession(connectionId, aplexerId, target);
    }

    // Locate `from` FIRST, and aim the rename at its server: a rename can only
    // run on the server that holds the session, and the per-session-server
    // world means that is usually not the default socket. The taken probe does
    // NOT reuse this socket — see guard two above for why it sweeps instead.
    const located = await this.helper.locateSession(connectionId, from);
    const socketPath = located.status === 'found' ? located.socketPath : null;

    const taken = await this.ssh.exec(
      connectionId,
      pathAwareCommand(sessionTakenAnywhereCommand(target)),
    );
    if (taken.exitCode === 0) {
      return {
        ok: false,
        sessionName: null,
        error: `A session called "${target}" is already running on this host.`,
        code: 'name-taken',
      };
    }

    const renamed = await this.ssh.exec(
      connectionId,
      pathAwareCommand(renameSessionCommand(from, target, socketPath)),
    );
    if (renamed.exitCode !== 0) {
      // tmux's own stderr is the useful sentence here ("can't find session"),
      // and it is the one thing that distinguishes a stale session list from a
      // host that cannot rename at all.
      const detail = renamed.stderr.trim() || renamed.stdout.trim();
      return {
        ok: false,
        sessionName: null,
        error: detail || `Could not rename "${from}".`,
        code: 'rename-failed',
      };
    }
    return { ok: true, sessionName: target, error: null, code: null };
  }

  /**
   * Kill a live tmux session.
   *
   * **The only destructive operation this app performs**, and the only one with
   * no undo: a tmux session is usually an agent in the middle of a task, and
   * killing it takes its scrollback, its shell and its process tree with it.
   * The confirmation belongs to the UI — a service is the wrong place to ask a
   * question — but everything that makes the command safe to issue lives here
   * and in {@link killSessionCommand}, which carries the fixture evidence for
   * why it is raw tmux with an `=` and not `tmuxctl kill`.
   *
   * ## Why the caller is told the session was already gone
   *
   * `not-found` is not an edge case, it is the ordinary race: the tab bar is
   * refreshed on a timer, so the session behind a tab can have been killed from
   * the phone, from the user's own terminal, or by the agent exiting, at any
   * moment before the menu item is clicked. Reporting it as a distinct outcome
   * lets the UI say "it was already gone" and simply refresh, rather than
   * showing a failure for something that produced the state the user asked for.
   *
   * It is separated by PROBING FIRST rather than by parsing tmux's stderr,
   * because "can't find session" is a message and messages are not an API. The
   * probe is `sessionExistsCommand`'s exact `has-session -t '=<name>'`, the same
   * one the rename path uses.
   *
   * ## Why the probe is preceded by a LOCATOR, and the kill aimed by it
   *
   * Probing and killing through a bare `tmux` asks the DEFAULT socket, and the
   * helper's ecosystem now runs one tmux SERVER per session — so `git-aplexer`
   * sat alive on its own `tmuxctl-*` server while every Stop click answered
   * "already gone" against the default one, for days, silently, because
   * `not-found` is the outcome the UI is built to treat as the ordinary race.
   * The locator is one sweep of every socket (the same exec the list already
   * runs); when it saw the name, both commands carry `-S` to that server; when
   * it proves the name is nowhere, `not-found` comes back without a round trip
   * and is finally TRUE; and when the sweep itself died, the bare commands run
   * exactly as before this existed.
   *
   * ## What this does NOT clean up
   *
   * Everything the DESKTOP keys by session name: the pool's live client and its
   * PTY, the mounted terminal pane, and the composer's per-session record. All
   * three are the caller's, exactly as they are for a rename — see the ipc
   * handler. The service reaches the host and stops
   * there.
   */
  async killSession(
    connectionId: string,
    name: string,
    ref?: AplexerSessionRef,
  ): Promise<KillSessionResult> {
    // An aplexer-backed row is killed by id. The lookup below also covers a
    // caller that only has the workspace: one live tag-holder is unambiguous,
    // and anything else falls through to the tmux probe rather than guessing.
    const aplexerId = await this.resolveAplexerId(connectionId, name, ref);
    if (aplexerId !== null) {
      const killed = await this.aplexer!.killSession(connectionId, aplexerId);
      if (killed.ok) return { ok: true, error: null, code: null };
      if (killed.notFound) {
        return {
          ok: false,
          error: `"${name}" is not running on this host any more.`,
          code: 'not-found',
        };
      }
      return { ok: false, error: killed.error, code: 'kill-failed' };
    }
    const located = await this.helper.locateSession(connectionId, name);
    if (located.status === 'absent') {
      return {
        ok: false,
        error: `"${name}" is not running on this host any more.`,
        code: 'not-found',
      };
    }
    // `unknown` keeps the bare default-socket spelling: a failed sweep proves
    // nothing, and the legacy probe is the only query left. `found` aims both
    // commands at the session's own server even when the column was missing
    // (null socket ⇒ bare form ⇒ default server, the old hosts' only one).
    const socketPath = located.status === 'found' ? located.socketPath : null;

    const alive = await this.ssh.exec(
      connectionId,
      pathAwareCommand(sessionExistsCommand(name, socketPath)),
    );
    if (alive.exitCode !== 0) {
      return {
        ok: false,
        error: `"${name}" is not running on this host any more.`,
        code: 'not-found',
      };
    }

    const killed = await this.ssh.exec(
      connectionId,
      pathAwareCommand(killSessionCommand(name, socketPath)),
    );
    if (killed.exitCode !== 0) {
      const detail = killed.stderr.trim() || killed.stdout.trim();
      return { ok: false, error: detail || `Could not stop "${name}".`, code: 'kill-failed' };
    }
    return { ok: true, error: null, code: null };
  }

  /**
   * The aplexer UUID for [name], or null when this is not an aplexer kill/rename.
   *
   * Three routes, in order. An explicit id from the row wins outright — it is
   * exact by construction. Otherwise the workspace the row was filed under
   * plus the name addresses `workspace + tag`, which the host enforces as
   * unique. With neither, a snapshot scan for the bare tag still resolves when
   * exactly one live session carries it.
   *
   * Null routes the caller to the tmux path, and that is deliberate in every
   * direction it fails in: zero matches mean the name is not an aplexer tag at
   * all (an ordinary tmux session, which the probe below handles), and several
   * matches mean the bare name is ambiguous — but a tmux probe for that name
   * answers `not-found` rather than killing wrong, because no tmux server
   * holds an aplexer tag. The UI always passes the workspace for an aplexer
   * row, so the ambiguous case needs a stale caller to reach it, and even
   * then nothing destructive can misfire.
   */
  private async resolveAplexerId(
    connectionId: string,
    name: string,
    ref?: AplexerSessionRef,
  ): Promise<string | null> {
    if (this.aplexer == null) return null;
    if (!(await this.aplexer.isAvailable(connectionId))) return null;
    if (ref?.aplexerId) return ref.aplexerId;
    const records = await this.aplexer.snapshotRecords(connectionId);
    if (ref?.workspace) {
      return records.find((r) => r.workspace === ref.workspace && r.tag === name)?.id ?? null;
    }
    const holders = records.filter((r) => r.tag === name);
    return holders.length === 1 ? holders[0]!.id : null;
  }

  /**
   * Rename an aplexer session's tag, with the host-answered uniqueness check.
   *
   * The namespace is one workspace, not every server: the snapshot that
   * resolved the id already answers whether [target] is taken there. A taken
   * tag reads as `name-taken`, the same code the tmux path returns, so the
   * rename field reacts identically whichever runtime owns the row.
   */
  private async renameAplexerSession(
    connectionId: string,
    id: string,
    target: string,
  ): Promise<RenameSessionResult> {
    const records = await this.aplexer!.snapshotRecords(connectionId);
    const self = records.find((r) => r.id === id);
    if (!self) {
      return {
        ok: false,
        sessionName: null,
        error: 'That session is not running any more.',
        code: 'rename-failed',
      };
    }
    if (records.some((r) => r.id !== id && r.workspace === self.workspace && r.tag === target)) {
      return {
        ok: false,
        sessionName: null,
        error: `A session called "${target}" is already running on this host.`,
        code: 'name-taken',
      };
    }
    const renamed = await this.aplexer!.renameSession(connectionId, id, target);
    if (renamed.ok) return { ok: true, sessionName: target, error: null, code: null };
    if (renamed.notFound) {
      return {
        ok: false,
        sessionName: null,
        error: 'That session is not running any more.',
        code: 'rename-failed',
      };
    }
    return { ok: false, sessionName: null, error: renamed.error, code: 'rename-failed' };
  }

  /**
   * The first free `<base>`, `<base>-2`, … on the host, or null when the host
   * did not answer.
   *
   * This used to fall back to [base] on a non-zero exit or an unreadable reply,
   * described as fail-safe on the grounds that a broken probe should never BLOCK
   * a create. That reasoning had the blast radius backwards. [base] is the one
   * answer this function must never invent, because the create it feeds is
   * attach-or-create: handing back [base] does not degrade a `unique` request
   * into a slightly worse `unique` request, it silently converts it into
   * `reuse`, and the caller is told `ok: true` with the name of a session it
   * very probably already has on screen. The only caller of this IS the `unique`
   * policy.
   *
   * So the failure is reported instead of papered over, and
   * {@link startSession} refuses. The last non-blank line is still what is read
   * on success — the walk's own `printf` is the last thing the shell runs, so
   * anything a login shell said before it is behind us.
   */
  private async freeSessionName(connectionId: string, base: string): Promise<string | null> {
    const probe = await this.ssh.exec(
      connectionId,
      pathAwareCommand(freeSessionNameCommand(base)),
    );
    if (probe.exitCode !== 0) return null;
    return lastNonEmptyLine(probe.stdout);
  }

  /**
   * `cd … && pwd -P`, or **null when the directory could not be entered**.
   *
   * The null is load-bearing: this one exec is both the canonicalisation and
   * the start path's folder guard. It used to fall back to the input on any
   * failure, which forced `startSession` to run a separate `[ -d ]` probe in
   * front of it to tell "missing" from "unresolvable" — a second login-shell
   * round trip on the create path for an answer `cd`'s exit code already
   * carries. The callers that genuinely have a fallback (`createFolder`, which
   * made the directory itself one exec earlier) keep it at the call site.
   */
  private async canonicalise(connectionId: string, path: string): Promise<string | null> {
    const res = await this.ssh.exec(
      connectionId,
      pathAwareCommand(resolveDirectoryCommand(path)),
    );
    if (res.exitCode !== 0) return null;
    return firstNonEmptyLine(res.stdout) ?? null;
  }
}

/** A scope that was not requested cannot make the call fail. */
function scopeOk(scope: ReposScopeResult | null): boolean {
  if (scope === null) return true;
  // gh being absent or logged out is a normal host state, not a failed call.
  return scope.state === 'ok' || scope.state === 'gh-missing' || scope.state === 'gh-unauthenticated';
}

// Re-exported so the preload can type `window.api.projects` without reaching
// into three modules.
export type { ReposListResult, ReposScopeResult, ReposCloneOptions, CreateSessionVia };
