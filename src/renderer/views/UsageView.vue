<script setup lang="ts">
// UsageView: per-provider quota dashboard from `pocketshell usage --json`.
//
// FORM: one shared table, not a row of cards. The job of this screen is
// COMPARISON — "who is nearly out?" — and comparison wants shared columns.
// Three side-by-side cards each laid out its own label/bar/percentage tracks,
// so no meter lined up with any other meter and the eye had to re-scan for
// every provider. Here every meter sits in one continuous column and every
// percentage right-aligns to one edge, so the shortest bar is the answer at a
// glance. It also holds at 1 provider and at 6+ without reflowing into a
// ragged grid, and provider rows cannot end up different heights.
//
// DATA SHAPE (see usageParsers.ts): each row carries `windows` — the windows
// that provider ACTUALLY has, shortest first. Copilot reports one monthly
// window, codex and grok a single weekly one, go three (5h + weekly +
// monthly); windows the provider does not have are dropped upstream, so the
// panel never shows a "not reported" placeholder for a window that does not
// exist. A window label (`5h`/`7d`/`weekly`/`monthly`) is always present.
// A `resets_available` count (codex's reset credits, grok's restok tokens)
// renders as a plain per-provider note line when the provider has one.
//
// A null percentage is NOT an empty row. It means the meter is unknown, not
// that the provider has nothing to say: the reset time is still real and is
// usually the more useful fact anyway ("codex resets in 2h"). So when the
// percentage is missing the reset becomes the row's primary content. Never
// coerce null to 0 — a 0%-wide bar reads as "quota exhausted" when the truth
// is "not reported".
import { computed, onMounted } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useAgentsStore } from '../stores/agents';
import AppIcon from '../components/AppIcon.vue';
import type { UsageRow } from '../../main/helper/usageParsers';

const props = defineProps<{
  /**
   * True when hosted inside OverlayPanel, which supplies the title itself —
   * and, since the polish pass, the refresh control too (it belongs beside the
   * close button, not floating at the top of the body). Without this the name
   * renders twice.
   */
  embedded?: boolean;
}>();

const connection = useConnectionStore();
const agents = useAgentsStore();
const connId = computed(() => connection.connectionId);

onMounted(async () => {
  if (connId.value) await agents.loadUsage(connId.value);
});

/** One rendered meter row: a provider's window, resolved for display. */
interface WindowRow {
  /** `5h` / `weekly` when the helper reports one, else the generic name. */
  label: string;
  /** null means "the provider did not report", never "zero left". */
  pct: number | null;
  reset: string | null;
}

/**
 * `percent_remaining` is nullable in the helper's 0.4.44 shape and codex and
 * grok both really do emit null.
 */
function hasPct(p: number | null | undefined): p is number {
  return typeof p === 'number' && Number.isFinite(p);
}

/**
 * One row per window the provider reported. The parser guarantees a non-empty
 * label and drops windows the provider does not have; the guards here are for
 * rows that bypassed it (a store fed by something other than
 * `parseUsageNdjson` must degrade to a quiet row, not a thrown render).
 */
function windowsOf(row: UsageRow): WindowRow[] {
  const list = Array.isArray(row.windows) ? row.windows : [];
  return list.map((w) => ({
    label: (w?.window ?? '').trim() || '—',
    pct: hasPct(w?.percent_remaining) ? w.percent_remaining : null,
    reset: w?.reset_at ?? null,
  }));
}

function pctColor(p: number): string {
  if (p > 50) return 'var(--success)';
  if (p > 20) return 'var(--warning)';
  return 'var(--error)';
}
function pctWidth(p: number): string {
  return `${Math.max(0, Math.min(100, p))}%`;
}
function pctText(p: number): string {
  return `${p.toFixed(0)}%`;
}

/**
 * The "how many full resets can I still spend" line — codex's reset credits,
 * grok's restok tokens — normalized by the parser into one count. Null when
 * the provider has no such concept (claude, copilot, zai), so no line.
 */
function resetsNote(row: UsageRow): string | null {
  const n = row.resets_available;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return `${n} reset${n === 1 ? '' : 's'} available`;
}

/**
 * The "why is this provider blocked" line, read from the pass-through
 * `details.limit_reached` the helper emits.
 *
 * Rendered as a neutral footnote, not a third alarm: the meter colour carries
 * the level and the status badge carries the category. Three amber signals for
 * one fact was the old card's loudest problem.
 */
