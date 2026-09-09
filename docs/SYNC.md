# SYNC — optional Google-login settings sync

One optional feature: sign in with a Google account and the host entries
from `~/.ssh/config` sync to it, encrypted so the server cannot read them.
Everything here is opt-in — with no account signed in, the app behaves
exactly as it did before this existed.

The backend (API Gateway + Lambda + DynamoDB, deployed from
`aws-infra/sandbox/pocketshell-sync`) is documented in that repo, including
the wire contract this feature implements:
`aws-infra/sandbox/pocketshell-sync/docs/CLIENT-INTEGRATION.md`. This doc is
the app side.

## Sign-in

Desktop-app OAuth against Google, driven by `src/main/sync/GoogleAuth.ts`:
a one-shot loopback HTTP listener on `127.0.0.1:<random port>`, the system
browser opened at Google's authorization endpoint with a PKCE `S256`
challenge and a `state` nonce, and the returned `code` exchanged for an ID
token plus a refresh token. Signing in twice shares one in-flight flow; a
deny, a state mismatch, or five minutes of silence all fail the same
promise with the reason.

The OAuth credential is the "Desktop app" type in `src/shared/syncConfig.ts`.
Google's token endpoint requires its client secret even for installed apps,
but the secret is a deployment fact of this machine's owner, not source —
GitHub push protection refuses any push containing one, and rightly. It is
read at login time from `~/.config/pocketshell/google-client-secret` (one
line) or `POCKETSHELL_GOOGLE_SECRET`, and lives nowhere else. The
server-side email allowlist is what bounds who can hold an account.

Tokens never reach the renderer. They live in the main process, encrypted
with Electron `safeStorage` (OS keychain) in `userData/sync-auth.bin`; when
no keychain exists (some minimal Linux sessions) login refuses rather than
store plaintext. `getIdToken` serves the cached token and refreshes it on
demand; the API client (`src/main/sync/SyncService.ts`) retries a request
once through a forced refresh on a 401 before surfacing the failure.

## Encryption

Zero-knowledge, in `src/main/sync/SyncCrypto.ts`. The passphrase is typed in
Settings and lives only in the renderer's memory for the session — not in
localStorage, not in main, not on the server — so it cannot be recovered:
losing it loses the stored blob (the section says so). Each write derives a
key with PBKDF2-SHA256 (600k iterations, 256 bits) over a fresh 16-byte
salt, encrypts with AES-256-GCM under a fresh 12-byte IV, and uploads the
serialized envelope `{v, kdf, iter, salt, iv, ct}`. The salt travels in the
header, which is what makes the same passphrase work on every machine; the
auth tag appended to `ct` makes a wrong passphrase and a corrupted blob fail
closed. Pull hands the decrypted plaintext across IPC; the envelope itself
never does.

## What syncs, and the merge

The synced payload is the host list exactly as `listConfigHosts()` reports
it — hostnames, users, ports, jump hosts, forward directives. Private keys
are files on disk and never leave it. One payload, one slot (`main`), the
whole list per sync: the entries are small, and 8 KB (the server's ceiling,
enforced before upload in `SyncService`) holds hundreds of them.

The merge (`src/shared/syncMerge.ts`) is a union by alias, local-wins:

- a host known to only one side is kept — that is how a host added on the
  laptop reaches the desktop and vice versa;
- a host both sides know is taken whole from the LOCAL machine. No per-field
  merge and no per-host timestamps: `HostEntry` has none, and a half-merged
  host is worse than either whole entry.

Pushing sends the version the merge started from as the conflict base; a 409
(another device wrote first) re-pulls, re-merges, and retries up to three
times. The merge is idempotent over its own output, so a retry cannot
compound.

## Applying the account to this machine

`sync:applyHosts` → `src/main/ssh-config/SshConfigWriter.ts` appends hosts
the local `~/.ssh/config` does not have. Appends ONLY: the config is the
user's document, full of directives this app never parses, so rewriting an
existing entry is not an operation this module defines. A directive's every
non-wildcard, non-negated token claims a name; the write is temp-file-plus-
rename, preserves the file mode, and creates `~/.ssh/config` on a machine
that has none. Because the writer re-checks against the file (not the
renderer's list), a host hand-added since the last config read is never
duplicated.

## IPC surface

Under `ipc.sync` (see `src/shared/channels.ts`, wrapped by the preload):
`status`, `login`, `logout`, `pull`, `push`, `applyHosts`. Push answers as a
result union — `ok` / `conflict` (with the current version) / `error` —
because the store branches on the first two and an IPC rejection would
flatten that into a string. Pull distinguishes a fresh account (`absent`)
from a blob. `applyHosts` degrades its payload per entry
(`coerceHostEntries` in `src/shared/sync.ts`) before anything reaches the
config writer.

The renderer side is `src/renderer/stores/sync.ts` plus the Account & sync
section of `views/SettingsView.vue`.
