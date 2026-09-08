# Port forwarding — decision record and current behaviour

The behaviour of the user's Python tool **`ssh-auto-forward`**
(`C:\Users\alexey\git\ssh-auto-forward`, v0.0.4, PyPI) has been **fully
reimplemented** in `src/main/portfwd/`, and the §16–§19 UI features are built
and tested. This document is no longer a port to-do list: it records the
decisions taken during the port and the behaviour the code has today.
`forwarder.py` / `dashboard.py` references are **provenance** — the Python
tool is not in this repo and nothing here remains to be ported from it.

## The decision this document implements

The Python tool is not embedded, shelled out to, or shipped. It opens its own
paramiko connection per host; PocketShell holds exactly **one authenticated
`ssh2` connection per host** and that property is load-bearing (one auth, one
keepalive, one TOFU prompt, one reconnect FSM). So the *behaviour* was ported
onto the existing connection; the Python process, its `uv` runtime, and its
stdout are never involved.

## Source map

| Role | File |
|---|---|
| Scan loop + policy | `src/main/portfwd/AutoForwarder.ts` |
| One forward rule (-L/-R/-D) | `src/main/portfwd/Forwarder.ts` |
| Remote scan orchestration + pure `ss`/`netstat` parsers | `src/main/portfwd/scanRemotePorts.ts`, `src/main/portfwd/PortScanner.ts` |
| Per-connection manager + IPC surface | `src/main/portfwd/ForwardService.ts` |
| Persistence | `src/main/portfwd/PortfwdStore.ts` |
| Reconnect schedule (shared with the renderer) | `src/shared/reconnectBackoff.ts` |
| UI | `src/renderer/views/PortPanelView.vue`, `src/renderer/stores/forwards.ts` |
| Rides on this engine: "Serve this folder" | `src/main/portfwd/ServeService.ts`, **`docs/SERVE.md`** |

**Serve** starts a static HTTP server on the host's loopback; the scan finds
the port like any other listener and a `force-on` intent opens the tunnel —
see `docs/SERVE.md`.

Lineage: the Android engine (`ssh-auto-forward-android`) was **local (`-L`)
forwards only**; desktop added `-R` and `-D` net-new. Auto-forwarding is
`-L`-only everywhere; `-R`/`-D` stay manual-only and share the key, state,
and persistence model below.

---

## 0. What still differs from the Python

Everything the inventory once listed as a Node gap is implemented. What
remains different is deliberate:

- Skip threshold **1024**, not Python's 1000 (§2).
- Scan order inverted: `ss -tln` authoritative, `-tlnp` only enriches (§1).
- Config `LocalForward`s are **opened**, not merely reported (§7).
- Failed-port memory **expires** (60s TTL); Python's never does (§2).
- Reconnect **gives up after 10 attempts**; the Python CLI retries forever
  (§8).
- Names, remaps, and intents **survive a restart**; only the Python's port
  names do, and its remaps do not even survive that (§9).

---

## 1. Port discovery

One `exec`, one round trip: `LISTENER_SCAN_COMMAND`
(`scanRemotePorts.ts:49-55`) emits `ss -tln`, `ss -tlnp`, `netstat -tlnp`,
`netstat -tln`, each behind a sentinel, and `PortScanner.ts` splits the
sections. The authoritative port list comes from **`ss -tln`**, because
non-root `ss -tlnp` *drops* rows whose process it cannot read instead of
blanking the name column; process names and PIDs are merged in afterwards by
port number from the `-tlnp` outputs (`mergeScanSections`,
`scanRemotePorts.ts:81-122`). Attribution costs at most one further exec —
the `/proc/<pid>/cwd` probe (§3).

Interval: **5s** (`AutoForwarder.ts:72`; the Python's `cli.py:42` default is
also 5). The loop is **single-flight** (`AutoForwarder.ts:125-126,
357-402`): an overlapping scan is dropped, not queued, as in the Python
dashboard (`dashboard.py:936-938`).

