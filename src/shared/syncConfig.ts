/**
 * Constants for the optional Google-login settings sync (docs/SYNC.md).
 *
 * The client ID identifies the Google OAuth "Desktop app" credential; the
 * API URL is the `ApiUrl` output of the pocketshell-sync CloudFormation
 * stack in the aws-infra repo (sandbox/pocketshell-sync).
 *
 * The desktop app uses PKCE and sends the one-time code to the sync backend's
 * token broker. The backend holds Google's client secret; the downloaded app
 * contains only this public client ID.
 */

export const GOOGLE_CLIENT_ID =
  '1035162854462-nos4fptbf2psbkp8ljd8tjem1psnekvt.apps.googleusercontent.com';

/** Base URL of the sync API ($default stage). */
export const SYNC_API_URL = 'https://a7sota2qic.execute-api.eu-west-1.amazonaws.com';

/** The one settings blob the app syncs. */
export const SYNC_SLOT = 'main';

/** The sync payload the server never sees unencrypted is this JSON shape. */
export interface SyncPayload {
  /** Host entries as `listConfigHosts()` returns them (never private keys). */
  hosts: unknown[];
}
