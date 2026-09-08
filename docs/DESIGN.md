# PocketShell Desktop — Visual Design Spec

Status: **implemented.** This document is the design spec and the decision
record for what shipped — the tokens and primitives in `App.vue`, the type
system in `fonts.ts`, the terminal options in `TerminalView.vue`, the theme
records in `themes.ts`, the host panel header strip — not a wishlist. It
describes the *restructured* navigation (session list as the default host
view; per-session Terminal/Conversation/Files tabs; Ports and Usage as icons
in the host panel's header strip). Where a later change overtook a section,
the section carries a **Revised** note rather than a rewrite.

Every decision here is grounded in one of four sources, cited inline:

| Source | What it grounds |
|---|---|
| Screenshots captured locally from the running app (§1 — local-only, `docs/screenshots/` is gitignored) | the "before" state |
| `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json` + Windows Terminal 1.24.11911.0 `defaults.json` | every terminal value in §3 |
| The Android app at `C:\Users\alexey\git\pocketshell` (v0.4.8) — `shared/ui-kit/.../theme/{Color,Type,Shape,Spacing}.kt`, `FolderListScreen.kt`, `mockups/tree/index.html` | the token values and component geometry in §4–§5 |
| WCAG 2.1 relative-luminance math, computed per pair | every contrast number stated |

---

## 1. Captured screenshots

Screenshots are **local-only reference, never committed** — `docs/screenshots/`
is gitignored. Recapture by driving the **built** app (`npm run build` →
`out/main/index.js`) with Playwright's `_electron.launch`, viewport 1280×800
(`BrowserWindow`'s default in `src/main/index.ts`); passes are diffable
against each other by prefix (`01`…`08`, `after-*`, `composer-*`,
`polish-01`…`16`). The driver runs against an isolated fake profile so the
user's real `~/.ssh/config` is never touched — and that fake profile directory
**must contain an `AppData\Roaming` subtree**, or Electron fails to resolve
`app.getPath('appData')`, `requestSingleInstanceLock()` returns false and the
app exits silently with code 3. Documented nowhere else.

**Known gap:** the Conversation tab was never photographed populated — the
fixture seeds `~/.claude/projects/` but the tmux session has no matching agent
log, so `Load` returns nothing. §5.6 is specified from the component's
existing CSS and the Android `conversation.html` mockup instead; treat it as
less grounded than the rest.

The before-screenshots are why §2, §4 and §5.1 exist: four different row
rhythms in one window; ~20 distinct font sizes from `grep font-size`, none
intentional; 30+ raw Catppuccin hexes hard-coded beside a six-token set with
no success/warning tokens; the accent colour re-typed as raw `rgba()` at four
alphas in six files; `.icon-btn`/`.muted`/`.error`/`.empty` copy-pasted across
5–10 files each with drifting padding; and the terminal on the same `#1e1e2e`
as its chrome, so the product's most important surface had no edge.

---

## 2. Typography

### 2.1 The problem with the current stack

The pre-spec stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
sans-serif`) was three dead entries around one real choice — on Windows every
entry before `'Segoe UI'` is unreachable — and it named the static face where
the system one is Segoe UI Variable. §2.2 replaced it.

### 2.2 Inter Variable

**Inter is the Android client's design font** (`mockups/tree/index.html:24`,
`docs/mockups/styles.css`), so adopting it makes the two clients one product.
It is bundled, not fetched (`@fontsource-variable/inter` 5.3.0, OFL-1.1 —
already a dependency; Vite fingerprints the woff2 into `out/renderer/assets/`,
which matters because the renderer loads over `file://` with no connectivity
guarantee). It is hinted for the 11–15px band the app lives in, and it has
real tabular figures: `font-variant-numeric: tabular-nums` stops the session
list, Usage meters and Ports table jittering between rows.

Fallback stack — the best native face on each OS, no dead entries:

```css
--font-ui: 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI',
           system-ui, sans-serif;
```

### 2.3 Monospace: Consolas by default, one setting for the whole app

The user's Windows Terminal is set to **Consolas** (§3), so the app's mono
chrome — session names, paths, ports, IDs — uses the same face, and the
terminal and the UI framing it read as one surface. Consolas ships with every
Windows install, so no bundling is needed:

```css
--font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;
```

This deliberately diverges from the Android app, which bundles JetBrains Mono:
matching the user's own terminal beats matching the phone.

**The face is a setting (`src/renderer/fonts.ts`); the stack above is only its
default.** Settings carries one `monospaceFontFamily` for the whole app, and
`App.vue` writes it onto `<html>` as `--font-mono`, so it moves the terminal,
the file editor and every mono chrome element together. That "together" is why
there is one family setting rather than one per surface: a per-surface family
would let the user undo, one dropdown at a time, the single-surface effect the
setting exists to create. Two mechanics matter:

- **The choice is PREPENDED to the stack above, never substituted for it.** A
  family the user does not have installed therefore falls through Consolas →
  `ui-monospace` → `monospace`. There is no path to a proportional face, which
  for a terminal is not degradation but breakage.
- **The stored value is a single family NAME, sanitised** — no quotes, no
  braces, no commas. Commas are stripped specifically so one setting cannot
  smuggle in a whole stack and get behind that fallback tail.

The picker is a curated list of common monospace families plus free text, and
not an enumeration of installed fonts: an Electron renderer has no reliable
way to obtain one. The Settings panel renders a sample line in the resolved
stack on `--term-bg` instead — if the sample does not change, the font is not
installed.

**Size is two settings, not one** (`terminalFontSize`, `editorFontSize`), both
clamped to 8–32px, and neither touches the UI scale in §2.4. The two surfaces
ship at different sizes, so a single knob would resize one of them on upgrade;
and the terminal's size is visible to the remote — it sets the PTY's
row/column count — while the editor's is not.

### 2.4 Type scale

Derived from the Android ladder in `shared/ui-kit/.../theme/Type.kt` (11 / 13 /
15 / 16 / 18 / 20 sp) mapped 1:1 to px, which is correct because Android `sp`
at the default font scale and CSS `px` in Electron are both 1/160-inch-class
device-independent units at 100% scaling.

| Token | Size | Weight | Line height | Used for |
|---|---|---|---|---|
| `--fs-100` | 11px | 600 | 1.45 | section headers (`SESSIONS`), chips, badges, timestamps, table headers |
| `--fs-200` | 12px | 400 | 1.45 | dense secondary text, hints, breadcrumbs |
| `--fs-300` | **13px** | 400 / 500 | **1.3846** | the workhorse — every list row, tab label, button, input |
| `--fs-400` | 15px | 600 | 1.3 | folder-group headers, session title, card titles, overlay titles |
| `--fs-500` | 18px | 600 | 1.25 | overlay/section headings ("Provider usage", "Port forwarding") |
| `--fs-600` | 20px | 700 | 1.2 | the `PocketShell` wordmark on the host picker only |

`--fs-300`'s 1.3846 is not arbitrary: it is Android's `bodyDense` 13sp/18sp
exactly, so a 13px row is 18px tall in both clients.

Weights come from Inter Variable's `wght` axis — 400 body, 500 for list-row
titles (enough to separate a session name from its timestamp without the
"bolded list" look), 600 for headers and the selected tab, 700 for the wordmark.
**Do not use 800/900**; the current `h1` at `1.5rem` with browser-default bold
is the heaviest thing in the app and it is a picker heading.

Two global rules ride alongside the scale:

```css
body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
```

`-webkit-font-smoothing: antialiased` is the CSS equivalent of Windows
Terminal's `"antialiasingMode": "grayscale"` (§3), so the UI and the terminal
are rasterised the same way.

---

## 3. Terminal — Consolas, from the user's Windows Terminal

### 3.1 What the settings file actually contains

`C:\Users\alexey\AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`:

- `profiles.defaults.font` = `{ "face": "Consolas", "size": 16 }`
- `defaultProfile` = `{2ece5bfe-…}` = the **Git Bash** profile, which repeats
  the same font block and adds `"bellStyle": "none"`
- `"schemes": []` and `"themes": []` — **both empty**
- top level: `"copyOnSelect": false`, `"copyFormatting": "none"`,
  and remapped keys: `ctrl+c` → `Terminal.CopyToClipboard`,
  `ctrl+v` → `Terminal.PasteFromClipboard`

> **The user's colour scheme is not in the file.** No profile sets
> `colorScheme` and `schemes` is empty, so the effective scheme is Windows
> Terminal's built-in default. The values below are read out of the installed
> product's `defaults.json` (Windows Terminal **1.24.11911.0**, at
> `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe\defaults.json`),
> where every shipped profile carries `"colorScheme": "Campbell"`. These are
> the real built-in values, not a reconstruction.