## 2. Filtering

Decision record — implemented as `AutoForwardConfig`
(`AutoForwarder.ts:43-79`), applied by `shouldForward`
(`:512-542`):

- **`skipPortsBelow: 1024` — a deliberate, documented divergence.** The
  Python skips 0–999 (`DEFAULT_SKIP_PORTS`, `forwarder.py:19`), an arbitrary
  round number; 1024 is the real privileged-port boundary and matches the
  Android engine. The only ports affected are 1000–1023. Do not "fix" it to
  1000.
- **`maxAutoPort: 10_000`, inclusive** — 10000 is auto-forwarded.
- **`skipPorts` unions** with the range; it never replaces it
  (`forwarder.py:95-99`).
- **Failed ports expire after `failedPortTtlMs: 60_000`.** The Python's
  `failed_ports` never expires, so one transient bind failure blacklists a
  port for the process lifetime (`forwarder.py:931-933` vs `:983`); Android
  used a 60s TTL.
- Ports **above** `maxAutoPort` are surfaced, not forwarded: they appear as
  discovered rows (`discovered()`, `AutoForwarder.ts:301-314`) and a
  `force-on` intent forwards them.

Order inside `shouldForward` matters: ssh-config ownership and a live recent
failure both beat an explicit `force-on`.

## 3. Process and folder attribution

The scan's most distinctive feature, now implemented: `RemotePort` carries
`process`, `pid`, `cwd` (`PortScanner.ts:24-32`). Process blobs parse through
`parseProcessInfo` (`PortScanner.ts:51`), a port of `forwarder.py:59-78` with
one correction — net-tools truncates `PID/Program name` to 20 chars
(`1/sshd: /usr/sbin/s`), so the name is cut at the first space or colon
rather than taken after the last `/`. The cwd probe is one exec over all
discovered PIDs (`procCwdCommand`, `scanRemotePorts.ts:60-76`). Two rules to
keep:

- `readlink /proc/<pid>/cwd` only succeeds for **your own processes or as
  root**, so on a shared box most ports have no cwd. The UI must degrade to
  `-`.
- **SECURITY:** PIDs are remote-sourced and interpolated into a shell
  command. Filter to positive integers at the call site; `procCwdCommand`
  asserts the same thing again. Never pass a raw token through.

---

## 4. Local port allocation

Resolution order (`AutoForwarder.ts:548-608`):

1. user remap — always wins (persisted per host, §9)
2. mirror — the remote port itself, if bindable
3. `preferred+1 .. preferred+999`
4. linear sweep of `localPortRange` `[3000, 65535]`
5. `null` — recorded as a failed port and retried after the TTL, never
   thrown

The bind probe uses `exclusive: false`, Node's `SO_REUSEADDR` equivalent:
without it a port left in TIME_WAIT by a just-closed forwarded connection
reads as busy and the allocator needlessly remaps to `port+1` — see the
comment at `AutoForwarder.ts:579-588` before "simplifying" the probe away.
The Python's `-p/--port-range` was dead config (`forwarder.py:533` vs
`:894`) and was not ported; the *concept* survives as `localPortRange`.

---

## 6. Lifecycle: start, stop, and flap protection

One tri-state intent per remote port drives everything
(`PortIntent` in `PortfwdStore.ts:22-23`,
`AutoForwarder.ts:109-110`): **absent** = follow the auto policy,
**`force-on`**, **`force-off`**. The intents persist per host (§9), so a
user who silenced a noisy port expects it silent tomorrow.

Two scan-loop rules (`AutoForwarder.ts:371-380, 457-486`):

- **The empty-scan guard.** `scanRemoteListeners` returns `ok: false` when
  the scan failed (`scanRemotePorts.ts:15-27`); a failed scan — and an empty
  one, which is indistinguishable and equally harmless — leaves every tunnel
  alone. Reading a failed scan as "nothing is listening any more" is what
  once tore down every live tunnel mid-transfer.
