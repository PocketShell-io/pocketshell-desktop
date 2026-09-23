import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clampFontSize,
  EDITOR_FONT_SIZE_DEFAULT,
  fontCssVariables,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  MONOSPACE_FAMILIES,
  parseFontSize,
  resolveMonoStack,
  sanitiseFontFamily,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '@ui/fonts';

const UI_TOKENS = resolve(__dirname, '..', '..', '..', 'pocketshell-core', 'packages', 'ui', 'src', 'tokens.css');

/**
 * The rules a font setting has to obey, pinned here because the three surfaces
 * that consume them (CSS custom properties, the CodeMirror theme, xterm's
 * options object) cannot each be trusted to re-derive them.
 *
 * The two that matter most are the two the brief called out: a size that is
 * neither 4 nor 400, and a family that can never resolve to something
 * proportional.
 */

describe('sanitiseFontFamily', () => {
  it('keeps an ordinary family name unchanged', () => {
    expect(sanitiseFontFamily('JetBrains Mono')).toBe('JetBrains Mono');
    expect(sanitiseFontFamily('Fira Code')).toBe('Fira Code');
    expect(sanitiseFontFamily('DejaVu Sans Mono')).toBe('DejaVu Sans Mono');
  });

  it('reads empty and whitespace as "no choice"', () => {
    expect(sanitiseFontFamily('')).toBeNull();
    expect(sanitiseFontFamily('   ')).toBeNull();
    expect(sanitiseFontFamily(null)).toBeNull();
  });

  it('rejects a non-string outright', () => {
    expect(sanitiseFontFamily(16)).toBeUndefined();
    expect(sanitiseFontFamily({ family: 'Consolas' })).toBeUndefined();
    expect(sanitiseFontFamily(undefined)).toBeUndefined();
  });

  it('strips the characters that would let a value escape its property', () => {
    // Quotes, semicolons and braces are what a CSS value would need to become
    // a CSS rule. None of them survive.
    expect(sanitiseFontFamily('Consolas"; } body { display: none')).toBe(
      'Consolas body display none',
    );
    expect(sanitiseFontFamily("Fira'Code")).toBe('Fira Code');
    expect(sanitiseFontFamily('Mono\\Face')).toBe('Mono Face');
  });

  it('strips commas, so one setting can only ever name ONE family', () => {
    // Otherwise a user could enter their own stack and get behind the fallback
    // tail that resolveMonoStack appends.
    expect(sanitiseFontFamily('Comic Sans MS, cursive')).toBe('Comic Sans MS cursive');
  });

  it('collapses runs of whitespace and bounds the length', () => {
    expect(sanitiseFontFamily('  Source   Code  Pro ')).toBe('Source Code Pro');
    const long = sanitiseFontFamily('A'.repeat(200));
    expect(long).not.toBeNull();
    expect(long?.length).toBeLessThanOrEqual(64);
  });

  it('accepts every family the picker suggests, unchanged', () => {
    for (const family of MONOSPACE_FAMILIES) {
      expect(sanitiseFontFamily(family)).toBe(family);
    }
  });
});

describe('resolveMonoStack', () => {
  it('falls back to the shipped stack when nothing is chosen', () => {
    const shipped = resolveMonoStack(null);
    expect(shipped).toContain('Consolas');
    expect(shipped).toContain('monospace');
    expect(resolveMonoStack(undefined)).toBe(shipped);
    expect(resolveMonoStack('')).toBe(shipped);
  });

  it('prepends the choice and KEEPS the fallbacks behind it', () => {
    const stack = resolveMonoStack('JetBrains Mono');
    expect(stack.startsWith('"JetBrains Mono",')).toBe(true);
    expect(stack).toContain('Consolas');
    expect(stack).toContain('ui-monospace');
  });

  it('supports the consuming platform’s fallback stack', () => {
    const stack = resolveMonoStack(null, "'JetBrains Mono', ui-monospace, monospace");
    expect(stack).toBe("'JetBrains Mono', ui-monospace, monospace");
    expect(resolveMonoStack('Fira Code', "'JetBrains Mono', ui-monospace, monospace")).toBe(
      '"Fira Code", \'JetBrains Mono\', ui-monospace, monospace',
    );
  });

  it('never lets a stack end anywhere but the monospace generic', () => {
    // The hard requirement: an uninstalled family must degrade to a mono face,
    // because a terminal in a proportional font is unusable.
    for (const family of [null, 'Consolas', 'Not A Real Font 9000', ...MONOSPACE_FAMILIES]) {
      expect(resolveMonoStack(family).trim().endsWith('monospace')).toBe(true);
    }
  });

  it('quotes the family, so a name with spaces is one token', () => {
    expect(resolveMonoStack('Cascadia Mono')).toContain('"Cascadia Mono"');
  });

  it('sanitises on the way through, so a raw stored value cannot leak', () => {
    expect(resolveMonoStack('Consolas"; }')).not.toContain(';');
    expect(resolveMonoStack('Consolas"; }')).not.toContain('}');
  });
});

