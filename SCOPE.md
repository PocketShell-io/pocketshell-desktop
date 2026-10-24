# PocketShell scope

The [PocketShell product charter](https://github.com/PocketShell-io/pocketshell/blob/main/SCOPE.md)
is the scope policy for this repository, including its in-scope, owner-labelled
NOT and "Removed (Hub owns this)" lists.

This repo: the desktop human-access client; manual terminal/files/ports access works without Hub and never silently retries refused Hub work.

PocketShell must work without Hub. Hub owns managed agent work and may stop/delete
any session, including manual PocketShell/psc sessions; PocketShell owns live human access.
