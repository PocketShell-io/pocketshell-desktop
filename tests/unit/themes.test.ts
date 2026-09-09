import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseThemeChoice,
  resolveTheme,
  setSystemPrefersLightForTest,
  SYSTEM_THEME_IDS,
  THEME_CHOICE_DEFAULT,
  THEME_CHOICE_SYSTEM,
  themeById,
  THEMES,
} from '../../src/renderer/themes';

/**
 * The theme system's three load-bearing guarantees, executed rather than
 * remembered (the designGates.test.ts philosophy):
 *
 *   1. PARITY — the `dark` record and App.vue's `:root` block are the same
 *      palette, and every other theme defines exactly the same token set, so
 *      no theme can leave a surface silently unthemed.
 *   2. CONTRAST — every theme meets the WCAG floors of 
 *      This is the audit that keeps "add a theme = one record" honest: a
 *      half-audited palette fails the suite instead of shipping.
 *   3. RESOLUTION — the stored choice, including `system`, always lands on a
 *      real theme.
 */

const APP_VUE = resolve(__dirname, '..', '..', 'src', 'renderer', 'App.vue');

/** A value that paints a colour (hex or rgb/rgba) — the themable kind. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

/**
 * The custom properties of App.vue's `:root` block, with comments stripped so
 * a hex inside prose cannot masquerade as a token.
 */
function rootTokens(): Map<string, string> {
  const source = readFileSync(APP_VUE, 'utf8');
  const start = source.indexOf(':root {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  const block = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}

/** Normalise for comparison: whitespace collapsed, hex case-folded. */
function norm(value: string): string {
  return value.replace(/\s+/g, ' ').toLowerCase().trim();
}

describe('token parity', () => {
  const dark = themeById('dark')!;
  const root = rootTokens();
  const colourTokens = [...root.entries()].filter(([, v]) => COLOUR.test(v));

  it('the dark record IS the :root block — same tokens, same values', () => {
    // Both directions: a colour token added to :root must join the record
    // (else five other themes silently miss it), and a token added to the
    // record must exist in :root (else the no-JS default lacks it).
    expect(Object.keys(dark.tokens).sort()).toEqual(colourTokens.map(([k]) => k).sort());
    for (const [token, value] of colourTokens) {
      expect(norm(dark.tokens[token]!), token).toBe(norm(value));
    }
  });

  it(':root only leaves colour out of a token deliberately', () => {
    // The inverse guard for the filter above: a token that references another
    // token (var(--…)) or carries a non-colour value is fine, but nothing in
    // the record may be missing from :root entirely.
    for (const token of Object.keys(dark.tokens)) {
      expect(root.has(token), `${token} missing from :root`).toBe(true);
    }
  });

  it('every theme defines exactly the token set the dark theme defines', () => {
    const reference = Object.keys(dark.tokens).sort();
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort(), theme.id).toEqual(reference);
    }
  });

  it('ids are unique and labels are non-empty', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of THEMES) {
      expect(theme.label.trim()).not.toBe('');
      expect(['dark', 'light']).toContain(theme.appearance);
    }
  });
});

