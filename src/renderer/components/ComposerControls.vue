<script setup lang="ts">
// ComposerControls: the composer card's control row — the attach / draw /
// slash pill, the keyboard hint, the armed Discard, and Send. Extracted from
// PromptComposer.vue; the row is presentational and announces through events,
// so every behaviour (what attach opens, what Send does, how the arm times
// out) stays with the composer.
//
// Scoped styles do not cross a component boundary, so every rule this markup
// uses is carried here from PromptComposer.vue's stylesheet; `.spacer` is
// mirrored because the card's title bar uses it on the parent's side too.
import AppIcon from './AppIcon.vue';
import type { ComposerAgentKind } from '../../shared/composerSend';

defineProps<{
  /** Drives the tools' disabled state while a batch is still landing. */
  uploadingCount: number;
  /** Slash commands need a detected agent; the button says so when absent. */
  agentKind?: ComposerAgentKind | null;
  canSend: boolean;
  sendInFlight: boolean;
  /** The Discard button exists only over something discardable. */
  draftLength: number;
  attachmentCount: number;
  discardArmed: boolean;
}>();

const emit = defineEmits<{
  attach: [];
  doodle: [];
  slash: [];
  discardClick: [];
  send: [];
}>();
</script>

<template>
  <div class="controls">
    <div class="pill">
      <button
        class="tool"
        type="button"
        title="Attach files (Ctrl+Shift+A)"
        aria-label="Attach to prompt"
        :disabled="uploadingCount > 0"
        @click="emit('attach')"
      >
        <AppIcon name="paperclip" />
      </button>
      <button
        class="tool"
        type="button"
        title="Draw or annotate an image"
        aria-label="Draw or annotate an image"
        :disabled="uploadingCount > 0"
        @click="emit('doodle')"
      >
        <AppIcon name="edit-2" />
      </button>
      <button
        class="tool"
        type="button"
        :title="
          (agentKind ?? null) === null
            ? 'Slash commands need a detected agent'
            : 'Slash commands'
        "
        aria-label="Slash commands"
        :disabled="uploadingCount > 0 || (agentKind ?? null) === null"
        @click="emit('slash')"
      >
        /
      </button>
    </div>
    <span class="spacer"></span>
    <span class="kbd-hint muted">Enter send &middot; Shift+Enter newline &middot; Ctrl+&uarr;&darr; history</span>
    <button
      v-if="draftLength || attachmentCount"
      :class="['discard', { armed: discardArmed }]"
      type="button"
      :title="discardArmed ? 'Click again to discard the draft and attachments' : 'Discard the draft (Ctrl+Shift+Backspace)'"
      :aria-label="discardArmed ? 'Click again to discard the draft' : 'Discard the draft'"
      @click="emit('discardClick')"
    >
      {{ discardArmed ? 'Discard draft?' : 'Discard' }}
    </button>
    <button
      class="send"
      type="button"
      :disabled="!canSend"
      title="Send (Enter)"
      @click="emit('send')"
    >
      {{ sendInFlight ? 'Sending…' : 'Send' }}
    </button>
  </div>
</template>

<style scoped>
/* Everything in this block styles THIS component's markup and was carried
   verbatim from PromptComposer.vue's stylesheet — scoped styles do not cross
   the component boundary, so the rules live beside the row they draw. */

/* ---- control row ------------------------------------------------------- */
.controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border-soft);
}
.pill {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 22px;
  flex: 0 0 auto;
}
/* The slash button keeps a TEXT `/`: it is the literal character the button
   inserts into the draft, a keycap rather than a pictogram. Everything else in
   this panel is a drawn icon. */
.tool {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: 1;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.tool:hover:not(:disabled) {
  background: var(--state-active);
  color: var(--fg);
}
.tool:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Mirrored from the parent, whose title bar uses the same class. */
.spacer {
  flex: 1 1 auto;
  min-width: 0;
}
/* First thing to give when the panel is narrow — it is a reminder, not a
   control, so it truncates instead of pushing Send off the edge. */
.kbd-hint {
  flex: 0 1 auto;
  font-size: var(--fs-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The control-row Discard, a ghost next to Send. Armed — after one click —
   it wears the error colors, so the destructive click announces itself
   before it fires. */
.discard {
  flex: 0 0 auto;
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.discard:hover {
  border-color: var(--error);
  color: var(--error);
}
.discard.armed {
  background: var(--error);
  border-color: var(--error);
  color: var(--on-accent);
}
.send {
  flex: 0 0 auto;
  height: var(--control-h);
  padding: 0 var(--sp-4);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  color: var(--on-accent);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.send:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.send:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Anything clickable that reaches into the 6px edge band has to sit above the
   grips, or the grip swallows a click that was aimed at the button. Mirrored
   from the parent, where the same rule carries the panel's action buttons. */
.send {
  position: relative;
  z-index: 3;
}
</style>
