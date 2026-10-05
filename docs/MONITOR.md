# Host monitor — decision record

**The decision this document implements.** The host monitor is `htop`,
running in a terminal pane of our own, in a hidden root of its own — not a
panel that samples the host ourselves. Every "Host monitor" trigger (the
session panel's header strip, the collapsed rail, the palette verb) navigates
to the maintenance workspace; htop answers "what is this host doing, and
which pid is doing it" with instantaneous per-process rates, sorting,
filtering and a kill menu, all of which the renderer would otherwise have to
re-own.

The decision replaced a self-sampled panel (a 2s `ps -eo` + `/proc` snapshot,
client-side tick deltas, our own meters and process table). Two of its
findings are the durable reasons: `ps`'s %CPU is a lifetime average that
reports garbage for its own just-forked process — the monitor's own snapshot
command topped its own table at an impossible 700% — and a full process-table
scan every two seconds is real host cost on a busy box, spent re-deriving
what htop already renders. Don't rebuild a system monitor in the renderer;
if a cheap fixed glance (load, memory) is ever wanted again, it is a one-read
figure, not a process table.

## 1. The maintenance root, and the two doors to it

The workspace lives at the stable pseudo-key `::maintenance::`
(`MAINTENANCE_ROOT` in core `sessionRoots.ts`, sibling of `::other::`). It
names no directory — `rootHostPath` refuses it, so no `+` can offer a session
under it — and it is not a root in the session tree's grouping: the tree's
root rows are headers over real directories, and this one has none. Instead
the panel renders a **Maintenance** section below the roots
(`SessionTreeRowsView`), the app's own chrome rather than the host's data:
it survives the session filter, takes no sort and no drag, and its one row —
`htop`, under the activity glyph — emits the same `select` the folder rows
do, so navigation, re-click focus and the current-row tint are the folder
rows' own machinery. A second tool workspace would slot in as a sibling row.

The section is the door BACK, and it earns its place by being used: it
appears for a host once its maintenance workspace has been opened this
session (`markMaintenanceOpened`, wired to the Host monitor button's
navigation; being on the route counts by itself), and a reload forgets it —
nothing renders before the first click, and nothing persists after. The
Host monitor button (header strip, rail, palette — still the `activity`
glyph and the "Host monitor" name) is the door in. Both land on the same
route, and while the workspace is open the row carries the current tint.

## 2. One tool pane, bare

The bar holds exactly one tab of the `tool` kind (core
`shared/workspaceTabs.ts`): client-minted rather than host-listed, so no
`created` order, no rename, no `×` — and the `+` is hidden, since neither of
its items makes sense under a root that names no directory. The pane behind
it is a **bare** `TerminalView` (`bare` prop, identity rules in
`@ui/app/paneIdentity.ts`): `sessionKey` is only its shells-registry identity
(`tool:htop`), never a session to join, and `shell:open`'s typed mode writes
`htop\n` into a fresh login shell — sshd starts it in `$HOME`, so nothing is
typed on the user's behalf about where they are. The command is plain `htop`
(`MAINTENANCE_COMMAND` in `@ui/app/maintenance.ts`, the feature's one home
for its constants): a missing htop prints `command not found`, which is the
honest answer, and quitting htop leaves a live prompt in `~`, so the tab
doubles as a maintenance shell.

No new IPC verb — the same rule the sampled monitor kept: `shell:open` and
the per-shellId input/resize/close seam are the generic tracked-PTY plumbing
every pane shares.

## 3. Ephemeral by construction

The pane is a PTY of ours, not a host session: nothing appears in any
host-side listing, and its lifetime is the workspace visit. Leaving the
workspace retires the pane record (`useWorkspaceTabs`' tab watcher prunes it
even when the host lists no sessions at all — the session-list guard that
protects a loading bar must not become a place for htop to hide), unmounting
the TerminalView closes the SSH shell, and htop dies with it. Nothing is
left polling the host behind the user's back.

The root is never the relaunch destination: `persist` skips
`writeLastFolder` for `::maintenance::`, so a relaunch never opens a PTY and
launches a process on its own. The workspace memory record still persists;
it is simply inert while nothing links to the key.