describe('terminal palettes', () => {
  const ANSI_SLOTS = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
    'brightMagenta', 'brightCyan', 'brightWhite',
  ] as const;

  it('every theme carries a complete xterm palette', () => {
    for (const theme of THEMES) {
      for (const slot of ANSI_SLOTS) {
        expect(theme.terminal[slot], `${theme.id}.${slot}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(theme.terminal.cursor).toBeTruthy();
      expect(theme.terminal.cursorAccent).toBeTruthy();
      expect(theme.terminal.selectionBackground).toBeTruthy();
      expect(theme.terminal.selectionInactiveBackground).toBeTruthy();
    }
  });

  it('xterm ground and ink equal the --term-* tokens', () => {
    // The Settings samples and the editor read the tokens; xterm reads the
    // record. They are the same surface and must be the same colours.
    for (const theme of THEMES) {
      expect(norm(theme.terminal.background!), theme.id).toBe(norm(theme.tokens['--term-bg']!));
      expect(norm(theme.terminal.foreground!), theme.id).toBe(norm(theme.tokens['--term-fg']!));
    }
  });
});

/* ---------------------------------------------------------------------------
 * The contrast audit — WCAG 2.1 relative luminance, the same math as the
 * floors are computed per theme.
 * ------------------------------------------------------------------------- */

function lin(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Code roles that are read as 13px text, so they take the 4.5 text floor. */
const CODE_TEXT_ROLES = [
  '--code-comment', '--code-keyword', '--code-string', '--code-number',
  '--code-function', '--code-type', '--code-variable', '--code-tag',
  '--code-attribute', '--code-punctuation', '--code-meta', '--code-invalid',
  '--code-link', '--code-heading', '--code-inserted', '--code-deleted',
  '--code-gutter-fg-active',
];

describe('contrast floors', () => {
  for (const theme of THEMES) {
    describe(theme.id, () => {
      const t = theme.tokens;
      const floor = (fgTok: string, bgTok: string, min: number): void => {
        const value = contrast(t[fgTok]!, t[bgTok]!);
        expect(value, `${fgTok} on ${bgTok} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      };

      it('body and secondary text hold 4.5:1 on every reading surface', () => {
        for (const surface of ['--bg', '--surface', '--surface-2']) {
          floor('--fg', surface, 4.5);
          floor('--fg-secondary', surface, 4.5);
        }
      });

      it('muted text and strong borders hold the non-text floor', () => {
        floor('--fg-muted', '--bg', 3);
        floor('--border-strong', '--bg', 3);
        floor('--border-strong', '--surface-2', 3);
      });

      it('accent and status colours read as text on the ground', () => {
        for (const token of ['--accent', '--success', '--warning', '--error', '--agent']) {
          floor(token, '--bg', 4.5);
        }
        const onAccent = contrast(t['--on-accent']!, t['--accent']!);
        expect(onAccent, `--on-accent = ${onAccent.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });

      it('the terminal ink and every code text role hold 4.5:1', () => {
        floor('--term-fg', '--term-bg', 4.5);
        for (const role of CODE_TEXT_ROLES) {
          floor(role, '--term-bg', 4.5);
        }
        floor('--code-gutter-fg', '--term-bg', 3);
      });
    });
  }
});

describe('resolution', () => {
  it('every id resolves to its own record', () => {
    for (const theme of THEMES) {
      expect(resolveTheme(theme.id)).toBe(theme);
    }
  });

  it('unknown ids fall back to the default theme', () => {
    expect(resolveTheme('vaporwave').id).toBe(THEME_CHOICE_DEFAULT);
  });

  it('system resolves through the designated pair, live', () => {
    // In this environment there is no matchMedia, so the ref defaults to
    // dark — which is also the correct answer for "no information".
    expect(resolveTheme(THEME_CHOICE_SYSTEM).id).toBe(SYSTEM_THEME_IDS.dark);
    setSystemPrefersLightForTest(true);
    expect(resolveTheme(THEME_CHOICE_SYSTEM).id).toBe(SYSTEM_THEME_IDS.light);
    setSystemPrefersLightForTest(false);
    expect(resolveTheme(THEME_CHOICE_SYSTEM).id).toBe(SYSTEM_THEME_IDS.dark);
  });

  it('the designated system pair exists and matches its appearance', () => {
    for (const [appearance, id] of Object.entries(SYSTEM_THEME_IDS)) {
      const theme = themeById(id);
      expect(theme, id).toBeDefined();
      expect(theme!.appearance).toBe(appearance);
    }
  });

  it('parseThemeChoice accepts system and registered ids, nothing else', () => {
    expect(parseThemeChoice('system')).toBe('system');
    for (const theme of THEMES) {
      expect(parseThemeChoice(theme.id)).toBe(theme.id);
    }
    expect(parseThemeChoice(' dark ')).toBe('dark');
    expect(parseThemeChoice('monokai')).toBeUndefined();
    expect(parseThemeChoice(42)).toBeUndefined();
    expect(parseThemeChoice(null)).toBeUndefined();
    expect(parseThemeChoice(undefined)).toBeUndefined();
  });

  it('the default choice is dark — an upgrade repaints nobody', () => {
    expect(THEME_CHOICE_DEFAULT).toBe('dark');
  });
});
