# Host monitor — decision record

**The decision this document implements.** The host monitor is the
htop-style read of the connected box, opened as the THIRD host overlay —
beside Ports and Provider usage, from the session panel's header or the
collapsed rail (`activity` glyph, tooltip "Host monitor"). It draws CPU,
memory, load and a live process table for one purpose: answering "what is
this host doing, and which pid is doing it" without opening a terminal
and typing `top`. It is a viewer with one verb — kill a process — not a
general task manager.

---

## 1. The data path: one exec, no new IPC

Every sample is ONE `ssh.exec` of a fixed snapshot command over the
existing connection — the same seam `stores/workspaceRoots.ts` builds on.
There is **no monitor IPC verb** and no push channel: the renderer polls,
a closed panel costs the host nothing, and every client that can `exec`
(desktop, web) gets the monitor from the same shared app tree. The
command and its parsers live in `@ui/app/hostMonitor.ts`; the poll loop
in `@ui/app/useHostMonitor.ts`; the panel in `views/MonitorPanelView.vue`
and `components/MonitorProcessTable.vue`.

The snapshot emits marked sections in one stdout: `ps -eo
pid,ppid,user,stat,pcpu,pmem,vsz,rss,time,args` FIRST (under `LC_ALL=C` —
decimals must not arrive locale-comma'd), then `cat /proc/stat`,
`/proc/meminfo`, `/proc/loadavg`, `/proc/uptime`, each `2>/dev/null`. ps
leads because it is the only section a non-Linux host answers: on a macOS
box the /proc sections come back empty and the panel keeps the process
table and loses the meters, which the meters' absence states more
honestly than empty wells would.

The strip's three counts come from three sources and say so: **procs** is
the ps table's own length, **threads** and **running** are `/proc/loadavg`'s
scheduler-entity counts (the loadavg figure is threads, not processes —
htop shows it as `12157 thr`).

## 2. CPU percentages are client-side tick deltas

The parser returns raw `/proc/stat` ticks, never percentages. Busy CPU =
the non-idle share of the ticks elapsed between two samples, computed in
the panel from the previous sample. A remote `sleep 1` double-sample
would put its own latency under every poll; the delta needs no sleep and
decays at the poll's own cadence. Consequences, both deliberate:

- **The first sample shows unset bars** — one dash per core, never a
  fabricated `0%` — and by the second (two seconds) the panel is live.
- A counter that did not move (or moved backwards) answers null: unset,
  not zero.

Per-process CPU is `ps`'s lifetime `pcpu`, and the column tooltip says
so. Instantaneous per-process rates would cost a `/proc/<pid>/stat` exec
per pid per poll; that is not a trade this panel makes.

## 3. Poll loop

Two seconds, chained `setTimeout` scheduled from the previous answer: a
slow host stretches the cadence instead of stacking samples, and a tick
landing on an in-flight exec is dropped. Pause stops the execs entirely;
Resume samples immediately. A hidden window skips the exec but keeps the
timer, so coming back costs at most one poll. Reconnect mints a new
connection id and the panel re-samples from scratch — the old host's
tick history is another machine's. Unmount stops the poll
(`onScopeDispose`); there is deliberately no store behind it, because
the monitor has one consumer at a time and nothing to keep fresh while
closed.

## 4. Killing a process

A row carries TERM and KILL. Both are **two-press verbs**: the first
press arms (`TERM` → `sure?`), the second fires; touching anything else —
the other signal, the filter, a sort — disarms. It is the inline cousin
of the session Stop confirm: same refusal to destroy on a single click,
sized for a table where the victim is already the focused row. The kill
travels the same exec seam as a whitelisted signal name plus a
pid that `killCommand` has re-proven a positive integer, so nothing in
the process list can shape the command that runs.

## 5. The table, and its ceiling

The column set is htop's minus the fields nobody asked this table for
(PRI, NI, SHR): **pid, user, virt, res, S, cpu%, mem%, time+, command**.
The state letter is coloured — R green, D/T amber, Z red — and the cpu
figure carries the same tiers as the meters, so a hot row is findable in
a sweep. Headers and cells walk ONE column list in the component; the
first shipping table assembled them by hand and drifted a column off
itself (`mem` over the cpu figures), which is the drift the list exists
to prevent. Filter (pid / user / command substring), click-to-sort on
every column but state, CPU descending on landing — htop's own order.
Rendered rows cap at 300 with a footnote naming the remainder, so a
2000-pid host cannot DOM the panel to death; the filter is the way to
the tail. Rows are deliberately denser than a settings list — a monitor
is read in sweeps.

## 5.1 The meters

The cores sit in a compact auto-fill grid (htop's layout), not a column
of full-width bars. Every meter wears the pipe texture — one repeating
overlay in the track's own `--bg` slicing fill and track into ticks — so
a partial fill is countable at a glance. Mem and swap speak a used/total
pair in ONE unit, the total's (`32.6 / 62.7 GB`, `formatKibPair`).

## 6. Where the strip's ninth square came from

The monitor's header button is the ninth control in the session panel's
header strip, which pins the panel's drag floor: `9×28 + 8×4 + 12 =
296` — `MIN_PANEL_WIDTH` in HostWorkspaceView and `.tree`'s min-width
move together, and SessionTree's template keeps the arithmetic. The
quick-actions palette carries the matching "Host monitor" verb.
