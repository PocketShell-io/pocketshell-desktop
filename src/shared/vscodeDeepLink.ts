/**
 * The "Open in VS Code" deep link: the `vscode://` URL that makes VS Code
 * desktop open a folder on THIS host through its Remote-SSH extension.
 *
 * Pure functions — the URL is decided here so main and the unit tests agree
 * on one spelling, and main can refuse anything it did not just build itself.
 *
 * ## The URL, and what each part must be
 *
 *     vscode://vscode-remote/ssh-remote+<host-token>/<absolute remote path>
 *
 * The scheme is VS Code's, not ours, and only the `ssh-remote` authority is
 * documented-by-example (vscode-remote-release#8764 asks for real docs; the
 * format below is the one that works). Two constraints shape everything:
 *
 *   - **the host token is resolved through the USER's `~/.ssh/config`.**
 *     Remote-SSH dials by looking the token up in that file, which is where
 *     the port, the key and any ProxyJump already live. A config alias is
 *     therefore the one token with full fidelity, and it is what
 *     {@link vscodeHostToken} produces for a host this app read from the
 *     config. A manually entered host has no alias to hand over; the best
 *     the link can carry is `user@host`, which works while the port is the
 *     default — a non-default port needs a config entry, and inventing one
 *     from here is not this feature's business.
 *   - **the path must be absolute.** The URL's path is resolved server-side
 *     with no shell in front of it, so a literal `~/git/foo` would look for
 *     a DIRECTORY NAMED `~` — the same trap `stripTilde` exists for in the
 *     SFTP channel. Workspace folder keys can be tilde-spelled, so the
 *     expansion is {@link absoluteRemoteFolder}, driven by the remote home
 *     the projects store already resolved.
 */

/** The authority prefix of a Remote-SSH folder link; also main's allow-list. */
export const VSCODE_REMOTE_PREFIX = 'vscode://vscode-remote/ssh-remote+';

/**
 * The host token a deep link for [host] carries.
 *
 * The config alias when the host has one — Remote-SSH resolves the same
 * entry the same way this app dialled it, port and key included — and
 * `user@host` for a manually entered one (see the module header for why the
 * port cannot ride along).
 */
export function vscodeHostToken(host: {
  name: string;
  hostname: string;
  user: string;
  fromConfig: boolean;
}): string {
  if (host.fromConfig && host.name.trim() !== '') return host.name;
  return host.user ? `${host.user}@${host.hostname}` : host.hostname;
}

/**
 * Expand a workspace folder path to the absolute path a deep link needs.
 *
 * Absolute paths pass through. `~` and `~/x` are anchored on [home] — the
 * remote `$HOME` the projects store resolves — and stay null while it is
 * unknown, because guessing is how `/home/me~git` gets opened. Anything else
 * (a relative path, `~other/x` meaning another user's home) is refused, on
 * the same footing as `stripTilde`'s: failing honestly beats opening the
 * wrong directory.
 */
export function absoluteRemoteFolder(path: string, home: string | null): string | null {
  if (path.startsWith('/')) return path;
  if (path === '~') return home;
  if (path.startsWith('~/')) return home === null ? null : `${home}${path.slice(1)}`;
  return null;
}

/**
 * The deep-link URL, or null when the pieces cannot make an honest one.
 *
 * The host token must be a single authority word — no whitespace and no
 * `/ ? #`, which would otherwise start reading as the rest of a URL — and
 * the folder must already be absolute ({@link absoluteRemoteFolder}'s job).
 * Each path segment is percent-encoded; the slashes between them are the
 * URL's own structure and stay literal.
 */
export function vscodeRemoteFolderUrl(hostToken: string, folderPath: string): string | null {
  const token = hostToken.trim();
  if (token === '' || /[\s/?#]/.test(token)) return null;
  if (!folderPath.startsWith('/') || folderPath === '/') return null;
  return VSCODE_REMOTE_PREFIX + token + folderPath.split('/').map(encodeURIComponent).join('/');
}
