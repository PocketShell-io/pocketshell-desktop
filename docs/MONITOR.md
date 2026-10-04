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

The tasks row's three counts come from three sources and say so: **procs** is
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

One deliberate exception to the cadence: the first sample that carries
`/proc` ticks cannot show percentages (nothing to diff against), so the
poll right after it lands at 700ms (`MONITOR_PRIME_MS`) instead of two
seconds — a freshly opened panel is live within about a second of its
first read instead of dead until the second full cadence — and the two
second rhythm resumes from there.

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
Headers and cells walk ONE column list in the component; the first
shipping table assembled them by hand and drifted a column off itself
(`mem` over the cpu figures), which is the drift the list exists to
prevent — and each caption carries the column's `align`, so a numeric
header sits on the same right-hand reading edge its figures do. Filter
(pid / user / command substring), click-to-sort on every column but
state, CPU descending on landing — htop's own order. While a filter is
active the count says what it filtered down from (`4 of 366
processes`). Rendered rows cap at 300 with a footnote naming the
remainder, so a 2000-pid host cannot DOM the panel to death; the filter
is the way to the tail. Rows are deliberately denser than a settings
list — a monitor is read in sweeps — and a row-hover band pairs with the
kill chips: the row under the cursor is the row the buttons act on. The
state letter is coloured — R green, D/T amber, Z red — and the cpu
figure carries the same tiers as the meters, so a hot row is findable in
a sweep.

The kill chips (TERM / KILL) are visible at rest at metadata emphasis —
muted text on a hairline border — because invisible controls are
undiscoverable, and this panel's ONE verb should not be a secret; row
hover brings them to full contrast. The two-press choreography below is
unchanged.

## 5.1 The meters

Two columns, htop's own shape. Left: the aggregate CPU bar and the
per-core grid (`auto-fill`, compact — a column of twelve full-width bars
spends the panel's height repeating one number twelve times). Right:
memory, swap, and the text meters — load (tiered against the CORE COUNT
it is measured against: amber at 0.7×, red at saturation), uptime, and
the three counts as one `tasks` row (procs · thr · running). There is no
caption strip and no full-width orphan bar; load is tiered against the
core count it is measured against.

Every meter is one text-height track with the figure INSIDE it, at the
track's right end on a surface chip — a core row is one fixation,
`0 [||| 86%]` — and every track wears the pipe texture (one repeating
overlay slicing fill and track into ticks) plus a hairline border, so
even the unset state reads as a meter, not a hole. Mem and swap speak a
used/total pair in ONE unit, the total's (`32.6 / 62.7 GB`,
`formatKibPair`), inside the bar like every other figure.

The panel body is a FIXED frame (`min(640px, 70vh)` — the settings
tabs' precedent, DESIGN.md 5.7c): the process table owns the panel's
only scrollbar, and scrolling it never scrolls the meters away. A
ps-only host (macOS) draws no bars at all — their absence states the
missing /proc more honestly than empty wells would — while the text
meters survive, because the procs figure is the ps table's own length
and stays real. When the host answers nothing the banner is the whole
body: a table skeleton under it would claim a read that never happened.

## 6. Where the strip's ninth square came from

The monitor's header button is the ninth control in the session panel's
header strip, which pins the panel's drag floor: `9×28 + 8×4 + 12 =
296` — `MIN_PANEL_WIDTH` in HostWorkspaceView and `.tree`'s min-width
move together, and SessionTree's template keeps the arithmetic. The
quick-actions palette carries the matching "Host monitor" verb.
