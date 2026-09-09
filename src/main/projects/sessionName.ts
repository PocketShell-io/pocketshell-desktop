/**
 * Directory-derived tmux session naming — folder-name validation and path
 * joining. Both apps must name the same folder the same way, because the
 * session name IS the folder identity on the host — `tmuxctl` uses the same
 * convention, so a session created from the phone and one created from the
 * desktop in `~/git/pocketshell` are the same session, not two.
 *
 * A faithful port of the Android app's
 * `app/src/main/java/com/pocketshell/app/projects/SessionNameDerivation.kt`
 * (`normaliseProjectFolderName` ← FolderListGateway.kt:2059).
 *
 * The name-derivation rules themselves (`sessionBaseName`, `sanitiseName`,
 * `sanitisePart`, `resolveSessionName`, `resolveAplexerTag`) live in
 * ../../shared/sessionNameParts.ts — the renderer's folder workspace labels
 * its tabs by stripping a folder's derived base name off its sessions, so it
 * needs the derivation itself, not merely the sanitiser, and two
 * implementations of a rule this exact would drift.
 */

import { trimTrailingSlash } from '../../shared/sessionNameParts.js';

/**
 * Validate a new-folder name typed by the user — port of
 * `FolderListGateway.normaliseProjectFolderName` (FolderListGateway.kt:2059).
 *
 * Returns the cleaned name, or null when it cannot be a single folder under
 * the chosen parent. Rejecting `/` and `\` here is what keeps "create a new
 * empty folder" from silently creating a nested tree (or escaping the parent
 * via `..`); it is a usability rule, not the security boundary — the shell
 * quoting in ./commands.ts is that.
 */
export function normaliseProjectFolderName(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

/** Join a parent directory and a child name into a remote path. */
export function childPath(parentPath: string, childName: string): string {
  const parent = trimTrailingSlash(parentPath.trim());
  return parent.length === 0 || parent === '/' ? `/${childName}` : `${parent}/${childName}`;
}
