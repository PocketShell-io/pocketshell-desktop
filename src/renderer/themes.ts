/**
 * Themes as DATA: one record per theme, and nothing per-theme anywhere else.
 *
 * A theme is the complete set of colour decisions the app makes — the CSS
 * token block App.vue ships as `:root`, plus the two surfaces that cannot read
 * the cascade: xterm (rasterises from an options object) and, indirectly,
 * anything that keys off `appearance`. So a record carries exactly three
 * things: the token values, the xterm ANSI palette, and whether the theme is
 * light or dark. Applying one is a loop writing custom properties onto
 * `<html>` (App.vue, the same pattern as the font settings) plus one
 * `term.options.theme` assignment (TerminalView).
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD A THEME — one object in THEMES, and nothing else.
 * ---------------------------------------------------------------------------
 * Copy an existing record of the same appearance and change the values. The
 * registry drives everything downstream: the Settings picker lists whatever is
 * here, the settings store accepts whatever ids exist here, and the tests in
 * tests/unit/themes.test.ts hold every record to the same two gates —
 *
 *   1. token parity: a record must define exactly the tokens the dark theme
 *      defines (which are welded to App.vue's `:root` by the same test), so a
 *      new theme cannot silently leave a surface unthemed;
 *   2. contrast: the text roles must meet the WCAG floors — the audit is executed, not remembered.
 *
 * A record that fails either gate fails `npm run test:unit`; there is no way
 * to ship a half-audited palette by accident.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE PALETTES COME FROM
 * ---------------------------------------------------------------------------
 * Terminal ANSI sets are TRANSCRIBED from their published sources, verbatim,
 * cited on each record — the same discipline the dark theme's Campbell block
 * has always followed (: read out of Windows Terminal's own
 * defaults.json, not reconstructed). Transcription is verifiable; invention is
 * not. Render-time legibility of a scheme's own weak pairs is xterm's
 * `minimumContrastRatio: 3`, exactly as it is for Campbell's dim blue.
 *
 * The UI tokens are NOT part of any published terminal scheme — sixteen ANSI
 * colours plus a ground do not give you a surface ramp, a border, or a muted
 * text role — so those are DERIVED per theme, and audited. Where a scheme's
 * own colour misses a WCAG floor for the role it takes, the value here is the
 * scheme's colour lifted toward the readable pole (hue preserved) until it
 * meets the floor, and the comment says so. That mirrors the dark theme's own
 * precedent: its `--code-comment` is a lifted Campbell brightBlack, and its
 * `--code-meta` a substitution, both documented in App.vue.
 *
 * All ratios in comments are WCAG 2.1 relative-luminance, against the theme's
 * `--bg` unless the comment names another ground, and every one of them is
 * re-computed by the contrast test rather than trusted.
 */
import { ref } from 'vue';
import type { ITheme } from '@xterm/xterm';

export type ThemeAppearance = 'dark' | 'light';

export interface ThemeSpec {
  /** Stable id — what the settings store persists. Never rename one. */
  id: string;
  /** What the Settings picker shows. */
  label: string;
  /**
   * Declared, not guessed from the background: it decides which side of the
   * `system` choice this theme can serve, and the `color-scheme` App.vue sets
   * so form controls and scrollbars agree with the surfaces.
   */
  appearance: ThemeAppearance;
  /** The CSS custom properties written onto `<html>`. Keys include the `--`. */
  tokens: Readonly<Record<string, string>>;
  /** The xterm palette. `foreground`/`background` must equal the two
   * `--term-*` tokens — the Settings samples and the editor read the tokens,
   * xterm reads this, and the test holds them equal. */
  terminal: ITheme;
}

/* ---------------------------------------------------------------------------
 * Dark — what ships, untouched. GitHub-dark-derived UI,
 * Campbell terminal (transcribed from Windows Terminal 1.24 defaults.json).
 * These values are duplicated from App.vue's `:root` block ON PURPOSE: `:root`
 * stays readable as "what ships" and works with no JavaScript at all, and the
 * parity test asserts this record and that block never drift.
 * ------------------------------------------------------------------------- */
