import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { classHighlighter, tags as t, type Tag } from '@lezer/highlight';
import { highlightTree } from '@lezer/highlight';
import { loadLanguage, supportedLanguageIds } from '@ui/app/codeEditorLanguages';
import { PLAIN_TEXT, languageIdForFilename, type LanguageId } from '@ui/app/codeLanguage';
import { pocketshellHighlightStyle } from '@ui/app/codeEditorTheme';

/**
 * The half of the editor that talks to CodeMirror, tested WITHOUT a DOM.
 *
 * CodeMirror's model layer is deliberately headless — `EditorState` parses and
 * `highlightTree` walks the result with no view attached — so the questions
 * that actually matter ("does opening a .py file produce coloured tokens?")
 * can be answered here, in a node environment, rather than by mounting a
 * component and scraping spans out of a virtualised viewport.
 *
 * These are also the tests that catch a broken lazy import. Every grammar
 * arrives through a dynamic `import()` so Rollup can split it into its own
 * chunk; a renamed package export would otherwise surface as an uncoloured
 * file in the packaged app and nowhere else.
 */

/**
 * Parse `doc` with `id`'s grammar and return the tags it produced.
 *
 * `classHighlighter` is used rather than the app's own HighlightStyle on
 * purpose: it names each tag (`tok-keyword`) instead of emitting a generated
 * CSS class (`ͼ4c`), so a failure reads as "shell produced no keyword tag"
 * rather than as an unreadable diff of style hashes. The app's style is
 * checked separately, below, for covering the tags these produce.
 */
async function highlightClasses(id: LanguageId, doc: string): Promise<Set<string>> {
  const extension = await loadLanguage(id);
  expect(extension, `no extension loaded for ${id}`).not.toBeNull();
  const state = EditorState.create({ doc, extensions: [extension ?? []] });
  // The default parse works to a time budget and can stop early; tests want the
  // whole document, so the parser is given an explicit deadline instead.
  const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
  expect(tree, `parse timed out for ${id}`).not.toBeNull();
  const classes = new Set<string>();
  highlightTree(tree!, classHighlighter, (_from, _to, cls) => {
    for (const c of cls.split(' ')) classes.add(c);
  });
  return classes;
}

describe('loadLanguage', () => {
  it('returns null for plain text, so no extension is attached at all', async () => {
    await expect(loadLanguage(PLAIN_TEXT)).resolves.toBeNull();
  });

  it('returns null rather than throwing for an id with no grammar', async () => {
    await expect(loadLanguage('nonsense' as LanguageId)).resolves.toBeNull();
  });

  /**
   * The guard against a language id that the mapping can produce but the
   * loader table forgot — which would be a silently uncoloured file type.
   */
  it('has a loader for every id the filename mapping can return', async () => {
    const ids = supportedLanguageIds();
    for (const id of ids) {
      await expect(loadLanguage(id), `loader failed for ${id}`).resolves.not.toBeNull();
    }
    expect(ids.length).toBeGreaterThan(30);
  });
});

