# Serve this folder — behaviour and the decisions behind it

Right-click a directory in the Files tab → **Serve this folder**. A static HTTP
server starts on the host, the existing port-forward machinery tunnels it, and
the local URL opens in the system browser. The served folder appears in the
**Ports** panel as an ordinary row, badged `served`, with a `stop` button.

Distinct from the **HTML preview**, which renders one remote file by pulling
its assets over SFTP: this runs the actual site, with working relative URLs,
`fetch` and routing, because a real origin is serving it.

The pure parts (command construction, port choice, URL, failure
classification) live in `src/main/portfwd/serveCommand.ts`; execution and
lifetime in `ServeService.ts`. Tests: `tests/unit/serveCommand.test.ts`,
`tests/unit/ServeService.test.ts`.

---

## 1. The bind address

**`127.0.0.1`, always, and it is not a setting.**

`python3 -m http.server` binds *all interfaces* when `--bind` is omitted, the
hosts this app talks to are internet-facing dev boxes, and the folders are
whatever the user right-clicked — source trees, `.env` siblings. Exposing the
bind address as an option means one mis-click publishes a home directory to
the internet — no auth, and nothing in the UI would look different. Loopback
makes that impossible at the socket: the only route in is the SSH connection
the app already holds, and the `-L` tunnel listens on `127.0.0.1` at this end
too.

A "share this on my LAN" feature, if it is ever wanted, must be a separate,
explicitly-named, explicitly-confirmed action — never a widening of
`SERVE_BIND_ADDRESS`. `tests/unit/serveCommand.test.ts` asserts `--bind
127.0.0.1` is present and that `0.0.0.0` never appears in a command.

---

## 2. Which server

```
python3 -u -m http.server <port> --bind 127.0.0.1 --directory <dir> [--protocol HTTP/1.1]
```

The stdlib server ships with the interpreter and works in any folder on any
host today; `--bind`, `--directory` and `--protocol` are probed, not assumed.
An ASGI app was once suggested for the job and rejected: a network-dependent
`uv` resolution in front of an action whose whole value is being instant, no
directory listings, and a traversal check in the weak `startswith` spelling.
`pocketshell serve` (§6) is the right long-term home; deferred, because it
would ship dead on every host that has not upgraded the helper.

---

## 3. The tunnel is the existing one

Nothing here opens a socket of its own. The auto-forward scan keys on the
port, so it sees the server like any other listener, and "forward this one"
is the same `force-on` intent the Ports panel uses — one kind of tunnel in
the app, one place where allocation, collisions and reconnect live.

Two consequences written down rather than hidden:

- **Serving a folder turns auto-forwarding on** — that is the app's existing
  contract for forcing a port (`ForwardService.setIntent` → `ensure`).
- **Port range `8081–8180`**: inside the auto-forward window, away from the
  ports dev servers squat on (3000, 5173, 8000, 8080). A lost bind race is
  retried on the next candidate, up to three attempts.

---

## 4. Lifetime — the part that matters on someone else's production box

The server is **not detached**. It runs on a PTY channel, `exec`ing the login
shell away so python is the session leader; closing the channel is a hangup,
and a hangup on a pty kills its session. So every way the app can go away
kills the server with it, with no bookkeeping that could be wrong:

| Event | Mechanism |
|---|---|
| user presses **stop** | `ServeService.stop` → `ssh.shellClose` |
| user disconnects | `SshService.close` → `ShellTracker.closeAllForConnection` |
| transport drops | sshd tears the channel down from its end |
| app quits | `before-quit` → `registry.clear()` → `client.end()` |

The alternative — `setsid` + a pidfile — survives all four, which sounds like
a feature and is not: the failure mode becomes an orphaned `http.server`
still publishing a directory on a live box, recoverable only through a
pidfile that is itself a thing that can be wrong. The honest cost: **a
dropped connection stops the server**, and the panel says so.

**Caveat, stated plainly:** the hangup-kills-the-server property is reasoned,
not observed — the four teardown paths were traced in the code, but no
end-to-end "quit the app, check the host" run has been done. The open manual
check is tracked in `docs/BACKLOG.md`.

**Stopping is three operations, in order:** kill the server; remove the
forward by key (manual forwards are never reaped by the scan, so this must be
explicit); clear the intent, so re-serving the folder is not blocked by the
last time it was stopped. For the same reason the panel disables the per-row
toggle and remove button on a served row — `stop` is the operation that ends
both halves.

---

## 5. Failures, and how each one is legible

Every failure produces a sentence in the Files tab's error banner, never a
silent no-op. The probe pre-flights — before any channel is opened — the
python binary and version, the directory (there, a directory, readable *and*
executable: one without the other starts fine and then 403s everything), and
port availability; a server that dies later fails its row and tears the
tunnel down. A lost bind race is recovered silently on the next candidate. A
tunnel that never opens tears everything down and names the port — **no
record with a null URL is ever returned**.

---

## 6. `pocketshell serve` — the follow-up

Adding the subcommand is mechanically trivial; the cost is the version pinning
and the per-host upgrade treadmill (this app does not sniff helper versions).
Filed as `alexeygrigorev/pocketshell#2333`. Retiring the stdlib path later
costs one function — `serveCommand()` — and the subcommand should earn its
keep by doing what the stdlib cannot: pick and report a free port atomically,
emit a machine-readable ready line, and hold the socket itself.
