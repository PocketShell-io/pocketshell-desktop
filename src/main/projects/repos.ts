/**
 * `pocketshell repos list --json` parsing and failure classification.
 *
 * The unified schema is documented in the helper's own
 * `pocketshell/repos.py` module docstring (read off the Docker fixture,
 * helper 0.4.44) and confirmed against real `--local --json` output:
 *
 * ```json
 * {
 *   "owner": "alexeygrigorev" | null,
 *   "name": "pocketshell",
 *   "full_name": "alexeygrigorev/pocketshell" | null,
 *   "local":  {"path": "/home/…", "head": "main"} | null,
 *   "remote": {"default_branch": "main", "html_url": "…",
 *              "ssh_url": "…", "updated_at": "…"} | null
 * }
 * ```
 *
 * `--local` rows always have `remote: null` and `--remote` rows always have
 * `local: null` — the helper deliberately does NOT join the two server-side,
 * so the merge lives here (same split as the Android `ReposRemoteSource`,
 * app/src/main/java/com/pocketshell/app/repos/ReposRemoteSource.kt:38).
 *
 * `owner`/`full_name` are null for a local clone whose origin is not GitHub
 * (or has no origin at all) — verified on the fixture, where a `git init`d
 * folder came back as `{"full_name": null, "owner": null, "name": "demo-repo"}`.
 * Any consumer that keys on `full_name` must therefore fall back to `name`.
 */

/** Where a repo lives on the host's disk. */
interface RepoLocal {
  path: string;
  /** Checked-out branch, or null when it could not be read. */
  head: string | null;
}

/** The GitHub side of a repo. Fields are best-effort — the helper passes `gh` through. */
interface RepoRemote {
  defaultBranch: string | null;
  htmlUrl: string | null;
  sshUrl: string | null;
  updatedAt: string | null;
}

/** One row of `repos list --json`, normalised to camelCase. */
export interface RepoEntry {
  /** Directory basename for a local clone; GitHub repo name for a remote row. */
  name: string;
  /** GitHub owner, or null (non-GitHub origin / no origin). */
  owner: string | null;
  /** `owner/name`, or null when the owner is unknown. */
  fullName: string | null;
  local: RepoLocal | null;
  remote: RepoRemote | null;
}

/**
 * Why a `repos list` scope produced no rows.
 *
 * `gh-missing` and `gh-unauthenticated` are NORMAL states, not errors: a host
 * with no GitHub CLI simply has no remote repos to offer, and the local scan
 * is unaffected. The UI should show the local list plus a hint, never a
 * failure dialog.
 */
export type ReposScopeState =
  | 'ok'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'helper-missing'
  | 'failed';

/** Result of one scope (`--local` or `--remote`). */
export interface ReposScopeResult {
  state: ReposScopeState;
  repos: RepoEntry[];
  /** Host-supplied reason, when there is one. */
  error: string | null;
}

/** Result of a `projects:reposList` call. */
export interface ReposListResult {
  /** True when every requested scope came back `ok`. */
  ok: boolean;
  /** Local and remote rows merged by `fullName` (falling back to `name`). */
  repos: RepoEntry[];
  local: ReposScopeResult | null;
  remote: ReposScopeResult | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseLocal(value: unknown): RepoLocal | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const path = asString(record['path']);
  if (path === null) return null;
  return { path, head: asString(record['head']) };
}

function parseRemote(value: unknown): RepoRemote | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    defaultBranch: asString(record['default_branch']),
    htmlUrl: asString(record['html_url']),
    sshUrl: asString(record['ssh_url']),
    updatedAt: asString(record['updated_at']),
  };
}

/**
 * Parse a `repos list --json` payload.
 *
 * Tolerant by design — this decorates a picker, it does not gate it. Junk
 * around the array, a non-array payload, or a row with no usable name are all
 * dropped rather than thrown: an unparseable repos list must degrade to "no
 * repos offered", never break the session-creation flow it hangs off.
 */