- **The teardown debounce.** A policy-forwarded port must be missing from
  `missingScansBeforeStop: 2` consecutive scans before its tunnel drops —
  ~10s at the 5s interval, enough to ride out a `systemctl restart` or a
  dev-server reload. **Manual and ssh-config forwards are never torn down
  here**: the user asked for them explicitly.

## 7. SSH config `LocalForward`

The deliberate divergence: the Python only *reports* config forwards because
OpenSSH is a separate process there. **PocketShell is the SSH client** —
nothing else will establish them — so the app **opens** the host's
`HostEntry.localForwards` on connect as ordinary `-L` forwards tagged
`origin: 'ssh-config'` (`startConfigForwards`,
`AutoForwarder.ts:317-342`). Their `destPort`s are excluded from the auto
policy: SSH itself owns that local port (`forwarder.py:916-922`).

If the bind fails (`EADDRINUSE` — the user really does have an `ssh -L`
running), the row is kept in the map with `active: false` and the failure is
recorded with `Number.POSITIVE_INFINITY` as its timestamp (`:336`) — **never
retried**. That lands on exactly the Python's read-only view, arrived at
honestly. `RemoteForward` entries are established the same way through the
`forwardIn` path. The Python's `--include-configs` flag was dead
(`cli.py:71-75`) and is not ported.

---

## 8. Reconnect

The supervisor that opened its own second connection is gone; the schedule
survives as the pure value object `src/shared/reconnectBackoff.ts` —
5 → 10 → 20 → 40 → 60s (capped), giving up after `MAX_ATTEMPTS = 10` so a
dead host does not spin forever. That keeps the Python CLI's curve
(`forwarder.py:1141`) and drops both the CLI's infinite retry and the TUI's
flat 5s hammering (`dashboard.py:1036-1038`). The countdown belongs in the
renderer, which ticks toward `retryAtEpochMs`.

`ForwardService` owns its `onCloseConnection` subscription
(`ForwardService.ts:41-52`). On a transport drop it suspends the engine,
keeping the host's names, remaps, intents, and `autoEnabled` preference;
before the renderer exposes a new connection id, `connection.ts` checks that
preference and calls `forwards.startAuto()` when it is still on
(`restoreAutoForward`, `stores/connection.ts:345-360`). This covers both
reconnects and the first connection after an app restart; the Ports panel
then only takes its initial reading. An explicit stop in the Ports panel is
what writes `autoEnabled: false`.

| Survives a reconnect | Dropped |
|---|---|
| friendly names, remaps, `force-on`/`force-off` intents, `autoEnabled` | live `Forwarder` objects, byte counters, failed-port memory, discovered-port cache |

The application entrypoint must not also call `forwards.evict()` from its
generic close handler. That method is an explicit teardown operation and
clears the persisted preference. A second call there would turn a temporary
transport loss into a user-requested stop, making forwarding appear to resume
only after the Ports panel is opened and enabled again. The entrypoint's
close handler evicts only the state it owns (sftp, projects, preview) —
`index.ts:33-41`.

---

## 9. Persistence

Implemented in `PortfwdStore.ts` over `electron-store`; schema
(`PortfwdStore.ts:26-44`):

```ts
interface PortfwdState {           // per host
  names:  Record<string, string>;  // "8080" -> "admin UI"
  remaps: Record<string, number>;  // "19840" -> 3000
  forceOn: number[];               // user-forced ports (e.g. above maxAutoPort)
  forceOff: number[];              // user-silenced ports
  autoEnabled: boolean;            // engine left running for this host
}
// PortfwdSchema = { hosts: Record<hostKey, PortfwdState>, version: 1 }
```

Rules ported from `_load_port_names` / `_save_port_names`
(`forwarder.py:30-56`, `:999-1006`):

- Corrupt or non-object data is treated as empty, never thrown.
- Non-numeric port keys and empty names are dropped on read.
- Setting an **empty name deletes** the entry; a host whose state becomes
  fully empty is removed from `hosts`.
