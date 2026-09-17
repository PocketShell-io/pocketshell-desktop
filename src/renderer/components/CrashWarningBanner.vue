<script setup lang="ts">
// CrashWarningBanner: the session panel's unacknowledged crash/OOM warnings,
// one row per warning above the session tree.
//
// A crash warning outlives its session: aplexer keeps it host-side until
// `a ack` retires it, and by then the snapshot row is often gone already —
// pruned, or the worker died so hard the panel's own parse drops it — which
// is exactly why the strip reads the standalone `a warnings --json`
// endpoint rather than the listing the tree is built from.
//
// In flow, not an overlay like DiagBanner: this is panel business about the
// rows beneath it, and overlaying a narrow tree hides what it warns about.
// It pushes the tree down while it stands, and it leaves only through an
// acknowledge click — there is no dismiss, because "seen it" is not what
// makes a crash go away; `a ack` is durable and host-side, so every client
// sees the warning go together.
import AppIcon from './AppIcon.vue';
import { useConnectionStore } from '../stores/connection';
import { useWarningsStore } from '../stores/warnings';
import { aplexerSelector } from '../../shared/aplexer';
import { fmtRelative } from '../sessionTreeText';

defineProps<{ now: number }>();

const connection = useConnectionStore();
const warnings = useWarningsStore();

/** Last path segment — the panel speaks in tails; the tooltip carries the truth. */
function workspaceTail(workspace: string): string {
  return workspace.split('/').filter(Boolean).at(-1) ?? workspace;
}

async function ackOne(session: string): Promise<void> {
  if (connection.connectionId) await warnings.ack(connection.connectionId, session);
}

async function ackAll(): Promise<void> {
  if (connection.connectionId) await warnings.ack(connection.connectionId);
}
</script>

<template>
  <div
    v-if="warnings.warnings.length > 0 && connection.connectionId"
    class="crash-strip"
    role="alert"
  >
    <div v-if="warnings.warnings.length > 1" class="head">
      <span class="count">{{ warnings.warnings.length }} crashed sessions</span>
      <button class="ack-all" title="Acknowledge every warning (a ack)" @click="ackAll">
        <AppIcon name="check" :size="12" />
        Acknowledge all
      </button>
    </div>
    <p v-for="w in warnings.warnings" :key="w.session" class="row">
      <span class="line1">
        <span class="kind">{{ w.kind === 'oom' ? 'OOM' : 'crash' }}</span>
        <span class="sel" :title="aplexerSelector(w.workspace, w.tag)">
          {{ workspaceTail(w.workspace) }}:{{ w.tag }}
        </span>
        <span class="age">{{ fmtRelative(Math.floor(w.created_at_ms / 1000), now) }}</span>
        <button class="icon-btn sm ack" title="Acknowledge (a ack)" @click="ackOne(w.session)">
          <AppIcon name="check" :size="12" />
        </button>
      </span>
      <span class="detail" :title="w.detail">{{
        w.detail ||
          (w.kind === 'oom' ? 'killed by the kernel OOM killer' : 'died without recording an exit')
      }}</span>
    </p>
    <p v-if="warnings.ackError" class="ack-error">{{ warnings.ackError }}</p>
  </div>
</template>

<style scoped>
.crash-strip {
  display: flex;
  flex-direction: column;
  margin: 0 var(--sp-2) var(--sp-2);
  border: 1px solid var(--warning);
  background: var(--warning-soft);
  border-radius: var(--r-md);
  padding: var(--sp-1) var(--sp-2);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
}
.count {
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.ack-all {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  border: none;
  background: none;
  color: var(--warning);
  font-size: var(--fs-100);
  cursor: pointer;
  padding: 0;
}
.row {
  margin: 0;
  padding: var(--sp-1) 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row + .row {
  border-top: 1px solid var(--border-soft);
}
.line1 {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.kind {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--warning);
}
.sel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-200);
}
.age {
  flex: none;
  color: var(--fg-secondary);
  font-size: var(--fs-100);
}
.ack {
  flex: none;
}
.detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  line-height: var(--lh-200);
}
.ack-error {
  margin: 0;
  padding: var(--sp-1) 0 0;
  color: var(--error);
  font-size: var(--fs-100);
}
</style>