const DARK: ThemeSpec = {
  id: 'dark',
  label: 'Dark',
  appearance: 'dark',
  tokens: {
    '--bg': '#0d1117',
    '--surface': '#161b22',
    '--surface-2': '#1c2129',
    '--surface-3': '#232a34',
    '--scrim': 'rgba(1, 4, 9, 0.72)',
    '--fg': '#e6edf3',
    '--fg-secondary': '#8b949e',
    '--fg-muted': '#6e7681',
    '--border': '#2d333b',
    '--border-soft': '#21262d',
    '--border-strong': '#6e7681',
    '--accent': '#22d3ee',
    '--accent-dim': '#0891b2',
    '--accent-soft': 'rgba(34, 211, 238, 0.12)',
    '--on-accent': '#04101a',
    '--success': '#22c55e',
    '--warning': '#f59e0b',
    '--error': '#ef4444',
    '--agent': '#a78bfa',
    '--success-soft': 'rgba(34, 197, 94, 0.12)',
    '--warning-soft': 'rgba(245, 158, 11, 0.12)',
    '--error-soft': 'rgba(239, 68, 68, 0.12)',
    '--agent-soft': 'rgba(167, 139, 250, 0.14)',
    '--state-hover': 'rgba(230, 237, 243, 0.05)',
    '--state-active': 'rgba(230, 237, 243, 0.09)',
    '--shadow-overlay': '0 16px 48px rgba(0, 0, 0, 0.5)',
    '--shadow-card': '0 8px 32px rgba(0, 0, 0, 0.5)',
    '--term-bg': '#0c0c0c',
    '--term-fg': '#cccccc',
    '--code-comment': '#8b949e',
    '--code-keyword': '#3b78ff',
    '--code-string': '#c19c00',
    '--code-number': '#16c60c',
    '--code-function': '#f9f1a5',
    '--code-type': '#61d6d6',
    '--code-variable': '#cccccc',
    '--code-tag': '#3a96dd',
    '--code-attribute': '#61d6d6',
    '--code-punctuation': '#8b949e',
    '--code-meta': '#a78bfa',
    '--code-invalid': '#e74856',
    '--code-link': '#22d3ee',
    '--code-heading': '#f2f2f2',
    '--code-inserted': '#16c60c',
    '--code-deleted': '#e74856',
    '--code-gutter-fg': '#767676',
    '--code-gutter-fg-active': '#cccccc',
    '--code-active-line': 'rgba(255, 255, 255, 0.04)',
    '--code-selection': 'rgba(255, 255, 255, 0.22)',
    '--code-selection-inactive': 'rgba(255, 255, 255, 0.1)',
    '--code-cursor': '#ffffff',
    '--code-bracket-match': 'rgba(34, 211, 238, 0.25)',
  },
  // Windows Terminal's built-in "Campbell", verbatim — the same block that
  // lived inline in TerminalView.vue since , moved here so
  // a theme switch is a lookup rather than an edit. Provenance: WT 1.24
  // defaults.json (the user's settings.json has "schemes": [] and no
  // colorScheme key, so Campbell is what they actually see).
  terminal: {
    background: '#0C0C0C',
    foreground: '#CCCCCC',
    cursor: '#FFFFFF',
    cursorAccent: '#0C0C0C',
    // Campbell defines no selectionBackground; Windows Terminal falls back to
    // white drawn at ~50% alpha. Kept translucent so text stays readable.
    selectionBackground: 'rgba(255, 255, 255, 0.35)',
    selectionInactiveBackground: 'rgba(255, 255, 255, 0.18)',
    black: '#0C0C0C',
    red: '#C50F1F',
    green: '#13A10E',
    yellow: '#C19C00',
    blue: '#0037DA',
    magenta: '#881798',
    cyan: '#3A96DD',
    white: '#CCCCCC',
    brightBlack: '#767676',
    brightRed: '#E74856',
    brightGreen: '#16C60C',
    brightYellow: '#F9F1A5',
    brightBlue: '#3B78FF',
    brightMagenta: '#B4009E',
    brightCyan: '#61D6D6',
    brightWhite: '#F2F2F2',
  },
};

/* ---------------------------------------------------------------------------
 * Light — GitHub Primer light, the mirror of the dark theme's own derivation:
 * the dark UI palette is the Android client's GitHub-dark scheme, so the light
 * one is the SAME publisher's light scheme rather than an invention. Terminal
 * ANSI transcribed from primer/primitives (GitHub's published light ANSI set,
 * designed against white). The code palette is GitHub's own light syntax
 * palette (prettylights): unlike Campbell, this scheme's publisher ships a
 * purpose-built editor palette for this exact ground, and transcribing it
 * beats forcing ANSI slots into syntax roles — the same reasoning that had
 * dark's editor derive from ITS terminal scheme.
 * ------------------------------------------------------------------------- */
