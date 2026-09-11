import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The two definition-of-done greps from , executed rather
 * than remembered.
 *
 * They are the kind of rule that decays the moment it lives only in a doc: the
 * emoji this app spent a pass removing were added one at a time, each of them
 * locally reasonable. Here they fail a test run instead.
 */

const RENDERER = resolve(__dirname, '..', '..', 'src', 'renderer');

function files(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

function vueFiles(dir: string): string[] {
  return files(dir, '.vue');
}

/** Repo-relative, forward-slashed, so assertion output is readable anywhere. */
function rel(file: string): string {
  return relative(RENDERER, file).split(sep).join('/');
}

/**
 * Lines of `file` with every comment body blanked out: line comments,
 * block comments, and HTML comments alike. Newlines are preserved so
 * reported line numbers still point at the real line. Both gates exempt
 * comments: a comment explaining which glyph was removed must not itself
 * trip the rule.
 */
function codeLines(source: string): { line: number; text: string }[] {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
  return stripped.split('\n').map((text, i) => ({ line: i + 1, text }));
}

describe('design gates', () => {
  /**
   * Gate 1 — colour tokens. Raw six-digit hex belongs to the token block in
   * App.vue and to TerminalView's Campbell theme, which is a terminal palette
   * rather than a UI colour. Everywhere else uses `var(--…)`.
   */
  it('has no raw hex colours outside App.vue and TerminalView.vue', () => {
    const allowed = new Set(['App.vue', 'components/TerminalView.vue']);
    const offenders = vueFiles(RENDERER)
      .filter((f) => !allowed.has(rel(f)))
      .filter((f) => /#[0-9a-fA-F]{6}/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  /**
   * Gate 1b — the same rule for renderer .ts modules, added when themes became
   * data. `themes.ts` is the DESIGNATED second home for colour literals — a
   * theme record is a palette, which is the one kind of code whose entire job
   * is colour values, and tests/unit/themes.test.ts holds every record to the
   * parity and contrast gates. Everything else in .ts (stores, composables,
   * the CodeMirror theme) reads tokens, exactly as components do; a hex
   * appearing there is a palette escaping its registry.
   */
  it('has no raw hex colours in renderer .ts outside themes.ts', () => {
    const allowed = new Set(['themes.ts']);
    const offenders = files(RENDERER, '.ts')
      .filter((f) => !allowed.has(rel(f)))
      .filter((f) => /#[0-9a-fA-F]{6}/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  /**
   * Gate 2 — no character-as-icon. Every glyph doing an icon's job is a real
   * inline SVG via AppIcon, inheriting currentColor.
   *
   * Exempt, deliberately:
   *   - code comments, which is why comment bodies are blanked first;
   *   - `TerminalView.vue`, whose glyphs come from the remote program;
   *   - `↑` / `↓` inside the composer's keyboard-shortcut tooltip copy, the
   *     one arrow that survives as text because it IS text.
   * The `·` `…` `—` `–` `~` `/` family is not in the set at all: that is
   * punctuation and displayed path text, not iconography.
   */
  it('has no character-as-icon glyphs in renderer templates', () => {
    const BANNED = /[▸▾▼▶◀◁▷△▽←→↑↓☰⟳✕✖✗✓⌘●📁📄↪🔧📎]/u;
    const EXEMPT_FILES = new Set(['components/TerminalView.vue']);
    /** `↑`/`↓` as shortcut copy inside a title attribute — genuine text. */
    const SHORTCUT_COPY = /Ctrl\+Shift\+[↑↓]/u;

    const offenders: string[] = [];
    for (const file of vueFiles(RENDERER)) {
      if (EXEMPT_FILES.has(rel(file))) continue;
      for (const { line, text } of codeLines(readFileSync(file, 'utf8'))) {
        if (!BANNED.test(text)) continue;
        if (SHORTCUT_COPY.test(text) && !BANNED.test(text.replace(/Ctrl\+Shift\+[↑↓]/gu, ''))) {
          continue;
        }
        offenders.push(`${rel(file)}:${line}: ${text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Gate 3 — component size. CLEAN_CODE rule 12: a component over ~1000
   * lines is flagged for extraction with the specific sections named. The
   * flag is this gate; an over-limit file must be listed in EXEMPT with the
   * extraction queue that will bring it under, and a NEW file over the line
   * fails here rather than quietly joining the list.
   *
   * The eight exemptions are the recorded queue, not a licence: TerminalView
   * (was 1846) and the stores' logic already left through this door, and the
   * remaining files shrink the same way — logic first, then template splits.
   */
  it('has no .vue file over 1000 lines without a recorded exemption', () => {
    const MAX_LINES = 1000;
    /** Over-limit files, each with the extraction queue that retires it. */
    const EXEMPT: Record<string, string> = {
      'views/FolderWorkspaceView.vue':
        'tab model, pane wiring, chords, drag and files-tabs plumbing; template split pending',
      'components/PromptComposer.vue':
        'composer UI; its pipelines are already extracted (composerSend, AttachmentStager) — template split pending',
      'components/SessionTree.vue':
        'template/style-heavy session tree; subcomponent split pending',
      'components/NewSessionDialog.vue':
        'three-route creation form; subcomponent split pending',
      'views/SettingsView.vue':
        'settings panels; per-section component split pending',
    };
    const offenders = vueFiles(RENDERER)
      .map((f) => ({ file: rel(f), lines: readFileSync(f, 'utf8').split('\n').length }))
      .filter(({ file, lines }) => lines > MAX_LINES && !(file in EXEMPT))
      .map(({ file, lines }) => `${file} (${lines} lines)`);
    expect(offenders).toEqual([]);
  });
});
