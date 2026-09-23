<script setup lang="ts">
// OverlayPanel: a modal sheet for host-level panels (Ports, Usage) that are
// reachable from the host header but are not peer tabs of the session tabs.
// Closes on backdrop click and on Escape; the content is supplied by the
// default slot so the panels themselves stay plain views.
//
// The overlay chrome owns the heading. A hosted view that carries its own
// title must suppress it when embedded (see UsageView's `embedded` prop),
// otherwise the name appears twice — which it used to, see
// docs/screenshots/07-usage-overlay.png.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';

withDefaults(
  defineProps<{
    title: string;
    /**
     * Content width. `lg` (960px) suits the wide port-forward table; `md`
     * (720px) suits a panel whose content is narrower — a panel wider than its
     * content is just a void with a border around it. `sm` (480px) is for a
     * short form of stacked label/control rows, where `md` would stretch every
     * control to twice the width its content needs.
     */
     size?: 'sm' | 'md' | 'lg';
  }>(),
  { size: 'lg' },
);
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

/**
 * Focus management, the minimal version. Without it, opening a panel left
 * keyboard focus on the trigger button BEHIND the scrim — Tab then walked the
 * obscured background — and closing restored nothing. So: on mount, remember
 * where focus was and move it into the panel (the `tabindex="-1"` below is
 * what makes a plain div focusable), so keyboard events start inside the
 * dialog and the `role="dialog"`/`aria-label` are announced; on unmount, hand
 * focus back, best-effort — the trigger may be gone by then (a session row
 * that closed itself), hence the `isConnected` guard.
 *
 * Two deliberate limits. A full focus TRAP — cycling Tab at the panel's edges,
 * inert-ing the background — was considered and deferred: it is a page of
 * subtle code for a marginal gain here, since every panel is dismissed by
 * Escape and none is long enough for Tab to walk off the end of in practice.
 * And the panel must not STEAL focus from its own content: several dialogs
 * focus a field of their own as they mount, and slot children mount before
 * this component's mounted hook runs, so we only take focus when none of them
 * already did.
 */
const panelEl = ref<HTMLElement | null>(null);
/**
 * Captured at SETUP, not in `onMounted` — the same child-first ordering that
 * makes the no-stealing check above work means that by mounted-time a child
 * may have focused its own field, and `activeElement` would then name an
 * element inside the panel: we would "restore" focus to a field that is being
 * torn down with the panel, and it would die with it, dropping focus to
 * `<body>`. Setup runs before any of the subtree exists, so what is captured
 * here is genuinely where the user was.
 */
const openedFrom: HTMLElement | null =
  document.activeElement instanceof HTMLElement ? document.activeElement : null;

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  const panel = panelEl.value;
  if (panel && !panel.contains(document.activeElement)) panel.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  if (openedFrom?.isConnected) openedFrom.focus();
});
</script>

<template>
  <!-- `appear` so the entrance plays on the first render too: the panel is
       mounted by a v-if, so its first appearance IS its only appearance. -->
  <Transition name="overlay" appear>
    <div class="overlay-backdrop" @click.self="emit('close')">
      <div
        ref="panelEl"
        class="overlay-panel"
        :class="size"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="overlay-header">
          <h2 class="overlay-title">{{ title }}</h2>
          <div class="overlay-actions">
            <!-- Panel-scoped controls (refresh, filters) belong up here beside
                 the close control, not floating at the top of the body. -->
            <slot name="actions" />
            <button class="icon-btn" title="Close" @click="emit('close')">
              <AppIcon name="close" />
            </button>
          </div>
        </header>
        <div class="overlay-body">
          <slot />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay-backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
/* Sizes to its CONTENT, capped: `height` used to reserve a fixed 720px slab,
   so a panel with 180px of content rendered as a mostly-empty rectangle. The
   body scrolls once the content exceeds the cap. */
.overlay-panel {
  display: flex;
  flex-direction: column;
  max-height: min(720px, 88vh);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
}
/* The panel takes programmatic focus on open (see the script), and App.vue's
   one-focus-treatment rule matches every `[tabindex]` — but the panel is a
   SURFACE, not a control, and a ring around the whole sheet would say "this is
   operable" about something that is only a container. `:focus-visible` (not
   bare `:focus`) so the suppression is scoped to exactly the case the global
   rule creates; real controls inside keep their rings untouched. */
.overlay-panel:focus-visible {
  outline: none;
}
.overlay-panel.lg {
  width: min(960px, 92vw);
}
.overlay-panel.md {
  width: min(720px, 92vw);
}
.overlay-panel.sm {
  width: min(480px, 92vw);
}
.overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
}
.overlay-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.overlay-title {
  margin: 0;
  font-size: var(--fs-500);
  line-height: var(--lh-500);
  font-weight: var(--fw-semibold);
}
.overlay-body {
  /* `1 1 auto` not `1`: flex-basis auto lets the body take its content's
     height, which is what makes the panel size to its content. */
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: auto;
}
.overlay-body > :deep(*) {
  flex: 1;
  min-width: 0;
}

/* Entrance decelerates in over --dur-slow; dismissal is a plain fast fade and
   nothing scales on the way out — leaving should feel quicker than arriving. */
.overlay-enter-active {
  transition: opacity var(--dur-normal) var(--ease-out);
}
.overlay-enter-active .overlay-panel {
  transition:
    transform var(--dur-slow) var(--ease-out),
    opacity var(--dur-normal) var(--ease-out);
}
.overlay-enter-from {
  opacity: 0;
}
.overlay-enter-from .overlay-panel {
  opacity: 0;
  transform: translateY(8px) scale(0.985);
}
.overlay-leave-active {
  transition: opacity var(--dur-fast) var(--ease);
}
.overlay-leave-to {
  opacity: 0;
}
</style>