const LIGHT: ThemeSpec = {
  id: 'light',
  label: 'Light',
  appearance: 'light',
  tokens: {
    '--bg': '#ffffff', /* Primer canvas-default */
    '--surface': '#f6f8fa', /* canvas-subtle: topbar, panels, overlay body */
    '--surface-2': '#eaeef2', /* inputs, chips, menus */
    '--surface-3': '#ffffff', /* popovers: white above a subtle overlay body */
    '--scrim': 'rgba(31, 35, 40, 0.48)',
    '--fg': '#1f2328', /* 15.80:1 */
    '--fg-secondary': '#59636e', /* 6.11:1; 5.24:1 on --surface-2 */
    '--fg-muted': '#6e7781', /* 4.55:1 — >=15px or decorative ONLY */
    '--border': '#d0d7de', /* Primer border-default */
    '--border-soft': '#d8dee4', /* Primer border-muted */
    '--border-strong': '#6e7781', /* 4.55:1; 3.90:1 on --surface-2 */
    /* Cyan stays the product's accent in every theme; #22d3ee is 1.62:1 on
       white, so the light accent is the same hue two steps down. */
    '--accent': '#0e7490', /* 5.36:1 */
    '--accent-dim': '#155e75',
    '--accent-soft': 'rgba(14, 116, 144, 0.12)',
    '--on-accent': '#ffffff', /* 5.36:1 on --accent */
    '--success': '#15803d', /* 5.02:1 */
    '--warning': '#b45309', /* 5.02:1 */
    '--error': '#b91c1c', /* 6.47:1; 5.55:1 on --surface-2 */
    '--agent': '#6d28d9', /* 7.10:1 */
    '--success-soft': 'rgba(21, 128, 61, 0.12)',
    '--warning-soft': 'rgba(180, 83, 9, 0.12)',
    '--error-soft': 'rgba(185, 28, 28, 0.12)',
    '--agent-soft': 'rgba(109, 40, 217, 0.12)',
    /* Ink washes, not white ones: hover on a light ground darkens. */
    '--state-hover': 'rgba(31, 35, 40, 0.05)',
    '--state-active': 'rgba(31, 35, 40, 0.09)',
    /* Light shadows are soft ink, never black at 0.5 — a dark-theme shadow on
       white reads as a hole in the page. */
    '--shadow-overlay': '0 16px 48px rgba(31, 35, 40, 0.2)',
    '--shadow-card': '0 8px 32px rgba(31, 35, 40, 0.18)',
    '--term-bg': '#ffffff',
    '--term-fg': '#1f2328', /* 15.80:1 */
    /* GitHub prettylights (light), ratios on #ffffff. */
    '--code-comment': '#57606a', /* 6.39:1 */
    '--code-keyword': '#cf222e', /* 5.36:1 */
    '--code-string': '#0a3069', /* 12.81:1 */
    '--code-number': '#0550ae', /* 7.59:1 */
    '--code-function': '#6639ba', /* 7.34:1 */
    '--code-type': '#953800', /* 7.39:1 */
    '--code-variable': '#1f2328', /* 15.80:1 */
    '--code-tag': '#116329', /* 7.39:1 */
    '--code-attribute': '#0550ae', /* 7.59:1 */
    '--code-punctuation': '#57606a', /* 6.39:1 */
    '--code-meta': '#8250df', /* 5.05:1 */
    '--code-invalid': '#82071e', /* 10.51:1 */
    '--code-link': '#0e7490', /* 5.36:1 — the app accent, as in dark */
    '--code-heading': '#1f2328', /* the STRONGEST text, as dark's brightWhite is */
    '--code-inserted': '#116329', /* 7.39:1 */
    '--code-deleted': '#cf222e', /* 5.36:1 */
    '--code-gutter-fg': '#8c959f', /* 3.04:1 — decorative floor */
    '--code-gutter-fg-active': '#1f2328',
    '--code-active-line': 'rgba(31, 35, 40, 0.04)',
    '--code-selection': 'rgba(31, 35, 40, 0.16)',
    '--code-selection-inactive': 'rgba(31, 35, 40, 0.08)',
    '--code-cursor': '#1f2328',
    '--code-bracket-match': 'rgba(14, 116, 144, 0.22)',
  },
  // "GitHub Light" ANSI, transcribed from primer/primitives. GitHub designed
  // these sixteen against white — including the near-brown yellows, which is
  // what an actually-legible yellow on white is.
  terminal: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(31, 35, 40, 0.2)',
    selectionInactiveBackground: 'rgba(31, 35, 40, 0.1)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
  },
};

/* ---------------------------------------------------------------------------
 * Solarized Light — Ethan Schoonover's palette, transcribed from the canonical
 * table at ethanschoonover.com/solarized. Solarized's accents are DESIGNED as
 * midtones (~3–4:1 on its own grounds — the scheme values symmetric lightness
 * over contrast), so more roles need lifting here than in any other theme;
 * every lifted value names its canonical origin. The terminal ANSI block stays
 * verbatim, with one stated exception: the foreground, which the editor and
 * samples share via --term-fg, is base00 lifted from 4.13:1 to meet the 4.5
 * text floor.
 * ------------------------------------------------------------------------- */
