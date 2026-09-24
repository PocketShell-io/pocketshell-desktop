import type { RepoEntry, RepoLocal, RepoRemote, ReposScopeResult, ReposScopeState } from '@pocketshell/core';
export type { RepoEntry, RepoLocal, RepoRemote, ReposScopeResult, ReposScopeState } from '@pocketshell/core';
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

// The repos payload parsers and failure classifiers live in core now — one
// copy for every client (see src/reposScope.ts there).
export {
  parseReposJson,
  mergeRepos,
  classifyReposFailure,
  isHelperMissing,
  describeHelperRejection,
  annotateHelperRejection,
} from '@pocketshell/core';