function blockNote(row: UsageRow): string | null {
  const reason = row.details?.['limit_reached'];
  if (typeof reason === 'string' && reason.trim()) return reason;
  return null;
}

/**
 * "in 2h 14m" — the form that actually answers "how much have I got left".
 * The absolute timestamp is never lost: it is the cell's `title`, and a reset
 * already in the past falls back to it, because "due" would be a worse answer
 * than the date when the data is stale.
 */
function fmtRel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return fmtAbs(iso);
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `in ${hours}h ${mins % 60}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `in ${days}d ${hours % 24}h` : `in ${days}d`;
}

function fmtAbs(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function onRefresh(): Promise<void> {
  if (connId.value) await agents.loadUsage(connId.value);
}
</script>

<template>
  <div class="usage">
    <!-- Standalone only: embedded, OverlayPanel owns both the title and the
         refresh control. -->
    <div v-if="!props.embedded" class="usage-bar">
      <h2>Provider usage</h2>
      <button class="icon-btn" :disabled="agents.loading" title="Refresh" @click="onRefresh">
        <AppIcon name="refresh" :class="{ spin: agents.loading }" />
      </button>
    </div>

    <!-- The failure line stands ALONGSIDE stale rows rather than replacing
         them: a table that is a few minutes old with a reason attached beats
         an empty one — the same call the sessions store makes for its poll,
         and the store keeps the rows for exactly this. -->
    <p v-if="agents.usageError" class="error fetch-error">{{ agents.usageError }}</p>

    <div v-if="agents.usage.length" class="usage-table">
      <span class="th">provider</span>
      <span class="th">window</span>
      <span class="th">remaining</span>
      <span class="th end">resets</span>
      <!-- One continuous rule. Per-cell borders were broken up by the column
           gaps, which read as four stray underlines rather than a table head. -->
      <div class="head-rule" />

      <template v-for="(row, i) in agents.usage" :key="row.provider">
        <div v-if="i > 0" class="divider" />

        <!-- The identity cell leads every provider group ONCE, whatever the
             provider's window count — 1, 2, 3, or (an errored row) none. -->
        <span class="cell provider-cell">
          <span class="provider">{{ row.provider }}</span>
          <!-- Badge only when the state is NOT ok: a row of "ok" chips is
               noise, and the meter already says so when it is fine. -->
          <span v-if="row.status !== 'ok'" :class="['status', row.status]">
            {{ row.status }}
          </span>
        </span>

        <template v-for="(w, j) in windowsOf(row)" :key="j">
          <span class="cell window">{{ w.label }}</span>

          <span class="cell remaining">
            <template v-if="w.pct !== null">
              <span class="meter">
                <span
                  class="meter-fill"
                  :style="{ width: pctWidth(w.pct), background: pctColor(w.pct) }"
                />
              </span>
              <span class="pct" :style="{ color: pctColor(w.pct) }">{{ pctText(w.pct) }}</span>
            </template>
            <!-- The meter is unknown, not the window; see the header comment. -->
            <span v-else class="unreported">not reported</span>
          </span>

          <span class="cell resets">
            <span
              v-if="w.reset"
              class="reset"
              :class="{ lead: w.pct === null }"
              :title="fmtAbs(w.reset)"
            >
              {{ fmtRel(w.reset) }}
            </span>
          </span>
        </template>

        <!-- A provider whose every window came back empty (an errored row, a
             helper that reported nothing usable): one quiet line, so the
             provider still appears in the comparison instead of vanishing. -->
        <p v-if="!windowsOf(row).length" class="note unreported">
          {{ row.error || 'not reported' }}
        </p>

        <!-- The spendable full-reset count, when the provider reports one:
             the fact that answers "am I out, and can I do anything about
             it?" — a resource, so it reads as a plain count, not an alarm. -->
        <p v-if="resetsNote(row)" class="note">{{ resetsNote(row) }}</p>

        <p v-if="blockNote(row)" class="note">{{ blockNote(row) }}</p>
      </template>
    </div>

    <!-- While the INITIAL fetch is in flight there is nothing to compare yet,
         and the empty state below would flash its "is the helper there?"
         question at a host that has not had the chance to answer. A quiet
         holding line instead; once rows exist a refresh spins the header icon
         and the table stays put. -->
    <p v-else-if="agents.loading" class="muted empty">loading usage…</p>

    <!-- Only when the host ANSWERED and the answer was empty. A failed fetch is
         the error line above, not this — accusing the helper of being missing
         when we never managed to ask would be the wrong sentence. -->
    <p v-else-if="!agents.usageError" class="muted empty">
      no usage data — is <code>pocketshell usage</code> available on this host?
    </p>
  </div>
</template>

<style scoped>
.usage {
  padding: var(--sp-4) var(--sp-5);
  overflow-y: auto;
  width: 100%;
}
.usage-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
h2 {
  margin: 0;
  font-size: var(--fs-500);
  line-height: var(--lh-500);
  font-weight: var(--fw-semibold);
}

/* ---------------------------------------------------------------------------
 * The shared grid. Every track is fixed except the meter, so meters, numbers
 * and timestamps line up across EVERY provider — which is the whole point of
 * choosing a table over cards. Widths are 4px multiples, per the spacing rule.
 * ------------------------------------------------------------------------- */
.usage-table {
  display: grid;
  grid-template-columns: 128px 72px minmax(160px, 1fr) 128px;
  column-gap: var(--sp-4);
  align-items: center;
  width: 100%;
}
/* Column captions, matching the port table's th treatment. */
.th {
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  padding-bottom: var(--sp-2);
}
/* Captions sit over their column's own edge: left for the two text columns and
   the meter (which starts left), right for the times (which end right). */
.th.end {
  text-align: right;
}
.head-rule {
  grid-column: 1 / -1;
  height: 1px;
  background: var(--border);
  margin-bottom: var(--sp-2);
}
.cell {
  display: flex;
  align-items: center;
  min-height: var(--row-h);
  min-width: 0;
}
/* One hairline per provider group. A full-width grid child, so it cannot fall
   out of step with the cells the way a per-cell border would. */
.divider {
  grid-column: 1 / -1;
  height: 1px;
  background: var(--border-soft);
  margin: var(--sp-2) 0;
}

/* ---- column 1: identity, the top of the hierarchy ---------------------- */
.provider-cell {
  gap: var(--sp-2);
}
.provider {
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
  text-transform: capitalize;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* One badge metric across the app. */
.status {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  border: 1px solid transparent;
}
.status.limited {
  color: var(--warning);
  background: var(--warning-soft);
}
.status.blocked,
.status.error {
  color: var(--error);
  background: var(--error-soft);
}

/* ---- columns 2-4: pinned, not auto-placed ------------------------------ */
/* A provider's window count varies (go has three, codex one, an errored row
   none); pinning each cell to its column lets the grid assemble any count —
   the identity cell always leads, and auto-placement cannot pull a meter up
   into the column a missing window left free. */
.window {
  grid-column: 2;
  font-size: var(--fs-200);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
}

/* ---- column 3: the meters, this screen's primary content --------------- */
.remaining {
  grid-column: 3;
  gap: var(--sp-3);
}
/* 8px on a --bg well: the bars ARE the content here, and the old 6px bar on a
   --surface-3 track was barely distinguishable from the card behind it. */
.meter {
  flex: 1;
  min-width: 0;
  height: 8px;
  background: var(--bg);
  border-radius: var(--r-sm);
  overflow: hidden;
}
.meter-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-sm);
  transition: width var(--dur-normal) var(--ease);
}
/* Fixed width + tabular figures: the percentages form one clean right edge. */
.pct {
  flex: none;
  width: 40px;
  text-align: right;
  font-size: var(--fs-200);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
/* The METER is unknown, not the row — so this is quiet, not alarming, and the
   resets cell beside it carries the weight instead. */
.unreported {
  font-size: var(--fs-100);
  font-style: italic;
  color: var(--fg-muted);
}

/* ---- column 4: reset times -------------------------------------------- */
.resets {
  grid-column: 4;
  justify-content: flex-end;
}
/* Secondary by default: it must not compete with the meter next to it. */
.reset {
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* ...but PRIMARY when there is no meter, because then it is the only thing
   this row actually knows, and it is the useful half anyway. */
.reset.lead {
  font-size: var(--fs-200);
  font-weight: var(--fw-medium);
  color: var(--fg);
}

/* ---- the footnote ------------------------------------------------------ */
.note {
  grid-column: 2 / -1;
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.empty {
  padding: var(--sp-4) 0;
}
/* The fetch-failure line. Colour and size come from the global `.error`; the
   margin keeps it clear of the stale table it can sit above. */
.fetch-error {
  margin: 0 0 var(--sp-3);
}
/* Same inline-code treatment as HostPickerView's empty state — the app's
   convention for command names, instead of literal backtick glyphs. */
code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
