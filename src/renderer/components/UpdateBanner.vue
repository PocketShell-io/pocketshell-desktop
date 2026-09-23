<script setup lang="ts">
// UpdateBanner: the app-wide strip for a newer release, mounted once in
// App.vue beside the DiagBanner.
//
// The desktop port of the phone's update banner, with the same honesty
// contract: shown only when a check SUCCEEDED and found something, and the
// download is a browser tab, not an in-app install — unpacking or running an
// installer is the user's act, exactly like sideloading on the phone.
//
// Fixed, not in-flow, for the same reason DiagBanner is (views size to the
// viewport); it parks BELOW the diag strip so the two can coexist.
import { computed } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { useUpdateStore } from '../stores/update';
import { api } from '../ipc';

const store = useUpdateStore();
const visible = computed(() => store.status === 'available');
const openDownload = () => {
  if (store.downloadUrl) void api.update.open(store.downloadUrl);
};
const openNotes = () => {
  if (store.notesUrl) void api.update.open(store.notesUrl);
};
const dismiss = () => {
  store.status = 'up-to-date';
};
</script>

<template>
  <div v-if="visible" class="update-strip" role="status">
    <div class="row">
      <span class="message">
        <strong>{{ store.tagName }}</strong> is available — you are on
        {{ store.currentVersion }}.
      </span>
      <span class="actions">
        <button class="btn primary" title="Open the download in your browser" @click="openDownload">
          <AppIcon name="download" :size="12" /> Download
        </button>
        <button class="btn ghost" title="Release notes on GitHub" @click="openNotes">Notes</button>
        <button class="icon-btn sm dismiss" title="Dismiss" @click="dismiss">
          <AppIcon name="close" :size="12" />
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.update-strip {
  position: fixed;
  top: calc(var(--sp-2) + 40px); /* below the diag strip's slot, not on top of it */
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  width: min(560px, calc(100vw - var(--sp-6)));
  background: var(--surface-3);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-overlay);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}
.message {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  font-size: 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
.btn.primary {
  border-color: var(--accent);
  color: var(--accent);
}
.btn.primary:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.btn.ghost:hover {
  background: var(--surface-3);
}
</style>
