/**
 * The CodeMirror theme, expressed entirely in the app's design tokens.
 *
 * Not one colour literal appears below. Every value is a `var(--…)` reference
 * resolved by the browser against the token block in App.vue, which is the same
 * rule tests/unit/designGates.test.ts enforces for `.vue` files and the same
 * reason DoodleCanvas reads its pens out of computed style. The practical
 * payoff is that this file never has to be revisited when the palette moves:
 * `EditorView.theme` emits real CSS rules, so custom properties cascade into it
 * exactly as they do into any other stylesheet — including inheriting whatever
 * `:root` says at the moment of paint, which a JS colour constant cannot do.
 *
 * The syntax colours are Campbell-derived in the dark theme; App.vue's
 * `--code-*` block carries that derivation and its contrast audit. Since
 * themes became data (src/renderer/themes.ts), every theme record supplies its
 * own `--code-*` values — which is why this file keeps working unchanged: the
 * rules below re-resolve against whatever the applied theme wrote onto
 * `<html>`, on the next paint, with no editor rebuild.
 *
 * ## The one thing tokens could not carry: `dark`
 *
 * CodeMirror keeps a BOOLEAN alongside a theme's rules — `EditorView.darkTheme`
 * — and its own base themes branch on it in CSS that no custom property of ours
 * reaches. That flag used to be baked here as `{ dark: true }`, stating the
 * shipped appearance forever, and it was the single piece of this file that did
 * not follow a theme switch.
 *
 * It is fixed by building the chrome
 * ONCE PER APPEARANCE, {@link codeThemeFor} hands back the right one, and
 * CodeEditor.vue holds it in a Compartment so a theme change reconfigures the
 * live EditorState instead of rebuilding it. Both variants share one spec
 * object below — the CSS is genuinely identical, because every value in it is a
 * token — so the pair cannot drift, and the only difference between them is the
 * boolean CodeMirror needed all along.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import type { ThemeAppearance } from './themes';

/**
 * Editor chrome: surface, gutter, cursor, selection.
 *
 * Not one colour literal, for the reason the file header gives. This is the
 * SPEC rather than the extension: `EditorView.theme` is called on it twice
 * below, once per appearance.
 */
const chromeSpec = {
  '&': {
    color: 'var(--term-fg)',
    backgroundColor: 'var(--term-bg)',
    height: '100%',
    // The editor's type is the terminal's type. Line height matches the
    // textarea this replaces so swapping the two does not reflow the pane.
    fontFamily: 'var(--font-mono)',
    // `--code-font-size`, not `--fs-300`: both default to 13px, but the
    // former is the user's editor size setting and the latter is the UI
    // density scale. They were the same value and the same token until the
    // first of them became settable. See src/renderer/fonts.ts.
    fontSize: 'var(--code-font-size)',
  },
  '&.cm-focused': {
    // CodeMirror draws a focus outline on the editor box by default. This
    // pane is the primary surface of the tab and is focused by simply
    // clicking into the file, so an outline around the whole thing reads as
    // a rendering artefact rather than as focus. The cursor is the affordance.
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.5',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--code-cursor)',
    padding: 'var(--sp-3) 0',
  },
  '.cm-line': {
    padding: '0 var(--sp-4)',
  },
  '.cm-cursor, .cm-dropCursor': {
    // Windows Terminal's cursorShape is "bar"; a 2px bar is
    // the same shape one line-height taller.
    borderLeftColor: 'var(--code-cursor)',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--code-selection-inactive)',
  },
  '&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
    backgroundColor: 'var(--code-selection)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--code-active-line)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--term-bg)',
    color: 'var(--code-gutter-fg)',
    // A hairline in the app's own border token rather than a filled gutter:
    // the file is one surface, and a differently-shaded gutter would split it.
    borderRight: '1px solid var(--border-soft)',
    fontFamily: 'inherit',
    fontSize: 'var(--fs-200)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 var(--sp-2) 0 var(--sp-3)',
    minWidth: '2.5ch',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--code-active-line)',
    color: 'var(--code-gutter-fg-active)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--code-bracket-match)',
    outline: 'none',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    color: 'var(--code-invalid)',
  },
  '.cm-specialChar': {
    color: 'var(--code-invalid)',
  },
};