- **Read-modify-write the whole document** on save, so two windows on
  different hosts cannot clobber each other. Never cache the document.

Hosts are keyed by `hostKeyFor` (`PortfwdStore.ts:100-120`): the
**SSH config host alias** when there is one (`ConnectionRecord.hostAlias`,
`ConnectionRegistry.ts:28` — two aliases pointing at the same box keep
separate name sets), else `user@host:port` for a manually-entered host. The
desktop is deliberately better than the Python here: its remaps were
documented "persistent" (`forwarder.py:1009`) but died with the process;
names, remaps, and intents all survive a restart here.

---

## 10. Parsers are pinned to captured fixtures, never assumed formats

Every parser in `PortScanner.ts` is tested against real captured output in
`tests/unit/fixtures/portscan-*.txt` (Alpine root + non-root, Debian
iproute2, BusyBox netstat, net-tools netstat, nginx) — see the header comment
at `PortScanner.ts:6-18`. The cautionary example is the Python's
`awk '{print $4, $7}'` on `ss -tlnp`: the process blob is column **6**, so
the `ss` path silently never produced process info at all — a bug its own
Docker fixture (root, both toolsets installed) could never catch. Do not port
the awk trick, and do not write a parser from a format you assumed.

---

## 11. Deliberately not ported

| Python behaviour | Why not |
|---|---|
| Textual TUI widgets, keymap (`dashboard.py:696-1180`) | The app has a real UI. The *actions* (name, remap, toggle, open URL) ported; the widgets did not. |
| `HostSelectorScreen` / host hiding for `LocalForward` hosts | PocketShell has a host picker with a real config parser. Hiding a host because it has a forward directive would be actively wrong. |
| `_find_ssh_config` / `_load_ssh_config` / `_host_matches` | `SshConfigParser.ts` is a better parser (Include, globs, multi-name `Host`, IPv6, `RemoteForward`); the Python's break-on-second-match loop mis-handles multiple matching blocks. |
| All paramiko connection management, incl. **`AutoAddPolicy`** | The app owns one authenticated connection with real known_hosts/TOFU. `AutoAddPolicy` accepts any host key — **never bring it in**. |
| `_update_terminal_title` ANSI escape | Would corrupt a packaged app's stdout. |
| `LogHandler` + `_log_buffer` | Logging plumbing for a TUI that hijacks stdout. |
| `--include-configs` | Dead in the Python — threaded through and never read. |
| `-p/--port-range` as specified | Dead in the Python (§4); only the sweep-range concept was ported. |
| `pipe.py` | Dead module; only its test imports it. |
| `SSHTunnel._pipe`'s thread choreography, `SO_LINGER`, half-close | Python solving a Python problem; `socket.pipe(channel)` gets it all from the stream layer. **But** the idle-timeout idea was kept — §12. |

---

## 12. Do not regress

Behaviours that are better than the Python and must stay that way:

1. **Scan order** — `ss -tln` authoritative, `-tlnp` enrichment (§1).
2. **`-R` and `-D`** — net-new here (`forwardIn` and SOCKS5); neither the
   Python nor Android has them. Nothing may drop them.
3. **Manual forwards survive a port disappearing** (§6).
4. **Streams instead of threads** — no per-connection thread pairs and error
   queues.
5. **`SshConfigParser`** (Include, globs, IPv6, `RemoteForward`).
6. **One connection** — `Forwarder` resolves its client from the registry
   per operation; no component may open a second SSH connection.

Things the Python had that Node initially dropped and now has:

- **The idle-connection reaper** (`SSH_FORWARD_IDLE_TIMEOUT`, 1h, 0
  disables): a proxied connection silent in **both** directions for the
  window is torn down (`Forwarder.ts:79`, `armIdleReaper` `:354-378`), so an
  abandoned keep-alive socket cannot leak an SSH channel.