const SOLARIZED_LIGHT: ThemeSpec = {
  id: 'solarized-light',
  label: 'Solarized Light',
  appearance: 'light',
  tokens: {
    '--bg': '#fdf6e3', /* base3 */
    '--surface': '#eee8d5', /* base2 — the scheme's own "background highlights" */
    '--surface-2': '#e4dcc3', /* base2 stepped toward base1 */
    '--surface-3': '#fdf6e3',
    '--scrim': 'rgba(0, 43, 54, 0.5)', /* base03 ink */
    /* base00 (#657b83), the canonical body ink, is 4.13:1 on base3 and 3.25:1
       on --surface-2 — under the floor at 13px. Body text takes base02; the
       quiet roles keep the base00/base1 family, lifted. */
    '--fg': '#073642', /* base02 — 12.05:1 */
    '--fg-secondary': '#53646b', /* base00 lifted — 5.72:1; 4.50:1 on --surface-2 */
    '--fg-muted': '#859191', /* base1 lifted — 3.02:1, decorative roles only */
    '--border': '#d0d0c3',
    '--border-soft': '#dfdccc',
    '--border-strong': '#657b83', /* base00 — 4.13:1; 3.25:1 on --surface-2 */
    '--accent': '#2076b3', /* blue #268bd2 lifted from 3.41:1 — 4.52:1 */
    '--accent-dim': '#196391',
    '--accent-soft': 'rgba(32, 118, 179, 0.12)',
    '--on-accent': '#ffffff', /* 4.88:1 on --accent */
    '--success': '#697800', /* green #859900 lifted from 2.97:1 — 4.54:1 */
    '--warning': '#c44915', /* orange #cb4b16 lifted from 4.27:1 — 4.52:1 */
    '--error': '#d5312e', /* red #dc322f lifted from 4.29:1 — 4.52:1 */
    '--agent': '#666ab8', /* violet #6c71c4 lifted from 4.06:1 — 4.51:1 */
    '--success-soft': 'rgba(133, 153, 0, 0.14)',
    '--warning-soft': 'rgba(203, 75, 22, 0.12)',
    '--error-soft': 'rgba(220, 50, 47, 0.12)',
    '--agent-soft': 'rgba(108, 113, 196, 0.14)',
    '--state-hover': 'rgba(7, 54, 66, 0.05)',
    '--state-active': 'rgba(7, 54, 66, 0.09)',
    '--shadow-overlay': '0 16px 48px rgba(0, 43, 54, 0.22)',
    '--shadow-card': '0 8px 32px rgba(0, 43, 54, 0.2)',
    '--term-bg': '#fdf6e3',
    '--term-fg': '#60747c', /* base00 lifted from 4.13:1 — 4.54:1 */
    /* Solarized IS a syntax palette (that is what it was designed as), so the
       roles map straight onto its accents — every one lifted to the 4.5 floor,
       canonical origin named. Ratios on base3. */
    '--code-comment': '#697373', /* base1 #93a1a1 lifted from 2.48:1 — 4.53:1 */
    '--code-keyword': '#697800', /* green #859900 lifted — 4.54:1 */
    '--code-string': '#217e77', /* cyan #2aa198 lifted from 2.93:1 — 4.51:1 */
    '--code-number': '#ca347d', /* magenta #d33682 lifted — 4.53:1 */
    '--code-function': '#2076b3', /* blue #268bd2 lifted — 4.52:1 */
    '--code-type': '#8f6c00', /* yellow #b58900 lifted from 2.98:1 — 4.51:1 */
    '--code-variable': '#60747c', /* = --term-fg */
    '--code-tag': '#2076b3', /* blue, as Solarized's html mapping */
    '--code-attribute': '#8f6c00', /* yellow */
    '--code-punctuation': '#697373', /* base1 lifted */
    '--code-meta': '#666ab8', /* violet lifted — 4.51:1 */
    '--code-invalid': '#d5312e', /* red lifted — 4.52:1 */
    '--code-link': '#2076b3',
    '--code-heading': '#073642', /* base02 — 12.05:1 */
    '--code-inserted': '#697800',
    '--code-deleted': '#d5312e',
    '--code-gutter-fg': '#859191', /* 3.02:1 — decorative floor */
    '--code-gutter-fg-active': '#586e75', /* base01 — 4.99:1 */
    '--code-active-line': 'rgba(7, 54, 66, 0.04)',
    '--code-selection': 'rgba(7, 54, 66, 0.15)',
    '--code-selection-inactive': 'rgba(7, 54, 66, 0.07)',
    '--code-cursor': '#073642',
    '--code-bracket-match': 'rgba(32, 118, 179, 0.25)',
  },
  // Canonical Solarized ANSI mapping (ethanschoonover.com/solarized): the
  // eight accents plus the base tones in the bright slots, verbatim. The
  // bright slots landing on base01/base00 (2.5–4:1 here) is the scheme's
  // design; xterm's minimumContrastRatio lifts them at render time.
  terminal: {
    background: '#fdf6e3',
    foreground: '#60747c', // base00 #657b83 lifted to the 4.5 floor — see --term-fg
    cursor: '#073642',
    cursorAccent: '#fdf6e3',
    selectionBackground: 'rgba(7, 54, 66, 0.18)',
    selectionInactiveBackground: 'rgba(7, 54, 66, 0.09)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
};

/* ---------------------------------------------------------------------------
 * Nord — transcribed from the official palette (nordtheme.com; nord0–nord15).
 * The four Polar Night tones are a ready-made elevation ramp, which is why the
 * surfaces here are pure transcription. Nord's one famous weakness — comment
 * grey nord3 at 1.9:1 — is lifted hard and said so.
 * ------------------------------------------------------------------------- */
const NORD: ThemeSpec = {
  id: 'nord',
  label: 'Nord',
  appearance: 'dark',
  tokens: {
    '--bg': '#2e3440', /* nord0 */
    '--surface': '#3b4252', /* nord1 */
    '--surface-2': '#434c5e', /* nord2 */
    '--surface-3': '#4c566a', /* nord3 */
    '--scrim': 'rgba(22, 25, 32, 0.72)',
    '--fg': '#eceff4', /* nord6 — 10.84:1 */
    '--fg-secondary': '#b3bccb', /* nord4 dimmed — 6.51:1; 4.51:1 on --surface-2 */
    '--fg-muted': '#8792a5', /* 3.98:1 — >=15px or decorative ONLY */
    '--border': '#3f4758',
    '--border-soft': '#363c4b',
    '--border-strong': '#8f99ab', /* 4.36:1; 3.00:1 on --surface-2 */
    '--accent': '#88c0d0', /* nord8, the Frost accent — 6.24:1 */
    '--accent-dim': '#5e81ac', /* nord10 */
    '--accent-soft': 'rgba(136, 192, 208, 0.12)',
    '--on-accent': '#2e3440', /* 6.24:1 on --accent */
    '--success': '#a3be8c', /* nord14 — 6.13:1 */
    '--warning': '#ebcb8b', /* nord13 — 8.00:1 */
    '--error': '#cf888f', /* nord11 #bf616a lifted from 3.05:1 — 4.50:1 */
    '--agent': '#b590af', /* nord15 #b48ead lifted from 4.41:1 — 4.50:1 */
    '--success-soft': 'rgba(163, 190, 140, 0.12)',
    '--warning-soft': 'rgba(235, 203, 139, 0.12)',
    '--error-soft': 'rgba(191, 97, 106, 0.14)', /* fills keep canonical nord11 */
    '--agent-soft': 'rgba(180, 142, 173, 0.14)',
    '--state-hover': 'rgba(236, 239, 244, 0.05)',
    '--state-active': 'rgba(236, 239, 244, 0.09)',
    '--shadow-overlay': '0 16px 48px rgba(0, 0, 0, 0.5)',
    '--shadow-card': '0 8px 32px rgba(0, 0, 0, 0.5)',
    '--term-bg': '#2e3440', /* Nord's terminal ground IS nord0 */
    '--term-fg': '#d8dee9', /* nord4 — 9.25:1 */
    /* Nord's own syntax mapping (nordtheme.com docs: comments nord3, strings
       nord14, numbers nord15, keywords nord9, functions nord8, types nord7).
       Ratios on nord0. */
    '--code-comment': '#939cad', /* nord3 #4c566a lifted from 1.90:1 — 4.52:1 */
    '--code-keyword': '#81a1c1', /* nord9 — 4.64:1 */
    '--code-string': '#a3be8c', /* nord14 — 6.13:1 */
    '--code-number': '#b590af', /* nord15 lifted — 4.50:1 */
    '--code-function': '#88c0d0', /* nord8 — 6.24:1 */
    '--code-type': '#8fbcbb', /* nord7 — 5.99:1 */
    '--code-variable': '#d8dee9', /* nord4 — 9.25:1 */
    '--code-tag': '#81a1c1', /* nord9 */
    '--code-attribute': '#8fbcbb', /* nord7 */
    '--code-punctuation': '#aeb7c8', /* nord4 dimmed — 6.19:1 */
    '--code-meta': '#b590af', /* nord15 lifted */
    '--code-invalid': '#cf888f', /* nord11 lifted — 4.50:1 */
    '--code-link': '#88c0d0',
    '--code-heading': '#eceff4', /* nord6 — 10.84:1 */
    '--code-inserted': '#a3be8c',
    '--code-deleted': '#cf888f',
    '--code-gutter-fg': '#717d94', /* nord3 lifted to 3.01:1 — decorative floor */
    '--code-gutter-fg-active': '#d8dee9',
    '--code-active-line': 'rgba(236, 239, 244, 0.04)',
    '--code-selection': 'rgba(236, 239, 244, 0.22)',
    '--code-selection-inactive': 'rgba(236, 239, 244, 0.1)',
    '--code-cursor': '#d8dee9',
    '--code-bracket-match': 'rgba(136, 192, 208, 0.25)',
  },
  // Official Nord terminal mapping (nordtheme.com/docs/colors-and-palettes):
  // Nord repeats its Aurora colours across normal and bright slots by design.
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: 'rgba(236, 239, 244, 0.22)',
    selectionInactiveBackground: 'rgba(236, 239, 244, 0.11)',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
};

/* ---------------------------------------------------------------------------
 * Gruvbox Dark — transcribed from morhetz/gruvbox (dark, medium contrast).
 * The bg0…bg2 greys are the surface ramp; the accent is gruvbox's signature
 * orange. The warm counterpart to Nord's cool.
 * ------------------------------------------------------------------------- */
const GRUVBOX_DARK: ThemeSpec = {
  id: 'gruvbox-dark',
  label: 'Gruvbox Dark',
  appearance: 'dark',
  tokens: {
    '--bg': '#282828', /* bg0 */
    '--surface': '#32302f', /* bg0_s */
    '--surface-2': '#3c3836', /* bg1 */
    '--surface-3': '#504945', /* bg2 */
    '--scrim': 'rgba(29, 32, 33, 0.72)', /* bg0_h ink */
    '--fg': '#ebdbb2', /* fg1 — 10.75:1 */
    '--fg-secondary': '#aea08c', /* fg4 #a89984 lifted — 5.65:1; 4.53:1 on --surface-2 */
    '--fg-muted': '#928374', /* gray — 4.02:1 */
    '--border': '#413d3a',
    '--border-soft': '#343230',
    '--border-strong': '#928374', /* 4.02:1; 3.16:1 on --surface-2 */
    '--accent': '#fe8019', /* bright orange, THE gruvbox accent — 5.84:1 */
    '--accent-dim': '#d65d0e', /* orange */
    '--accent-soft': 'rgba(254, 128, 25, 0.12)',
    '--on-accent': '#282828', /* 5.84:1 on --accent */
    '--success': '#b8bb26', /* bright green — 7.14:1 */
    '--warning': '#fabd2f', /* bright yellow — 8.69:1 */
    '--error': '#fb533f', /* bright red #fb4934 lifted from 4.29:1 — 4.50:1 */
    '--agent': '#d3869b', /* bright purple — 5.37:1 */
    '--success-soft': 'rgba(184, 187, 38, 0.12)',
    '--warning-soft': 'rgba(250, 189, 47, 0.12)',
    '--error-soft': 'rgba(251, 73, 52, 0.14)',
    '--agent-soft': 'rgba(211, 134, 155, 0.14)',
    '--state-hover': 'rgba(235, 219, 178, 0.05)',
    '--state-active': 'rgba(235, 219, 178, 0.09)',
    '--shadow-overlay': '0 16px 48px rgba(0, 0, 0, 0.5)',
    '--shadow-card': '0 8px 32px rgba(0, 0, 0, 0.5)',
    '--term-bg': '#282828',
    '--term-fg': '#ebdbb2', /* 10.75:1 */
    /* gruvbox.vim's own mapping: keywords red, strings green, functions
       yellow, types/tags aqua, numbers purple. Ratios on bg0. */
    '--code-comment': '#9a8c7e', /* gray #928374 lifted from 4.02:1 — 4.51:1 */
    '--code-keyword': '#fb533f', /* bright red lifted — 4.50:1 */
    '--code-string': '#b8bb26', /* bright green — 7.14:1 */
    '--code-number': '#d3869b', /* bright purple — 5.37:1 */
    '--code-function': '#fabd2f', /* bright yellow — 8.69:1 */
    '--code-type': '#8ec07c', /* bright aqua — 7.01:1 */
    '--code-variable': '#ebdbb2', /* fg1 — 10.75:1 */
    '--code-tag': '#8ec07c', /* aqua */
    '--code-attribute': '#8ec07c', /* aqua */
    '--code-punctuation': '#a89984', /* fg4 — 5.30:1 */
    '--code-meta': '#fe8019', /* orange — 5.84:1 */
    '--code-invalid': '#fb533f',
    '--code-link': '#fe8019', /* the app accent, so links read as links */
    '--code-heading': '#fbf1c7', /* fg0 — 12.99:1 */
    '--code-inserted': '#b8bb26',
    '--code-deleted': '#fb533f',
    '--code-gutter-fg': '#928374', /* 4.02:1 */
    '--code-gutter-fg-active': '#ebdbb2',
    '--code-active-line': 'rgba(235, 219, 178, 0.04)',
    '--code-selection': 'rgba(235, 219, 178, 0.22)',
    '--code-selection-inactive': 'rgba(235, 219, 178, 0.1)',
    '--code-cursor': '#ebdbb2',
    '--code-bracket-match': 'rgba(254, 128, 25, 0.25)',
  },
  // morhetz/gruvbox dark (medium), the palette table from the README: neutral
  // colours in the normal slots, bright variants in the bright slots.
  terminal: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: 'rgba(235, 219, 178, 0.22)',
    selectionInactiveBackground: 'rgba(235, 219, 178, 0.11)',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
};

/* ---------------------------------------------------------------------------
 * One Dark — transcribed from Atom's One Dark (the palette VS Code users know
 * from One Dark Pro). The blue-grey middle ground between the app's GitHub
 * dark and Nord.
 * ------------------------------------------------------------------------- */
const ONE_DARK: ThemeSpec = {
  id: 'one-dark',
  label: 'One Dark',
  appearance: 'dark',
  tokens: {
    '--bg': '#282c34', /* the editor ground */
    '--surface': '#2f343f',
    '--surface-2': '#353b48',
    '--surface-3': '#3e4451', /* One Dark's own selection grey */
    '--scrim': 'rgba(24, 26, 31, 0.72)', /* #181a1f ink */
    '--fg': '#abb2bf', /* 6.57:1 */
    '--fg-secondary': '#9da5b0', /* 5.42:1; 4.51:1 on --surface-2 */
    '--fg-muted': '#6f7787', /* 3.11:1 — >=15px or decorative ONLY */
    '--border': '#383e4a',
    '--border-soft': '#30353f',
    '--border-strong': '#7d8593', /* 3.83:1; 3.02:1 on --surface-2 */
    '--accent': '#61afef', /* the One Dark blue — 5.92:1 */
    '--accent-dim': '#4d81ae',
    '--accent-soft': 'rgba(97, 175, 239, 0.12)',
    '--on-accent': '#282c34', /* 5.92:1 on --accent */
    '--success': '#98c379', /* green — 6.94:1 */
    '--warning': '#d19a66', /* orange — 5.68:1 */
    '--error': '#e17078', /* red #e06c75 lifted from 4.38:1 — 4.53:1 */
    '--agent': '#c678dd', /* magenta — 4.75:1 */
    '--success-soft': 'rgba(152, 195, 121, 0.12)',
    '--warning-soft': 'rgba(209, 154, 102, 0.12)',
    '--error-soft': 'rgba(224, 108, 117, 0.14)',
    '--agent-soft': 'rgba(198, 120, 221, 0.14)',
    '--state-hover': 'rgba(171, 178, 191, 0.05)',
    '--state-active': 'rgba(171, 178, 191, 0.09)',
    '--shadow-overlay': '0 16px 48px rgba(0, 0, 0, 0.5)',
    '--shadow-card': '0 8px 32px rgba(0, 0, 0, 0.5)',
    '--term-bg': '#282c34',
    '--term-fg': '#abb2bf', /* 6.57:1 */
    /* One Dark's own syntax mapping (Atom): keywords purple, strings green,
       functions blue, types yellow, tags red. Ratios on #282c34. */
    '--code-comment': '#8e939b', /* #7f848e lifted from 3.73:1 — 4.53:1 */
    '--code-keyword': '#c678dd', /* purple — 4.75:1 */
    '--code-string': '#98c379', /* green — 6.94:1 */
    '--code-number': '#d19a66', /* orange — 5.68:1 */
    '--code-function': '#61afef', /* blue — 5.92:1 */
    '--code-type': '#e5c07b', /* yellow — 8.10:1 */
    '--code-variable': '#abb2bf', /* fg — 6.57:1 */
    '--code-tag': '#e17078', /* red lifted — 4.53:1 */
    '--code-attribute': '#d19a66', /* orange */
    '--code-punctuation': '#9098a5', /* 4.81:1 */
    '--code-meta': '#56b6c2', /* cyan — 5.91:1 */
    '--code-invalid': '#e17078',
    '--code-link': '#61afef', /* the app accent */
    '--code-heading': '#e6ebf1', /* 11.68:1 */
    '--code-inserted': '#98c379',
    '--code-deleted': '#e17078',
    '--code-gutter-fg': '#7f848e', /* 3.73:1 — decorative floor */
    '--code-gutter-fg-active': '#abb2bf',
    '--code-active-line': 'rgba(171, 178, 191, 0.04)',
    '--code-selection': 'rgba(171, 178, 191, 0.22)',
    '--code-selection-inactive': 'rgba(171, 178, 191, 0.1)',
    '--code-cursor': '#528bff', /* One Dark's own caret blue */
    '--code-bracket-match': 'rgba(97, 175, 239, 0.25)',
  },
  // Atom One Dark's terminal mapping: the eight syntax colours doubled across
  // normal and bright slots (Atom shipped it that way), dark grey and white
  // in the two remaining bright corners.
  terminal: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: 'rgba(171, 178, 191, 0.22)',
    selectionInactiveBackground: 'rgba(171, 178, 191, 0.11)',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#d19a66',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
};

/** Every theme, in the order the Settings picker shows them. */
export const THEMES: readonly ThemeSpec[] = [
  DARK,
  LIGHT,
  SOLARIZED_LIGHT,
  NORD,
  GRUVBOX_DARK,
  ONE_DARK,
];

/**
 * The stored value that means "follow the OS", and the pair it resolves to.
 * The pair is DATA, not a search: with several dark themes registered, "which
 * dark does the system setting mean" is a product decision, and it means the
 * two defaults — the theme that ships, and its designed light counterpart.
 */
export const THEME_CHOICE_SYSTEM = 'system';
export const SYSTEM_THEME_IDS: Readonly<Record<ThemeAppearance, string>> = {
  dark: 'dark',
  light: 'light',
};

/** Exactly what shipped before themes existed, so upgrades change nothing. */
export const THEME_CHOICE_DEFAULT = 'dark';

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

/** The theme registered under `id`, or undefined. */
export function themeById(id: string): ThemeSpec | undefined {
  return BY_ID.get(id);
}

/**
 * Parser for the settings spec: `system` or a registered theme id. Anything
 * else — including the id of a theme a newer build shipped and this one does
 * not have — falls back to the default, per the store's degradation contract.
 */
export function parseThemeChoice(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === THEME_CHOICE_SYSTEM) return trimmed;
  return BY_ID.has(trimmed) ? trimmed : undefined;
}

