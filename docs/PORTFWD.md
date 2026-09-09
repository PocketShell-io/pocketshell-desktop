# Port forwarding — decision record

The Python tool **`ssh-auto-forward`** (v0.0.4) is fully reimplemented in
`src/main/portfwd/`; references to `forwarder.py` / `dashboard.py` are
provenance — nothing remains to be ported from it.

**The decision this document implements.** The Python tool is not embedded,
shelled out to, or shipped. It opens its own paramiko connection per host;
PocketShell holds exactly **one authenticated `ssh2` connection per host**,
and that property is load-bearing (one auth, one keepalive, one TOFU prompt,
one reconnect FSM). So the *behaviour* was ported onto the existing
connection; the Python process is never involved. Lineage: the Android engine
was `-L`-only; desktop added `-R` and `-D` net-new, and auto-forwarding stays
`-L`-only everywhere.

---

## 1. Port discovery

One exec, one round trip: the scan command emits `ss -tln`, `ss -tlnp`,
`netstat -tlnp`, `netstat -tln` behind sentinels, and the authoritative port
list comes from **`ss -tln`** — non-root `ss -tlnp` *drops* rows whose process
it cannot read instead of blanking the name column, so process names merge in
afterwards, by port number, from the `-tlnp` outputs. Interval 5s, single
flight — an overlapping scan is dropped, not queued.

## 2. Filtering

- **`skipPortsBelow: 1024`, not Python's 1000** — 1024 is the real
  privileged-port boundary. Only 1000–1023 are affected. Do not "fix" it to
  1000.
- `maxAutoPort: 10_000` inclusive; `skipPorts` unions with the range, never
  replaces it.
- **Failed ports expire after 60s.** The Python's never expire, so one
  transient bind failure blacklists a port for the process lifetime.
- Ports above the max are surfaced, not forwarded: a `force-on` intent
  forwards them. Order matters: ssh-config ownership and a live recent
  failure both beat an explicit `force-on`.

## 3. Attribution, and one security rule

`RemotePort` carries process, pid, cwd (`/proc/<pid>/cwd` probe, one exec for
all PIDs). The probe only succeeds for your own processes or as root, so on a
shared box most ports degrade to `-` in the UI. **PIDs are remote-sourced and
interpolated into a shell command: filter to positive integers at the call
site; `procCwdCommand` asserts the same thing again.**

## 4. Local port allocation

Resolution order: user remap → mirror (the remote port, if bindable) →
preferred+1..+999 → linear sweep of `[3000, 65535]` → `null`, recorded as a
failed port and retried after the TTL, never thrown. The bind probe uses
`exclusive: false` (the `SO_REUSEADDR` equivalent): without it a port in
TIME_WAIT reads as busy and the allocator needlessly remaps to port+1 — see
the comment at the probe before "simplifying" it away.

## 6. Lifecycle: intents, and the two scan-loop rules

One tri-state intent per remote port drives everything: **absent** = follow
the auto policy, **`force-on`**, **`force-off`**. Intents persist per host,
so a user who silenced a noisy port expects it silent tomorrow.

- **The empty-scan guard.** A failed scan — and an empty one, which is
  indistinguishable and equally harmless — leaves every tunnel alone. Reading
  a failed scan as "nothing is listening any more" is what once tore down
  every live tunnel mid-transfer.
- **The teardown debounce.** A policy-forwarded port must be missing from two
  consecutive scans (~10s) before its tunnel drops — enough to ride out a
  `systemctl restart`. Manual and ssh-config forwards are never torn down
  here: the user asked for them explicitly.

## 7. SSH config `LocalForward`

The Python only *reports* config forwards because OpenSSH is a separate
process there. **PocketShell is the SSH client** — nothing else will
establish them — so the app **opens** the host's config forwards on connect,
tagged `origin: 'ssh-config'`, with their dest ports excluded from the auto
policy. A failed bind (the user really does have an `ssh -L` running) keeps
the row inactive and is **never retried**.

## 8. Reconnect

The supervisor that opened its own second connection is gone; the schedule
survives as the pure `shared/reconnectBackoff.ts` — 5 → 10 → 20 → 40 → 60s,
giving up after 10 attempts so a dead host does not spin forever. On a
transport drop `ForwardService` suspends the engine, keeping names, remaps,
intents and `autoEnabled`; the renderer restores auto-forward from the
persisted preference before exposing the new connection id. Survives:
names, remaps, intents, `autoEnabled`. Dropped: live forwarders, byte
counters, failed-port memory, the discovered-port cache.

One rule to keep: **the app entrypoint must not call `forwards.evict()`** in
its generic close handler. That method is an explicit teardown and clears the
persisted preference; a second call there turns a temporary transport loss
into a user-requested stop, so forwarding appears to resume only after the
Ports panel is reopened.

## 9. Persistence

`PortfwdStore` over electron-store, per host keyed by the SSH config alias
(else `user@host:port`): names, remaps, force-on/force-off, `autoEnabled`.
Rules that matter: corrupt data is empty, never thrown; an empty name
deletes its entry; and **read-modify-write the whole document on save** so
two windows on different hosts cannot clobber each other. Never cache the
document. Unlike the Python, all of it survives a restart.

## 10. Parsers are pinned to captured fixtures, never assumed formats

