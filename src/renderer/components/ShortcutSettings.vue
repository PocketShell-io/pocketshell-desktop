<script setup lang="ts">
// ShortcutSettings: the Keyboard group of the settings sheet — the list of
// every chord PocketShell claims, the rebinding capture, and the refused-keys
// ledger. Extracted from SettingsView.vue with its reasoning; the parent keeps
// the group chrome and the rest of the sheet.
//
// THE LIST STANDS ALONE. It is rendered straight off `SHORTCUTS`, grouped by
// surface, and it shows EVERY binding including the ones nothing here can
// change: the zoom chords the main process recognises, CodeMirror's own undo,
// the Escape ladder. Hiding those would make this screen a list of "shortcuts
// PocketShell happens to implement in the renderer", which is not the question
// being asked. What the user wants to know is which keys do something, and a
// key Electron's default menu took is still a key that does something.
//
// There is no local copy of any chord in this file. Every chip below is
// rendered from `settings.shortcutBindings`, which is the same map the handlers
// read, so the list cannot go stale the way the zoom percentage would have if
// the keyboard had been allowed its own copy of the number.
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSettingsStore } from '../stores/settings';
import {
  type BindingRefusal,
  type Chord,
  chordFromEvent,
  chordsFor,
  formatChordParts,
  MENU_CLAIMED_UNSUPPRESSIBLE,
  RESERVED_CHORDS,
  type ShortcutSpec,
  shortcutsForSurface,
  SURFACES,
  terminalCanEncode,
} from '../../shared/shortcuts';

const settings = useSettingsStore();

const mac = computed(() => navigator.platform.toLowerCase().includes('mac'));

/** The surfaces, each with its bindings. Rendered in the registry's order. */
const shortcutGroups = computed(() =>
  SURFACES.map((surface) => ({ surface, specs: shortcutsForSurface(surface.id) })).filter(
    (group) => group.specs.length > 0,
  ),
);

/** The chords in force for one binding — never the defaults, unless they match. */
function chipsFor(spec: ShortcutSpec): string[][] {
  return chordsFor(settings.shortcutBindings, spec.id).map((chord) =>
    formatChordParts(chord, mac.value),
  );
}

/**
 * Which binding is currently listening for a keypress, and what went wrong.
 *
 * Capture, not a text field. Typing `Ctrl+Shift+V` into a box would ask the
 * user to spell a chord in a notation they have never seen, and it would get
 * shifted punctuation wrong in a way nobody could debug — Shift+` is `~`, so a
 * hand-typed `Ctrl+Shift+\`` matches no keypress that exists (see the module
 * header). Pressing the keys reads exactly the field the matcher reads.
 */
const capturing = ref<string | null>(null);
const captureError = ref<BindingRefusal | null>(null);

/**
 * Focus the capture control the moment it exists.
 *
 * A function ref rather than `autofocus`, which browsers only honour for an
 * element present at page load and silently ignore for one a framework inserts.
 * Focus is not decoration here: the control's entire purpose is to receive a
 * keydown, and a user who clicked "change" and then pressed Ctrl+Shift+K
 * without focus would fire the composer toggle instead of rebinding it.
 */
function bindCaptureEl(el: unknown): void {
  if (el instanceof HTMLElement) el.focus();
}

function startCapture(id: string): void {
  capturing.value = id;
  captureError.value = null;
}

function cancelCapture(): void {
  capturing.value = null;
  captureError.value = null;
}

/**
 * A keypress inside a capture field.
 *
 * `preventDefault` AND `stopPropagation` on EVERY key, not only on the ones
 * that turn out to be bindable. While this field has focus it owns the
 * keyboard: the chord being pressed is, by definition, one that means something
 * somewhere else in the app, and letting it through would fire that command
 * while the user was in the middle of moving it. Escape is the one key that
 * leaves rather than binds, so there is always a way out.
 *
 * Bare modifiers are ignored rather than refused: a user holding Ctrl on the
 * way to Ctrl+Shift+K produces a keydown for Ctrl and one for Shift first, and
 * flashing "that is a modifier on its own" at them twice per rebinding would be
 * a bug wearing a validation message.
 */
