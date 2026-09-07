# PocketShell Desktop — Testing

Four tiers, bottom-up. The guiding rule, inherited
from the Android project: **only deterministic Docker targets, never real
hosts or real provider credentials.**

---

## 1. Test tiers

| Tier | Runner | Target | Covers | When |
|---|---|---|---|---|
| **Unit** | vitest (node) | none (pure logic) | parsers, ssh-config, known_hosts, reconnect FSM logic, port-scanner parser, shell-quote | every push |
| **Integration** | vitest + `testcontainers` | ephemeral Docker port per test | SshService, SftpService, forwarder round-trips, helper-client | every push (requires Docker) |
| **E2E** | Playwright + Electron | fixed compose port (3205) | full UI flows: host pick → tree → terminal → files → conversation → usage | on PR + pre-release |
| **Manual smoke** | `scripts/smoke.sh` | compose fleet | brings everything up, runs unit+integration+E2E, tears down, prints summary | pre-release gate |

### Unit

Pure TypeScript, no network, no Docker. Fast (<2s). Covers anything that
transforms bytes → data:

- `SshConfigParser`: sample `~/.ssh/config` → `HostEntry[]` (Host,
  HostName, Port, User, IdentityFile, ProxyJump, ForwardAgent,
  LocalForward, RemoteForward, wildcards, `Include`).
- `KnownHosts`: matcher accepts/rejects; TOFU path returns "unknown".
- `parsers.ts`: `sessions list` table, `resumable` table, `usage --json`
  NDJSON — pinned to fixture strings copied
  from the source repo so shapes stay byte-identical.
- `AutoForwarder` port-resolution (mirror vs allocate), `PortScanner`
  output parsing (`ss`/`netstat` shapes).
- Reconnect FSM: given a fake clock + a scripted transport, assert the
  backoff sequence and the `retryNow` wake.
- `TmuxClientPool`: concurrent tab mounts are serialized, and a
  `Channel open failure` can recover by evicting one cached tab and retrying.

### Integration

`testcontainers` builds the Dockerfiles at test time and maps container 22
to an **ephemeral** host port, so tests are isolated and parallel-safe.
Each suite starts its own container. Docker is a required integration-test
prerequisite; collection fails loudly when the daemon is unavailable, so a
machine that ran no integration tests cannot report a misleading green suite.

Examples:

- `SshServiceIntegration`: connect with the committed `test_key` (ed25519)
  → `exec('whoami')` → assert `testuser`, exit 0. Then a non-zero-exit
  case (`exec('false')`) asserts exit 1 with no throw. Then a tail and a
  shell round-trip.
- `SftpIntegration`: `list /home/testuser`, write a file, read it back,
  mkdir/rename/delete, upload a 10MB file with progress.
- `ForwarderIntegration`: start `python -m http.server 8000` in the
  container via exec, auto-forward, `curl http://localhost:<local>` → 200;
  `-R` round-trip; `-D` SOCKS round-trip. The `flaky-helper` image proves
  reconnect. Every image from `:ssh` up also runs
  `tests-docker/traffic-server.py` on **8021** (entrypoint-started, as
  `testuser` so `ss -tlnp` can attribute it): it answers
  `<up> <down> [chunk] [gap_ms]\n` by draining exactly `up` bytes and
  writing exactly `down`, optionally paced — without it every fixture
  listener was idle and a byte-counter or rate-maths bug was invisible.
  The suite asserts exact totals (65 557 out / 262 144 in) and a paced
  1 MiB download whose sampled `rateIn` must land near 512 KiB/s.
  **Rebuild the images after changing it** —
  `scripts/build-docker.sh`; the tests use the prebuilt tags.
- `Reconnect.integration`: against the `flaky` image, watch a REAL
  transport drop arrive as close-reason `lost` on a deterministic schedule,
  confirm the dead id is a hard unknown-id error, then re-dial the same
  sshd and round-trip `whoami`. Main's half of reconnect; the renderer FSM
  that decides WHEN to redial is unit-tested under fake timers
  (`connectionAutoReconnect.test.ts`).
