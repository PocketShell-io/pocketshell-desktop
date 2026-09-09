# PocketShell Desktop — Visual Design Spec

Status: **implemented.** Decision record for what shipped — the tokens in
`App.vue`, the type system in `fonts.ts`, the terminal options in
`TerminalView.vue`, the theme records in `themes.ts`. The code is the source
of truth for values; this file holds the reasoning and the provenance.

Sources, cited inline throughout: the user's Windows Terminal
`settings.json` + the installed product's `defaults.json` (§3); the Android
client at `C:\Users\alexey\git\pocketshell` (token values and component
geometry); WCAG 2.1 contrast math, computed per pair (and executed per theme
by `tests/unit/themes.test.ts`, §8.2).

---

## 1. Captured screenshots

Screenshots are **local-only reference, never committed** —
`docs/screenshots/` is gitignored. Recapture by driving the **built** app
(`npm run build` → `out/main/index.js`) with Playwright's `_electron.launch`,
viewport 1280×800, against an isolated fake profile so the user's real
`~/.ssh/config` is never touched. That fake profile directory **must contain
an `AppData\Roaming` subtree**, or Electron fails to resolve
`app.getPath('appData')`, `requestSingleInstanceLock()` returns false and the
app exits silently with code 3 — documented nowhere else. When recapturing
the session panel, cover: two or more `$HOME` roots, ≥10 one-session folders
under one of them, a folder holding 2+ sessions, a worktree-divergent name,
an out-of-`$HOME` session, and a no-cwd session whose name names a real root.

---

## 2. Typography

### 2.2 Inter Variable

**Inter is the Android client's design font**, so adopting it makes the two
clients one product. It is bundled, not fetched (`@fontsource-variable/inter`,
OFL-1.1; Vite fingerprints the woff2, which matters because the renderer
loads over `file://` with no connectivity guarantee). Real tabular figures:
`font-variant-numeric: tabular-nums` stops the session list, Usage meters and
Ports table jittering between rows. Fallback stack — the best native face on
each OS, no dead entries:

```css
--font-ui: 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI',
           system-ui, sans-serif;
```

### 2.3 Monospace: Consolas by default, one setting for the whole app

The user's Windows Terminal is set to **Consolas** (§3), so the app's mono
chrome uses the same face and the terminal and the UI framing it read as one
surface. Consolas ships with every Windows install, so no bundling. This
deliberately diverges from the Android app, which bundles JetBrains Mono:
matching the user's own terminal beats matching the phone.

```css
--font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;
```

**The face is a setting (`src/renderer/fonts.ts`); the stack above is only
its default.** One `monospaceFontFamily` for the whole app, written onto
`<html>` as `--font-mono`, so it moves the terminal, the editor and every
mono chrome element together — a per-surface family would let the user undo,
one dropdown at a time, the single-surface effect the setting exists to
create. Two mechanics matter:

- **The choice is PREPENDED to the stack, never substituted for it.** A
  family the user does not have falls through to `ui-monospace` →
  `monospace`. There is no path to a proportional face, which for a terminal
  is not degradation but breakage.
- **The stored value is a single family NAME, sanitised** — no quotes,
  braces, or commas; commas are stripped specifically so one setting cannot
  smuggle in a whole stack and get behind that fallback tail.

The picker is a curated list plus free text (an Electron renderer has no
reliable way to enumerate installed fonts); the Settings panel renders a
sample line in the resolved stack on `--term-bg` instead — if the sample does
not change, the font is not installed. **Size is two settings, not one**
(`terminalFontSize`, `editorFontSize`), both clamped 8–32: the terminal's size
is visible to the remote — it sets the PTY's row/column count — while the
editor's is not.

### 2.4 Type scale

Derived from the Android ladder in `Type.kt` (11 / 13 / 15 / 16 / 18 / 20 sp)
mapped 1:1 to px — correct because Android `sp` at the default font scale and
CSS `px` in Electron are both device-independent units at 100% scaling. The
tokens live in `App.vue`; the workhorse is `--fs-300` (13px), whose line
height 1.3846 is Android's `bodyDense` 13sp/18sp exactly, so a 13px row is
18px tall in both clients. Weights come from Inter Variable's `wght` axis
(400 body, 500 list-row titles, 600 headers, 700 the wordmark only). **Do
not use 800/900.** `-webkit-font-smoothing: antialiased` is the CSS
equivalent of Windows Terminal's `"antialiasingMode": "grayscale"` (§3), so
UI and terminal rasterise the same way.

