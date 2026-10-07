<script setup lang="ts">
// Settings → Advanced → Local terminal: what a plain terminal tab on THIS
// machine opens. Desktop-only by construction — the section is contributed
// through the `settings.sections` slot (renderer/main.ts), so a platform
// without local hosts renders nothing.
//
// Scope note for the hint text: this is the bare terminal's shell only. The
// commands the app runs on the machine stay on Git Bash (they are POSIX), and
// a session's shell belongs to the aplexer session, not to this setting.
import { computed } from 'vue';
import { LOCAL_SHELL_OPTIONS } from '@pocketshell/core';
import { useSettingsStore } from '@ui/app/stores/settings';

const settings = useSettingsStore();
// PowerShell and cmd are Windows programs. On a mac/Linux desktop the choice
// that remains is the default bash, or pwsh — which is a cross-platform install.
const isWindows = navigator.userAgent.includes('Windows');
const options = computed(() =>
  LOCAL_SHELL_OPTIONS.filter((option) => isWindows || option.id === '' || option.id === 'pwsh'),
);

function onChange(event: Event): void {
  settings.set('localShell', (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="row">
    <div class="row-text">
      <label class="row-label" for="local-shell">Terminal shell</label>
      <p class="row-hint">
        What a plain terminal tab on this computer opens. New tabs take it up at once;
        open tabs keep their shell. Commands PocketShell runs itself, and session tabs,
        stay on Git Bash.
      </p>
    </div>
    <select
      id="local-shell"
      data-testid="setting-local-shell"
      :value="settings.localShell"
      @change="onChange"
    >
      <option v-for="option in options" :key="option.id" :value="option.id">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>

<style scoped src="@ui/app/components/settings/settingsGroup.css"></style>