- **Directional byte counters and rates.** `bytesIn` is download (channel),
  `bytesOut` is upload (local socket) — `Forwarder.ts:330-339`, fixed after
  being swapped; rates are delta/elapsed per snapshot (`:164-173`). The key
  string has one source, `forwardKey` (`:67-69`), shared by main and
  renderer; inbound `-R` channels are dispatched by one per-client
  dispatcher, not a listener per forward (`:274`, `:390-446`).

Current behaviour, not a bug: a **basic `-R` inbound connection stays
byte-count-only** (`onRemoteConnection`, `Forwarder.ts:285-296`) — the
channel is kept open and counted; there is no local destination for a
bare `-R`.

---

## 15. Bugs found while reading

In `ssh-auto-forward` — kept for provenance; all are recorded in code
comments and the §11 table:

1. `awk $7` reads the wrong `ss -tlnp` column; no process info from `ss` (§10).
2. `failed_ports` never expires (§2).
3. `-p/--port-range` dead config (§4).
4. `--include-configs` threaded and never read (§7, §11).
5. Dashboard ignores `--interval` (hardcoded 5s), and its reconnect has no
   backoff while the CLI retries forever (§8).
6. `scan_and_forward` tears down **manual** tunnels (§6 keeps manual alive).
7. Remaps documented "persistent", survive only a reconnect (§9).
8. Config parse stops at the second `Host` match; wildcard matching unanchored (§11).
9. `pipe.py` dead behind a 214-line test file (§11).
10. Byte totals drift under load (`+=` across two threads).

In `pocketshell-electron`: the nine defects this section once recorded are
**all fixed**. Two are still cited by number from tests, so their names are
kept. **§15.6** — a `client.on('tcp')` handler was registered per `-R`
forward on the shared client, so every inbound channel was handled N times;
fixed by the per-client `RemoteChannelDispatcher` (`Forwarder.ts:390-446`),
pinned by `tests/unit/Forwarder.test.ts`. **§15.7** — `bytesIn`/`bytesOut`
were swapped relative to the panel's In/Out headers; fixed at
`Forwarder.ts:330-339`, pinned by an asymmetric-traffic test in
`tests/integration/ForwardService.integration.test.ts`.

---

## 16. Seeing that it is on from the outside