function onCaptureKey(id: string, event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    cancelCapture();
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph'].includes(event.key)) return;
  const chord: Chord = chordFromEvent(event);
  const refusal = settings.rebindShortcut(id, chord);
  if (refusal) {
    captureError.value = refusal;
    return;
  }
  cancelCapture();
}

function onResetShortcut(id: string): void {
  settings.resetShortcut(id);
  if (capturing.value === id) cancelCapture();
}

function onResetAllShortcuts(): void {
  settings.resetAllShortcuts();
  cancelCapture();
}

/**
 * What this binding costs the shell, DERIVED rather than written down.
 *
 * "What did I just lose?" is the first question a terminal user has when an app
 * claims a Ctrl chord, and the answer changes the moment they rebind it — so it
 * cannot be a fixed sentence in the registry. It comes from the chord in force
 * through `terminalCanEncode`, which is transcribed from the xterm this app
 * actually ships rather than from a belief about terminals in general.
 *
 * BOTH answers are shown, not only the reassuring one. A screen that said "the
 * shell loses nothing" where that was true and went silent where it was not
 * would be worth very little — "not" was the common case for the tab chords,
 * whose briefing assumed the opposite and was wrong: Ctrl+Tab is a plain tab at
 * a shell prompt, and Ctrl+3..Ctrl+8 are C0 controls. Being measured wrong is
 * part of why the cycle chords were released back to the shell.
 *
 * Only for surfaces that sit in front of a shell, and never for a binding the
 * terminal itself owns — on the Files tab there is no shell to lose anything,
 * which is the same asymmetry the conflict graph turns on.
 */
function shellCostNote(spec: ShortcutSpec): { text: string; safe: boolean } | null {
  if (spec.surface !== 'workspace' && spec.surface !== 'terminal') return null;
  if (spec.owner === 'library') return null;
  const chords = chordsFor(settings.shortcutBindings, spec.id);
  if (chords.length === 0) return null;
  if (chords.every((chord) => !terminalCanEncode(chord))) {
    return { text: 'A terminal cannot send this key, so the shell loses nothing.', safe: true };
  }
  return {
    text: 'A terminal CAN send this key, so the shell no longer receives it in this pane.',
    safe: false,
  };
}
</script>