---

## 3. Terminal — Consolas, from the user's Windows Terminal

### 3.1 What the settings file actually contains

The user's `settings.json` sets only `profiles.defaults.font` =
`{ "face": "Consolas", "size": 16 }` (repeated in the default Git Bash
profile), `copyOnSelect: false`, `copyFormatting: "none"`, and remapped
`ctrl+c`/`ctrl+v` clipboard keys. **The user's colour scheme is not in the
file** — `schemes` and `themes` are empty and no profile sets
`colorScheme`, so the effective scheme is the built-in default. The values
below are read out of the installed product's `defaults.json` (Windows
Terminal 1.24, where every shipped profile carries
`"colorScheme": "Campbell"`). These are the real built-in values, not a
reconstruction — and that transcription discipline is the precedent §8.3
follows for every theme: **terminal ANSI sets are transcribed, never
invented**, because transcription is verifiable.

Also inherited from that default block: `cursorShape: "bar"`, `padding: "8,
8, 8, 8"`, `historySize: 9001`, `antialiasingMode: "grayscale"`,
`snapOnInput: true`, and the `wordDelimiters` string.

### 3.2 fontSize: 16 — a default, not a conversion

Windows Terminal's `font.size` is in points (16pt = 21.33px at 96 DPI); that
conversion was worked out and then **not taken** — the number is read
literally as pixels, so `TERMINAL_OPTIONS.fontSize` is **16**. That 16 is now
only the *default* of `terminalFontSize` and must stay exactly 16: changing
it would resize the terminal of every existing user on upgrade, silently,
which is the one thing a default is there to prevent. Anyone who wants 21
sets it in two clicks. xterm does not read the cascade — `TerminalView.vue`
assigns `fontFamily`/`fontSize` from the settings store and calls
`fitAddon.fit()`, because a changed cell size changes the row and column
count and an unfitted terminal reports stale geometry to the remote.

### 3.3 Contrast: `minimumContrastRatio: 3`

Campbell's dim blue and magenta are genuinely unreadable on its own
background — a known property of the scheme, not a transcription error.
Rather than editing the palette, xterm's **`minimumContrastRatio: 3`** lifts
only the failing pairs at render time and leaves the other colours
pixel-identical to Windows Terminal. Set to `1` if byte-exact parity is ever
preferred over legibility.

### 3.4 The options object (`TERMINAL_OPTIONS`)

`TerminalView.vue`'s `TERMINAL_OPTIONS` carries everything not themed and not
user-settable, each value verified against the installed xterm's typings and
traceable to a `defaults.json` line: bar cursor (blinking; outline when
inactive), scrollback 9001, the user's `wordDelimiters` verbatim (so
double-click word selection splits paths exactly as Windows Terminal does),
`drawBoldTextInBrightColors`, `minimumContrastRatio: 3` (§3.3). **No
`theme`:** the palette belongs to the applied theme record, assigned at
construction and re-assigned by the settings watcher (§8). `bellStyle:
"none"` has no xterm equivalent and is satisfied by doing nothing.

### 3.5 Character widths — Unicode 11, not xterm's default 6

xterm parses panes with Unicode 6 width tables unless told otherwise, and
Unicode 6 counts emoji as one column while the fonts that draw them render
two — on any row carrying a background, the right half of every emoji
vanished under the overflow. Every pane therefore applies the Unicode 11
provider (`@xterm/addon-unicode11`) at construction, before the first output
byte is parsed — buffer cells keep the width they were parsed with, so a
switch cannot land under already-streamed content. Mechanism and rationale:
`src/renderer/terminalUnicode.ts`; regression test runs the real headless
emulator.

---

## 4. Colour tokens

### 4.1 The Android palette, adopted

The scaffold default was Catppuccin Mocha; the shipped tokens are the
Android app's GitHub-dark-derived palette. Two reasons: product coherence —
two clients of one product, and the phone's palette is the documented one —
and it resolves the terminal-edge problem for free: Campbell's `#0C0C0C`
against `#0D1117` reads as a slightly deeper well in the same neutral family
(1.03:1), exactly the relationship the Android app builds deliberately.

### 4.2 Contrast rules (computed, WCAG 2.1)