While the engine runs for the connected host, the Ports button
(`arrow-right-left`) in the session header and the collapsed rail carries
the state on its face (`HostPanelButtons.vue`): an accent ring and a glowing
corner dot when the engine is running. Once ports are live the dot grows
into a **count pill** — solid accent with digit count, capped at "99+", and
the tooltip gains the state and the count ("Port forwarding — auto-forward
on, 2 ports"). The count is of **LIVE forwards** — auto, manual, and
ssh-config alike, what the panel's table renders — not of discovered ports,
most of which are deliberately not forwarded (§2). The ring uses the same
"on" register as the panel's own `Auto-forward: ON` toggle, so one state
reads one way in both places.

### Where the state lives, and why it is not the store's `autoOn`

The forwards store's `autoOn` is the flag the ports panel itself renders —
and it is only fresh while that panel is MOUNTED: `PortPanelView` subscribes
on entry and the store `clear()`s on unmount (`stores/forwards.ts`). An
indicator read off it would say OFF almost all of the time, which is the
opposite of an indicator. The connection store restores a persisted ON
setting before it exposes a newly connected id to the workspace
(`stores/connection.ts`), so the engine is live before the panel is opened.
The workspace owns the value it displays (`HostWorkspaceView.vue`):

- whenever the connection or the ports overlay changes, it asks the engine
  directly — `forwards.isAutoEnabled`, which answers "forwarder running, else
  the persisted per-host flag" (`ForwardService.ts:108`);
- while the overlay IS open, the store's live flips are mirrored straight
  through, so the toggle inside the panel reaches the header button without
  waiting for a reopen.

The count lives in the same place for the same reason, and needs no new verb:
the engine already BROADCASTS every state change (`ipc.forwards.states`,
`ipc.ts:99`), including an empty array on engine stop and on a dropped link —
the two transitions that must empty the badge. The workspace subscribes once
per connection, filters by connection id, and takes one initial snapshot
(`forwards.list`) to cover the gap before the engine's next scan beat. A push
with live forwards also raises the ring's flag: a manual add or a forced port
starts the engine outside the panel, and the button must not say "off" while
its badge counts forwards. A late answer for a replaced connection is dropped
— reconnect mints a new id, and the old flag is about a dead link.

Tests: `tests/unit/autoForwardIndicator.test.ts`, `tests/unit/SessionTree.test.ts`.

---

## 17. One-click open in the browser

A forwarded port is a URL; the LOCAL column opens it. Every row with a live
local tunnel has an `external-link` button beside the port number, opening
`http://127.0.0.1:<listenPort>/` in the system browser (`PortPanelView.vue`,
`localUrlOf`/`openLocal`). Where the button appears is the whole design,
because a forwarded port is only a URL when a local tunnel exists:

- **A live local forward gets it, at the tunnel's LISTEN port** — not the
  remote port. They differ whenever a pin or an allocation moved the local
  end, and a URL naming the remote port would reach whatever else sits there.
- **A `-R` forward does not.** Its listener is on the HOST; a browser here
  reaches nothing.
- **A discovered-but-not-forwarded port does not.** No tunnel; a button that
  opens an error page teaches the user it lies.
- **The served row keeps its single open** — it has been this feature for
  that one row since SERVE landed, and `stop` is the other half of that pair.

The URL host is the loopback unless the forward bound a specific interface on
purpose (`listenHost` verbatim); a wide host (`0.0.0.0`, `::`, empty) maps to
`127.0.0.1` rather than putting `0.0.0.0` in an address bar. The open itself
is `window.open(url, '_blank', 'noopener,noreferrer')` — not an IPC verb —
because main's `setWindowOpenHandler` already allow-lists http(s) into
`shell.openExternal` (`index.ts`); that, together with the preview-frame
navigation guard's hand-off to the same function, is the one destination
every in-app link must take, and new open affordances go through it, not
around it. Tests: `tests/unit/portPanelOpen.test.ts`.

---

## 18. Arranging the panel: the face is the live table

A host with auto-forward on has a dozen passive listeners for every forward
actually opened, so the arrangement follows the panel's point
(`PortPanelView.vue:29`):

- **The live table leads**: forwarded rows first, then the tail, each group
  in port order. The merge on remote port is unchanged; only display order
  moved.
- **The tail folds under a count**: one "N not forwarded" disclosure row at
  the foot; folded rows keep their cells behind a `v-show`, so expanding
  costs no fetch and no re-render of the live rows. Force-on for an
  out-of-range port is still one toggle away inside the fold.
- **Scan moved to the overlay header**, into the `#actions` seat beside the
  close control (`HostWorkspaceView.vue:574`) — the engine rescans on its own
  every few seconds, and a press still means one policy-APPLYING pass.
- **The add form hides behind "Add forward"**, a ghost expander that folds
  after a successful add and stays open on a failure, beside the error line.

Nothing was removed; every control is one click away. Tests:
`tests/unit/portPanelOpen.test.ts`, describe "arranged live-first".

## 19. The actions column: one mark per verb

Engine-side, `remove` is `stop` + a `force-off` intent (`AutoForwarder.ts:
223-233`) — exactly what toggle-off does — so on every row the toggle can
act on (anything with a remote port) the × was a second spelling of one verb
and is gone. The × **survives only on `-R`/`-D` rows**, whose listener is on
the host and which have no remote port for the toggle to key on: there it is
not redundant but the ONLY action. Served rows lost nothing — their × was
already disabled in favour of `stop`. The `local` badge is gone with the same
reasoning: auto opens nothing but `-L`, so it labelled every row; `-R`/`-D`
keep theirs, the one place the mark says something. Tests:
`tests/unit/portPanelOpen.test.ts` — no remove and no `local` badge on a
keyed row; remove and the `remote` badge on a `-R` row.