Other values inherited from that same built-in default block (also not in the
user's file, also read from `defaults.json`): `cursorShape: "bar"`,
`padding: "8, 8, 8, 8"`, `historySize: 9001`,
`antialiasingMode: "grayscale"`, `snapOnInput: true`,
`wordDelimiters: " /\\()\"'-.,:;<>~!@#$%^&*|+=[]{}~?│"`.

### 3.2 fontSize: 16 — a default, not a conversion

Windows Terminal's `font.size` is in points (16pt = 21.33px at 96 DPI); that
conversion was worked out and then **not taken** — the user chose to read the
number literally as pixels, so `TERMINAL_OPTIONS.fontSize` is **16** and
`--term-font-size` mirrors it. That 16 is now only the *default* of
`terminalFontSize` (§2.3) and must stay exactly 16: changing it would resize
the terminal of every existing user on upgrade, silently, which is the one
thing a default is there to prevent. Anyone who wants 21 sets it in two
clicks, and nobody gets it by surprise.

xterm does **not** read the cascade — it rasterises to a canvas from its
options object — so `--term-font-size` cannot drive it. `TerminalView.vue`
assigns `term.options.fontFamily/fontSize` from the settings store and calls
`fitAddon.fit()`, because a changed cell size changes the row and column count
and an unfitted terminal reports stale geometry to the remote. The token
remains what terminal-adjacent chrome sizes from. `lineHeight` stays at
**1.0**: the user sets no `font.cellHeight`, so Windows Terminal uses
Consolas' natural cell.

### 3.3 Contrast: `minimumContrastRatio: 3`

Campbell's dim **blue** (`#0037DA`, **2.38:1**) and **magenta** (`#881798`,
**2.44:1**) are genuinely unreadable on its own background `#0C0C0C` — a known
property of the scheme, not a transcription error. (The other fourteen
colours all clear 3.2:1; foreground/white is 12.18:1.) Rather than editing the
user's palette, xterm's **`minimumContrastRatio: 3`** lifts only the failing
pairs at render time and leaves the other colours pixel-identical to Windows
Terminal. Set it to `1` to disable if byte-exact parity is preferred over
legibility.

### 3.4 The options object (`TERMINAL_OPTIONS`)

`TerminalView.vue`'s `TERMINAL_OPTIONS` carries everything that is *not*
themed and *not* user-settable; every option name was verified against
`node_modules/@xterm/xterm/typings/xterm.d.ts` (6.0.0):

- `fontFamily` — the mono stack of §2.3; overridden at construction by
  `resolveMonoStack(settings.monospaceFontFamily)`.
- `fontSize: 16`, `lineHeight: 1.0`, `letterSpacing: 0`, weights 400/700 —
  fontSize overridden by `settings.terminalFontSize` (§3.2).
- `cursorStyle: 'bar'`, `cursorBlink: true`, `cursorInactiveStyle: 'outline'`
  — defaults.json `cursorShape "bar"`; Windows Terminal blinks by default.
- `scrollback: 9001`, `scrollOnUserInput: true` — defaults.json.
- `wordSeparator` — the user's `wordDelimiters` string verbatim, so
  double-click word selection splits paths and punctuation exactly as it does
  in Windows Terminal.
- `drawBoldTextInBrightColors: true`; `minimumContrastRatio: 3` (§3.3).
- **No `theme`.** The palette belongs to the applied theme record:
  `resolveTheme(settings.theme).terminal` is assigned at construction and
  re-assigned by the settings watcher (§8). The dark record carries Campbell
  verbatim, provenance intact (`src/renderer/themes.ts`).

The `.terminal` element itself: `padding: 8px` (defaults.json), background
`var(--term-bg)`, `-webkit-font-smoothing: antialiased` (defaults.json
`antialiasingMode: "grayscale"`).

**Not mappable:** `bellStyle: "none"` has no xterm 6 equivalent (`bellStyle`
was removed in xterm 5 and no bell is emitted), so the user's setting is
satisfied by doing nothing.

### 3.5 Character widths — Unicode 11, not xterm's default 6

xterm parses panes with Unicode 6 width tables unless told otherwise, and
Unicode 6 counts emoji as one column. The fonts that actually draw them
render two, so the next cell painted straight over the overflow: on any row
carrying a background — diff output, TUI panels — the right half of every
emoji vanished. The far end never disagreed; tmux and the agent TUIs lay out
with current Unicode tables and expect two columns.

Every pane therefore applies the Unicode 11 provider
(`@xterm/addon-unicode11`) at construction, before the first output byte is
parsed — buffer cells keep the width they were parsed with, so a switch
cannot land under already-streamed content. The mechanism and its rationale
live in `src/renderer/terminalUnicode.ts`; the regression test runs the real
headless emulator (`tests/unit/terminalUnicode.test.ts`).

---

## 4. Colour tokens

### 4.1 Recommendation: adopt the Android palette

The current tokens are Catppuccin Mocha (`#1e1e2e` / `#cdd6f4` / `#89b4fa`).
The Android app is on a GitHub-dark-derived palette
(`shared/ui-kit/src/main/java/com/pocketshell/uikit/theme/Color.kt`):
`#0D1117` / `#E6EDF3` / cyan `#22D3EE`. Two reasons to move:

1. **Product coherence.** These are two clients of one product. The phone's
   palette is the documented one (`docs/design-system.md`, 700 lines of token
   tables); the desktop's Catppuccin was a scaffold default.
2. **It resolves the terminal-edge problem for free.** Campbell's `#0C0C0C`
   against Catppuccin's `#1e1e2e` is a visible violet-vs-neutral clash. Against
   `#0D1117` the ratio is **1.03:1** — the terminal reads as a slightly deeper
   well in the same neutral family, exactly the relationship the Android app
   builds deliberately with `TermBg #010409` vs `Background #0D1117`.

### 4.2 Contrast (computed, WCAG 2.1)

Text tokens, against the three surface elevations:

| Token | Hex | on `--bg` | on `--surface` | on `--surface-2` |
|---|---|---:|---:|---:|
| `--fg` | `#E6EDF3` | 16.02 AAA | 14.64 AAA | 13.68 AAA |
| `--fg-secondary` | `#8B949E` | 6.15 AA | 5.62 AA | 5.26 AA |
| `--fg-muted` | `#6E7681` | 4.12 | 3.77 | 3.52 |
| `--accent` | `#22D3EE` | 10.47 AAA | 9.57 AAA | 8.95 AAA |
| `--success` | `#22C55E` | 8.31 AAA | 7.59 AAA | 7.10 AAA |
| `--warning` | `#F59E0B` | 8.81 AAA | 8.05 AAA | 7.53 AAA |
| `--error` | `#EF4444` | 5.03 AA | 4.60 AA | 4.30 |
| `--agent` | `#A78BFA` | 6.95 AA | 6.36 AA | 5.94 AA |
| `--on-accent` on `--accent` | `#04101A` | — | — | 10.62 AAA |