/**
 * Whether the OS currently prefers light, as a ref so `system` is LIVE: flip
 * Windows' mode and the app follows without a restart, which is the entire
 * point of offering the option.
 *
 * Read via `matchMedia('(prefers-color-scheme: …)')`, which in an Electron
 * renderer is fed by main's `nativeTheme` (itself following the OS unless
 * overridden) — the renderer-side face of the same fact, needing no IPC. The
 * guard is for the unit-test environment; a missing matchMedia means "dark",
 * matching the app's default.
 */
const systemPrefersLight = ref(false);
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  systemPrefersLight.value = query.matches;
  query.addEventListener('change', (event) => {
    systemPrefersLight.value = event.matches;
  });
}

/**
 * The theme a stored choice means RIGHT NOW. Reactive: reads the system
 * preference ref, so a computed/watcher over this re-runs when the OS mode
 * flips while the choice is `system`. Unknown ids resolve to the default
 * rather than throwing — the parser keeps them out of the store, but this
 * function is also called with values that never passed through it.
 */
export function resolveTheme(choice: string): ThemeSpec {
  if (choice === THEME_CHOICE_SYSTEM) {
    const id = SYSTEM_THEME_IDS[systemPrefersLight.value ? 'light' : 'dark'];
    return BY_ID.get(id) ?? DARK;
  }
  return BY_ID.get(choice) ?? DARK;
}