export function parseReposJson(stdout: string): RepoEntry[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RepoEntry[] = [];
  for (const raw of parsed as unknown[]) {
    if (raw == null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const local = parseLocal(record['local']);
    const owner = asString(record['owner']);
    // `name` is the helper's stable identity; fall back to the clone's
    // directory basename if a future payload ever omits it.
    const name =
      asString(record['name']) ??
      (local ? local.path.slice(local.path.lastIndexOf('/') + 1) : null);
    if (name === null) continue;
    out.push({
      name,
      owner,
      fullName: asString(record['full_name']) ?? (owner ? `${owner}/${name}` : null),
      local,
      remote: parseRemote(record['remote']),
    });
  }
  return out;
}

/** The identity two scopes are joined on. */
function repoKey(entry: RepoEntry): string {
  return entry.fullName ?? entry.name;
}

/**
 * Merge the local and remote scopes into one list.
 *
 * Local rows come first and win on identity, so a GitHub repo that is already
 * cloned renders as one row carrying BOTH blocks — the difference between an
 * "Open" affordance and a "Clone" one. Remote-only rows are appended in the
 * order `gh` returned them.
 */
export function mergeRepos(local: RepoEntry[], remote: RepoEntry[]): RepoEntry[] {
  const byKey = new Map<string, RepoEntry>();
  const order: string[] = [];
  for (const entry of local) {
    const key = repoKey(entry);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, entry);
  }
  for (const entry of remote) {
    const key = repoKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        owner: existing.owner ?? entry.owner,
        fullName: existing.fullName ?? entry.fullName,
        remote: existing.remote ?? entry.remote,
      });
    } else {
      order.push(key);
      byKey.set(key, entry);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Classify a non-zero `pocketshell repos …` exit.
 *
 * The exit code alone is not enough. Captured on the fixture (helper 0.4.44):
 *
 *  - `repos list --remote --json` with no `gh` on PATH exits **127** with
 *    "pocketshell: `gh` is not installed on this host. …" on stderr;
 *  - a MISSING `pocketshell` also exits 127, but with the shell's own
 *    "pocketshell: not found".
 *
 * Both are 127, and they mean opposite things to the UI ("install gh, the
 * rest of the app is fine" vs "this host has no helper at all"), so the
 * stderr text is what actually decides. The `gh auth` wording mirrors the
 * phone's `ghUnauthenticated` (AppAssistantActions.kt:514).
 */
export function classifyReposFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
): { state: Exclude<ReposScopeState, 'ok'>; error: string } {
  const text = `${stdout}\n${stderr}`;
  const lower = text.toLowerCase();
  const message = stderr.trim() || stdout.trim() || `pocketshell repos exited ${exitCode}`;

  if (
    lower.includes('not authenticated') ||
    lower.includes('gh auth') ||
    lower.includes('authentication required')
  ) {
    // `gh auth login` appears in the gh-missing message too, so the absent
    // binary must be ruled out first.
    if (!lower.includes('is not installed')) {
      return { state: 'gh-unauthenticated', error: message };
    }
  }
  if (lower.includes('`gh` is not installed') || lower.includes('gh is not installed')) {
    return { state: 'gh-missing', error: message };
  }
  if (isHelperMissing(exitCode, text)) {
    return { state: 'helper-missing', error: message };
  }
  // A Click usage error is a REAL failure, not an absent helper: `failed`
  // carries an error tone in the UI where `helper-missing` reads as "this host
  // just doesn't have it". The host's own line goes out annotated so the user
  // is told which of the two it is.
  return { state: 'failed', error: annotateHelperRejection(message, text) };
}

/**
 * Is this exit the host telling us the `pocketshell` BINARY is absent, rather
 * than the command running and failing?
 *
 * One question only: did the shell fail to find the executable. 127 from
 * `/bin/sh` is "command not found", and the `gh` guard above it is needed
 * because the helper's own "`gh` is not installed" message also exits 127 —
 * see {@link classifyReposFailure}.
 *
 * ## What used to be here, and why it is gone
 *
 * This also returned true for Click's exit-2 `No such command` / `No such
 * option`, on the theory that a helper too old to have the subcommand is, to
 * us, as good as no helper. That was back-compat by intent and it is now
 * removed (no backwards-compat, hard cuts only): hosts run 0.4.44,
 * which has every subcommand and every option this app sends, so those exits
 * can no longer mean "old helper". They can only mean we built the invocation
 * wrong, or `pocketshell` on that host is not the helper we think it is.
 *
 * Keeping them here was actively unsafe rather than merely obsolete, because
 * this predicate is the trigger for the create fallback in
 * ../helper/PocketshellClient.ts (`createSession`): a true answer drops to a
 * raw `tmux new-session`, which creates the
 * session with NO memory cap and reports `ok`. A wrong flag on `sessions
 * create` would therefore have been laundered into a successful-looking create
 * that quietly ignored the repo's `cgroups.toml` budget. Those exits are now
 * explained by {@link describeHelperRejection} and surfaced as failures.
 *
 * Still deliberately narrow in the other direction too: a genuine runtime
 * failure of a command that DID run must be reported, never downgraded.
 */
export function isHelperMissing(exitCode: number, output: string): boolean {
  const lower = output.toLowerCase();
  if (lower.includes('is not installed')) return false; // a gh message, not a helper one
  return exitCode === 127 && /pocketshell[^\n]*not found|command not found/.test(lower);
}

/**
 * Explain a Click usage error from the helper, or null when the output is not
 * one.
 *
 * Click exits **2** for both of these, and they are different bugs on our side:
 *
 *  - `Error: No such command 'sessions'.` — the group has no such subcommand.
 *    Against 0.4.44 this means the `pocketshell` on that host is not the helper
 *    (a namesake on PATH, a half-installed shim), because every subcommand we
 *    call exists in the version the app targets.
 *  - `Error: No such option: --cwd` — the subcommand exists but rejected a flag
 *    we passed. That is drift between this client and the installed helper:
 *    `sessions resumable --json` was removed upstream while the docs still
 *    promised it.
 *
 * They were previously lumped together AND swallowed as `helper-missing`. They
 * are kept apart here because the fix differs — check the host's install vs.
 * fix the command we build — and the raw Click line names neither, so a user
 * reading "No such option: --cwd" in a dialog has nothing to act on. The host's
 * own text is still shown; this only adds the sentence that makes it legible.
 */
export function describeHelperRejection(output: string): string | null {
  const lower = output.toLowerCase();
  if (lower.includes('no such command')) {
    return "The `pocketshell` on this host does not have that subcommand — check `pocketshell --version` there (this app targets 0.4.44).";
  }
  if (lower.includes('no such option')) {
    return "The host's `pocketshell` rejected an option this app passed — the app and the installed helper have drifted.";
  }
  return null;
}

/**
 * A host failure message with the usage-error explanation appended, when there
 * is one.
 *
 * Both call sites (repos classification and session creation) compose it the
 * same way, so they share this rather than each inventing their own wording.
 * The newline collapses to a space in the renderer's `<p>` and keeps the two
 * sentences apart in a log.
 */
export function annotateHelperRejection(hostMessage: string, output: string): string {
  const reason = describeHelperRejection(output);
  return reason === null ? hostMessage : `${hostMessage}\n${reason}`;
}