Two rules fall out of this table:

- **`--fg-muted` (4.12:1) is below AA for body text.** Restrict it to ≥15px
  text or to genuinely decorative content (the `··` separators, disabled
  glyphs). Everything currently using `--muted` for real information —
  session timestamps, `user@host` in the picker, folder counts — must move to
  `--fg-secondary` (6.15:1). The current app has the same defect and worse:
  Catppuccin `--muted #7f849c` on `#1e1e2e` is **4.44:1**, and it is used for
  every timestamp and subtitle in the product.
- **`--error` on `--surface-2` is 4.30:1**, marginally under AA. Error text
  inside inputs/menus should sit on `--surface` or `--bg`, not `--surface-2`.

Non-text pairs:

| Pair | Ratio | Note |
|---|---:|---|
| `--surface` on `--bg` | 1.09 | elevation step — intentionally subtle, carried by the border |
| `--surface-2` on `--surface` | 1.07 | ditto |
| `--border` `#2D333B` on `--bg` | 1.49 | decorative hairline only; exempt from 1.4.11 |
| `--border-strong` `#6E7681` on `--bg` | 4.12 | ✅ ≥3:1 — **required** for input/control boundaries |
| `--border-strong` on `--surface-2` | 3.52 | ✅ still ≥3:1 |

WCAG 1.4.11 requires 3:1 for boundaries that are the *only* way to identify a
control. `--border` at 1.49:1 cannot carry a text input; that is why
`--border-strong` exists and why control boundaries that must self-identify —
inputs, selects, the composer's at-rest toggle (COMPOSER.md) — are drawn with
it.

### 4.3 The token block — shipped in `App.vue`, one theme of several

The `:root` block in `src/renderer/App.vue` is the shipped token set; this
section no longer duplicates it. When themes became data (§8), every
colour-carrying token was copied into the `dark` record in
`src/renderer/themes.ts`, and the applied theme's record is written over
`:root` as inline custom properties on `<html>`. `App.vue`'s block stays
because it is the no-JS default, and `tests/unit/themes.test.ts` asserts the
two copies are identical, so neither can drift. What is not obvious from the
values alone:

- **Hover is a neutral lift** (`--state-hover`, ~5% white), not a tint:
  tinting every hover cyan makes hover read as selection.
- **`--fg-muted` is ≥15px/decorative only** (§4.2's rule — 4.12:1).
- **`--term-*` are Campbell**: `--term-bg #0C0C0C`, `--term-fg #CCCCCC`,
  `--term-padding 8px` (§3).
- **`--term-font-size: 16px`** — the §3.2 default; must not change silently.
- **Motion tokens**: `--dur-slow` and `--ease-out` exist for the overlay
  entrance, the one thing slow enough to want a decelerating curve; `--ease`
  stays the default for state changes (§5.9).

---

## 5. Layout & components

### 5.0 Global rules

Two body-level rules ship in `App.vue`: the type defaults
(`--font-ui`/`--fs-300`/`--lh-300` with `-webkit-font-smoothing: antialiased`)
and `tabular-nums` on every number column — timestamps, ports, percentages,
file sizes — so figures do not jitter between rows.

**The focus ring is the only focus treatment in a keyboard-driven app** —
without it nothing shows focus except the browser default that the custom
`background: transparent` buttons largely suppress. Every focusable element
gets `outline: var(--focus-ring-width) solid var(--focus-ring)` at
`--focus-ring-offset` — except rows inside `overflow-y: auto` lists
(`.session-row`, `.entry`, `.folder-header`), which take the **inset**
variant (`outline-offset: -2px`), because scrolling lists clip a +2px outward
ring.

### 5.1 Shared primitives

`.icon-btn`, `.muted`, `.error` and `.empty` exist once each, as global
classes in `App.vue`'s unscoped `<style>` (shipped there; the CSS is not
repeated here). Extract-then-restyle is the rule: restyling seven hand-copied
`.icon-btn`s is how the original drift happened.

- The bordered `.icon-btn` is split in two, both **ghost**: invisible at
  rest, filled on hover — the VS Code register. Nine bordered rectangles at
  rest in a 40px topbar were the single biggest "unpolished" signal in the
  before-screenshots. Icon-only buttons are **square by construction**
  (`--control-h` / `--control-h-sm`); the old primitive sized itself from
  padding plus the glyph's advance width, so two adjacent icon buttons were
  visibly different widths. `.btn-ghost` is the labelled counterpart; the
  loading state spins the icon in place rather than swapping content widths.
- A bordered look survives **only** where chrome is earned: filled accent
  actions (`Load`, `Add`, `Save`), the stateful `Auto-forward` toggle, the
  `Scan` button beside it in the same form bar, and form controls. Status
  chips keep their tinted borders — they are status, not controls.
- **Badge metric.** Every `--r-sm` badge-like — `.chip`, `.tag`,
  `.agent-badge`, `.kind`, `.status`, `.window-tag`, `.resume-chip`,
  `.block-toggle` — uses `padding: 0 var(--sp-1)`, `line-height:
  var(--lh-100)`, and `display: inline-flex; align-items: center; gap:
  var(--sp-1)`. The inline-flex is also what centres an icon against the
  label once a chip contains one.

### 5.2 Host picker (`01-host-picker.png`)

Before (§1): 720px column, 52px rows, `1.5rem` bold `h1`, a `.badge` reading
"select a host".

- Wordmark `PocketShell` → `--fs-600` / `--fw-bold`, colour `--fg`. Drop the
  "select a host" badge — the list is self-evident and the badge is the only
  bordered pill on the screen.
- Host rows → `--surface`, `1px solid var(--border-soft)`, `--r-lg`, height
  44px (this is the one place a taller, card-like row is right — it is a
  landing screen, not a dense list). Matches the Android `HostCard`'s 14dp/
  44dp geometry, scaled.
- Host name `--fs-400`/`--fw-semibold`; `user@host:port` `--font-mono`/
  `--fs-200`/`--fg-secondary` (currently `--muted` at 4.44:1 — a real
  legibility fix).
- Hover: `background: var(--state-hover); border-color: var(--border-strong)`.
  Replace `border-color: var(--accent)` — reserve accent for *selected*, never
  hover.
- Add a leading 8px status dot per host (idle `--fg-muted`, connecting
  `--warning` pulsing, connected `--success`) to mirror the Android
  `StatusDot`; the desktop currently shows connection state only as the text
  "connecting…".

### 5.3 Session list — the default host view (`02`, `08`)

> **Superseded by docs/SESSIONLIST.md (implemented).** The *leaf*-level tree
> this section once tabulated is gone: on a real host the folder/session
> distribution is 1:1, so every folder header cost a row to say nothing, and
> the session name is *derived from the folder path*, so the two lines were
> the same fact twice.
>
> The panel is not flat, though. One folder level survives, at the **root** —
> `$HOME`'s children (`git`, `tmp`, …) plus an `other` catch-all — because
> that is the level the 1:1 measurement does *not* apply to: on the real host
> all sessions live under one `git`. So the header earns its row there, and
> only there. SESSIONLIST.md §2–§3 owns the current row spec; the `SESSIONS`
> header row and the chip metric stand.