/** Test hook: drive the system preference without a real matchMedia. */
export function setSystemPrefersLightForTest(value: boolean): void {
  systemPrefersLight.value = value;
}

/**
 * The at-rest block tint behind linked paths in the terminal (see
 * terminalPathHighlights.ts): this theme's own selection tint composited over
 * the terminal ground and solidified. The xterm decoration API takes only
 * `#RRGGBB`, while `selectionBackground` is written with alpha so real
 * selections keep the text readable — compositing it over `background`
 * reproduces exactly the colour a selection paints there, per theme, with no
 * new palette values. Both inputs are this file's palette entries; the
 * defaults only guard a palette that dropped one.
 */
export function terminalLinkTint(palette: ITheme): string {
  return blendOver(palette.background ?? '#000000', palette.selectionBackground ?? 'rgba(255, 255, 255, 0.2)');
}

function blendOver(ground: string, overlay: string): string {
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(overlay);
  if (rgba === null) return ground;
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(ground);
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(ground);
  const channels = hex6 !== null
    ? [1, 2, 3].map((i) => parseInt(hex6[i] ?? '0', 16))
    : hex3 !== null
      ? [1, 2, 3].map((i) => parseInt(hex3[i] ?? '0', 16) * 17)
      : [0, 0, 0];
  const alpha = Number(rgba[4] ?? 1);
  return `#${[0, 1, 2]
    .map((i) => Math.round(Number(rgba[i + 1]) * alpha + (channels[i] ?? 0) * (1 - alpha)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;
}