- `HelperIntegration`: against the `helper` image, `pocketshell sessions
  list`, `usage --json` parse cleanly; `sessions
  create` then `sessions list` shows it. The env-editor round trip
  (FEATURES.md F16) rides here too: `env set` (a `{"KEY":"value"}` JSON
  object on the command's STDIN — never argv) writes a value containing
  quotes, dollars and `=`; `env list` shows the key `hasValue`;
  `env get` reads the exact value back; an explicit `--file .envrc` write
  lands where it was aimed.

### E2E

Playwright launches the **packaged** Electron app (built once per run)
against a fixed compose service on `127.0.0.1:3205`. Scenarios:

1. **Core terminal flow (Phase 1):** host picker lists the seeded
   `pocketshell-test` host → click → bootstrap completes → session tree
   shows seeded sessions → click one → terminal renders → type `echo hi`
   → assert visible output.
2. **Files (Phase 2):** open Files tab → browse `~` → open a seeded file
   → edit → save → reopen / second-channel `cat` shows the change.
3. **Forwards (Phase 3):** open Port panel → add a forward → curl it.
4. **Agents (Phase 4):** open a seeded session → Conversation tab renders
   messages → Usage tab shows cards.

Headless in CI; screenshots + traces on failure.

---

## 2. Local Docker instance

The standalone `instance` service is a disposable remote-like machine for
manual PocketShell demos and for testing host-scoped settings. It is separate
from the ephemeral fleet below, so it can stay running while unit or
testcontainer tests execute.

Every `scripts/test-instance.sh` action has a `.ps1` twin
(`scripts/test-instance.ps1`); where local script execution is restricted,
run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
.\scripts\test-instance.ps1 <action>` instead. The examples below use Bash
(Git Bash and WSL both work).

### Prerequisites

- Docker Desktop with **Linux containers** and Docker Compose v2.
- An OpenSSH client (`ssh` and `sftp`). Windows 10/11 normally includes one.
- Node 20+ if you are running the Electron app from this checkout.

### Build and start

```bash
bash scripts/test-instance.sh build
bash scripts/test-instance.sh start
bash scripts/test-instance.sh status
```

`start` builds `pocketshell-test:instance` from
`tests-docker/Dockerfile.instance`, starts Compose service `instance`, and
waits for its in-container SSH healthcheck. The default host port is **3222**
so it does not collide with the test fleet's 3202–3206 ports. Override it for
one run with `POCKETSHELL_SSH_PORT=3322`.

The image includes OpenSSH + SFTP, `testuser`, tmux, git, Python 3, `curl`,
`ss`/`netstat`, Node.js 22/npm, the pinned `pocketshell` and `tmuxctl` helpers,
the `aplexer` CLI (the app's main session manager; latest release at build
time — set `APLEXER_VERSION` to pin it — with its glibc release binary running
under Alpine's `gcompat`; see `tests-docker/Dockerfile.helper` for the full
rationale and the layer-cache caveat), deterministic agent command
stubs, and the byte-moving port-forward test responder. The entrypoint creates
`~/git` and `~/tmp`, then seeds the `main` and `build` sessions under both
tmux and aplexer; with `a` installed the app lists the aplexer pair, since
`PocketshellClient` reads the snapshot alone on such a host. No provider
credentials or network access are needed by the stubs.

### Tmux scrolling

The standalone instance applies `tests-docker/tmux.conf` whenever it starts:
mouse mode is enabled, so the wheel scrolls the tmux pane history, and
`history-limit` is set to 100,000 lines. The overlay is applied after any
existing `~/.tmux.conf` without replacing that file, so local customisations
remain in the home volume. Recreate or restart the instance after changing the
checked-in config.

### Optional real Codex and Claude

The default image keeps `codex` and `claude` as deterministic stubs so
normal tests never make provider requests. Real CLIs are opt-in for the
standalone instance: start with `POCKETSHELL_REAL_AGENTS=true`. They
install at first boot into the named `pocketshell-test-instance-agents`
volume (mounted at `/home/testuser/.agent-tools`) — not the image layer,
so container recreation or image rebuilds keep them.
`POCKETSHELL_CODEX_VERSION` and `POCKETSHELL_CLAUDE_CODE_VERSION` pin the
install (`latest` by default; a normal `start` installs a missing or
changed pin; `update-agents` force-refreshes both, including a newer
`latest`). Authentication is deliberately a runtime action, never a Docker
build input: `ssh -t pocketshell-local codex` (or `claude`) and complete
each CLI's own sign-in flow. The `pocketshell-test-instance-home` volume
keeps the resulting `~/.codex`, `~/.claude`, and npm's cache across
`stop`/`start`; `reset` removes both volumes. Real CLIs need internet
access and the relevant OpenAI/Anthropic account; the normal test fleet
continues to use its credential-free stubs.

### Stop, reset, and inspect

```bash
bash scripts/test-instance.sh stop    # stop; preserve the remote home
bash scripts/test-instance.sh shell   # open /bin/sh as testuser
bash scripts/test-instance.sh logs    # follow sshd/fixture logs
bash scripts/test-instance.sh reset   # delete state volumes and start clean
```

The named volumes `pocketshell-test-instance-home` and
`pocketshell-test-instance-agents` preserve files, accounts, helper state and
the opt-in agent installs across `stop`/`start`; the entrypoint recreates the
seed tmux sessions after a container restart. `reset` is deliberately
destructive — it removes both named volumes before creating a clean instance.
Use reset after changing the image or when a test needs a pristine remote
filesystem. The raw Compose equivalent:

```bash
docker compose --project-name pocketshell-local \
  --file tests-docker/docker-compose.instance.yml \
  up -d --build --wait instance
```

### Add the SSH alias

Add this block to `~/.ssh/config` (create the file if necessary):

```sshconfig
Host pocketshell-local
  HostName 127.0.0.1
  Port 3222
  User testuser
  IdentityFile C:/Users/<your-user>/git/pocketshell-electron/tests-docker/test_key
  IdentitiesOnly yes
```

Use a forward-slash absolute path on Windows. Git Bash/WSL can instead use
`/c/Users/<your-user>/git/pocketshell-electron/tests-docker/test_key`. The
committed `test_key` is a local fixture only — see §3 before using it.

Verify the alias before opening the app:

```bash
ssh pocketshell-local 'whoami; command -v pocketshell; command -v tmuxctl; command -v a; tmux list-sessions; a snapshot --json'
sftp pocketshell-local
```

Both commands should authenticate as `testuser`; the first should show the
`main` and `build` sessions in both the tmux list and the aplexer snapshot.
For a one-off command without editing SSH config,
use `-i tests-docker/test_key -p 3222 testuser@127.0.0.1`.

On Windows, if OpenSSH reports that the private key is too accessible, tighten
the fixture file's ACL from PowerShell:

```powershell
$key = (Resolve-Path .\tests-docker\test_key).Path
icacls $key /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

With the app built (`npm run build`) or running in dev mode (`npm run dev`),
select `pocketshell-local` in the host picker. Configure root folders there
when testing instance-specific settings; the alias is a separate host identity
from any Hetzner or AWS entry. The app reaches the same SSH/SFTP/tmux/helper
surface as a remote machine. If you edit `~/.ssh/config` while PocketShell is
open, click **Reload hosts** in the host picker's header to see the changed
aliases without restarting the app.

---

## 3. Docker fixtures (`tests-docker/`)

Mirror of the Android project's `tests/docker/`, adapted for the desktop
test runner.

### Images

- **`Dockerfile.ssh`** — Alpine + openssh-server/client, `ssh-keygen -A`,
  non-root `testuser` (password-locked, pubkey-only), sshd on 22
  foreground (`-D -e`), committed ed25519 `test_key` → `authorized_keys`,
  `sshd_config` with `AllowTcpForwarding yes`. Byte-for-byte port of the
  original base.
- **`Dockerfile.tmux`** — `FROM pocketshell-test:ssh` + `apk add tmux`.
- **`Dockerfile.helper`** — Alpine + tmux + git + python3 + uv, then
  `uv tool install pocketshell` (the **real** helper, so the test exercises
  the actual `pocketshell sessions list` / `usage` code
  paths). Plus `/bin/sh` stub binaries for `claude`/`codex`/`opencode`/
  `quse` (deterministic, no API keys).
- **`Dockerfile.flaky`** — `FROM pocketshell-test:ssh` + a chaos
  entrypoint (`flaky-entrypoint.sh`): every
  `PS_FLAKY_INTERVAL_SEC` (default 45) it kills the PER-CONNECTION sshd
  handlers — the processes OpenSSH re-titles `sshd: testuser@pts/0` — and
  only those. The listener survives, so a connected client sees a real
  transport drop while the next dial still succeeds. Consumed by
  `Reconnect.integration.test.ts` (interval tuned to 5s per run).

### Compose (`docker-compose.yml`)

| Service | Image | Host port → container | Purpose |
|---|---|---|---|
| `ssh` | `pocketshell-test:ssh` | `3202:22` | base SSH integration |
| `tmux` | `pocketshell-test:tmux` | `3204:22` | tmux attach integration + Phase 1 E2E |
| `helper` | `pocketshell-test:helper` | `3205:22` | **primary E2E target** — real helper + stub agents |
| `flaky` | `pocketshell-test:flaky` | `3206:22` | reconnect tests |

Shared healthcheck: in-container
`ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/test_key testuser@localhost true`
(interval 2s, retries 10, start_period 5s).

### Fixtures (`tests-docker/fixtures/`)

The checked-in fixture files are small, credential-free inputs for the helper
stubs: `pocketshell-sessions-list.txt` and
`pocketshell-usage.ndjson`. The real helper is still installed and exercised;
the fixture files only make the provider stub deterministic.

### The fixture key (`tests-docker/test_key`)

Committed ed25519 keypair, used **only** by Docker tests — never point it at
AWS, Hetzner, or any other real host. The public half is installed as
`authorized_keys` in every image; the private half is loaded by the
integration tests via `SshKey.Path` and by the `pocketshell-local` alias
above. The standalone instance also uses it as its SSH **host identity**, so
rebuilding or recreating the container does not change the `known_hosts`
entry. The repository normalizes the key to LF line endings; if you copy it
outside Git, keep it an OpenSSH private-key file and do not let an editor
convert it to a different format. Removing the host entry of an instance
built before this stable key existed:

```bash
ssh-keygen -R '[127.0.0.1]:3222'
```

---

## 4. Determinism rules

- Only Docker targets; never real hosts or real keys.
- Agent CLIs are stubs with canned output — no real provider credentials,
  no network calls (matches the Android `agents` fixture philosophy).
- Fixtures are byte-identical to real helper output so parser tests pin to
  the actual contract.
- E2E seeds a disposable host entry in the app's settings (not the user's
  real `~/.ssh/config`) and cleans it up after.