The full tables are computed per theme by `tests/unit/themes.test.ts`
(§8.2); the rules that fell out of the original audit:

- **`--fg-muted` (4.12:1) is below AA for body text** — restrict it to
  ≥15px text or genuinely decorative content. Real information (timestamps,
  counts) takes `--fg-secondary` (6.15:1).
- **`--error` on `--surface-2` is marginally under AA** — error text inside
  inputs/menus sits on `--surface` or `--bg`.
- **WCAG 1.4.11**: a boundary that is the *only* way to identify a control
  needs 3:1. `--border` (1.49:1) is a decorative hairline only; that is why
  `--border-strong` exists and why control boundaries that must
  self-identify — inputs, the composer's at-rest toggle — are drawn with it.

### 4.3 The token block — shipped in `App.vue`, one theme of several

The `:root` block in `App.vue` is the no-JS default; the applied theme's
record is written over it as inline custom properties on `<html>` (§8), and
`tests/unit/themes.test.ts` asserts the two copies are identical, so neither
can drift. What is not obvious from the values: **hover is a neutral lift**
(~5% white), not a tint — tinting every hover cyan makes hover read as
selection; `--term-*` are Campbell verbatim; and the motion tokens exist for
the overlay entrance, the one thing slow enough to want a decelerating
curve.

---

## 5. Layout & components

### 5.0 Global rules

Type defaults and `tabular-nums` on every number column — figures do not
jitter between rows. **The focus ring is the only focus treatment in a
keyboard-driven app**: every focusable element gets the token ring, except
rows inside scrolling lists, which take the **inset** variant
(`outline-offset: -2px`) because scrolling lists clip a +2px outward ring.

### 5.1 Shared primitives

`.icon-btn`, `.muted`, `.error` and `.empty` exist once each, as global
classes in `App.vue`'s unscoped `<style>`. Extract-then-restyle is the rule:
restyling seven hand-copied `.icon-btn`s is how the original drift happened.
The bordered `.icon-btn` split in two, both **ghost** — invisible at rest,
filled on hover, square by construction (`--control-h`); nine bordered
rectangles at rest in a 40px topbar were the single biggest "unpolished"
signal in the before-screenshots. A bordered look survives only where chrome
is earned: filled accent actions, the Auto-forward toggle, form controls,
status chips. Every badge-like element shares one metric
(`padding: 0 var(--sp-1)`, `line-height: var(--lh-100)`, inline-flex).

### 5.2 Host picker

Card-like 44px rows (a landing screen, not a dense list — matches the
Android `HostCard` geometry); wordmark at `--fs-600`; `user@host:port` in
mono at `--fg-secondary`. Hover is `--state-hover` with a border lift —
**accent is reserved for selected, never hover**. A leading 8px status dot
per host (idle/connecting/connected) mirrors the Android `StatusDot`.

### 5.3 Session list

Owned by **docs/SESSIONLIST.md** — the panel is `root -> folder`, two
levels, in the host's order. Nothing here overrides it.

### 5.3b Host workspace chrome — NO topbar

The host topbar is **gone**: a full bar of chrome above every terminal whose
largest element was an identity label, in an app whose whole point is the
terminal. Every control was redistributed, none deleted: the host label
became the **OS window title** (built by the pure `shared/windowTitle.ts` —
the title mirrors the *view*, not the connection, and the host lands in the
taskbar and Alt-Tab); back and collapse moved into the session panel's
header row; Ports/Usage/Settings became the header strip (§5.3c–e);
disconnect moved to the **host picker**, on the connected host's row, at its
destination — and that row re-enters the workspace without re-dialling (a
second dial would orphan the live connection). **Collapsed state is a ~36px
rail, not nothing** — a zero-width collapse would take every host control
off screen — and the rail offers nothing less than the expanded panel. With
the panel hidden the tab bar covers only the *open* folder, so the rail also
carries a **session switcher** (`HostWorkspaceView.vue`): a menu mirror of
the panel's folder list — same root grouping, same order, same keys — from
the one `useFolderTree` derivation the panel and the `Ctrl+↑`/`Ctrl+↓`
chords already share. A pick is `onSelectFolder`, the panel row's own
handler, so re-picking the open folder keeps its re-click semantics (focus
the pane, navigate nowhere); it navigates and creates nothing.

### 5.3c–e — Host panel header strip

