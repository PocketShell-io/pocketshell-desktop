# Host monitor — decision record

**The decision this document implements.** The host monitor is `htop`,
running in a terminal pane of our own, in a hidden root of its own — not a
panel that samples the host ourselves — and Provider usage has moved into
the same workspace as its second tool, a mounted view instead of an overlay.
Every trigger (the session panel's header strip, the collapsed rail, the
palette verb) OPENS its tool and navigates to the maintenance workspace;
htop answers "what is this host doing, and which pid is doing it" with
instantaneous per-process rates, sorting, filtering and a kill menu, all of
which the renderer would otherwise have to re-own.

The decision replaced a self-sampled panel (a 2s `ps -eo` + `/proc` snapshot,
client-side tick deltas, our own meters and process table). Two of its
findings are the durable reasons: `ps`'s %CPU is a lifetime average that
reports garbage for its own just-forked process — the monitor's own snapshot
command topped its own table at an impossible 700% — and a full process-table
scan every two seconds is real host cost on a busy box, spent re-deriving
what htop already renders. Don't rebuild a system monitor in the renderer;
if a cheap fixed glance (load, memory) is ever wanted again, it is a one-read
figure, not a process table.

## 1. The maintenance root, its tools, and the doors to it

The workspace lives at the stable pseudo-key `::maintenance::`
(`MAINTENANCE_ROOT` in core `sessionRoots.ts`, sibling of `::other::`). It
names no directory — `rootHostPath` refuses it, so no `+` can offer a session
under it — and it is not a root in the session tree's grouping: the tree's
root rows are headers over real directories, and this one has none. Instead
the panel renders a **Maintenance** section below the roots
(`SessionTreeRowsView`) while the host has open tools, the app's own chrome
rather than the host's data: it survives the session filter, takes no sort
and no drag, and holds one row per tool like the tabs they are.

The rows behave like the workspace tabs they mirror. A row's click emits the
same `select` the folder rows do — navigation, re-click focus and the
current-row tint are the folder rows' own machinery — with the tool's
identity as the tab hand-off; the row's `×` closes that tool, and closing
the last one retires the section, which is the user saying "I don't have
it". The Host monitor button (header strip, rail, palette — still the
`activity` glyph and the "Host monitor" name) is the door in: it OPENS the
tool, then navigates. Both surfaces dispose through one list
(`maintenance.ts`'s per-host `openTools`), so the tab's × and the row's ×
are the same close.

## 3. Tool tab, bare pane, and what outlives what

The workspace's bar holds one `tool`-kind tab per open tool (core
`shared/workspaceTabs.ts`): client-minted rather than host-listed, so no
`created` order, no rename, no Stop-confirm — and the `+` is hidden, since
neither of its items makes sense under a root that names no directory. The
tab's `×` reads **Close**, never Stop: the kill word stays reserved for the
user's sessions, and a tool pane is a viewer process this app spawned. The
pane behind it is a **bare** `TerminalView` (`bare` prop, identity rules in
`@ui/app/paneIdentity.ts`): `sessionKey` is only its shells-registry
identity, never a session to join, and `shell:open`'s typed mode writes the
tool's command into a fresh login shell — sshd starts it in `$HOME`, so
nothing is typed on the user's behalf about where they are. The command is
plain `htop`: a missing htop prints `command not found`, which is the honest
answer, and quitting htop leaves a live prompt in `~`, so the tab doubles as
a maintenance shell.

What outlives what, deliberately. **The tool** is the persistent thing —
open until its `×` closes it, on either surface; the list is session-only
and a restart forgets it. **The pane** lives while its host's folder
workspace stays mounted: across folder navigation on the same host it rides
along mounted-but-hidden (a visited session tab's treatment, minus the
session), so coming back is the same htop; a host-level navigation, a host
switch, or closing the tool unmounts it and closes the PTY, and the next
entry starts a fresh one. Identities are host-scoped (`tool:<host>:<kind>`)
because vue-router reuses the workspace across hosts — a bare `tool:htop`
would let one host's pane answer for another's.

No new IPC verb — the same rule the sampled monitor kept: `shell:open` and
the per-shellId input/resize/close seam are the generic tracked-PTY plumbing
every pane shares.

## 4. The root is never the relaunch destination

`persist` skips `writeLastFolder` for `::maintenance::`, so a relaunch never
opens a PTY and launches a process on its own. The workspace memory record
still persists; it is simply inert while nothing links to the key.
