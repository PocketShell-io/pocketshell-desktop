import type { UsageRow, UsageWindow } from '@pocketshell/core';
export type { UsageRow } from '@pocketshell/core';
/**
 * Pure parsers for `pocketshell usage --json` — NDJSON rows.
 *
 * Each parser turns raw stdout into typed rows, pinned to fixture strings so
 * the output contract stays byte-identical to what the real helper emits.
 */

// ---------------------------------------------------------------------------
// `pocketshell usage --json` — NDJSON rows
// ---------------------------------------------------------------------------



/**
 * The wire, which is not one shape but three a host can speak: the 0.4.44
 * top-level pair, the keyed `windows` map the installed helper now emits
 * (`5h`, `7d`, `weekly`, `monthly`, `short_term` — keys, not a fixed pair),
 * and any mix of the two. Only `normalizeUsageRow` reads it.
 */
interface WireRow extends Omit<UsageRow, 'windows'> {
  short_term?: Partial<UsageWindow> | null;
  long_term?: Partial<UsageWindow> | null;
  windows?: Record<string, Partial<UsageWindow> | undefined>;
}

/** Which term a window label sits in, for the shortest-first display order. */
function termRank(label: string): number {
  if (label === '5h' || label === 'short_term' || label === 'short-term') return 0;
  if (label === '7d' || label === 'weekly' || label === 'long_term' || label === 'long-term') {
    return 1;
  }
  if (label === 'monthly') return 2;
  // A future label degrades to the end of the list, in emission order, not
  // to the wrong slot.
  return 3;
}

/**
 * The resets count, read from whichever detail key the provider's record
 * speaks (codex `reset_credits_available`, grok `resets_available`) and
 * taken only when it is a real number — a string or absent key means the
 * provider has nothing to say, which is null's job.
 */
function resetsAvailable(details: Record<string, unknown> | undefined): number | null {
  const n = details?.['reset_credits_available'] ?? details?.['resets_available'];
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Rebuild the row's window list from either wire shape. The helper still
 * self-reports 0.4.44 while quse's record underneath it moved from the
 * top-level pair to a keyed map, and a row consumed raw has neither a
 * `windows` array nor (on the map shape) a `short_term` at all — a consumer
 * that indexes it throws.
 */
function normalizeUsageRow(row: WireRow): UsageRow {
  const candidates: { label: string | null; generic: string; w: Partial<UsageWindow> }[] = [];
  // The pair, when the row carries it, wins over the map — that priority is
  // what kept pair-shaped rows byte-stable across the map's arrival.
  if (row.short_term && typeof row.short_term === 'object') {
    candidates.push({ label: row.short_term.window ?? null, generic: 'short-term', w: row.short_term });
  }
  if (row.long_term && typeof row.long_term === 'object') {
    candidates.push({ label: row.long_term.window ?? null, generic: 'long-term', w: row.long_term });
  }
  if (!candidates.length && row.windows && typeof row.windows === 'object') {
    for (const [key, w] of Object.entries(row.windows)) {
      if (!w || typeof w !== 'object') continue;
      // The key is the human label (`5h`, `7d`) — except when it is the
      // slot's own name, which must never reach the screen as "short_term".
      candidates.push({
        label: key === 'short_term' || key === 'long_term' ? null : key,
        generic: key === 'long_term' ? 'long-term' : 'short-term',
        w,
      });
    }
  }

  // A window with neither a meter nor a reset is the helper's way of saying
  // "the provider has no such window" — not a row to render.
  const withData = candidates.filter(
    ({ w }) => w.percent_remaining != null || w.reset_at != null,
  );
  // An UNNAMED window is data with nowhere to point (copilot's filler). Keep
  // one only when the row names nothing at all — then the generic slot
  // wording is the honest label.
  const anyNamed = withData.some(({ label }) => label !== null);
  const windows = withData
    .filter(({ label }) => label !== null || !anyNamed)
    .map(({ label, generic, w }) => ({
      percent_remaining: typeof w.percent_remaining === 'number' ? w.percent_remaining : null,
      reset_at: typeof w.reset_at === 'string' ? w.reset_at : null,
      window: label ?? generic,
    }))
    .sort((a, b) => termRank(a.window) - termRank(b.window));
  return { ...row, windows, resets_available: resetsAvailable(row.details) };
}

/** Parse `pocketshell usage --json` (one JSON object per line). */
export function parseUsageNdjson(stdout: string): UsageRow[] {
  const out: UsageRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      out.push(normalizeUsageRow(parsed as WireRow));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
