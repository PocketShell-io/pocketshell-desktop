# PocketShell Desktop — Design System

Status: **implemented.** This is the reference for the app's design system —
type, colour tokens, primitives, iconography, motion, themes. The code is the
source of truth for values: tokens, theme records and presentational CSS live
in the shared UI package (`@ui` — the `pocketshell-core` sibling's
`packages/ui`, §9); per-feature decisions live in the components and the
feature docs (`COMPOSER.md`, `SHORTCUTS.md`).

---

## 2. Typography

### 2.2 Inter Variable

The UI font is Inter Variable, bundled (`@fontsource-variable/inter`), not
fetched — the renderer loads over `file://` with no connectivity guarantee.
Every number column sets `font-variant-numeric: tabular-nums`, so figures do
not jitter between rows. Fallback stack:

```css
--font-ui: 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI',
           system-ui, sans-serif;
```

### 2.3 Monospace

```css
--font-mono: Consolas, 'Cascadia Mono', ui-monospace, monospace;
```

Consolas matches the user's Windows Terminal, so the terminal and the UI
framing it read as one surface. It is only the default of the one
`monospaceFontFamily` setting (`@ui/fonts.ts`), written onto `<html>` so it
moves the terminal, the editor and every mono chrome element together. The
stored value is a single family name (no quotes, braces or commas), PREPENDED
to the stack — never substituted for it — so a missing face falls through to
`monospace` and no setting can smuggle in a proportional face. Size is two
settings, `terminalFontSize` and `editorFontSize`, clamped 8–32: the
terminal's size is visible to the remote (it sets the PTY geometry), the
editor's is not.

### 2.4 Type scale

The Android ladder in `Type.kt` (11 / 13 / 15 / 16 / 18 / 20 sp) maps 1:1 to
px as the `--fs-*` tokens in `@ui/tokens.css`; `--fs-300` (13px) with its
18px line height is the workhorse, matching Android's `bodyDense` exactly,
so a 13px row is 18px tall in both clients. Weights: 400 body, 500 list-row
titles, 600 headers, 700 the wordmark only — **do not use 800/900**.
`-webkit-font-smoothing: antialiased`.

---

## 3. Terminal

The terminal follows the user's Windows Terminal: Consolas; `fontSize` **16**
— the literal default of `terminalFontSize`, which must not shift, or an
upgrade silently resizes every existing user's terminal; the built-in
Campbell scheme transcribed verbatim into the `--term-*`/ANSI tokens; xterm
`minimumContrastRatio: 3`, lifting only the pairs Campbell itself fails; and
Unicode 11 character widths. Everything not themed and not user-settable
lives in `TERMINAL_OPTIONS` in `TerminalView.vue`, each value traceable to a
`defaults.json` line.

---

## 4. Colour tokens

### 4.1 The palette

The UI palette is the Android client's GitHub-dark-derived palette — two
clients of one product. Campbell's `#0C0C0C` against `#0D1117` reads as a
deeper well in the same neutral family.

### 4.2 Contrast rules (computed, WCAG 2.1)

The floors are computed per theme by `tests/unit/themes.test.ts` (§8.2).
Rules for authors:

- `--fg-muted` (4.12:1) is below AA for body text — ≥15px text or decorative
  content only; real information (timestamps, counts) takes `--fg-secondary`
  (6.15:1).
- `--error` on `--surface-2` is marginally under AA — error text inside
  inputs and menus sits on `--surface` or `--bg`.
- A boundary that is the only way to identify a control needs 3:1 (WCAG
  1.4.11): `--border` is a decorative hairline; controls that must
  self-identify (inputs, at-rest toggles) are drawn with `--border-strong`.

### 4.3 The token block — shipped in `@ui/tokens.css`, one theme of several

The `:root` block in `@ui/tokens.css` is the no-JS default; the applied
theme's record is written over it as inline custom properties on `<html>`
(§8), and `tests/unit/themes.test.ts` asserts the two copies identical, so
neither can drift. Hover is a neutral lift (~5% white), not a tint — tinted
hover would read as selection.

---

## 5. Layout & components

Screen-level layout decisions live with their screens and components
(`COMPOSER.md`); this section holds only the cross-screen
system.

### 5.0 Global rules

`tabular-nums` on every number column. **The focus ring is the only focus
treatment** in a keyboard-driven app: every focusable element gets the token
ring, except rows inside scrolling lists, which take the inset variant
(`outline-offset: -2px`) because scrolling lists clip an outward ring.

### 5.1 Shared primitives

`.icon-btn`, `.muted`, `.error` and `.empty` exist once each as global
classes in `@ui/primitives.css` — extract-then-restyle, never hand-copy.
Controls are **ghost** by default (invisible at rest, filled on hover, square
by construction at `--control-h`); a bordered look survives only where chrome
is earned: filled accent actions, toggles, form controls, status chips. Every
badge-like element shares one metric (`padding: 0 var(--sp-1)`,
`line-height: var(--lh-100)`, inline-flex).

### 5.7b Document preview

HTML, markdown and SVG open as render + source behind one segmented toggle
over the sandboxed `psview:` frame; the pipeline and its guarantees live in
`docs/ARCHITECTURE.md` (Files pane).

### 5.8 Iconography — no character does an icon's job

