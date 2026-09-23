<script setup lang="ts">
/**
 * CodeEditor: the Files tab's text editor, with syntax highlighting.
 *
 * A drop-in replacement for the `<textarea>` FilesView has used since Phase 2.
 * The contract is deliberately the textarea's own — a value in, a string out —
 * so adopting it is a tag swap:
 *
 *     <textarea :value="files.openContent"
 *               @input="files.setContent($event.target.value)" />
 *     <CodeEditor :model-value="files.openContent" :filename="files.openPath"
 *                 @update:model-value="files.setContent" />
 *
 * Note the explicit `:model-value` / `@update:model-value` pair rather than
 * `v-model="files.openContent"`. `v-model` would ASSIGN to the store ref and
 * skip `setContent`, which is the only thing that raises the dirty flag — the
 * Save button would stay disabled and Ctrl+S would do nothing. Same trap the
 * textarea has (`:value`, not `v-model`), for the same reason.
 *
 * Ctrl/Cmd-S is not handled here, also deliberately. FilesView owns the chord
 * on its container; keydown from inside the editor bubbles to it because no
 * CodeMirror binding claims `Mod-s`, so save keeps working untouched.
 *
 * ## Why CodeMirror 6 and not Monaco
 *
 * Monaco is already in the repo's devDependencies and this view's header
 * comment has pointed at it for two phases, so it was the default answer. It
 * is the wrong one here, and the deciding fact was measured in the BUILT app
 * rather than reasoned about:
 *
 * The packaged renderer is loaded with `loadFile` (src/main/index.ts), so it
 * runs from a `file://` document under the CSP in src/renderer/index.html —
 * `default-src 'self'; script-src 'self'`, with no `worker-src`. Under that
 * document a same-origin worker DOES run, but a worker created from a `blob:`
 * URL is refused outright ("Refused to create a worker from 'blob:file://…'
 * because it violates … script-src 'self'"). Monaco's language services are
 * workers, and the blob-wrapper shim is the shape most Monaco+Vite setups end
 * up with — which is precisely the failure that works in `dev` (an http origin
 * with Vite's own relaxed CSP) and dies in the packaged build. Making it work
 * would mean widening the app's CSP with `worker-src blob:` and pinning
 * Vite's worker format, to gain an IDE's worth of features nobody asked for on
 * top of a renderer bundle Vite already warns about.
 *
 * CodeMirror 6 needs no workers at all, and its grammars split into chunks that
 * load only when a file of that language is opened (codeEditorLanguages.ts).
 * The whole editing surface — undo, multiple cursors, bracket matching — comes
 * along, so nothing about saving over SFTP changes. A highlight-only option
 * (Shiki or highlight.js over a styled `<pre>`) was rejected outright: this
 * file is edited and written back, and re-implementing a text editor on top of
 * a read-only highlighter to keep that working is strictly more work than
 * using an editor.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { codeThemeFor } from '../codeEditorTheme';
import { loadLanguage } from '../codeEditorLanguages';
import { PLAIN_TEXT, languageIdForFilename, shouldHighlight } from '../codeLanguage';
import { resolveTheme } from '@ui/themes';
import { useSettingsStore } from '../stores/settings';

const props = withDefaults(
  defineProps<{
    /** File contents. Mirrors the textarea's `:value`. */
    modelValue: string;
    /** Path or name of the open file — the only input to language choice. */
    filename?: string | null;
  }>(),
  { filename: null },
);

const emit = defineEmits<{
  /** Every document change, as a plain string. Mirrors the textarea's `input`. */
  'update:modelValue': [string];
}>();

const host = ref<HTMLDivElement | null>(null);
/**
 * `shallowRef`, not `ref`: an EditorView is a large mutable object graph with
 * its own change protocol, and making it deeply reactive would have Vue walk
 * the entire document tree on every keystroke.
 */
const view = shallowRef<EditorView | null>(null);

/**
 * The language slot. A Compartment is how CodeMirror swaps one part of a
 * configuration without rebuilding the state — which matters because
 * rebuilding would throw away undo history and the cursor every time the open
 * file changed type.
 */
const language = new Compartment();

/**
 * The appearance slot, for the same mechanism and a smaller reason.
 *
 * Every colour the user reads in this editor comes from a `--code-*` or
 * `--term-*` token and retints on the next paint with nothing to do here
 * (codeEditorTheme.ts). What could NOT follow was CodeMirror's own `dark`
 * boolean, which its base themes branch on for panel chrome, the placeholder
 * tint and a handful of selection fallbacks — CSS of CodeMirror's own that no
 * custom property of ours reaches.
 *
 * The mechanism matters more than the payoff. What a reconfigure must not do is
 * disturb anything the user owns, and a Compartment is the reason it does not:
 * `compartment.reconfigure()` dispatches a transaction carrying an EFFECT and
 * no changes, so
 *
 *   - the document is untouched — `docChanged` is false on that transaction,
 *     which is also what keeps the update listener below from emitting and
 *     therefore what keeps the store's dirty flag exactly as it was. Losing an
 *     unsaved edit to a theme switch would be a bad trade for panel chrome;
 *   - the selection is untouched, so the cursor and any multi-cursor state stay
 *     where they were;
 *   - undo history survives, because the history extension is in a different
 *     part of the configuration and is not rebuilt;
 *   - the scroll position survives, because the view is not recreated — it
 *     re-measures against the same scroller.
 *
 * Rebuilding the EditorState, the obvious alternative, loses all four.
 */
