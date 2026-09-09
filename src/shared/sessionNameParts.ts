/**
 * Session-name derivation, shared across the process boundary.
 *
 * This is pure string logic with no Node dependency, and both sides need the
 * SAME one: the main process derives the session name the host will use
 * (../main/projects/sessionName.ts), and the renderer's redundancy test —
 * "is this session name just its folder restated?" — must run the exact regex
 * that derived it, or it suppresses the wrong rows. Duplicating the pattern
 * would let the two copies drift silently, so it lives here and
 * `sessionName.ts` re-exports it for its existing callers.
 */

/**
 * The character rules of `sanitisePart` WITHOUT the edge trim: `.` and `:`
 * collapse to `_` (tmux forbids both — `:` is its window/pane separator), then
 * any other disallowed run collapses to a single `-`.
 *
 * This exists for the rename field, which sanitises AS THE USER TYPES. A `-`
 * is typed at the END of the field first, so an as-you-type edge trim would
 * eat every hyphen on landing and `foo-bar` could only ever be typed as
 * `foobar`. Edge hyphens are still illegal in a committed name — the commit
 * runs the full `sanitisePart` — so trimming stays a commit-time fact and
 * typing only rewrites characters no name could keep. Built ON rather than
 * beside `sanitisePart` so the two passes cannot drift.
 */
export function normalisePart(part: string): string {
  return part.replace(/[.:]+/g, '_').replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * Normalise a single path component to tmux-safe characters.
 *
 * Order matters and mirrors tmuxctl: the `normalisePart` character rules
 * first, then leading and trailing `-` are stripped.
 */
export function sanitisePart(part: string): string {
  return normalisePart(part)
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Directory -> session name
// ---------------------------------------------------------------------------
/**
 * `sessionBaseName` lives HERE rather than in ../main/projects/sessionName.ts,
 * which is where it was written and which still re-exports it for its existing
 * callers.
 *
 * It moved for the same reason `sanitisePart` was put here in the first place:
 * the renderer now needs the derivation, not just the sanitiser. The folder
 * workspace strips a folder's derived base name off its sessions' names to
 * label the tabs, and that prefix has to be the exact
 * string the main process would derive for the same folder — a second, nearly
 * identical implementation in the renderer would drift the first time either
 * side was touched, and the symptom would be tab labels that stop stripping.
 *
 * Nothing about the rules changed in the move; see the doc comments below,
 * which are the ones the original carried.
 */

function splitPathParts(path: string): string[] {
  return path.split('/').filter((p) => p.length > 0 && p !== '.');
}

function joinParts(parts: string[]): string {
  return parts
    .map(sanitisePart)
    .filter((p) => p.length > 0)
    .join('-');
}

/** Drop a trailing `/` (but never turn `/` itself into the empty string twice). */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The directory-derived base name — the port of `SessionNameDerivation.baseName`.
 *
 * The convention:
 *
 *  - the directory IS `$HOME`            -> `home-<homeBasename>`  (`/home/alexey` -> `home-alexey`)
 *  - the directory is UNDER `$HOME`      -> home-relative components joined by `-`
 *                                          (`~/git/pocketshell` -> `git-pocketshell`)
 *  - anything else (or home unknown)     -> absolute components joined by `-`
 *                                          (`/var/log` -> `var-log`)
 *
 * The name is a pure path prefix: agent and shell sessions in one folder derive
 * the SAME base name. That is deliberate — it is what makes `sessions create`
 * idempotent per folder, and it is what makes the tab-label prefix a property
 * of the FOLDER rather than a coincidence of spelling shared by some of its
 * sessions.
 *
 * @param startDirectory the folder the session will start in. May be absolute,
 *   `~`, or `~/...`; a `~` form is resolved against [homeDirectory] so the same
 *   folder yields the same name whichever form the caller passed.
 * @param homeDirectory the remote `$HOME`, or null when it could not be resolved.
 */
export function sessionBaseName(startDirectory: string, homeDirectory: string | null): string {
  const trimmedHome = trimTrailingSlash((homeDirectory ?? '').trim());
  const home = trimmedHome.length > 0 ? trimmedHome : null;
  const raw = trimTrailingSlash(startDirectory.trim());

  let resolved: string;
  if (raw.length === 0) resolved = home ?? '';
  else if (raw === '~') resolved = home ?? raw;
  else if (raw.startsWith('~/')) resolved = home !== null ? `${home}/${raw.slice(2)}` : raw;
  else resolved = raw;

  // The directory IS $HOME.
  if (home !== null && resolved === home) {
    const homeTail = home.slice(home.lastIndexOf('/') + 1) || 'home';
    return joinParts(['home', homeTail]);
  }

  // The directory is UNDER $HOME.
  if (home !== null && resolved.startsWith(`${home}/`)) {
    return joinParts(splitPathParts(resolved.slice(home.length + 1))) || 'shell';
  }

  // Unresolved `~` form with no known home: best effort.
  if (resolved === '~') return 'home';
  if (resolved.startsWith('~/')) {
    return joinParts(splitPathParts(resolved.slice(2))) || 'shell';
  }

  return joinParts(splitPathParts(resolved)) || 'shell';
}

/** Sanitise a whole user-entered label (trimmed, then per-component rules). */
export function sanitiseName(name: string): string {
  return sanitisePart(name.trim());
}

/**
 * The final BASE name for a new session, honouring an optional user label.
 *
 * A label that sanitises to something with at least one letter or digit wins;
 * anything else (blank, whitespace, `...`, `:::`) falls back to the
 * directory-derived name. Port of `SessionNameDerivation.resolveSessionName`.
 *
 * Still just the base: no `-2` suffix is appended here. This module NEVER
 * decides uniqueness — the host answers "is this name free?" at create time
 * (`freeSessionNameCommand` in ../main/projects/commands.ts). The Kotlin
 * removed its client-side `-2`/`-3` disambiguation because a stale UI cache
 * silently requested names that were already taken.
 */
export function resolveSessionName(
  customName: string | null | undefined,
  startDirectory: string,
  homeDirectory: string | null,
): string {
  if (customName != null) {
    const custom = sanitiseName(customName);
    if (/[A-Za-z0-9]/.test(custom)) return custom;
  }
  return sessionBaseName(startDirectory, homeDirectory) || 'shell';
}

// ---------------------------------------------------------------------------
// aplexer tags
// ---------------------------------------------------------------------------

/**
 * The tag a workspace's first aplexer session gets, and the stem the numbered
 * ones continue (`main`, `main-2`, `main-3`… via the free-tag walk).
 *
 * An aplexer tag is namespaced PER WORKSPACE (`workspace:tag`), so `main` in
 * one folder cannot collide with `main` in another — the constraint that keeps
 * the tmux name folder-derived (host-global namespace) does not exist here.
 * The tag is also the app's only name for the session — there is no display
 * relabel on top — so it is named for humans, not for grouping.
 */
export const APLEXER_DEFAULT_TAG = 'main';

/**
 * The BASE tag for a new aplexer session: the user's label when it survives
 * sanitising, else {@link APLEXER_DEFAULT_TAG}. Same custom-name rule as
 * {@link resolveSessionName}; only the fallback differs. No `-2` suffix here —
 * uniqueness is the live-tag walk at create time (`freeAplexerTag`), exactly
 * as `resolveSessionName` never decides it.
 */
export function resolveAplexerTag(customName: string | null | undefined): string {
  if (customName != null) {
    const custom = sanitiseName(customName);
    if (/[A-Za-z0-9]/.test(custom)) return custom;
  }
  return APLEXER_DEFAULT_TAG;
}
