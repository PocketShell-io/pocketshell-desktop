import { describe, expect, it } from 'vitest';
import { parseUsageNdjson } from '@main/helper/usageParsers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Output captured verbatim from the helper the user actually runs (0.4.44),
 * and host-captured rather than Docker-captured: the fixture image has no
 * provider credentials, so every `usage --json` row comes back
 * `status: "error"` there. The image and the host run the same pinned 0.4.44,
 * so the two agree on wire format; helper-parsers.test.ts keeps the full
 * fixture note.
 */
const V44 = resolve(__dirname, 'fixtures');
const readV44 = (name: string): string => readFileSync(resolve(V44, name), 'utf8');

describe('parseUsageNdjson', () => {
  it('skips malformed lines', () => {
    const out = parseUsageNdjson('{"provider":"a"}\nnot json\n{"provider":"b"}\n');
    expect(out.map((u) => u.provider)).toEqual(['a', 'b']);
  });

  /** One row's window labels + percents, the shape every usage test reads. */
  const shape = (rows: ReturnType<typeof parseUsageNdjson>) =>
    rows.map((r) => ({
      provider: r.provider,
      windows: r.windows.map((w) => [w.window, w.percent_remaining, w.reset_at] as const),
    }));

  it('parses the real 0.4.44 pair shape into the windows each provider has', () => {
    const out = parseUsageNdjson(readV44('v0.4.44-usage.ndjson'));
    expect(out.map((u) => u.provider)).toEqual(['claude', 'codex', 'copilot', 'grok', 'zai']);

    // claude really has both a 5h and a 7d window; the pair maps onto the
    // list one-to-one, shortest first.
    expect(shape(out)[0]).toEqual({
      provider: 'claude',
      windows: [
        ['5h', 92.0, '2026-08-24T11:59:59Z'],
        ['7d', 91.0, '2026-08-27T14:59:59Z'],
      ],
    });

    // codex has NO 5h window: its null short_term slot is the helper saying
    // "no such window", so it is dropped — not carried as a "not reported"
    // placeholder row for a meter that does not exist.
    expect(shape(out)[1]).toEqual({
      provider: 'codex',
      windows: [['7d', 90.0, '2026-08-31T00:45:22Z']],
    });

    // copilot has ONLY a monthly window. The 100%-no-reset short_term beside
    // it is a synthesized filler (the real number is premium_percent_remaining
    // = 100 in details), and its null window label is nowhere to point a
    // meter — dropped, leaving the one window the plan actually has.
    expect(shape(out)[2]).toEqual({
      provider: 'copilot',
      windows: [['monthly', 100.0, '2026-09-01T00:00:00Z']],
    });

    // grok: a lone weekly. `status` stays `ok` even at 0% — the percentage is
    // the signal, not the status string.
    expect(out[3]!.status).toBe('ok');
    expect(shape(out)[3]).toEqual({
      provider: 'grok',
      windows: [['weekly', 0.0, '2026-08-25T00:08:17Z']],
    });

    // zai's 5h window has a percent but NO reset: both fields are guarded
    // independently, and a real window is never dropped for one null field.
    expect(shape(out)[4]).toEqual({
      provider: 'zai',
      windows: [
        ['5h', 100.0, null],
        ['weekly', 0.0, '2026-08-24T14:04:58Z'],
      ],
    });
  });

  it('reads the installed helper\'s keyed windows map the same way', () => {
    // Captured verbatim from the host the user actually runs (still
    // self-reported as 0.4.44): the rows carry a keyed `windows` map and NO
    // top-level pair. Consumed raw, `row.short_term` is undefined — the render
    // throw that blanked the usage panel.
    const out = parseUsageNdjson(readV44('v0.4.44-usage-windows.ndjson'));

    // The map key becomes the window label, one entry per real window.
    expect(shape(out)[0]).toEqual({
      provider: 'claude',
      windows: [
        ['5h', 93, '2026-08-27T20:20:00Z'],
        ['7d', 98, '2026-09-03T15:00:00Z'],
      ],
    });
    expect(shape(out)[1]).toEqual({
      provider: 'codex',
      windows: [['7d', 92.0, '2026-09-03T16:26:47Z']],
    });
    // copilot's map carries a literal `short_term` key beside `monthly` — the
    // synthesized filler again (real number: premium_percent_remaining 90.3).
    // It is unnamed data, dropped so copilot shows its one monthly window.
    expect(shape(out)[2]).toEqual({
      provider: 'copilot',
      windows: [['monthly', 90.3, '2026-09-01T00:00:00Z']],
    });
    expect(shape(out)[3]).toEqual({
      provider: 'grok',
      windows: [['weekly', 30.0, '2026-09-01T00:08:17Z']],
    });
    expect(shape(out)[4]).toEqual({
      provider: 'zai',
      windows: [
        ['5h', 84.0, null],
        ['weekly', 85.0, '2026-09-03T14:04:58Z'],
      ],
    });

    // Reset credits ride in `details` under a per-provider key — codex
    // `reset_credits_available`, grok `resets_available` — normalized into
    // one count; providers without the concept are null, not 0.
    expect(out.map((r) => r.resets_available)).toEqual([null, 1, null, 1, null]);
  });

  it('reads the resets count from either detail key, or says nothing', () => {
    const line = (keys: string) =>
      `{"provider":"x","status":"ok","error":null,"details":{${keys}},"windows":{"weekly":{"percent_remaining":1.0,"reset_at":null}}}`;
    const rows = (keys: string) => parseUsageNdjson(line(keys))[0]!;

    expect(rows('"reset_credits_available":2').resets_available).toBe(2);
    expect(rows('"resets_available":1').resets_available).toBe(1);
    // Spent is a fact worth showing; only ABSENCE is null.
    expect(rows('"reset_credits_available":0').resets_available).toBe(0);
    // A provider with no resets concept, or a count that is not a number.
    expect(rows('').resets_available).toBeNull();
    expect(rows('"resets_available":"1"').resets_available).toBeNull();
  });

  it('keeps all three windows of a provider like go, shortest first', () => {
    // The row that broke the old short_term/long_term fold: a provider with
    // THREE windows (go: 5h + weekly + monthly) had its third silently
    // dropped once both slots filled. Shape per the user's host report —
    // synthetic line, map deliberately listed longest-first.
    const line =
      '{"provider":"go","status":"ok","error":null,"details":{},"windows":{' +
      '"monthly":{"percent_remaining":41.0,"reset_at":"2026-09-30T00:00:00Z"},' +
      '"weekly":{"percent_remaining":75.0,"reset_at":"2026-09-06T15:00:00Z"},' +
      '"5h":{"percent_remaining":97.0,"reset_at":"2026-09-04T16:20:00Z"}}}';
    expect(shape(parseUsageNdjson(line))).toEqual([
      {
        provider: 'go',
        windows: [
          ['5h', 97.0, '2026-09-04T16:20:00Z'],
          ['weekly', 75.0, '2026-09-06T15:00:00Z'],
          ['monthly', 41.0, '2026-09-30T00:00:00Z'],
        ],
      },
    ]);
  });

  it('keeps a window with a reset but no meter, and drops rows with no window at all', () => {
    // A real window can report only its reset — "not reported" beside a real
    // reset time is a fact; both-null is not a window.
    const line =
      '{"provider":"go","status":"ok","error":null,"details":{},"windows":{' +
      '"5h":{"percent_remaining":null,"reset_at":"2026-09-04T16:20:00Z"},' +
      '"weekly":{"percent_remaining":null,"reset_at":null},' +
      '"monthly":{"percent_remaining":41.0,"reset_at":null}}}';
    expect(shape(parseUsageNdjson(line))).toEqual([
      {
        provider: 'go',
        windows: [
          ['5h', null, '2026-09-04T16:20:00Z'],
          ['monthly', 41.0, null],
        ],
      },
    ]);

    // Every window null → an empty list. The view renders such a provider as
    // one quiet line; it must not fabricate slots.
    const empty =
      '{"provider":"x","status":"error","error":"quse expired","details":{},' +
      '"windows":{"5h":{"percent_remaining":null,"reset_at":null}}}';
    expect(parseUsageNdjson(empty)[0]!.windows).toEqual([]);
  });

  it('prefers the top-level pair when a row carries both shapes', () => {
    const row = {
      provider: 'claude',
      status: 'ok',
      short_term: { percent_remaining: 1, reset_at: null, window: '5h' },
      long_term: { percent_remaining: 2, reset_at: null, window: '7d' },
      error: null,
      details: {},
      windows: { monthly: { percent_remaining: 99 } },
    };
    const out = parseUsageNdjson(JSON.stringify(row));
    expect(out[0]!.windows.map((w) => w.window)).toEqual(['5h', '7d']);
    expect(out[0]!.windows.map((w) => w.percent_remaining)).toEqual([1, 2]);
  });

  it('names unnamed windows with the generic slot wording, never the raw key', () => {
    // A row where every surviving window is unnamed (old helper, null window
    // labels): the slot's own wording stands in, so "short_term" never
    // reaches the screen.
    const row = {
      provider: 'mystery',
      status: 'ok',
      short_term: { percent_remaining: 50, reset_at: null, window: null },
      long_term: { percent_remaining: 60, reset_at: '2026-09-10T00:00:00Z', window: null },
      error: null,
      details: {},
    };
    expect(parseUsageNdjson(JSON.stringify(row))[0]!.windows.map((w) => w.window)).toEqual([
      'short-term',
      'long-term',
    ]);
  });
});
