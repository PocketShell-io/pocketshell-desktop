<script setup lang="ts">
// ComposerAttachmentTiles: the pending list of staged attachments.
//
// These are STRUCTURED STATE, never folded into the draft while composing —
// their remote paths are appended to the text at send time and only then
//. That is why attaching a file does not make the
// textarea jump, and why removing a tile leaves the draft untouched.
//
// Each tile shows the file NAME only, never the full remote path
// (PromptComposerViewModel.kt:2675).
import AppIcon from './AppIcon.vue';
import { classifyByName } from '../fileKind';
import type { StagedAttachment } from '../stores/composer';

defineProps<{
  attachments: StagedAttachment[];
  /** Removal is disabled while a send is in flight. */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'remove', remotePath: string): void;
  (e: 'annotate', remotePath: string): void;
}>();

/**
 * Can this tile be opened in the doodle surface?
 *
 * `classifyByName` rather than a rule of this component's own. There were
 * already two ways to ask "is this an image" — `previewFor` in PromptComposer
 * (`mimeType.startsWith('image/')`, off a live `File`) and the Files tab's
 * classifier — and a third would be the one that drifts. The classifier is the
 * right one of the two because it answers from the NAME: a tile only carries a
 * preview when it came from a paste or a drop, so keying off `previewDataUrl`
 * would offer annotation on a dropped screenshot and refuse it on the same
 * file chosen through the paperclip, or on either one after a restart (the
 * preview is deliberately never persisted). The remote path always survives.
 *
 * It also gets the negatives right for free, which is the point of the gate: a
 * PDF, an mp3 and a zip are `pdf`, `audio` and `binary`, and none of them has
 * pixels a canvas could paint.
 */
function canAnnotate(attachment: StagedAttachment): boolean {
  return classifyByName(attachment.remotePath).kind === 'image';
}
</script>

<template>
  <ul class="tiles" aria-label="Staged attachments">
    <li v-for="a in attachments" :key="a.remotePath" class="tile" :title="a.remotePath">
      <img v-if="a.previewDataUrl" class="thumb" :src="a.previewDataUrl" alt="" />
      <AppIcon v-else class="glyph" name="file" />
      <span class="name">{{ a.displayName }}</span>
      <!-- Images only. The button sits BEFORE the remove `×` so the
           destructive control keeps the corner it has always had — a tile
           whose rightmost button changed meaning depending on file type is how
           you get a muscle-memory click that deletes an attachment. -->
      <button
        v-if="canAnnotate(a)"
        class="annotate"
        type="button"
        :disabled="disabled"
        :title="`Annotate ${a.displayName}`"
        :aria-label="`Annotate ${a.displayName}`"
        @click="emit('annotate', a.remotePath)"
      >
        <AppIcon name="edit-2" />
      </button>
      <button
        class="remove"
        type="button"
        :disabled="disabled"
        :title="`Remove ${a.displayName}`"
        :aria-label="`Remove ${a.displayName}`"
        @click="emit('remove', a.remotePath)"
      >
        <AppIcon name="close" />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.tiles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  list-style: none;
  margin: 0;
  padding: 0;
}
.tile {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 220px;
  height: var(--control-h);
  padding: 0 var(--sp-1) 0 var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-200);
  color: var(--fg);
}
.thumb {
  width: 18px;
  height: 18px;
  object-fit: cover;
  border-radius: 2px;
  flex: 0 0 auto;
}
.glyph {
  width: 14px;
  height: 14px;
  color: var(--fg-secondary);
}
.name {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.annotate,
.remove {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  cursor: pointer;
}
.annotate :deep(.app-icon),
.remove :deep(.app-icon) {
  width: 11px;
  height: 11px;
}
.annotate:hover:not(:disabled),
.remove:hover:not(:disabled) {
  background: var(--state-active);
  color: var(--fg);
}
.annotate:disabled,
.remove:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
</style>