/**
 * The two chrome extensions, built at module load and never rebuilt.
 *
 * `EditorView.theme` compiles its spec into a StyleModule and mints generated
 * class names, so calling it per reconfigure would leak a fresh stylesheet into
 * the document on every theme switch — a slow accumulation in a window that
 * stays open for days, and one nobody would ever notice. Two constants cost two
 * style modules for the life of the app, which is what a theme is.
 */
const CHROME: Record<ThemeAppearance, Extension> = {
  dark: EditorView.theme(chromeSpec, { dark: true }),
  light: EditorView.theme(chromeSpec, { dark: false }),
};

/**
 * Token colours.
 *
 * Both grammar families feed this one table. The `@codemirror/lang-*` packages
 * are Lezer grammars that tag nodes precisely (`function(variableName)` is a
 * call, `definition(variableName)` is a binding); the `legacy-modes` tokenisers
 * run through StreamLanguage and emit a coarser set — mostly `keyword`,
 * `string`, `comment`, `variableName`, `typeName`, `atom`. Listing the coarse
 * tags alongside the precise ones is what makes a shell script and a TypeScript
 * file look like they came from the same editor.
 */
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },

  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.self, t.modifier],
    color: 'var(--code-keyword)',
  },

  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--code-string)' },
  // An escape inside a string has to be visible AGAINST the string colour, not
  // merely different from the background, so it borrows the type colour.
  { tag: [t.escape], color: 'var(--code-type)' },

  { tag: [t.number, t.bool, t.null, t.atom, t.integer, t.float, t.unit], color: 'var(--code-number)' },

  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.macroName],
    color: 'var(--code-function)',
  },

  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.definition(t.typeName)],
    color: 'var(--code-type)',
  },

  {
    tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.local(t.variableName), t.labelName],
    color: 'var(--code-variable)',
  },
  // Constants read as data, not as identifiers — SCREAMING_CASE and the
  // language's own `true`/`nil` should land in the same colour.
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--code-number)' },

  { tag: [t.tagName, t.angleBracket, t.processingInstruction], color: 'var(--code-tag)' },
  { tag: [t.attributeName], color: 'var(--code-attribute)' },
  { tag: [t.attributeValue], color: 'var(--code-string)' },

  { tag: [t.meta, t.annotation, t.documentMeta], color: 'var(--code-meta)' },

  { tag: [t.punctuation, t.bracket, t.separator, t.operator, t.derefOperator], color: 'var(--code-punctuation)' },

  { tag: [t.link, t.url], color: 'var(--code-link)', textDecoration: 'underline' },
  { tag: [t.heading], color: 'var(--code-heading)', fontWeight: 'var(--fw-bold)' },
  { tag: [t.strong], fontWeight: 'var(--fw-bold)' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.quote], color: 'var(--code-comment)' },
  { tag: [t.monospace], color: 'var(--code-string)' },

  // Diff and patch files, which are a first-class thing to open on a dev box.
  { tag: [t.inserted], color: 'var(--code-inserted)' },
  { tag: [t.deleted], color: 'var(--code-deleted)' },
  { tag: [t.changed], color: 'var(--code-string)' },

  { tag: [t.invalid], color: 'var(--code-invalid)' },
]);

/**
 * Chrome + token colours for one appearance, ready to drop into an
 * EditorState's extensions — or into a Compartment, which is what
 * CodeEditor.vue does so that a theme switch reconfigures rather than rebuilds.
 *
 * The highlight style is shared between the two, deliberately: every colour in
 * it is a `var(--code-*)` that the applied theme has already redefined on
 * `<html>`, so there is nothing appearance-specific left in it to split. Only
 * the chrome differs, and only by the boolean.
 */
export function codeThemeFor(appearance: ThemeAppearance): Extension {
  return [CHROME[appearance], syntaxHighlighting(highlight)];
}

/** Exported for tests, which assert the token table covers the common tags. */
export const pocketshellHighlightStyle = highlight;