Every parser in `PortScanner.ts` is tested against real captured output in
`tests/unit/fixtures/portscan-*.txt`. The cautionary example is the Python's
`awk '{print $4, $7}'` on `ss -tlnp`: the process blob is column **6**, so
the `ss` path silently never produced process info at all — a bug its own
Docker fixture (root, both toolsets) could never catch. Do not write a parser
from a format you assumed.

## 11. Deliberately not ported

The TUI widgets (the app has a real UI; the *actions* ported), the Python's
SSH-config loader (breaks on a second matching `Host` block; `SshConfigParser`
handles Include, globs, IPv6), the terminal-title ANSI escape, and all
paramiko connection management — above all **`AutoAddPolicy`, which accepts
any host key. Never bring it in.**

## 12. Do not regress

Behaviours better than the Python, or net-new here:

1. **Scan order** — `ss -tln` authoritative, `-tlnp` enrichment (§1).
2. **`-R` and `-D`** — neither the Python nor Android has them. Nothing may
   drop them.
3. **Manual forwards survive a port disappearing** (§6).
4. **One connection** — `Forwarder` resolves its client from the registry per
   operation; no component may open a second SSH connection.
5. **The idle-connection reaper** (1h, 0 disables): a proxied connection
   silent in both directions is torn down, so an abandoned keep-alive socket
   cannot leak an SSH channel.
6. **Directional byte counters.** `bytesIn` is download (channel), `bytesOut`
   upload (local socket) — they were once swapped; the key string has one
   source, `forwardKey`, shared by main and renderer, and inbound `-R`
   channels are dispatched by one per-client dispatcher, not a listener per
   forward.

Current behaviour, not a bug: a bare `-R` inbound connection stays
byte-count-only — there is no local destination for it.

---

## 15. Bugs found while reading

In `ssh-auto-forward`, kept for provenance (each fixed here or deliberately
not ported): the `awk $7` wrong-column bug (§10), never-expiring
`failed_ports` (§2), dead `-p/--port-range` and `--include-configs` config,
a dashboard that ignores `--interval` and tears down manual tunnels, remaps
that die with the process, and a config parser that stops at the second
`Host` match.

In `pocketshell-electron`, two fixed defects are still cited by number from
tests, so their names are kept. **§15.6** — a `client.on('tcp')` handler was
registered per `-R` forward on the shared client, so every inbound channel
was handled N times; fixed by the per-client `RemoteChannelDispatcher`,
pinned by `tests/unit/Forwarder.test.ts`. **§15.7** — `bytesIn`/`bytesOut`
were swapped relative to the panel's In/Out headers; fixed, pinned by an
asymmetric-traffic test in
`tests/integration/ForwardService.integration.test.ts`.

---

## 16. Seeing that it is on from the outside

While the engine runs, the Ports button carries the state on its face: an
accent ring and glowing dot, growing into a **count pill** of LIVE forwards
(auto, manual, ssh-config alike) once any are up. The ring uses the same "on"
register as the panel's own toggle, so one state reads one way in both
places.

**Why the indicator does not read the store's `autoOn`:** that flag is only
fresh while the ports panel is mounted — the store `clear()`s on unmount — so
an indicator read off it would say OFF almost all the time, which is the
opposite of an indicator. The workspace asks the engine directly
(`isAutoEnabled`: "forwarder running, else the persisted flag") whenever the
connection or the overlay changes, and mirrors the store's live flips while
the overlay is open. The count needs no new verb: the engine already
broadcasts every state change, and the workspace takes one initial snapshot
per connection to cover the gap before the next scan beat. Tests:
`tests/unit/autoForwardIndicator.test.ts`, `tests/unit/SessionTree.test.ts`.

## 17. One-click open in the browser

A forwarded port is a URL; the LOCAL column opens it — where, is the whole
design, because a forwarded port is only a URL when a local tunnel exists:

- A live local forward gets the button, at the tunnel's **listen port** — not
  the remote port; they differ whenever a pin or allocation moved the local
  end, and a URL naming the remote port would reach whatever else sits there.
- A `-R` forward does not (its listener is on the host); a discovered-but-
  not-forwarded port does not (no tunnel; a button that opens an error page
  teaches the user it lies).
- A wide bind host (`0.0.0.0`, `::`) maps to `127.0.0.1` in the URL.
- The open is `window.open(url, '_blank', 'noopener,noreferrer')` — main's
  `setWindowOpenHandler` allow-lists http(s) into `shell.openExternal`, and
  that is the one destination every in-app link must take, not around it.

## 18. Arranging the panel: the face is the live table

A host with auto-forward on has a dozen passive listeners for every forward
actually opened, so **the live table leads** (forwarded rows first, each
group in port order) and the tail folds under one "N not forwarded"
disclosure row — folded rows keep their cells, so expanding costs no fetch
and no re-render. Scan sits in the overlay header's actions seat; the add
form hides behind a ghost expander that folds after a success and stays open
on a failure.

## 19. The actions column: one mark per verb

Engine-side `remove` is `stop` + `force-off` — exactly what toggle-off does —
so on every row the toggle can act on, the × was a second spelling of one
verb and is gone. The × survives only on `-R`/`-D` rows, where there is no
remote port for a toggle to key on and it is the only action; the `local`
badge went with the same reasoning (auto opens nothing but `-L`, so it
labelled every row).
