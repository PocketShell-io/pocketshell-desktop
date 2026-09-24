/**
 * The exact remote shell commands the folder-first session flow runs — pure
 * string builders, because every one of them interpolates a value the user
 * chose (a folder path, a folder name, a repo slug, a session name) into a
 * command line that a remote shell will parse.
 *
 * LIFTED INTO @pocketshell/core (src/projectCommands.ts) so the browser
 * transport builds the SAME commands; this module is now a re-export so the
 * main process's importers keep one import path. Wrap the result in
 * `pathAwareCommand` before exec'ing: sshd runs a non-login shell, so
 * `$HOME/.local/bin` — where uv installs `pocketshell` and `tmuxctl` — is not
 * on PATH by default.
 */
export {
  FREE_SESSION_NAME_MAX_SUFFIX,
  resolveDirectoryCommand,
  HOME_COMMAND,
  mkdirCommand,
  tmuxServerArg,
  sessionExistsCommand,
  freeSessionNameCommand,
  sessionTakenAnywhereCommand,
  createSessionCommand,
  fallbackCreateSessionCommand,
  reposListCommand,
  reposCloneCommand,
  renameSessionCommand,
  killSessionCommand,
  gitRepoProbeCommand,
  type ReposListOptions,
  type ReposCloneOptions,
} from '@pocketshell/core';