describe('grammars produce themed tokens', () => {
  /**
   * One representative snippet per family. Both grammar families are covered:
   * the Lezer `lang-*` packages and the StreamLanguage `legacy-modes`, which
   * emit a coarser tag set — if the theme only styled the precise tags, shell
   * scripts would come out grey and these assertions would say so.
   */
  const samples: [LanguageId, string, string[]][] = [
    ['typescript', 'const x: number = 1; // note\n', ['tok-keyword', 'tok-comment', 'tok-number']],
    ['python', 'def f(x):\n    return "s"  # note\n', ['tok-keyword', 'tok-string', 'tok-comment']],
    ['json', '{"a": 1, "b": true}\n', ['tok-propertyName', 'tok-number', 'tok-bool']],
    ['yaml', 'key: value\n# note\n', ['tok-comment']],
    ['rust', 'fn main() { let x = 1; }\n', ['tok-keyword', 'tok-number']],
    ['go', 'package main\nfunc main() {}\n', ['tok-keyword']],
    // `tagName` and `attributeName` are sub-tags of `typeName` and
    // `propertyName`; `classHighlighter` names the parent, while the app's
    // HighlightStyle matches the specific child. The distinction is asserted in
    // the theme-coverage block below, not here.
    ['html', '<a href="x">hi</a>\n', ['tok-typeName', 'tok-propertyName', 'tok-string']],
    ['css', 'a { color: red; }\n', ['tok-typeName', 'tok-propertyName']],
    ['markdown', '# Title\n\nsome *text*\n', ['tok-heading']],
    ['sql', 'select 1 from t; -- note\n', ['tok-keyword', 'tok-comment']],
    // --- StreamLanguage (legacy-modes) ---
    ['shell', 'if [ -f x ]; then\n  echo "hi" # note\nfi\n', ['tok-keyword', 'tok-string', 'tok-comment']],
    ['dockerfile', 'FROM alpine:3\n# note\nRUN echo hi\n', ['tok-keyword', 'tok-comment']],
    ['toml', '[section]\nkey = "value"\n', ['tok-string']],
    ['ini', '# note\nkey = value\n', ['tok-comment']],
    ['nginx', 'server {\n  listen 80;\n}\n', ['tok-keyword']],
    ['diff', '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n', ['tok-inserted', 'tok-deleted']],
  ];

  for (const [id, doc, expected] of samples) {
    it(`${id} yields ${expected.join(', ')}`, async () => {
      const classes = await highlightClasses(id, doc);
      for (const cls of expected) expect([...classes], `${id} classes`).toContain(cls);
    });
  }
});

describe('the theme covers the tags the grammars emit', () => {
  /**
   * A grammar can only be as colourful as the style that reads it. Every tag
   * asserted above has to resolve to a rule in the app's HighlightStyle, or the
   * token parses correctly and still renders in the plain foreground — the
   * exact failure mode of "I added a language and it still looks grey".
   */
  const covered: [string, Tag][] = [
    ['comment', t.comment],
    ['lineComment', t.lineComment],
    ['blockComment', t.blockComment],
    ['keyword', t.keyword],
    ['controlKeyword', t.controlKeyword],
    ['string', t.string],
    ['number', t.number],
    ['bool', t.bool],
    ['atom', t.atom],
    ['variableName', t.variableName],
    ['propertyName', t.propertyName],
    ['typeName', t.typeName],
    ['className', t.className],
    ['tagName', t.tagName],
    ['attributeName', t.attributeName],
    ['attributeValue', t.attributeValue],
    ['operator', t.operator],
    ['punctuation', t.punctuation],
    ['bracket', t.bracket],
    ['meta', t.meta],
    ['heading', t.heading],
    ['link', t.link],
    ['url', t.url],
    ['inserted', t.inserted],
    ['deleted', t.deleted],
    ['invalid', t.invalid],
    ['function(variableName)', t.function(t.variableName)],
    ['definition(variableName)', t.definition(t.variableName)],
    ['constant(variableName)', t.constant(t.variableName)],
    ['special(string)', t.special(t.string)],
  ];

  for (const [name, tag] of covered) {
    it(`styles ${name}`, () => {
      expect(pocketshellHighlightStyle.style([tag]), `${name} is unstyled`).not.toBeNull();
    });
  }
});

describe('the mapping and the loaders agree end to end', () => {
  /**
   * The whole chain a user exercises by clicking a file in the tree: a path
   * becomes an id, the id becomes a grammar, the grammar colours the text.
   */
  const files: [string, string, string][] = [
    ['/home/alexey/git/app/main.py', 'x = 1  # note\n', 'tok-comment'],
    ['/etc/nginx/nginx.conf', 'server { listen 80; }\n', 'tok-keyword'],
    ['/home/alexey/.bashrc', 'export PATH="$PATH:/opt/bin"\n', 'tok-string'],
    ['/srv/app/Dockerfile', 'FROM alpine:3\n', 'tok-keyword'],
    ['/srv/app/docker-compose.yml', '# note\nservices:\n', 'tok-comment'],
  ];

  for (const [path, doc, expected] of files) {
    it(`${path} highlights`, async () => {
      const id = languageIdForFilename(path);
      expect(id).not.toBe(PLAIN_TEXT);
      expect([...(await highlightClasses(id, doc))]).toContain(expected);
    });
  }
});
