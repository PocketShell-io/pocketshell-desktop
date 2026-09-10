# SYNC — optional Google-login settings sync

One optional feature: sign in with a Google account and the host entries
you pick from `~/.ssh/config` sync to it, encrypted so the server cannot
read them. Everything here is opt-in — with no account signed in, the app
behaves exactly as it did before this existed.

The backend (API Gateway + Lambda + DynamoDB, deployed from
`aws-infra/sandbox/pocketshell-sync`) is documented in that repo, including
the wire contract this feature implements:
`aws-infra/sandbox/pocketshell-sync/docs/CLIENT-INTEGRATION.md`. This doc is
the app side.

## Sign-in

Desktop-app OAuth against Google, driven by `src/main/sync/GoogleAuth.ts`:
a one-shot loopback HTTP listener on `127.0.0.1:<random port>`, the system
browser opened at Google's authorization endpoint with a PKCE `S256`
challenge and a `state` nonce. The returned code and PKCE verifier go to the
sync backend's token-broker route, which exchanges them with Google using the
client secret held in AWS Secrets Manager. Signing in twice shares one
in-flight flow; a deny, a state mismatch, or five minutes of silence all fail
the same promise with the reason.

The OAuth credential is the "Desktop app" type in `src/shared/syncConfig.ts`.
The downloaded app embeds only its public client ID; it never asks the user
for a client secret. The backend secret and the server-side email allowlist
are what control access to the sync service.

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

## What syncs: the selection

Sync is selective. The Account & sync section lists `~/.ssh/config`'s hosts
with a checkbox each; ONLY ticked hosts are uploaded — an unticked host
never leaves the machine, encrypted or otherwise. That is the privacy
property, and it is why the payload is assembled rather than merged: the
payload is the ticked set, and pushing replaces the account's content with
it (`assembleSyncSet` in `src/shared/syncMerge.ts`).

The tick marks live in the settings store (`syncSelectedHosts`, per
machine, persisted — a forgotten selection is the dangerous direction: a
relaunch that reset every tick would let an innocent "Sync now" wipe the
account). Each ticked alias contributes its LOCAL entry when the config
has one — the machine you are sitting at is authoritative for the hosts it
has — else the ACCOUNT's entry, so a ticked host the config has lost keeps
its backup instead of silently vanishing from the account too.

The account is part of the selection rather than a rival to it: aliases
pulled from the account tick themselves on — but only ones the local
config lacks, so an alias this machine can see is one the user has decided
about and their untick stands. The two rules together give the flows that
matter: a fresh machine pulls and auto-ticks everything, so its next push
re-uploads the account instead of wiping it; and removing a host from the
account is untick + sync, nowhere else.

Entries travel exactly as `listConfigHosts()` reports them — hostnames,
users, ports, jump hosts, forward directives; private keys are files on
disk and never leave it. One payload, one slot (`main`), whole list per
sync: the entries are small, and 8 KB (the server's ceiling, enforced
before upload in `SyncService`) holds hundreds of them.

Pushing sends the version the pull returned as the conflict base; a 409
(another device wrote first) re-pulls, re-absorbs its aliases,
re-assembles, and retries up to three times. Each retry absorbs only new
aliases, so a retry cannot compound.

## Applying the account to this machine

`sync:applyHosts` → `src/main/ssh-config/SshConfigWriter.ts` appends the
synced set's hosts that the local `~/.ssh/config` does not have. Appends
ONLY: the config is the
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
section of `views/SettingsView.vue`; the tick marks themselves are the
settings store's `syncSelectedHosts`.
