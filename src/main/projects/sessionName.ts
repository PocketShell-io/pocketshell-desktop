/**
 * Directory-derived tmux session naming — folder-name validation and path
 * joining.
 *
 * LIFTED INTO @pocketshell/core (src/projectFolderName.ts) so all three
 * clients (desktop, web, phone) validate and join identically; this module is
 * now a re-export so the main process's importers keep one import path. The
 * name-derivation rules themselves remain in shared/sessionNameParts.ts.
 */
export { normaliseProjectFolderName, childPath } from '@pocketshell/core';