describe('font sizes', () => {
  it('clamps a mistake into the legal range', () => {
    // The two the brief named by number.
    expect(clampFontSize(4)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(400)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(0)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(-20)).toBe(FONT_SIZE_MIN);
  });

  it('leaves a sensible size alone and rounds to a whole pixel', () => {
    expect(clampFontSize(16)).toBe(16);
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(14.4)).toBe(14);
    expect(clampFontSize(14.6)).toBe(15);
  });

  it('accepts the range endpoints themselves', () => {
    expect(clampFontSize(FONT_SIZE_MIN)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(FONT_SIZE_MAX)).toBe(FONT_SIZE_MAX);
  });

  it('parses the string a number input hands back', () => {
    expect(parseFontSize('18')).toBe(18);
    expect(parseFontSize(' 20 ')).toBe(20);
    expect(parseFontSize('999')).toBe(FONT_SIZE_MAX);
  });

  it('CLAMPS an out-of-range number but REJECTS a non-number', () => {
    // The distinction is intent: 400 is a user who wanted big, and honouring
    // that at the maximum beats silently reverting. 'huge' says nothing.
    expect(parseFontSize(400)).toBe(FONT_SIZE_MAX);
    expect(parseFontSize('huge')).toBeUndefined();
    expect(parseFontSize(Number.NaN)).toBeUndefined();
    expect(parseFontSize(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseFontSize(null)).toBeUndefined();
    expect(parseFontSize({})).toBeUndefined();
    expect(parseFontSize([])).toBeUndefined();
  });

  it('ships the exact values the app used before the setting existed', () => {
    // Nobody's terminal or editor may change size on upgrade.
    expect(TERMINAL_FONT_SIZE_DEFAULT).toBe(16);
    expect(EDITOR_FONT_SIZE_DEFAULT).toBe(13);
  });
});

describe('fontCssVariables', () => {
  const defaults = {
    monospaceFontFamily: null,
    terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
    editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  };

  it('maps the three settings onto the three tokens', () => {
    expect(fontCssVariables({ ...defaults, monospaceFontFamily: 'Hack' })).toEqual({
      '--font-mono': resolveMonoStack('Hack'),
      '--term-font-size': '16px',
      '--code-font-size': '13px',
    });
  });

  it('uses a platform fallback without changing the desktop defaults', () => {
    expect(fontCssVariables(defaults, "'JetBrains Mono', ui-monospace, monospace")['--font-mono'])
      .toBe("'JetBrains Mono', ui-monospace, monospace");
  });

  it('emits the shipped values when nothing has been changed', () => {
    const vars = fontCssVariables(defaults);
    expect(vars['--font-mono']).toBe(resolveMonoStack(null));
    expect(vars['--term-font-size']).toBe('16px');
    expect(vars['--code-font-size']).toBe('13px');
  });

  it('clamps again on the way out, so a bad stored value cannot reach the DOM', () => {
    const vars = fontCssVariables({ ...defaults, terminalFontSize: 400, editorFontSize: 1 });
    expect(vars['--term-font-size']).toBe(`${FONT_SIZE_MAX}px`);
    expect(vars['--code-font-size']).toBe(`${FONT_SIZE_MIN}px`);
  });
});

describe('shared CSS font defaults', () => {
  it('keeps the CSS mono stack aligned with the font policy fallback', () => {
    const css = readFileSync(UI_TOKENS, 'utf8');
    const stack = /--font-mono:\s*([^;]+);/.exec(css)?.[1]?.trim();
    expect(stack).toBe(resolveMonoStack(null));
  });
});