<template>
  <!--
    Grouped by SURFACE rather than alphabetically or by frequency, because
    the question a reader has is never "what does Ctrl+L do" — it is "I am
    looking at the Files tab, what can I press". The blurb under each heading
    says when that group is live, which is the part no code comment could
    ever have told them.

    Every chord is a run of <kbd> chips, one per key. Not a glyph: this is
    exactly the screen where a ⌘ or an ↑ would be pressed into service as an
    icon, and tests/unit/designGates.test.ts
    — enforces that every glyph doing an icon's job here is a real SVG. So the arrows
    are the words "Up" and "Down", which also happen to be what a keycap says.
  -->
  <div class="row stacked">
    <div class="row-text">
      <span class="row-label">Shortcuts</span>
      <p class="row-hint">
        Every key PocketShell claims, and what it does. Some are fixed — the zoom
        chords are recognised before the page sees the key, the editor's undo belongs
        to the editor, and <kbd>Esc</kbd> is a ladder that closes whatever you opened
        last rather than a single command. The rest you can move.
      </p>
    </div>
    <button
      class="add-btn self-start"
      :disabled="!settings.hasShortcutOverrides"
      @click="onResetAllShortcuts"
    >
      <AppIcon name="rotate-ccw" :size="14" />
      Reset every shortcut
    </button>
  </div>

  <div v-for="group in shortcutGroups" :key="group.surface.id" class="keys-group">
    <h4 class="keys-title">{{ group.surface.label }}</h4>
    <p class="keys-blurb">{{ group.surface.blurb }}</p>

    <ul class="keys">
      <li v-for="spec in group.specs" :key="spec.id" class="key-row">
        <div class="key-text">
          <span class="key-label">{{ spec.label }}</span>
          <p v-if="spec.note" class="key-note">{{ spec.note }}</p>
          <p
            v-if="shellCostNote(spec)"
            class="key-note"
            :class="shellCostNote(spec)!.safe ? 'safe' : 'cost'"
          >
            {{ shellCostNote(spec)!.text }}
          </p>
          <!-- The refusal sits under the binding it was refused for, not in
               a banner at the top: the user is looking at this row, and a
               conflict names another command they now have to find. -->
          <p v-if="captureError && capturing === spec.id" class="notice">
            <AppIcon name="alert-triangle" :size="14" />
            <span>{{ captureError.message }}</span>
          </p>
        </div>

        <div class="key-controls">
          <!-- Capturing REPLACES the chips rather than sitting beside them,
               so there is never a moment where the screen shows both the
               old chord and a field claiming to hold the new one. -->
          <button
            v-if="capturing === spec.id"
            :ref="bindCaptureEl"
            class="capture"
            @keydown="onCaptureKey(spec.id, $event)"
            @blur="cancelCapture"
          >
            Press the keys… <kbd>Esc</kbd> to cancel
          </button>
          <template v-else>
            <span class="chords">
              <span v-if="chipsFor(spec).length === 0" class="chord-none">
                Any printable key
              </span>
              <span v-for="(parts, i) in chipsFor(spec)" :key="i" class="chord">
                <kbd v-for="part in parts" :key="part">{{ part }}</kbd>
              </span>
            </span>
            <button
              v-if="spec.rebindable"
              class="icon-btn"
              :title="`Change the shortcut for ${spec.label}`"
              :aria-label="`Change the shortcut for ${spec.label}`"
              @click="startCapture(spec.id)"
            >
              <AppIcon name="edit-2" :size="14" />
            </button>
            <button
              v-if="spec.rebindable"
              class="icon-btn"
              :disabled="!settings.isShortcutOverridden(spec.id)"
              :title="`Reset ${spec.label} to its default`"
              :aria-label="`Reset ${spec.label} to its default`"
              @click="onResetShortcut(spec.id)"
            >
              <AppIcon name="rotate-ccw" :size="14" />
            </button>
            <!-- A fixed binding says so where the buttons would be, rather
                 leaving a gap the reader has to interpret. -->
            <span v-else class="fixed-tag">Fixed</span>
          </template>
        </div>
      </li>
    </ul>
  </div>

  <!--
    What PocketShell refuses to take, and why.

    This is not a disclaimer. Two of the three reasons are things a user
    would otherwise discover by breaking something: bind a command to
    Ctrl+C and you cannot stop a running program; bind one to Ctrl+W and
    the window closes as well as running the command, because that
    accelerator belongs to Electron's own menu and the page cannot take it
    back. Listing them turns "that didn't work" into "that was refused, and
    here is what would have happened".
  -->
  <div class="keys-group">
    <h4 class="keys-title">Keys PocketShell will not take</h4>
    <p class="keys-blurb">
      Refused when you try to bind them, so a rebinding cannot lock you out of your
      own shell or your own window.
    </p>

    <ul class="keys">
      <li v-for="entry in RESERVED_CHORDS" :key="entry.chord" class="key-row locked">
        <div class="key-text">
          <span class="key-label">{{ entry.why }}</span>
        </div>
        <div class="key-controls">
          <span class="chords">
            <span class="chord">
              <kbd v-for="part in entry.chord.split('+')" :key="part">{{ part }}</kbd>
            </span>
          </span>
        </div>
      </li>
      <li v-for="entry in MENU_CLAIMED_UNSUPPRESSIBLE" :key="entry.chord" class="key-row locked">
        <div class="key-text">
          <span class="key-label">Electron's built-in menu: {{ entry.role }}</span>
        </div>
        <div class="key-controls">
          <span class="chords">
            <span class="chord">
              <kbd v-for="part in entry.chord.split('+')" :key="part">{{ part }}</kbd>
            </span>
          </span>
        </div>
      </li>
    </ul>

    <p class="keys-blurb">
      A shortcut also needs <kbd>Ctrl</kbd> or <kbd>Alt</kbd> — without one it would
      swallow ordinary typing — and a bare <kbd>Alt</kbd> chord is refused anywhere a
      terminal can be behind, because <kbd>Alt</kbd> is Meta there and programs read
      it.
    </p>
  </div>
</template>

<style scoped>
/*
 * The row/label/hint primitives this group uses are mirrored from the
 * settings sheet's own stylesheet, not shared: Vue scoped styles do not
 * cross a component boundary, and promoting them to global CSS is not this
 * file's decision to make. The mirror is visual only — one spelling of each
 * rule still lives in SettingsView.vue.
 */