---

## 5. Commands

```bash
# Unit (no Docker)
npm run test:unit

# Integration (needs Docker)
npm run test:integration

# E2E (needs Docker; builds the app once)
npm run test:e2e

# Full Docker-backed smoke gate (also `npm run smoke`)
bash scripts/smoke.sh

# Build the ephemeral fleet in dependency order, then bring up the E2E target
bash scripts/build-docker.sh
docker compose --project-name pocketshell-tests \
  -f tests-docker/docker-compose.yml up -d --wait helper
docker compose --project-name pocketshell-tests \
  -f tests-docker/docker-compose.yml down --volumes --remove-orphans

# Unit tier with a coverage report (text to stdout, HTML under coverage/)
npm run test:coverage
```

### Coverage

`npm run test:coverage` runs the unit tier under the v8 provider with all
three source trees included (`src/main`, `src/preload`, `src/renderer`,
`src/shared`) — a report that only watched `src/main` would silently claim
the renderer was covered when it was merely unmeasured. Baseline
(2026-09-03): **86.6% statements overall**; renderer/shared sit at 90–100%,
and the honest gaps are deliberate:

- `main/index.ts` (0%) — the Electron bootstrap: window creation, the
  single-instance lock, protocol registration. It is what the E2E tier
  launches, so unit-mocking Electron to raise the number would test the
  mocks.
