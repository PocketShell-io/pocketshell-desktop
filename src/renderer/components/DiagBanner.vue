<script setup lang="ts">
// DiagBanner: the app-wide strip for unhandled renderer errors, mounted once
// in App.vue above the router outlet.
//
// Fixed, not in-flow, on purpose. Every view sizes itself to the viewport
// (`height: 100vh`), so a strip that pushed content down would overflow the
// window by its own height and nudge a scrollbar into every screen it appeared
// on. An error report may overlay the top bar briefly; that is the honest
// cost of being visible everywhere without rearranging every screen for a
// state that is usually absent. Dismiss it and it is gone — the same text is
// in the desktop log (see renderer/diag.ts), so dismissing loses nothing.
import AppIcon from '@ui/components/AppIcon.vue';
import { diagErrors, dismissDiagError } from '../diag';
</script>

<template>
  <div v-if="diagErrors.length" class="diag-strip" role="alert">
    <div class="rows">
      <p v-for="entry in diagErrors" :key="entry.id" class="row" :title="entry.stack ?? entry.message">
        <span class="kind">[{{ entry.kind }}]</span>
        <span class="message">{{ entry.message }}</span>
        <button class="icon-btn sm dismiss" title="Dismiss" @click="dismissDiagError(entry.id)">
          <AppIcon name="close" :size="12" />
        </button>
      </p>
    </div>
  </div>
</template>

<style scoped>
.diag-strip {
  position: fixed;
  top: var(--sp-2);
  left: 50%;
  transform: translateX(-50%);
  z-index: 50; /* overlays, including overlays: an error report outranks them */
  width: min(640px, calc(100vw - var(--sp-6)));
  background: var(--surface-3);
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
}
.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--error);
}
.row + .row {
  border-top: 1px solid var(--border-soft);
}
.kind {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
/* The message takes the slack and truncates; the stack — the real content —
   is the row's title, one hover away, and always whole in the desktop log. */
.message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dismiss {
  flex: none;
}
</style>