### 5.3c–e — Host panel header strip (implemented, after three revisions)

The host-level controls reached the panel header in three user-directed
rounds: into an overflow menu (5.3c), the gear out of the menu as its own
control and the strip reordered (5.3d), then the menu killed outright — Ports
and Usage as their own icons (5.3e). The reversal in 5.3e overruled 5.3c's
"two unlabelled overlay glyphs would be a memory test" at the user's say-so;
the words survived by moving onto the buttons. The durable decisions:

**Order, left to right — the user's sentence verbatim with its `⋯` expanded:**
`arrow-left` (leave this host's sessions), `plus` (new session in any folder),
`arrow-right-left` (Port forwarding), `bar-chart-2` (Provider usage),
`refresh`, `settings`, `panel-left` (hide the panel). Seven controls; there is
no eighth slot — the next addition displaces one (the way dropping the
`SESSIONS` word paid for the first extra control) or moves the panel floor.

**Words live in tooltips and accessible names, whole** ("Port forwarding",
"Provider usage") — exactly what the retired `⋯` trigger held for both at
once. `HOST_PANEL_ITEMS` (`src/renderer/hostPanels.ts`) carries a `label` AND
an `icon` per entry, and one component (`components/HostPanelButtons.vue`)
renders both the header strip and the collapsed rail, so the two surfaces
cannot drift.

**The glyphs:** `arrow-right-left` — forwarding is a symmetric MAPPING between
a local port and a remote port, so an opposing pair says it better than
`shuffle`'s crossing paths (which read as randomising); `bar-chart-2` —
Feather verbatim, the register every tool uses for a meter. `SESSIONS` went
because it was the cheapest thing in the row: a label for a panel whose
contents are self-evidently folders, on a window whose title already carries
host identity.

**Width: the 232px floor.** Seven 28px controls + six 4px gaps = 220, which
the old 200px floor could not hold, so `MIN_PANEL_WIDTH` in
`HostWorkspaceView.vue` and `.tree`'s `min-width` moved to 232 together, as
they have always had to move together. The folder-row label budget at the
floor improves with it (186px, up from 154).

**The collapsed rail mirrors the header, never less.** The rail exists
precisely so host controls are not stranded off-screen, so it must offer
nothing the expanded panel does not: ports, usage, settings. It gets **no
`+`**: the rail is an escape hatch, and creating a session is something you do
while looking at the list you are adding to, which is one click away on its
top button.

**Session creation reasoning lives in docs/SESSIONLIST.md §0a and §13–13a**
(the `+`s on rows, the `other` exclusion, the disabled-not-hidden failure
case, and the chained agent dialog's surviving objections). Settings stays
independently reachable from the host PICKER, where a user looks for a
startup-scoped setting.

### 5.3b Host workspace chrome — NO topbar (implemented)

The host topbar — back, collapse, `hetzner · alexey@135.181.114.209`,
Ports/Usage/Settings, disconnect — is **gone**. It was a full `--topbar-h` of
chrome above every terminal whose largest element was an identity label, in an
app whose whole point is the terminal; the same reasoning that merged the
session bar and tab strip (§5.4) applies one row up. Every control was
redistributed, none deleted:

| Was in the topbar | Lives now | Why there |
|---|---|---|
| Host label (`name · user@hostname`) | **the OS window title** | Built by the pure `src/shared/windowTitle.ts`, applied over `win:setTitle`; the renderer drives it because the title mirrors the *view*, not the connection (Back keeps the link alive while the picker shows). Also puts the host in the taskbar and Alt-Tab — the native title bar had been spending its row saying the static word "PocketShell". |
| Back arrow | leading slot of the session panel's `SESSIONS` header | An arrow beside `SESSIONS` reads as "leave this host's sessions". The header row was already paying `--topbar-h`. |
| Collapse toggle (`panel-left`) | trailing slot of the same header, beside Refresh | The hide control sits on the thing it hides. |
| Ports / Usage / Settings | the panel header strip — **§5.3c–e** | Direct triggers; words moved into tooltips and accessible names. |
| Disconnect | the **host picker**, on the connected host's row | Every disconnect already navigated to the picker; the button now lives at its destination, labeled, beside where the connection was opened. The connected row also gets the §5.2 `--success` dot, and clicking it re-enters the workspace **without re-dialling** (a second dial would orphan the live connection). |
| Missing-tools notice | unchanged — the workspace's top strip | Rendered only when a tool is absent, so the usual cost is zero rows. |

**Collapsed state is a rail, not nothing.** A zero-width collapse would take
the expand toggle — and with it every host control — off screen. Collapsing
leaves a ~36px rail (`--surface`, right hairline) holding the back arrow, the
expand toggle, and whatever the header holds (§5.3c–e), under the rail's rule
that it must not offer less than the expanded panel.

Alignment note: the `SESSIONS` header and the session bar across the splitter
are both `--topbar-h`, so the window's top row reads as one line broken only
by the panel seam.

### 5.4 Session workspace header — ONE row (`03`, `04`, `05`)

Android uses a filled `SegmentedToggle` (selected = accent fill, `--on-accent`
label). **Keep the underline** on desktop — a filled cyan segment at 13px is
heavy for a mouse UI, and the underline already reads correctly in
`03-terminal-attached.png`.

**Revised: the identity bar and the tab strip are one row.** They were two
full-height bars, `--topbar-h` + `--tabbar-h` = 72px of chrome above every
terminal, in an app whose whole point is the terminal. Merged, the row is one
`--topbar-h` — a full bar height, not a compromise between two — and the
terminal gains the 40px the tab strip used to take.

- `.session-bar` `height: var(--topbar-h)`, `align-items: stretch`, **no
  vertical padding**, `border-bottom: 1px solid var(--border)`
- **Tabs lead.** They are the only thing in the row that is clicked, and a
  leading identity label of unpredictable length would shift them horizontally
  on every session switch. A control that moves under the cursor per session is
  worse than a name that sits further right
- `.tab` full row height, `--fs-300`/`--fw-medium`/`--fg-secondary`, padding
  `0 var(--sp-3)`, `border-bottom: 2px solid transparent`, `margin-bottom: -1px`.
  Full height is what lets the active tab's 2px underline land **on the row's own
  bottom border**; centring shorter buttons in a taller bar would leave that
  underline floating mid-row with a gap beneath it
- `.tab:hover` → `color: var(--fg)`; `.tab.active` → `color: var(--fg)`,
  `--fw-semibold`, `border-bottom-color: var(--accent)`
- Session name trails, `flex: 1`, right-aligned, `--font-mono`/`--fs-300`/
  `--fg-secondary`, end-ellipsis; close button as `.icon-btn` at the far right
- **The path is not rendered.** A session is named after the directory it runs
  in, so name-plus-path is one fact written twice — the same redundancy
  `docs/SESSIONLIST.md` removed from the session panel. The full path is the
  name's `title` tooltip, where it costs no width

### 5.5 Overlays — Usage and Ports (`06`, `07`)

Both are header buttons opening `OverlayPanel.vue`. The pre-spec backdrop was
`rgba(0,0,0,0.5)`; the panel had no elevation cue beyond a border.

- `.overlay-backdrop` → `background: var(--scrim)`, `backdrop-filter: blur(2px)`
- `.overlay-panel` → `background: var(--surface)`, `border: 1px solid
  var(--border)`, `border-radius: var(--r-xl)`, `box-shadow: 0 16px 48px
  rgba(0,0,0,.5)`
- **Sizes to its content (revised).** The panel used a fixed
  `height: min(720px, 88vh)`, so a panel holding 180px of content rendered as
  a mostly-empty rectangle. It is now `max-height`, with the body scrolling
  past the cap. Width is a `size` prop: `lg` = 960px (the wide port-forward
  table), `md` = 720px (anything narrower — a panel wider than its content is
  just a void with a border around it), `sm` = 480px (short stacked
  label/control forms, where `md` would stretch every control to twice the
  width its content needs).
- **Panel-scoped controls live in the header**, via a named `actions` slot
  rendered beside the close button. A refresh control floating at the top-left
  of the body read as orphaned debris under the title.
- **Entrance.** `<Transition name="overlay" appear>`: the
  backdrop fades over `--dur-normal --ease-out` while the panel rises 8px and
  scales from `0.985` over `--dur-slow --ease-out`; leaving is a plain
  `--dur-fast` fade with no scale, because dismissal should feel faster than
  arrival. Overlays used to pop in fully formed in one frame.
- `.overlay-title` → `--fs-500`/`--fw-semibold`
- **The overlay owns the heading (implemented).** Hosting full views inside
  `OverlayPanel` used to render "Provider usage" twice. Hosted views now
  suppress their own title when embedded (`UsageView.vue`'s `embedded` prop —
  the overlay also takes over the refresh control via the `actions` slot);
  `PortPanelView.vue` ships no heading of its own.
- **Usage is a table, not cards (revised — supersedes the `.card` spec).**
  The job of this screen is *comparison* — "who is nearly out?" — and three
  side-by-side cards each laid out their own label/bar/percentage tracks, so
  no meter aligned with any other meter and card heights moved with the data.
  It is now one shared grid, `128px 72px minmax(160px, 1fr) 128px` with an
  `--sp-4` column gap: **provider · window · remaining · resets**. Every meter
  sits in one continuous column and every percentage right-aligns to one edge,
  so the shortest bar is the answer at a glance; the form holds at 1 provider
  and at 6+ without reflowing, and rows cannot end up different heights.
  - Window labels use the helper's own `window` value (`5h`/`7d`/`weekly`/
    `monthly`) when present, falling back to `short-term`/`long-term`.
  - `.meter` 8px on a `--bg` well (was 6px on `--surface-3`, barely
    distinguishable from the card behind it); `.meter-fill` `--success` >50%,
    `--warning` >20%, `--error` otherwise (replaces the raw
    `#a6e3a1/#f9e2af/#f38ba8`); `.pct` 40px, `--font-mono`, `tabular-nums`,
    right-aligned.
  - One hairline per provider group, as a full-width grid child — a per-cell
    border is broken up by the column gaps and reads as stray underlines.
  - `.reset` is `--fs-100`/`--fg-secondary` and shows a **relative** time
    ("in 2h 14m"), with the absolute timestamp on `title`. A reset already in
    the past falls back to the absolute date.
- **Null percentages are not empty rows.** `percent_remaining` is `null` for
  codex and grok on helper 0.4.44 — that means *the meter* is unknown, not
  that the provider has nothing to say. When the percentage is missing the
  remaining cell reads a quiet italic `not reported` and the **reset becomes
  the row's primary content** (`--fs-200`/`--fw-medium`/`--fg`), because
  "codex resets in 2h" is the useful half anyway. Only when the reset is
  *also* null is the row genuinely quiet. Never coerce null to 0: a 0%-wide
  bar reads as "quota exhausted".
- Status chips → `.status.limited` `--warning` on `--warning-soft`,
  `.blocked/.error` `--error` on `--error-soft`, all `--r-sm`/`--fs-100`.
  **`ok` renders no chip** — a row of "ok" badges is noise, and the meter
  already says so when it is fine. Likewise the `block_reason` footnote is
  `--fg-secondary`, not amber: the meter colour carries the level and the
  badge carries the category, and three amber signals for one fact was the
  old card's loudest problem.
- Ports `.fwd-table` → `th` in `--fs-100`/`--fw-semibold`/`--fg-muted`
  uppercase on `--surface-2`; `td` `--font-mono`/`--fs-200`; row separator
  `--border-soft`. `.kind.local/.remote/.dynamic` → `--accent` / `--warning` /
  `--agent` (replaces `#89b4fa` / `#f9e2af` / `#cba6f7`).
- `.toggle.on` (Auto-forward) → `--accent-soft` fill, `--accent` text,
  `--accent-dim` border.

### 5.4b Prompt composer — a floating, movable card (`PromptComposer.vue`)

Behaviour and the full geometry table are `docs/COMPOSER.md`'s (§21); this
section owns only what DESIGN introduced. The composer is **not** a docked row
and **not** a full-bleed bar: it is a card hovering over the session body,
inside a `.composer-dock` that is inset from that body and transparent to the
mouse, and **the user drags it and resizes it**.

- **Opaque surface rule.** `--surface`, `--border` hairline, never
  translucent: terminal text bleeding through a prompt field is unreadable
  for both.
- **Shadow Y-offset.** The card uses §5.5's overlay shadow with the 16px Y
  offset pulled in to 8px, because a card that can sit flush against the
  bottom of its dock would throw the longer shadow off the pane and leave its
  *top* edge — the one with terminal text behind it — unseparated.
- **Reserved: nothing.** The composer is a pure overlay and takes no terminal
  rows in any state. The row-count guarantee survives because a reserve of
  zero is still a constant: the terminal is sized by the pane and no composer
  state can change it. See COMPOSER.md §21.2.
- `--composer-inset` is declared on **`.folder-workspace`**, not in `:root`
  (`FolderWorkspaceView.vue`): it describes one pane's relationship with the
  composer, and custom properties inherit, so the composer reads it without
  being handed it.

### 5.5b Splitter (`02`, `03` · `HostWorkspaceView.vue`)

Transparent at rest, `--accent-dim` on hover with a **250ms enter delay** —
VS Code's sash. The splitter used to paint a 4px `--bg` band between the
session panel and the pane, visibly darker than both surfaces and doubling the
1px panel border beside it; the panel's own hairline is the seam. The delay
applies on enter only (leaving transitions immediately), so sweeping the
cursor across the app never flashes a cyan bar.

### 5.6 Conversation (`04` — empty state only)

Not photographed populated (see §1). Specified from `ConversationView.vue`'s
existing selectors and the Android `docs/mockups/conversation.html`:

- `.message.user` → `--accent-soft` fill, `--r-lg`, left rail 2px `--accent`
- `.message.assistant` → `--surface` fill, `--r-lg`, left rail 2px `--agent`
  (replaces the hard-coded `rgba(166,227,161,.08)` green, which currently reads
  as a success state rather than as a speaker)
- `.role` → `--fs-100`/`--fw-semibold` uppercase, `--fg-muted`
- `.text` → `--fs-300`, line-height **1.5** (`--lh` relaxed — this is the only
  prose in the app and 1.3846 is too tight for paragraphs)
- `.block pre` → `--font-mono`/`--fs-200`, `background: var(--term-bg)`,
  `--r-md`, `--sp-3` padding — deliberately the terminal's background so code
  blocks and the terminal agree.

### 5.7 Files (`05`)

- `.entry` height `--row-h`, hover `--state-hover`, `.entry.active`
  `--state-selected` (was `rgba(137,180,250,.16)`)
- **Entry icons — revised.** `.ic` is gone; the row renders
  `<AppIcon :name="icon(e)" :class="icon(e)" />` and the 16px SVG box *is* the
  icon column (the old `1.1rem` width was sized for an emoji). Colours:
  directory `--warning`, file `--fg-muted`, symlink `--fg-secondary`, the `..`
  row `--fg-muted`. On **selected** only the file icon lifts to
  `--fg-secondary` so it does not read disabled against the accent fill;
  on **hover nothing changes** (icon-colour flicker under a sweeping cursor
  reads as smear — the row's `--state-hover` fill is the feedback).
  The original spec asked for exactly these tokens and could not have them:
  `icon()` returned colour emoji, and colour-emoji rasterisation ignores CSS
  `color` entirely. Real SVGs are what made the token system reach this column.
- `.entry.active` carries the same 2px `--accent` left rail as `.session-row`
  (**revised**): one list marking selection with a rail and the adjacent one
  without it was exactly the sort of inconsistency that reads as unfinished
- `.nm` `--font-mono`/`--fs-300`; `.sz` `--fs-100`/`--fg-secondary`/
  `tabular-nums`, right-aligned
- `.breadcrumb` `--fs-200`, crumb links **`--fg-secondary` → `--fg` on hover**
  (**revised**), separators `--fg-muted`. The old all-`--accent`
  crumb row was the loudest thing on the Files screen while being pure
  navigation, and it contradicted §5.2's own rule that accent is reserved for
  *selected*
- **The current folder is not a link** (**revised**). It renders as
  `--fg`/`--fw-medium` against the ancestors' `--fg-secondary`, carries
  `aria-current="page"`, and has no hover state. NN/g's breadcrumb guideline #5
  ("the breadcrumb corresponding to the current page should not be a link"),
  USWDS and the ARIA authoring practices all say so, and here the click would
  have navigated to the directory already on screen. The weight lift is the
  same "you are here" signal GNOME's path bar gives its `current-dir` button
  while dimming everything to its left. Still no `--accent`: §5.2 reserves that
  for the selected *row*
- **Breadcrumb overflow — see §5.7.1**
- `.editor` → `--font-mono`, `--fs-300`, `background: var(--term-bg)`,
  `color: var(--term-fg)`

#### 5.7.1 Breadcrumb overflow — collapse segments, never characters

The strip is one line at every width the splitter reaches (180px–640px), and
it gets there by **dropping whole path segments into a menu**, not by cutting
letters out of the segments it keeps. `src/renderer/fileListView.ts`
(`buildCrumbs`) owns the rule, is fed a measured width by a `ResizeObserver` in
`FileTree.vue`, and is unit-tested across widths and depths.

**The ladder**, in order, and each rung has a source:

| | Rung | Why |
|---|---|---|
| 1 | Everything fits → show everything | Carbon: "The full breadcrumb path should remain visible when there's enough horizontal space." VS Code never collapses at all |
| 2 | Reserve the `…` first | It is the only route back to what is about to be hidden, so it outranks every segment it stands for |
| 3 | Reserve the root (`~` or `/`) next | One character, and the only cell saying which anchor you are under. Reserving it *before* ancestors is also what keeps the strip monotonic under a drag — filling ancestors first meant widening the pane could take the `~` away |
| 4 | Fill ancestors right-to-left, whole names only | A name that does not fit goes to the menu; what remains is always an unbroken run ending at the current folder, because a gap *between* two shown cells names a parent that is not the parent |
| 5 | Only the current folder ever truncates its text | And only when it alone exceeds the strip. `splitLabel`, so the tail survives — the app's one truncation rule, now applied to one cell instead of four |

At the 180px floor this bottoms out at `… / olya-merin` — Carbon's
narrowest-viewport prescription ("start with the overflow first, followed by
one breadcrumb"), Atlassian's ladder end, and VS Code's permanent
`breadcrumbs.filePath: "last"` setting.

**Rejected.** VS Code's horizontally scrolling strip (tail pinned) is the
cleanest design in the survey but needs an affordance and a gesture this pane
cannot spare; Nautilus's per-ancestor middle ellipsis and Fluent/Pajamas'
per-item character caps all cut characters where this rule drops whole
segments.

**Recovery, three ways**, because collapsing this hard is only safe if nothing
is lost: the `…` opens a menu of the hidden folders, each still a link; the
strip's `title` carries the full path; and the editable path bar (pencil, or
`Ctrl+L`) takes a typed one. The menu rather than the tooltip alone is NN/g's
rule — information a user needs in order to *act* has to be on screen, and
hover is not available to everyone.

**Sources.** NN/g breadcrumb + tooltip guidelines; IBM Carbon (breadcrumb,
overflow content); Adobe Spectrum; Fluent 2; WinUI BreadcrumbBar; GitHub
Primer; Atlassian; USWDS; GitLab Pajamas; Grafana's truncation spec; GNOME
Nautilus `src/nautilus-pathbar.c`; VS Code `breadcrumbsWidget.ts`.

### 5.7b Document preview — HTML, markdown and SVG, one pipeline

The Files tab shows three kinds as BOTH a render and their source, behind one
segmented control (`docView`, `Preview` / `Source`). The render is an
`<iframe sandbox="">` on the `psview:` scheme main serves; the source is the
same CodeEditor every other text file gets, with the same buffer, dirty flag
and Ctrl+S.

**Markdown reuses the HTML preview's argument rather than making a second
one.** Every guarantee that preview rests on is a property of how bytes are
SERVED, not of where they came from: the empty sandbox, a per-response CSP
naming no remote scheme, and containment checked twice (folded on the string,
then re-resolved with `realpath` on the host). Converting markdown to HTML in
main and handing it to that same handler inherits all three unchanged, and
relative images resolve exactly as a real page's do — because they become a
real page's. What is genuinely new is only *what the converter may emit*, which
is argued in `src/main/preview/markdownDocument.ts`.

| Decision | What it is, and why |
|---|---|
| Converter | `marked`, pinned. Zero runtime dependencies, ~56 KB in main's bundle |
| Where | **In main**, so the served bytes are plain HTML, the renderer never grows the dependency, and a relative link to another `.md` can be rendered too |
| Raw HTML in markdown | **Passed through**, not escaped or stripped. Under `sandbox=""` and this CSP nothing it can spell is live, and escaping would cost every README that uses `<details>`, `<img width>` or `<p align>` while removing no threat the pipeline does not already accept for `.html` files |
| Styling | A small inline stylesheet in the app's tokens (`previewStyle.ts`), values passed from the renderer and re-validated in main against a strict character allowlist — no `;`, `}`, `<`, `>`, `:`, `/` or `\`, so a value cannot end the rule, close the element or spell a URL |
| Markdown links | A `.md` **inside the preview's root** is rendered too, so `[design](DESIGN.md)` navigates and a `docs/` folder browses as a small site. Outside the root it is refused, exactly as an image would be |
| Heading anchors | Slugged from heading text, deduplicated per document, so a table of contents works — a fragment link needs no script and no network |
| Code blocks | Styled in `--term-bg`/`--term-fg` so a fence matches the editor beside it. **Not** syntax-highlighted: the editor is one click away |

**SVG joined through the same door and needs nothing done to it.** Its bytes
are already a document Chromium renders, so they are served untouched at
`image/svg+xml` — the HTML treatment with a different content type. That is
also why SVG must NOT be reasoned about as "only a picture": rendered as a
document (rather than through `<img>`) an SVG can carry `<script>`, fetch
remote references through `<image href>` / `<use href>`, and navigate — every
one refused by the same sandbox and CSP that guard a page, which is why they
are as load-bearing for a logo as for a web page. The frame paints on
`--term-bg`, the image viewer's ground, because most SVGs leave their own
background transparent. Relative references to sibling files resolve, the
same way a page's stylesheet does; remote ones are flagged in the toolbar
("remote resources are not loaded"), keyed on the SVG spellings. The source
toggle keeps what the classifier used to offer on its own: an `.svg` edits as
XML with highlighting, losslessly.

**Known limits, all shared with the HTML preview.** Clicking an *external*
link empties the frame — the CSP refuses the navigation, which is correct, and
Chromium paints its own error page with no scripts available to intercept the
click first; the Reload button restores it. And the preview always renders the
HOST's copy, so unsaved edits are not shown; the toolbar says so, alongside
counts of assets loaded, refused as outside the folder, and missing.

### 5.8 Iconography — no character ever does an icon's job

**The rule: no character-as-icon anywhere in the app.** Not emoji, not
box-drawing characters, not arrows, not an icon *font*. Every glyph standing
in for a graphic affordance is a real inline SVG that inherits `currentColor`.

Font glyphs cannot be stroke-tuned or token-tinted, they sit on the text
baseline rather than a control's optical centre, they rotate around the wrong
origin, and colour emoji ignore CSS `color` outright — which is why this
document's own §5.7 asked for a `--warning` folder and could not have one for
two revisions. An icon *font* repeats the same mistake in a tidier form, so
`@vscode/codicons` was considered and rejected on exactly that ground (it also
carries a visible-attribution requirement).

**The mechanism** is one local component, `src/renderer/components/AppIcon.vue`
— no package, no loader, nothing fetched, the strict `file://` renderer
untouched. Its contract:

| | |
|---|---|
| Geometry | Feather 4.29 path data (**MIT**), verbatim, in a registry inside the component |
| Canvas | one `24 24` viewBox for every mark, so stroke weights are identical across the set |
| Stroke | `2`, round caps and joins — the thin geometric unfilled register of VS Code's Codicons |
| Colour | **always `currentColor`.** An icon never sets its own colour; the parent's `color:` token does |
| Sizes | **16** (default: toolbars, tree glyphs), **14** (dense bars, the disclosure chevron), **12** (chips, table-row actions, block toggles). No others |
| Alignment | flex-centring, never baseline. The component is `display: block; flex: none`, which kills the inline-SVG descender gap and stops a truncating label from squashing it |

Two marks are painted rather than stroked (`dot`), or are Feather shapes with
a `<rect>` re-expressed as a path (`panel-left`, VS Code's toggle-sidebar
mark), so the template stays a single path loop.

`ComposerIcon.vue` was an earlier local copy of this contract, written while
this component was still being specified; it has been folded in and deleted.
There is one icon component in the tree.

**What stays text, deliberately:** `·` metadata separators, `…` inside a label
(`Sending…`, `probing…`), `—`/`–` as punctuation and no-data placeholders,
`~` and `/` in displayed paths, `↑`/`↓` inside keyboard-shortcut tooltip copy,
and the composer's `/` button — a keycap for the literal character it inserts.
That family is text, not iconography. A **bare** `…` swapped in as a button's
whole content is *not* text: those became the spinning refresh icon.

### 5.9 Motion

`--dur-fast` for state changes, `--dur-normal`/`--dur-slow` with `--ease-out`
for things arriving. What animates: hover tints, disclosure rotation, the
overlay entrance (§5.5), the splitter highlight (§5.5b), meter-fill width, the
loading `.spin`, and a 2px `translateX` nudge on the host-picker chevron.

**What must NOT animate:**

- **The terminal. Ever.** No transition or animation on `.terminal`, its
  container, or anything xterm renders — resize, attach and tab-switch are
  instant.
- **List-row hover** (`.session-row`, `.entry`). VS Code renders list hover
  instantly because a cursor sweeping a list with lagging tints reads as
  smear, not smoothness. The absence of a `transition` here is deliberate —
  do not "fix" it. (Same reason the file-tree icons do not change colour on
  hover, §5.7.)
- **Panel/splitter drag geometry** — width follows the pointer 1:1.
- **Folder expand/collapse height.** The chevron rotation is the motion cue.

One global `@media (prefers-reduced-motion: reduce)` guard in `App.vue` covers
every animation and transition, so components carry no per-component
reduced-motion blocks.

---

## 6. Enforcement — the design gates are executable

A rule that lives only in a document decays one locally-reasonable exception
at a time (which is exactly how the emoji arrived), so the gates run on every
`npm run test:unit` in `tests/unit/designGates.test.ts`:

1. **Colour tokens.** Raw six-digit hex belongs to the token block in
   `App.vue` and to `TerminalView.vue`'s Campbell theme — no other renderer
   `.vue` may carry one, and renderer `.ts` may carry hex only in
   `themes.ts`. Every component paints from the tokens.
2. **No character-as-icon** (§5.8). The glyph blacklist must match nothing
   outside (a) code comments, (b) the genuine-text cases listed in §5.8 —
   `↑`/`↓` in the composer's shortcut tooltip is the one arrow that
   legitimately survives, as copy — and (c) `TerminalView.vue`, whose glyphs
   come from the remote program and from Consolas and are off-limits on
   principle. The `·` `…` `—` `–` `~` family is exempt by design: that is
   text.

---

## 7. Conflicts and open questions

**1. Copy-on-select contradicts the user's Windows Terminal config.**
`TerminalView.vue`'s `onDocumentMouseUp` copies the selection on mouse-up.
The user's `settings.json` sets **`"copyOnSelect": false`** explicitly. The
desktop app is doing the one thing the user turned off in the tool this
spec is meant to mirror. Still to make opt-in and default to off.

**2. Clipboard chords** — the terminal binds Ctrl/Cmd-**Shift**-C/V where the
user's `settings.json` remaps plain `ctrl+c`/`ctrl+v` (with the SIGINT
conditional plain Ctrl-C requires). The chord inventory and its reasoning
live in **docs/SHORTCUTS.md**.

**5. Duplicated overlay headings** (§5.5) were a structural artifact of
hosting full views inside `OverlayPanel`, not a styling bug: the overlay
supplies the title, so a view carrying its own rendered it twice. Settled
structurally — hosted views suppress their own heading when embedded
(`UsageView.vue`'s `embedded` prop); `PortPanelView.vue` ships none.

**6. Android parity is deliberately broken in two places**, both on the user's
explicit instruction or on desktop-input grounds: mono font is Consolas, not
the phone's bundled JetBrains Mono (§2.3); tabs stay underlined rather than
becoming a filled segmented control (§5.4).

---

## 8. Themes — the palette became data

Added when the user asked for a light theme and then for "different themes
like in VS Code"; §3.4 and §4.3 point here rather than restate.

### 8.1 The shape: one record per theme, and nothing per-theme anywhere else

A theme is one object in `src/renderer/themes.ts`:

| Field | What it is |
|---|---|
| `id` | stable, persisted by the settings store — never renamed |
| `label` | what the Settings picker shows |
| `appearance` | `'dark'` \| `'light'` — **declared, not guessed** from the background. Decides which side of `system` the theme can serve and the `color-scheme` App.vue sets |
| `tokens` | every colour-carrying custom property of §4.3, by name |
| `terminal` | the complete xterm `ITheme` — ANSI 16, ground, ink, cursor, selection |

Applying a theme is the pattern the app already had for fonts and zoom: one
`watchEffect` in `App.vue` writes the record's tokens onto `<html>` as inline
custom properties (outranking `:root` in the cascade), stamps `data-theme`,
and sets `color-scheme`. Everything that paints from the cascade — the entire
UI, the CodeMirror theme (`codeEditorTheme.ts` is pure `var(--…)`), the
Settings samples, DoodleCanvas' pens — retints on the next frame with no
restart and no component involved. xterm is the one surface that cannot read
the cascade, so `TerminalView.vue` assigns `term.options.theme` from the same
record and is the only other consumer.

`system` is not a theme: it is a rule, resolved live through
`matchMedia('(prefers-color-scheme: light)')` — the renderer-side face of
Electron's `nativeTheme`, needing no IPC — and it picks between the two ids
in `SYSTEM_THEME_IDS`. That pair is data too: with several dark themes
registered, "which dark does the OS setting mean" is a product decision (the
shipped default and its designed light counterpart), not a search.

**The default is `dark`, not `system`**, because dark is what shipped and an
upgrade must not repaint the app of anyone whose OS happens to be in light
mode. The same rule every settings default in this app follows.

**To add a theme: write one record in `THEMES`. That is the whole recipe.**
The Settings picker lists the registry, the settings store's parser accepts
whatever ids exist, and two executable gates in `tests/unit/themes.test.ts`
hold the record to the bar: token parity (a record must define exactly the
token set the dark theme defines — which that same test welds to `App.vue`'s
`:root`) and the contrast floors of §8.2. A half-audited palette fails
`npm run test:unit`; it cannot ship by accident.

### 8.2 Contrast floors — the audit is executed, not remembered

WCAG 2.1 relative luminance, computed by the test for every theme:

| Pair | Floor | Why |
|---|---:|---|
| `--fg`, `--fg-secondary` on `--bg`/`--surface`/`--surface-2` | 4.5 | 13px body/secondary text (AA) |
| `--fg-muted` on `--bg` | 3 | ≥15px or decorative only (§4.2's rule) |
| `--border-strong` on `--bg` and `--surface-2` | 3 | WCAG 1.4.11 control boundaries |
| `--accent`, `--success`, `--warning`, `--error`, `--agent` on `--bg` | 4.5 | read as text |
| `--on-accent` on `--accent` | 4.5 | filled-button labels |
| `--term-fg` and every `--code-*` text role on `--term-bg` | 4.5 | 13px editor prose |
| `--code-gutter-fg` on `--term-bg` | 3 | line numbers are decorative (§4.3) |

Where a scheme's own colour misses the floor for the role it takes, the token
holds the scheme's colour **lifted toward the readable pole with hue
preserved**, and the record's comment names the canonical origin and both
ratios. This is the dark theme's own precedent: its `--code-comment` is a
lifted Campbell brightBlack (§4.3).

### 8.3 The set, and where each palette comes from

Terminal ANSI sets are **transcribed, never invented** — the discipline §3
established when it read Campbell out of Windows Terminal's `defaults.json`
rather than reconstructing it. Transcription is verifiable. A scheme's own
deliberately-weak pairs (Campbell's dim blue, Solarized's bright-slot base
tones) are xterm's problem at render time via `minimumContrastRatio: 3`,
identically in every theme.

| Theme | Appearance | Terminal source | UI derivation |
|---|---|---|---|
| **Dark** (default) | dark | Campbell, WT 1.24 `defaults.json` (§3) | §4 — GitHub-dark via the Android client. Byte-identical to what shipped |
| **Light** | light | GitHub Light ANSI, primer/primitives | GitHub Primer light — the same publisher the dark UI derives from, so `system` flips between one vendor's two designed modes. Code palette is GitHub's prettylights-light: unlike Campbell, this scheme's publisher ships a purpose-built editor palette for this exact ground, which beats forcing ANSI slots into syntax roles |
| **Solarized Light** | light | Canonical table, ethanschoonover.com/solarized | Grounds are base3/base2 verbatim; the accents are designed midtones (~3–4:1 on base3) so **more roles are lifted here than anywhere else** — body text takes base02 because base00 is 4.13:1, and all eight accents are lifted to 4.5. Recognisably Solarized, deliberately deeper-inked |
| **Nord** | dark | Official terminal mapping, nordtheme.com | nord0–nord3 are a ready-made elevation ramp, transcribed as the surfaces. Nord's famous 1.9:1 comment grey is lifted to 4.52 and says so |
| **Gruvbox Dark** | dark | morhetz/gruvbox (dark, medium) | bg0…bg2 as the ramp, signature orange as the accent; the warm counterpart to Nord's cool |
| **One Dark** | dark | Atom One Dark | The blue-grey middle ground VS Code users know; One Dark's own caret blue kept as the cursor |

Chosen to span the space — neutral/cool/warm × dark/light — rather than four
variations on dark blue. Accent identity note: cyan is the product's accent
in the dark and light defaults; the adopted schemes keep their own signature
accents (Nord frost, gruvbox orange, One Dark blue) because a Nord theme with
a foreign cyan is not Nord.

### 8.4 Key ratios per theme (text roles, on `--bg` / `--term-bg`)

Computed by the audit; stated here for the record.

| Theme | `--fg` | `--fg-secondary` | `--accent` | `--code-comment` |
|---|---:|---:|---:|---:|
| Dark | 16.02 | 6.15 | 10.47 | 6.36 |
| Light | 15.80 | 6.11 | 5.36 | 6.39 |
| Solarized Light | 12.05 | 5.72 | 4.52 | 4.53 |
| Nord | 10.84 | 6.51 | 6.24 | 4.52 |
| Gruvbox Dark | 10.75 | 5.65 | 5.84 | 4.51 |
| One Dark | 6.57 | 5.42 | 5.92 | 4.53 |

The secondary-text floor is the binding constraint everywhere: each theme's
`--fg-secondary` is chosen to clear 4.5 **on `--surface-2`**, the deepest
surface it is read on, which is why several sit at ~4.5 there while reading
5.4–6.5 on the ground.

### 8.5 What themes do NOT touch, and known limits

- **Non-colour tokens** — type scale, spacing, radii, density, motion — are
  not themed and live only in `:root`. A theme is a palette, not a layout.
- **Shadows became tokens** (`--shadow-overlay`, `--shadow-card`) because the
  light themes cannot use `rgba(0,0,0,.5)` — black at half opacity on white
  reads as a hole, not a lift. Light themes carry soft ink shadows instead.
- **CodeMirror's `dark` flag follows the theme** (revised — was a known
  limit). `codeEditorTheme.ts` builds its chrome once per appearance from ONE
  shared spec — the CSS is identical, because every value in it is a token —
  and `CodeEditor.vue` holds it in a `Compartment` and reconfigures on a theme
  change. The reconfigure dispatches a transaction carrying an **effect and no
  changes**, so the document, the selection, the undo history, the scroll
  position and the files store's **dirty flag** all survive (rebuilding the
  `EditorState`, the obvious alternative, loses all five). The appearance is
  read from the theme record's DECLARED `appearance` (through `resolveTheme`,
  so `system` follows the OS), never guessed from a background colour. Pinned
  by `tests/unit/CodeEditor.test.ts`.
- **A markdown preview is themed; an HTML or SVG preview is not.** The rendered
  markdown document is ours, so it is painted in the app's tokens
  (`src/main/preview/previewStyle.ts`). An HTML file brings its own styling and
  is deliberately left alone — a page that looked different here from how it
  looks in a browser would be a lie about the file, and the same holds for an
  SVG drawing. Because CSS custom
  properties do not cascade across a frame boundary, the token VALUES travel:
  the renderer resolves them out of computed style and main writes them into
  the generated document's own `:root`, re-validating every one. A theme switch
  re-mints, because a sandboxed frame with no scripts cannot be re-tinted in
  place. See §5.7b.
- **Terminal contents are the remote's.** A theme changes the 16 ANSI slots;
  a remote program that hardcodes 256-colour or truecolor output (many TUIs
  do) will look however it looks. That is every terminal emulator's contract.