const appearance = new Compartment();

const settings = useSettingsStore();

/**
 * `dark` or `light`, DECLARED by the applied theme record rather than guessed
 * from a background colour — the same distinction themes.ts insists on. It is
 * derived through `resolveTheme` so that `system` works: that choice is a rule
 * resolved against the OS preference, and flipping Windows' light/dark mode has
 * to move this too.
 */
const themeAppearance = computed(() => resolveTheme(settings.theme).appearance);

/**
 * Guards against a stale grammar landing on the wrong file. Grammar chunks are
 * fetched asynchronously, so opening `a.rs` and immediately opening `b.py` can
 * resolve Rust last. Each request takes a ticket; only the current one applies.
 */
let languageTicket = 0;

/**
 * True while we are pushing a prop change INTO the editor. The update listener
 * fires for those dispatches too, and echoing them back as `update:modelValue`
 * would mark a freshly-opened file dirty before the user has touched it.
 */
let applyingExternal = false;

const baseExtensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  rectangularSelection(),
  crosshairCursor(),
  indentOnInput(),
  bracketMatching(),
  EditorState.allowMultipleSelections.of(true),
  // The textarea soft-wrapped, and a file opened to read a long line should not
  // suddenly need horizontal scrolling to read it.
  EditorView.lineWrapping,
  // Matches the `tab-size: 2` the textarea's stylesheet set.
  EditorState.tabSize.of(2),
  // Tab indents rather than moving focus. CodeMirror's own accessibility
  // escape hatch is kept intact: `defaultKeymap` binds Ctrl-m (Shift-Alt-m on
  // macOS) to tab-focus mode, after which Tab leaves the editor again.
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  // No fold gutter, on purpose: CodeMirror draws its fold arrows as text
  // glyphs, and tests/unit/designGates.test.ts enforces that every glyph doing
  // an icon's job in this app is a real SVG.
  EditorView.updateListener.of((update) => {
    if (!update.docChanged || applyingExternal) return;
    emit('update:modelValue', update.state.doc.toString());
  }),
];

/**
 * Attach — or detach — the grammar for the currently-open file.
 *
 * Size is checked as well as name: `shouldHighlight` refuses multi-megabyte or
 * single-enormous-line documents, so a minified bundle opens as a plain
 * editable buffer instead of asking a parser to chew through it.
 */
async function syncLanguage(): Promise<void> {
  const ticket = ++languageTicket;
  const id = shouldHighlight(props.modelValue) ? languageIdForFilename(props.filename) : PLAIN_TEXT;
  const extension = await loadLanguage(id);
  const editor = view.value;
  if (!editor || ticket !== languageTicket) return;
  editor.dispatch({ effects: language.reconfigure(extension ?? []) });
}

onMounted(() => {
  if (!host.value) return;
  view.value = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        ...baseExtensions,
        language.of([]),
        appearance.of(codeThemeFor(themeAppearance.value)),
      ],
    }),
  });
  void syncLanguage();
});

onBeforeUnmount(() => {
  // An EditorView holds DOM listeners and a ResizeObserver; leaving them behind
  // on a tab switch is the classic slow leak in a long-lived Electron window.
  view.value?.destroy();
  view.value = null;
});

/**
 * Push an external value into the document.
 *
 * The guard is the whole function: without the equality check, the round trip
 * `edit -> emit -> store -> prop -> watch` would dispatch a full-document
 * replacement on every keystroke, which resets the selection and defeats undo.
 * With it, this fires only when something OTHER than this editor changed the
 * value — opening a different file, or a save that rewrote the buffer.
 */
watch(
  () => props.modelValue,
  (next) => {
    const editor = view.value;
    if (!editor || editor.state.doc.toString() === next) return;
    applyingExternal = true;
    try {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: next },
        // A wholesale replacement is a new document, not an edit of the old
        // one, so the cursor goes home rather than to a position that meant
        // something in a file that is no longer open.
        selection: { anchor: 0 },
      });
    } finally {
      applyingExternal = false;
    }
    void syncLanguage();
  },
);

watch(() => props.filename, () => void syncLanguage());

/**
 * Follow the theme's appearance.
 *
 * One dispatch, carrying one effect and no changes — see the `appearance`
 * Compartment above for what that buys and what a state rebuild would have
 * cost. `flush: 'post'` is not needed: nothing here reads layout.
 */
watch(themeAppearance, (next) => {
  view.value?.dispatch({ effects: appearance.reconfigure(codeThemeFor(next)) });
});
</script>

<template>
  <div ref="host" class="code-editor" />
</template>

<style scoped>
/* Deliberately the terminal's own background, inherited from the textarea this
   replaces: an open file and the shell it came from should read as the same
   surface. The height chain matters — CodeMirror measures its scroller against
   an ancestor with a real height, and a `flex: 1` box that forgets `min-height`
   grows to fit its content instead of scrolling. */
.code-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--term-bg);
}
</style>
