<script setup lang="ts">
// The desktop's root: the shared app root (@ui/app/AppRoot.vue — theme and
// typography watchers, the diagnostics and update strips, the router outlet,
// the app's Ctrl+W) plus the two things only the desktop has.
//
//   - Frame zoom. Zoom is not a CSS fact but a property of the Electron
//     frame, so it goes through the preload's `webFrame.setZoomFactor`.
//   - The account WINDOW (`?window=account`): the same renderer in a second
//     window shows the account surface instead of the router outlet.
//
// macOS keeps Electron's default menu, whose window role still holds
// Cmd/Ctrl+W, so the shared root stands down from that chord there
// (@ui/app/defaultMenu.ts).
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import { zoomFactor } from '@ui/app/zoom';
import { api } from '@ui/app/ipc';
import { KEEPS_DEFAULT_MENU } from '@ui/app/defaultMenu';
import { useSettingsStore } from '@ui/app/stores/settings';
import AppRoot from '@ui/app/AppRoot.vue';
import AccountView from '@ui/app/views/AccountView.vue';

const settings = useSettingsStore();
const isAccountWindow = new URLSearchParams(window.location.search).get('window') === 'account';

/**
 * The ONE call that actually moves the window's zoom: a watcher on the
 * settings store, so the stored value is the only input and there is exactly
 * one writer. Running immediately (as `watchEffect` does) is also what
 * restores the user's zoom on launch, before the first frame the user sees.
 */
watchEffect(() => {
  api.win.setZoom(zoomFactor(settings.zoomPercent));
});

/**
 * Zoom chords, caught in main (see src/shared/zoomKeys.ts) because the page
 * never gets to see them — the same `preventDefault()` that disarms Electron's
 * default-menu zoom roles also suppresses the page keydown. They land on the
 * store's actions rather than on `setZoom`: pressing Ctrl+- and dragging the
 * Settings stepper are the same write to the same value, so the panel cannot
 * show a percentage the window is not actually at.
 */
let stopZoomCommands: (() => void) | null = null;

onMounted(() => {
  stopZoomCommands = api.win.onZoomCommand((command) => {
    if (command === 'in') settings.zoomIn();
    else if (command === 'out') settings.zoomOut();
    else settings.resetZoom();
  });
});

onBeforeUnmount(() => {
  stopZoomCommands?.();
  stopZoomCommands = null;
});
</script>

<template>
  <AppRoot :claim-delete-word="!KEEPS_DEFAULT_MENU">
    <AccountView v-if="isAccountWindow" />
    <router-view v-else />
  </AppRoot>
</template>
