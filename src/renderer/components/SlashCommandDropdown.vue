<script setup lang="ts">
// SlashCommandDropdown: the `/`-triggered inline command list, floating ABOVE
// the draft field.
//
// It is a thin renderer — every decision (is it open, what is the query, what
// does an accepted row insert) is made by the pure helpers in
// src/shared/composerText.ts and src/shared/agentCommands.ts, exactly as the
// Android original splits SlashCommandAutocomplete from PromptComposerSheet.
//
// The catalog is app-shipped and per-agent, so a command an engine does not
// have is never offered. With no agent detected the parent never renders this.
// 
import type { AgentCommand } from '../../shared/agentCommands';

defineProps<{
  commands: AgentCommand[];
  /** Index of the keyboard-highlighted row. */
  active: number;
}>();

const emit = defineEmits<{
  (e: 'pick', command: AgentCommand): void;
  (e: 'hover', index: number): void;
}>();
</script>

<template>
  <div class="slash-dropdown" role="listbox" aria-label="Agent commands">
    <button
      v-for="(cmd, i) in commands"
      :key="cmd.command"
      :class="['slash-row', { active: i === active }]"
      role="option"
      :aria-selected="i === active"
      type="button"
      @mousedown.prevent="emit('pick', cmd)"
      @mouseenter="emit('hover', i)"
    >
      <span class="slash-token">{{ cmd.command }}</span>
      <span v-if="cmd.argument" class="slash-arg">&lt;{{ cmd.argument.placeholder }}&gt;</span>
      <span class="slash-desc">{{ cmd.description }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Height-capped and self-scrolling, per PromptComposerSheet.kt:2915 (196dp). */
.slash-dropdown {
  max-height: 196px;
  overflow-y: auto;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--sp-1);
  box-shadow: var(--shadow-popover);
}
.slash-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: baseline;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  padding: var(--row-pad-y) var(--row-pad-x);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  color: var(--fg);
}
.slash-row:hover,
.slash-row.active {
  background: var(--state-selected);
}
.slash-token {
  font-family: var(--font-mono);
  font-weight: var(--fw-semibold);
  color: var(--accent);
}
.slash-arg {
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--fg-muted);
  white-space: nowrap;
}
/* <=2 lines, then ellipsis — the Android row caps at 2 lines too. */
.slash-desc {
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