No character-as-icon anywhere: no emoji, box-drawing, arrows or icon font.
Every icon is an inline SVG through `@ui/components/AppIcon.vue` — Feather
4.29 path data verbatim, one `24 24` viewBox so stroke weights match across
the set, stroke 2, round caps, colour always `currentColor`, sizes 16 / 14 /
12 and no others, flex-centred (`display: block; flex: none` kills the
inline-SVG descender gap). What stays text, deliberately: `·` separators,
`…` inside a label, `—`/`–` as punctuation, `~` and `/` in paths, `↑`/`↓` in
shortcut copy, and the composer's `/` keycap — a keycap for the character it
inserts.

### 5.9 Motion

`--dur-fast` for state changes, the slow curve for things arriving (overlay
entrance, disclosure rotation, meter width, the loading spin). What must NOT
animate:

- **The terminal, ever** — resize, attach and tab-switch are instant.
- **List-row hover** — a cursor sweeping a list with lagging tints reads as
  smear. The missing `transition` is deliberate; do not "fix" it.
- **Drag geometry** — panel width follows the pointer 1:1.
- **Folder expand/collapse height** — the chevron rotation is the cue.

One global `prefers-reduced-motion` guard in `@ui/primitives.css` covers
everything; components carry no per-component blocks.

---

## 6. Enforcement — the design gates are executable

`tests/unit/designGates.test.ts` runs on every `npm run test:unit`:

1. **Colour tokens** — raw hex belongs only to `@ui/tokens.css`,
   `@ui/themes.ts` and `TerminalView.vue`'s Campbell theme; components paint
   from the tokens.
2. **No character-as-icon** (§5.8) — the glyph blacklist matches nothing
   outside code comments, §5.8's genuine-text list, and `TerminalView.vue`,
   whose glyphs come from the remote program.

---

## 8. Themes

### 8.1 One record per theme

A theme is one object in `@ui/themes.ts`: stable `id` (persisted, never
renamed), `label`, `appearance` (`'dark' | 'light'` — declared, not guessed
from the background), `tokens` (every colour-carrying custom property of
§4.3, by name) and `terminal` (the complete xterm `ITheme`). One
`watchEffect` writes the tokens onto `<html>`, stamps `data-theme` and sets
`color-scheme`; xterm — the one surface that cannot read the cascade — is
assigned `term.options.theme` from the same record. `system` is not a theme
but a rule resolved live through `matchMedia`; the default is `dark`, so an
upgrade never repaints anyone whose OS happens to be in light mode.

**To add a theme: write one record in `THEMES`. That is the whole recipe.**
`tests/unit/themes.test.ts` holds it to token parity with `tokens.css` and
the §8.2 floors; a half-audited palette fails `npm run test:unit`.

### 8.2 Contrast floors

| Pair | Floor | Why |
|---|---:|---|
| `--fg`, `--fg-secondary` on `--bg`/`--surface`/`--surface-2` | 4.5 | 13px body/secondary text (AA) |
| `--fg-muted` on `--bg` | 3 | ≥15px or decorative only (§4.2) |
| `--border-strong` on `--bg` and `--surface-2` | 3 | WCAG 1.4.11 control boundaries |
| `--accent`, `--success`, `--warning`, `--error`, `--agent` on `--bg` | 4.5 | read as text |
| `--on-accent` on `--accent` | 4.5 | filled-button labels |
| `--term-fg` and every `--code-*` text role on `--term-bg` | 4.5 | 13px editor prose |
| `--code-gutter-fg` on `--term-bg` | 3 | line numbers are decorative |

Where a scheme's colour misses the floor for the role it takes, the token
holds that colour lifted toward the readable pole with hue preserved, and the
record's comment names the origin and both ratios.

### 8.3 The set

Terminal ANSI sets are transcribed from canonical sources, never invented —
transcription is verifiable:

| Theme | Appearance | Terminal source |
|---|---|---|
| **Dark** (default) | dark | Campbell, Windows Terminal `defaults.json` |
| **Light** | light | GitHub Light ANSI, primer/primitives |
| **Solarized Light** | light | ethanschoonover.com/solarized |
| **Nord** | dark | nordtheme.com official mapping |
| **Gruvbox Dark** | dark | morhetz/gruvbox |
| **One Dark** | dark | Atom One Dark |

Adopted schemes keep their signature accents — a Nord theme with a foreign
cyan is not Nord.

### 8.5 What themes do NOT touch

- Non-colour tokens (type scale, spacing, radii, density, motion) live only
  in `:root` — a theme is a palette, not a layout.
- Shadows are tokens (`--shadow-overlay`, `--shadow-card`) because black at
  half opacity reads as a hole on light backgrounds, not a lift.
- CodeMirror's chrome is rebuilt per appearance through a `Compartment`
  reconfigure that carries an effect and no changes, so the document,
  selection, history, scroll position and dirty flag survive —
  `codeEditorTheme.ts`, pinned by `tests/unit/CodeEditor.test.ts`.
- A markdown preview is themed (it is our document); an HTML or SVG preview
  is not (it is the file's) — `src/main/preview/`.
- Terminal contents are the remote's: a theme changes the 16 ANSI slots, and
  hardcoded 256-colour or truecolor output looks however it looks.

---

## 9. Shared source — the `pocketshell-core` sibling

The shared visual package lives in the `pocketshell-core` sibling repo, at
`packages/ui` (the `@pocketshell/ui` source package): tokens, typography and
the licensed Inter Variable font, theme records, `AppIcon`,
`ComposerControls`. This repo consumes it as source through the `@ui` Vite
alias — no registry, no second copy. Components accept props and emit
events; Electron IPC, Pinia stores and host I/O stay in the desktop app. The
pure logic the clients share sits in the same repo as `@pocketshell/core`;
how the web and Android clients consume both is documented there.
