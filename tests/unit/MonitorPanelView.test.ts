// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';

/**
 * The monitor panel's contract with its data, pinned at the component seam:
 * what a first sample shows (unset bars, not fabricated 0%), what a second
 * one adds (tick-delta percentages), what a ps-only host loses (the meters,
 * not the table), and what killing a process demands (two presses — arm,
 * then confirm — before the exec seam hears the word kill).
 */

type ExecPayload = { stdout: string; stderr: string; exitCode: number };

const exec = vi.fn<(connectionId: string, command: string) => Promise<ExecPayload>>();

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: {
      exec: (connectionId: string, command: string): unknown => exec(connectionId, command),
      onState: vi.fn(),
    },
  },
}));

const MonitorPanelView = (await import('@ui/app/views/MonitorPanelView.vue')).default;
const MonitorProcessTable = (await import('@ui/app/components/MonitorProcessTable.vue')).default;
const { useConnectionStore } = await import('@ui/app/stores/connection');

function psSection(rows: string[]): string {
  return ['==ps==', '  PID  PPID USER     %CPU  %MEM     TIME COMMAND', ...rows, ''].join('\n');
}

const TWO_PROC = psSection([
  '    424     1 alexey    4.0  1.0     1:00 node server.js',
  '    999     1 root      2.0  0.5     0:30 nginx: worker',
]);

/** One /proc/stat line: only user and idle carry ticks, so busy+idle IS total. */
function cpuLine(name: string, busy: number, idle: number): string {
  return `${name}  ${busy} 0 0 ${idle} 0 0 0 0 0 0`;
}

function statBody(agg: [number, number], cores: Array<[number, number]>): string {
  return [
    cpuLine('cpu ', agg[0], agg[1]),
    ...cores.map(([busy, idle], i) => cpuLine(`cpu${i}`, busy, idle)),
    '',
  ].join('\n');
}

const MEM_BODY = [
  'MemTotal:       1024000 kB',
  'MemAvailable:    512000 kB',
  'SwapTotal:       102400 kB',
  'SwapFree:         51200 kB',
  '',
].join('\n');

function fullSample(stat: string): string {
  return [
    psSection([]),
    `==stat==\n${stat}`,
    `==mem==\n${MEM_BODY}`,
    '==load==',
    '0.50 0.40 0.30 1/42 999',
    '==up==',
    '90000.00 1.00',
    '',
  ].join('\n');
}

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