- `SshService`/`SftpService` connection paths — exercised by the Docker
  integration tier against a real sshd; mocked-channel unit tests there
  would pin nothing the fixtures don't already.
- The **preload bridge** (`preloadBridge.test.ts`) and the **IPC
  registrars** (`ipcRegistrars.test.ts`) are the deliberately-tested
  boundaries: the walker asserts every bridge method against the channel
  `shared/channels.ts` declares, and the registrar tests invoke handlers
  through a mocked `ipcMain` to pin their policies (the session fence, the
  128 MiB read ceiling, the update URL allow-list). These two suites are the
  reason a drifted channel name or a weakened clamp now fails in CI instead
  of at runtime.

---

## 6. CI

`.github/workflows/publish.yml` runs on pushes to `main`, `v*` tags, PRs
against `main`, and manual dispatch. Three jobs:

1. **build** — a windows/macos/ubuntu matrix: `npm ci`, typecheck, lint,
   `test:unit`, then `npm run dist` (`--publish never`); installers upload
   as workflow artifacts.
2. **smoke** — the Docker-backed gate: chmods `tests-docker/test_key`
   (Linux ssh refuses a world-readable private key), installs Electron's
   system libraries, then `xvfb-run scripts/smoke.sh`, retried once after a
   teardown + log dump. On failure it uploads Playwright traces and dumps
   Docker state.
3. **release** — tag-only (`v*`), gated on build + smoke: downloads the
   artifacts and creates a **DRAFT** GitHub release with the installers.
   CI deliberately does not publish; notes are finalized by hand, so a bad
   tag is fixable before anything is public.

Plain `main` pushes and PRs run build + smoke and stop there, so the
pipeline is exercised continuously and a release tag never triggers it for
the first time.