/* A key, wherever one is named — in a hint, or as a chip in the shortcut list.
   Not a control: it is the picture of a keycap, so it takes no hover, no focus
   ring and no pointer. `min-width` keeps a one-character cap ("K", "0") the
   same shape as the modifiers beside it, which is what makes a row of them read
   as one chord rather than as ragged text. */
kbd {
  display: inline-block;
  min-width: 1.6em;
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  /* The lower edge a keycap has. One pixel, in the same token as the border, so
     it survives every theme without a colour of its own. */
  box-shadow: 0 1px 0 var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--fg);
  text-align: center;
  font-family: var(--font-mono);
  font-size: 0.9em;
  line-height: 1.6;
}
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-soft);
}
.row:last-child {
  border-bottom: none;
}
/* A list plus an editor cannot sit in the label-left/control-right shape the
   other rows use — it needs the full width — so this row stacks instead. */
.row.stacked {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}
.add-btn {
  flex: none;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
}
.add-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: var(--accent-soft);
}
.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.row-label {
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  color: var(--fg);
}
/* --fg-secondary, not --fg-muted: this is real information at 12px, and
   --fg-muted is 4.12:1; restrict it to >=15px. */
.row-hint {
  margin: 0;
  max-width: 46ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
/* The section's own reset sits beside the heading text, top-aligned with it
   rather than centred against a two-line hint. */
.add-btn.self-start {
  align-self: flex-start;
}
/* --- The shortcut list ---------------------------------------------------
   One block per surface. The blurb under each heading is doing real work — it
   is the answer to "when is this live", which is the thing the code comments
   could never tell a user — so it is styled as prose, not as a caption.
   ---------------------------------------------------------------------- */
.keys-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-soft);
}
.keys-group:last-child {
  border-bottom: none;
}
.keys-title {
  margin: 0;
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  color: var(--fg);
}
.keys-blurb {
  margin: 0;
  max-width: 60ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.keys {
  list-style: none;
  margin: var(--sp-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}
/* Label left, chord right — the same shape as every other row on this screen,
   so the shortcut list does not read as a different kind of document. */
.key-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
}
.key-row:last-child {
  border-bottom: none;
}
/* The "will not take" rows are a reference, not a control: quieter ground so
   they do not read as things that could be changed. */
.key-row.locked {
  background: var(--surface-2);
}
.key-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.key-label {
  font-size: var(--fs-300);
  color: var(--fg);
}
/* The WHY, carried over from the code comment that used to be its only home.
   Narrow measure because these run long and a full-width line of 12px text is
   not read. */
.key-note {
  margin: 0;
  max-width: 62ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
/* "The shell loses nothing" — reassurance rather than explanation, so it takes
   the accent the app uses for a good state. */
.key-note.safe {
  color: var(--accent);
}
/* Its opposite: this chord DOES take a key away from the pane. The app's warning
   colour, not its error colour — a stated cost is not a fault, and painting it
   red would make a working binding look broken. */
.key-note.cost {
  color: var(--warning);
}
.key-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: var(--control-h);
}
.chords {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-2);
}
/* One chord: its keys sit tight together, and the gap above separates chords
   from each other. That spacing IS the grouping — without it `Ctrl 0 Ctrl -`
   reads as four keys rather than as two chords. */
.chord {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.chord-none {
  font-size: var(--fs-200);
  color: var(--fg-secondary);
  font-style: italic;
}
/* A binding that is not ours to move. Says so in words: a greyed-out button
   would look like something that could be enabled. */
.fixed-tag {
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
/* The capture field. A button rather than an input because it accepts no text —
   it accepts a KEYPRESS — and a button is already focusable, already announces
   itself, and cannot be typed into by a screen reader's virtual cursor. The
   accent border is the "I am listening" state, and it is the only place on this
   screen where a control holds the keyboard. */
.capture {
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  color: var(--accent);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-200);
}
/* The refusal sheet. Mirrors the settings sheet's shared notice rule (there it
   is grouped with the roots editor's `.root-notice`); scoped styles cannot be
   inherited across this component boundary. */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--warning);
  background: var(--warning-soft);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
</style>