/** Connect, mount, and wait out the first sample. Real timers. */
async function show(): Promise<VueWrapper> {
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  // The strip names the host while the first sample is in flight.
  connection.activeHost = { name: 'hetzner' } as never;
  const wrapper = mount(MonitorPanelView);
  await flush(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  exec.mockReset();
  // 50% busy aggregate, one core at 25% — and ONE core only, so the
  // second-sample assertions can watch a core appear unmatched.
  exec.mockResolvedValue({
    stdout: fullSample(statBody([500, 500], [[250, 750]])),
    stderr: '',
    exitCode: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MonitorPanelView — the states a panel moves through', () => {
  it('names the host while the first sample is in flight, then shows the read', async () => {
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    connection.activeHost = { name: 'hetzner' } as never;
    let resolveFirst!: (value: ExecPayload) => void;
    exec.mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const wrapper = mount(MonitorPanelView);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.sampling').text()).toContain('hetzner');

    resolveFirst({ stdout: fullSample(statBody([500, 500], [[250, 750]])), stderr: '', exitCode: 0 });
    await flush(wrapper);
    expect(wrapper.find('.sampling').exists()).toBe(false);
    expect(wrapper.find('.strip').text()).toContain('0.50 0.40 0.30');
    wrapper.unmount();
  });

  it('draws the first sample with UNSET cpu bars — a dash, never a fabricated 0%', async () => {
    const wrapper = await show();
    // aggregate + the one core, both without a previous sample to diff against
    const pcts = wrapper.findAll('.pct:not(.wide)').map((p) => p.text());
    expect(pcts).toEqual(['–', '–']);
    // ...while memory, which needs no delta, is already live: half of 1000 MB.
    expect(wrapper.text()).toContain('500.0 MB / 1000.0 MB');
    wrapper.unmount();
  });

  it('turns the cpu bars live on the second sample from the tick deltas', async () => {
    const wrapper = await show();
    exec.mockResolvedValue({
      stdout: fullSample(statBody([1250, 750], [
        [1000, 1000],
        [1500, 500],
      ])),
      stderr: '',
      exitCode: 0,
    });
    await new Promise((r) => setTimeout(r, 2100));
    await flush(wrapper);
    // Aggregate: 750 of the 1000 elapsed ticks busy → 75%. Core0 matched:
    // 750 busy of 1000 → 75%. Core1 has no previous to diff against → '–'.
    const pcts = wrapper.findAll('.pct:not(.wide)').map((p) => p.text());
    expect(pcts).toEqual(['75%', '75%', '–']);
    wrapper.unmount();
  });

  it('keeps the table but loses the meters on a host with no /proc', async () => {
    exec.mockResolvedValue({ stdout: TWO_PROC, stderr: '', exitCode: 0 });
    const wrapper = await show();
    expect(wrapper.find('.meters').exists()).toBe(false);
    expect(wrapper.findComponent(MonitorProcessTable).exists()).toBe(true);
    expect(wrapper.text()).toContain('2 processes');
    wrapper.unmount();
  });

  it('says so when the host answered nothing the monitor can draw', async () => {
    exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const wrapper = await show();
    expect(wrapper.find('.fetch-error').text()).toContain('answered nothing');
    wrapper.unmount();
  });

  it('keeps the stale read on screen under a transport failure', async () => {
    const wrapper = await show();
    expect(wrapper.find('.strip').exists()).toBe(true);
    exec.mockRejectedValue(new Error('channel closed'));
    await new Promise((r) => setTimeout(r, 2100));
    await flush(wrapper);
    expect(wrapper.find('.fetch-error').text()).toContain('channel closed');
    expect(wrapper.find('.strip').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('MonitorPanelView — the process table', () => {
  it('filters by pid, user and command substring', async () => {
    exec.mockResolvedValue({ stdout: TWO_PROC, stderr: '', exitCode: 0 });
    const wrapper = await show();
    const input = wrapper.find('.filter-input');
    await input.setValue('node');
    expect(wrapper.find('.count').text()).toContain('1 process');
    await input.setValue('root');
    expect(wrapper.find('.count').text()).toContain('1 process');
    await input.setValue('999');
    expect(wrapper.find('.count').text()).toContain('1 process');
    await input.setValue('nothing-matches');
    expect(wrapper.find('.empty').text()).toContain('No process matches');
    wrapper.unmount();
  });

  it('sorts by the clicked column, cpu descending on landing', async () => {
    exec.mockResolvedValue({ stdout: TWO_PROC, stderr: '', exitCode: 0 });
    const wrapper = await show();
    const table = wrapper.findComponent(MonitorProcessTable);
    // Landing order: ps pcpu descending — 4.0 before 2.0.
    expect(table.findAll('.prow .pid').map((c) => Number(c.text()))).toEqual([424, 999]);
    // The mem column: 1.0 vs 0.5 — same order descending.
    await table.findAll('.th.sort')[1]!.trigger('click');
    expect(table.findAll('.prow .pid').map((c) => Number(c.text()))).toEqual([424, 999]);
    // Flip it: mem ascending now.
    await table.findAll('.th.sort')[1]!.trigger('click');
    expect(table.findAll('.prow .pid').map((c) => Number(c.text()))).toEqual([999, 424]);
    wrapper.unmount();
  });
});

describe('MonitorPanelView — the two-step kill', () => {
  it('arms on the first press and only execs the kill on the second', async () => {
    exec.mockResolvedValue({ stdout: TWO_PROC, stderr: '', exitCode: 0 });
    const wrapper = await show();
    exec.mockClear();
    exec.mockResolvedValue({ stdout: TWO_PROC, stderr: '', exitCode: 0 });
    const table = wrapper.findComponent(MonitorProcessTable);
    const term = table.findAll('.kill')[0]!;
    await term.trigger('click');
    expect(term.text()).toBe('sure?');
    // Armed only: no kill has gone out over the wire yet.
    for (const [, command] of exec.mock.calls) expect(command).not.toMatch(/^kill /);

    await term.trigger('click');
    await flush(wrapper);
    const killCall = exec.mock.calls.map((c) => c[1]).find((cmd) => cmd.startsWith('kill '));
    expect(killCall).toBe('kill -TERM 424');
    wrapper.unmount();
  });

  it('sends SIGKILL from the second button and disarms on other touches', async () => {
    exec.mockResolvedValue({ stdout: TWO_PROC, stderr: '', exitCode: 0 });
    const wrapper = await show();
    const table = wrapper.findComponent(MonitorProcessTable);
    const buttons = table.findAll('.kill');
    expect(buttons.length).toBe(4);
    // Arm TERM, then touch the sort — the arm must drop.
    await buttons[0]!.trigger('click');
    await table.find('.th.sort').trigger('click');
    expect(buttons[0]!.text()).toBe('TERM');

    await buttons[1]!.trigger('click');
    await buttons[1]!.trigger('click');
    await flush(wrapper);
    const killCall = exec.mock.calls.map((c) => c[1]).find((cmd) => cmd.startsWith('kill '));
    expect(killCall).toBe('kill -KILL 424');
    wrapper.unmount();
  });
});

describe('MonitorPanelView — the poll loop', () => {
  it('pauses and resumes: no execs while paused, a fresh one on resume', async () => {
    vi.useFakeTimers();
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const wrapper = mount(MonitorPanelView);
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();
    const samplesAfterMount = exec.mock.calls.length;
    expect(samplesAfterMount).toBeGreaterThan(0);

    await wrapper.find('.tools .btn-ghost').trigger('click'); // Pause
    await vi.advanceTimersByTimeAsync(6000);
    expect(exec.mock.calls.length).toBe(samplesAfterMount);
    expect(wrapper.find('.paused').exists()).toBe(true);

    await wrapper.find('.tools .btn-ghost').trigger('click'); // Resume
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();
    expect(exec.mock.calls.length).toBe(samplesAfterMount + 1);
    expect(wrapper.find('.paused').exists()).toBe(false);

    // And the cadence resumes after it.
    await vi.advanceTimersByTimeAsync(2100);
    expect(exec.mock.calls.length).toBeGreaterThan(samplesAfterMount + 1);
    wrapper.unmount();
  });

  it('drops the poll entirely when the component unmounts', async () => {
    vi.useFakeTimers();
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const wrapper = mount(MonitorPanelView);
    await vi.advanceTimersByTimeAsync(0);
    const afterMount = exec.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(exec.mock.calls.length).toBe(afterMount);
  });

  it('re-samples from scratch when the connection is replaced', async () => {
    vi.useFakeTimers();
    const connection = useConnectionStore();
    connection.connectionId = 'conn-1';
    const wrapper = mount(MonitorPanelView);
    await vi.advanceTimersByTimeAsync(0);
    connection.connectionId = 'conn-2';
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();
    const ids = new Set(exec.mock.calls.map((c) => c[0]));
    expect(ids).toEqual(new Set(['conn-1', 'conn-2']));
    wrapper.unmount();
  });
});

describe('MonitorPanelView — the render cap', () => {
  it('caps the drawn rows and says how many it is not drawing', async () => {
    const many = psSection(
      Array.from({ length: 450 }, (_, i) => `  ${1000 + i}     1 u      0.0  0.0     0:00 sleeper ${i}`),
    );
    exec.mockResolvedValue({ stdout: many, stderr: '', exitCode: 0 });
    const wrapper = await show();
    const table = wrapper.findComponent(MonitorProcessTable);
    expect(table.findAll('.prow')).toHaveLength(300);
    expect(table.find('.count').text()).toContain('showing 300');
    expect(table.find('.note').text()).toContain('150 more');
    wrapper.unmount();
  });
});