Seven controls, left to right — the user's sentence verbatim: back, `+`,
Ports, Usage, refresh, settings, hide-panel. There is no eighth slot: the
next addition displaces one or moves the panel floor. **Words live in
tooltips and accessible names, whole** — `HOST_PANEL_ITEMS`
(`src/renderer/hostPanels.ts`) carries a `label` AND an `icon` per entry,
and one component renders both the header strip and the collapsed rail, so
the two surfaces cannot drift. The glyphs read as their verbs: forwarding is
a symmetric mapping, so an opposing pair, not `shuffle`'s crossing paths.
**Width: the 232px floor** — seven 28px controls + six 4px gaps = 220, which
the old 200px floor could not hold, so `MIN_PANEL_WIDTH` and `.tree`'s
`min-width` moved to 232 together, as they have always had to move together.
The rail gets **no `+`**: creating a session is something you do while
looking at the list you are adding to.

### 5.4 Session workspace header — ONE row

The identity bar and the tab strip are one `--topbar-h` row — they were two
full-height bars, 72px of chrome above every terminal. **Tabs lead** (the
only thing in the row that is clicked; a leading label of unpredictable
length would shift them on every session switch), full row height so the
active tab's 2px underline lands on the row's own bottom border. **Keep the
underline**, not Android's filled segmented toggle — a filled cyan segment
at 13px is heavy for a mouse UI. The session path is not rendered: a session
is named after its directory, so name-plus-path is one fact written twice;
the full path is the name's `title` tooltip.

### 5.4b Prompt composer

Behaviour and geometry are `docs/COMPOSER.md` §21; the DESIGN-owned rules:
the card is **opaque** (`--surface` — terminal text bleeding through a
prompt field is unreadable for both), its shadow's Y-offset is pulled in to
8px because a card flush against the dock's bottom would throw the long
shadow off the pane, and it **reserves nothing** — a pure overlay whose
row-count guarantee survives because a reserve of zero is still a constant.

### 5.5 Overlays — Usage and Ports

Both are header buttons opening `OverlayPanel.vue`. The decisions:

- **Sizes to its content** — `max-height`, not a fixed height that renders
  180px of content as a mostly-empty rectangle. Width is a `size` prop: `lg`
  960px (the port table), `md` 720px, `sm` 480px (short forms, where `md`
  would stretch every control to twice its content's width).
- **Panel-scoped controls live in the header** via the `actions` slot; a
  refresh control floating in the body read as orphaned debris.
- **Entrance**: backdrop fade + 8px rise/scale-in on the slow curve; leaving
  is a plain fast fade, because dismissal should feel faster than arrival.
- **The overlay owns the heading**: hosted views suppress their own title
  when embedded (`UsageView.vue`'s `embedded` prop) — hosting full views
  used to render "Provider usage" twice.
- **Usage is a table, not cards.** The job of the screen is *comparison* —
  "who is nearly out?" — and side-by-side cards each laid out their own
  meter tracks, so no meter aligned with any other. One shared grid:
  provider · window · remaining · resets; every meter in one continuous
  column, every percentage right-aligned to one edge, so the shortest bar is
  the answer at a glance.
- **Null percentages are not empty rows.** `percent_remaining` is null for
  some providers — that means *the meter* is unknown, not that the provider
  has nothing to say: the cell reads a quiet italic `not reported` and the
  **reset becomes the row's primary content**. Never coerce null to 0: a
  0%-wide bar reads as "quota exhausted".
- **`ok` renders no chip** — a row of "ok" badges is noise, and the meter
  already says so.

### 5.5b Splitter

Transparent at rest, accent on hover with a **250ms enter delay** — VS Code's
sash. Leaving transitions immediately, so sweeping the cursor across the app
never flashes a cyan bar. The panel's own hairline is the seam; no painted
band beside it.

### 5.7 Files

Row tokens (`--row-h`, hover fill, selection fill), the 2px accent selection
rail matching the session rows (one list marking selection with a rail and
the adjacent one without it reads as unfinished), entry icons as AppIcon SVGs
whose colours are tokens (colour-emoji rasterisation ignores CSS `color`
entirely — real SVGs are what made the token system reach this column; on
hover nothing changes — icon-colour flicker under a sweeping cursor reads as
smear), and the **current folder is not a link** (NN/g's breadcrumb rule; it
renders `--fg`/semibold with `aria-current`, no hover, still no accent —
accent is the selected row's, §5.2).

#### 5.7.1 Breadcrumb overflow — collapse segments, never characters

The strip is one line at every width the splitter reaches by **dropping
whole path segments into a menu**, not by cutting letters. `buildCrumbs` in
`src/renderer/fileListView.ts` owns the rule, fed a measured width by a
`ResizeObserver`, unit-tested across widths and depths. The ladder, each
rung with a source:

| | Rung | Why |
|---|---|---|
| 1 | Everything fits → show everything | Carbon; VS Code never collapses at all |
| 2 | Reserve the `…` first | The only route back to what is about to be hidden |
| 3 | Reserve the root (`~`/`/`) next | One character, the only cell naming the anchor; reserving it before ancestors keeps the strip monotonic under a drag |
| 4 | Fill ancestors right-to-left, whole names only | What remains is always an unbroken run ending at the current folder — a gap *between* shown cells names a parent that is not the parent |
| 5 | Only the current folder ever truncates its text | And only when it alone exceeds the strip — the tail survives (`splitLabel`) |

**Rejected:** VS Code's scrolling strip (needs an affordance this pane
cannot spare); per-ancestor middle ellipsis and per-item character caps
(they cut characters where this rule drops whole segments). **Recovery,
three ways**, because collapsing this hard is only safe if nothing is lost:
the `…` opens a menu of the hidden folders, each still a link; the `title`
carries the full path; the editable path bar takes a typed one. The menu
rather than the tooltip alone is NN/g's rule — information a user needs in
order to *act* has to be on screen. This rule was learned twice — the
session rows shipped middle-collapse-on-character-truncate first —
which is why it is written as a ladder, not a cell count.

#### 5.7.2 Creating a file or folder — an inline row, not a dialog

A `+` on the breadcrumb strip and a right-click on empty ground put an
inline naming row at the top of the list — where the new name sorts anyway.
Two rules are load-bearing and both live server-side of the UI: **a create
can never truncate** — files are made through `sftp:createFile`, which opens
with `wx` and refuses an existing name, unlike `writeFile`, which
overwrites by contract because its caller is saving a buffer that was read
on purpose; and **a created file opens, a created folder only lists** —
naming a file is the first half of "write something new here". The name is
ONE segment (`/`, `.`, `..` refused on the store side), so the field cannot
reach past the folder on screen.

### 5.7b Document preview — HTML, markdown and SVG, one pipeline

The Files tab shows all three as BOTH a render and their source, behind one
segmented control. The render is an `<iframe sandbox="">` on the `psview:`
scheme main serves; the source is the same CodeEditor every other text file
gets.

**Markdown reuses the HTML preview's argument rather than making a second
one.** Every guarantee that preview rests on is a property of how bytes are
SERVED, not of where they came from: the empty sandbox, a per-response CSP
naming no remote scheme, and request paths always folded and re-resolved
with `realpath` on the host. Converting markdown to HTML in main and handing
it to the same handler inherits all of it. One boundary is deliberately
wider: a markdown preview answers for the whole host rather than one folder,
because a README is cross-referenced by `../` and absolute paths — every
file it can name is one the SSH user can already open in the Files tab. The
converter (`marked`, pinned) runs **in main**, so the renderer never grows
the dependency and a relative link to another `.md` renders too — a docs
tree browses as a small site. Raw HTML in markdown is **passed through**:
under this sandbox and CSP nothing it can spell is live, and escaping would
cost every README that uses `<details>` or `<p align>` while removing no
threat the pipeline does not already accept for `.html` files.

**SVG joined through the same door and needs nothing done to it** — served
untouched at `image/svg+xml`, the HTML treatment with a different content
type. Which is also why SVG must NOT be reasoned about as "only a picture":
rendered as a document it can carry `<script>`, fetch remote references, and
navigate — every one refused by the same sandbox and CSP that guard a page,
as load-bearing for a logo as for a web page. Clicking an *external* link
does not navigate the frame: main hands a web URL to the **system browser**
(the http(s)-only allow-list) and the CSP refuses the in-app navigation —
the preview never touches the network. The preview always renders the HOST's
copy, so unsaved edits are not shown; the toolbar says so.

### 5.8 Iconography — no character ever does an icon's job

**The rule: no character-as-icon anywhere in the app.** Not emoji, not
box-drawing, not arrows, not an icon font. Every glyph standing in for a
graphic affordance is a real inline SVG that inherits `currentColor`. Why:
font glyphs cannot be stroke-tuned or token-tinted, sit on the text baseline
rather than a control's optical centre, rotate around the wrong origin, and
colour emoji ignore CSS `color` outright — which is why this document's own
§5.7 asked for a `--warning` folder icon and could not have one for two
revisions.

**The mechanism** is one local component, `src/renderer/components/AppIcon.vue`
— no package, no loader. Contract: Feather 4.29 path data (MIT) verbatim;
one `24 24` viewBox so stroke weights are identical across the set; stroke
2, round caps; **colour always `currentColor`**; sizes 16 / 14 / 12 and no
others; flex-centring, never baseline (`display: block; flex: none` kills
the inline-SVG descender gap). **What stays text, deliberately:** `·`
separators, `…` inside a label, `—`/`–` as punctuation, `~` and `/` in
paths, `↑`/`↓` in shortcut tooltip copy, and the composer's `/` button — a
keycap for the literal character it inserts. A **bare** `…` as a button's
whole content is *not* text: those became the spinning refresh icon.

### 5.9 Motion

`--dur-fast` for state changes, the slow curve for things arriving. What
animates: hover tints, disclosure rotation, the overlay entrance, the
splitter highlight, meter width, the loading spin.

**What must NOT animate:**

- **The terminal. Ever.** No transition on `.terminal` or anything xterm
  renders — resize, attach and tab-switch are instant.
- **List-row hover.** VS Code renders list hover instantly because a cursor
  sweeping a list with lagging tints reads as smear, not smoothness. The
  absence of a `transition` here is deliberate — do not "fix" it.
- **Panel/splitter drag geometry** — width follows the pointer 1:1 (the
  composer's snapping happens on mouse-up for the same reason, COMPOSER.md
  §21.1).
- **Folder expand/collapse height** — the chevron rotation is the motion cue.

One global `prefers-reduced-motion` guard in `App.vue` covers everything, so
components carry no per-component reduced-motion blocks.

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
`TerminalView.vue` copies the selection on mouse-up; the user's
`settings.json` sets **`"copyOnSelect": false`** explicitly. The app is
doing the one thing the user turned off in the tool this spec is meant to
mirror. Still to make opt-in and default to off.

**2. Clipboard chords** — the terminal binds Ctrl/Cmd-**Shift**-C/V where the
user's `settings.json` remaps plain `ctrl+c`/`ctrl+v` (with the SIGINT
conditional plain Ctrl-C requires). The chord inventory and its reasoning
live in **docs/SHORTCUTS.md**.

**6. Android parity is deliberately broken in two places**, both on the
user's explicit instruction or on desktop-input grounds: mono font is
Consolas, not the phone's bundled JetBrains Mono (§2.3); tabs stay underlined
rather than becoming a filled segmented control (§5.4).

---

## 8. Themes — the palette became data

Added when the user asked for a light theme and then for "different themes
like in VS Code".

### 8.1 The shape: one record per theme, and nothing per-theme anywhere else

A theme is one object in `src/renderer/themes.ts`: stable `id` (persisted —
never renamed), `label`, `appearance` (`'dark' | 'light'` — **declared, not
guessed** from the background), `tokens` (every colour-carrying custom
property of §4.3, by name), and `terminal` (the complete xterm `ITheme`).
Applying is the pattern the app already had for fonts: one `watchEffect`
writes the tokens onto `<html>` (outranking `:root`), stamps `data-theme`,
sets `color-scheme` — everything that paints from the cascade retints on the
next frame. xterm is the one surface that cannot read the cascade, so
`TerminalView.vue` assigns `term.options.theme` from the same record and is
the only other consumer.

`system` is not a theme: it is a rule, resolved live through `matchMedia`,
picking between the two ids in `SYSTEM_THEME_IDS` — with several dark themes
registered, "which dark does the OS setting mean" is a product decision, not
a search. **The default is `dark`, not `system`**, because an upgrade must
not repaint the app of anyone whose OS happens to be in light mode — the
same rule every settings default here follows.

**To add a theme: write one record in `THEMES`. That is the whole recipe.**
Two executable gates in `tests/unit/themes.test.ts` hold the record to the
bar: token parity (exactly the token set the dark theme defines — welded to
`App.vue`'s `:root`) and the contrast floors of §8.2. A half-audited palette
fails `npm run test:unit`; it cannot ship by accident.

### 8.2 Contrast floors — the audit is executed, not remembered

WCAG 2.1 relative luminance, computed by the test for every theme:

| Pair | Floor | Why |
|---|---:|---|
| `--fg`, `--fg-secondary` on `--bg`/`--surface`/`--surface-2` | 4.5 | 13px body/secondary text (AA) |
| `--fg-muted` on `--bg` | 3 | ≥15px or decorative only (§4.2) |
| `--border-strong` on `--bg` and `--surface-2` | 3 | WCAG 1.4.11 control boundaries |
| `--accent`, `--success`, `--warning`, `--error`, `--agent` on `--bg` | 4.5 | read as text |
| `--on-accent` on `--accent` | 4.5 | filled-button labels |
| `--term-fg` and every `--code-*` text role on `--term-bg` | 4.5 | 13px editor prose |
| `--code-gutter-fg` on `--term-bg` | 3 | line numbers are decorative |

Where a scheme's own colour misses the floor for the role it takes, the
token holds the scheme's colour **lifted toward the readable pole with hue
preserved**, and the record's comment names the canonical origin and both
ratios.

### 8.3 The set, and where each palette comes from

Transcription discipline throughout (§3.1). Chosen to span the space —
neutral/cool/warm × dark/light — rather than four variations on dark blue:

| Theme | Appearance | Terminal source | UI derivation |
|---|---|---|---|
| **Dark** (default) | dark | Campbell, WT 1.24 `defaults.json` (§3) | §4 — GitHub-dark via the Android client |
| **Light** | light | GitHub Light ANSI, primer/primitives | GitHub Primer light — the same publisher as the dark UI, so `system` flips between one vendor's two designed modes |
| **Solarized Light** | light | Canonical table, ethanschoonover.com/solarized | The accents are designed midtones, so **more roles are lifted here than anywhere else** — recognisably Solarized, deliberately deeper-inked |
| **Nord** | dark | Official terminal mapping, nordtheme.com | nord0–nord3 are a ready-made elevation ramp; the famous 1.9:1 comment grey is lifted to 4.52 and says so |
| **Gruvbox Dark** | dark | morhetz/gruvbox | bg0…bg2 as the ramp, signature orange as the accent — the warm counterpart to Nord's cool |
| **One Dark** | dark | Atom One Dark | The blue-grey middle ground; One Dark's own caret blue kept as the cursor |

Accent identity: cyan is the product's accent in the dark and light
defaults; the adopted schemes keep their own signature accents, because a
Nord theme with a foreign cyan is not Nord.

### 8.5 What themes do NOT touch, and known limits

- **Non-colour tokens** — type scale, spacing, radii, density, motion — are
  not themed and live only in `:root`. A theme is a palette, not a layout.
- **Shadows became tokens** (`--shadow-overlay`, `--shadow-card`) because
  light themes cannot use black at half opacity — on white it reads as a
  hole, not a lift.
- **CodeMirror's `dark` flag follows the theme.** `codeEditorTheme.ts`
  builds its chrome once per appearance from ONE shared spec — the CSS is
  identical, because every value in it is a token — held in a `Compartment`
  and reconfigured on a theme change. The reconfigure dispatches a
  transaction carrying an **effect and no changes**, so the document, the
  selection, the undo history, the scroll position and the files store's
  **dirty flag** all survive (rebuilding the `EditorState`, the obvious
  alternative, loses all five). The appearance comes from the theme
  record's DECLARED `appearance`, never guessed from a background colour.
  Pinned by `tests/unit/CodeEditor.test.ts`.
- **A markdown preview is themed; an HTML or SVG preview is not.** The
  rendered markdown document is ours, so it is painted in the app's tokens.
  An HTML file brings its own styling and is deliberately left alone — a
  page that looked different here from how it looks in a browser would be a
  lie about the file. Because CSS custom properties do not cascade across a
  frame boundary, the token VALUES travel: the renderer resolves them out of
  computed style and main writes them into the generated document's own
  `:root`, re-validating every one. A theme switch re-mints, because a
  sandboxed frame with no scripts cannot be re-tinted in place. See §5.7b.
- **Terminal contents are the remote's.** A theme changes the 16 ANSI slots;
  a remote program that hardcodes 256-colour or truecolor output will look
  however it looks. That is every terminal emulator's contract.
