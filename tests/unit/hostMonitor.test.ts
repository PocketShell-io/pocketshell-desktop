import { describe, expect, it } from 'vitest';
import {
  MONITOR_SNAPSHOT_COMMAND,
  cpuPercent,
  cpuPercentages,
  formatKib,
  formatKibPair,
  formatProcessTime,
  formatUptime,
  killCommand,
  parseMonitorSample,
  parseProcessTime,
  sortProcesses,
  type ProcessRow,
} from '@ui/app/hostMonitor';

/**
 * The monitor's data contract, held to fixed transcripts. The command is a
 * literal (no interpolation — nothing remote shapes what we run), the
 * parsers survive a non-Linux host (ps answered, /proc sections empty),
 * and a CPU bar is never drawn from a sample that had no previous to diff
 * against — null means unset, not 0%.
 */

/** The ps rows of a transcript, re-parsed for the assertions. */
const PS_BODY = [
  '    PID  PPID USER     STAT  %CPU  %MEM    VSZ    RSS     TIME COMMAND',
  '      1     0 root      Ss    0.0  0.1   1024    512     3:45 /sbin/init',
  '   1234     1 alexey    Sl   12.5  2.3  42124 1053600 1-02:03:04 node server.js --port 3000',
  '    99     1 root      Z     0.0  0.0      0      0     0:01 [kworker/0:1] <defunct>',
  '',
].join('\n');

const STAT_BODY = [
  'cpu  74608 2520 24433 1117073 6176 4054 0 0 0 0',
  'cpu0 38000 1200 12000 558000 3000 2000 0 0 0 0',
  'cpu1 36608 1320 12433 559073 3176 2054 0 0 0 0',
  'intr 1130557',
  '',
].join('\n');

const MEM_BODY = [
  'MemTotal:       16384256 kB',
  'MemFree:         8123456 kB',
  'MemAvailable:    9420232 kB',
  'Buffers:          524288 kB',
  'Cached:          2097152 kB',
  'SwapTotal:       2097152 kB',
  'SwapFree:        1048576 kB',
  'Dirty:               128 kB',
  '',
].join('\n');

const FULL_TRANSCRIPT = [
  '==ps==',
  PS_BODY,
  '==stat==',
  STAT_BODY,
  '==mem==',
  MEM_BODY,
  '==load==',
  '0.52 0.48 0.41 3/1234 56789',
  '==up==',
  '987654.32 1234567.89',
  '',
].join('\n');

describe('MONITOR_SNAPSHOT_COMMAND', () => {
  it('is a literal: nothing is interpolated into it', () => {
    expect(MONITOR_SNAPSHOT_COMMAND).not.toMatch(/\$\{|\$\(/);
  });

  it('pins the ps locale and carries every section marker, ps first', () => {
    expect(MONITOR_SNAPSHOT_COMMAND).toContain(
      'LC_ALL=C ps -eo pid,ppid,user,stat,pcpu,pmem,vsz,rss,time,args',
    );
    const markers = [...MONITOR_SNAPSHOT_COMMAND.matchAll(/==([a-z]+)==/g)].map((m) => m[1]);
    expect(markers).toEqual(['ps', 'stat', 'mem', 'load', 'up']);
    expect(MONITOR_SNAPSHOT_COMMAND.indexOf('==ps==')).toBeLessThan(
      MONITOR_SNAPSHOT_COMMAND.indexOf('/proc/stat'),
    );
  });

  it('silences per-section failures so a missing /proc is empty, not noisy', () => {
    for (const cat of MONITOR_SNAPSHOT_COMMAND.matchAll(/cat [^;]+/g)) {
      expect(cat[0]).toMatch(/2>\/dev\/null$/);
    }
  });
});

describe('parseMonitorSample', () => {
  const sample = parseMonitorSample(FULL_TRANSCRIPT);

  it('parses every ps data row and skips the header', () => {
    expect(sample.processes).toHaveLength(3);
    const node = sample.processes.find((row) => row.pid === 1234)!;
    expect(node.ppid).toBe(1);
    expect(node.user).toBe('alexey');
    // STAT arrives multi-letter; the row keeps the FIRST letter — the state.
    expect(node.state).toBe('S');
    expect(node.cpu).toBe(12.5);
    expect(node.mem).toBe(2.3);
    expect(node.vszKib).toBe(42124);
    expect(node.rssKib).toBe(1053600);
    // 1-02:03:04 — a day-carrying TIME, parsed to seconds.
    expect(node.timeS).toBe((24 + 2) * 3600 + 3 * 60 + 4);
    // The command is the WHOLE argv, spaces and flags intact.
    expect(node.command).toBe('node server.js --port 3000');
  });

  it('reads a zombie as Z with zeroed memory figures', () => {
    const zombie = sample.processes.find((row) => row.state === 'Z')!;
    expect(zombie.vszKib).toBe(0);
    expect(zombie.rssKib).toBe(0);
  });

  it('parses the aggregate first, then the cores in kernel order', () => {
    expect(sample.cpus).toHaveLength(3);
    // idle = idle + iowait; total = the first eight tick fields.
    expect(sample.cpus[0]).toEqual({ idle: 1117073 + 6176, total: 74608 + 2520 + 24433 + 1117073 + 6176 + 4054 });
    expect(sample.cpus[1]).toEqual({ idle: 558000 + 3000, total: 38000 + 1200 + 12000 + 558000 + 3000 + 2000 });
    expect(sample.cpus[2]).toEqual({ idle: 559073 + 3176, total: 36608 + 1320 + 12433 + 559073 + 3176 + 2054 });
  });

  it('reads memory, load and uptime out of their sections', () => {
    expect(sample.memory).toEqual({
      totalKib: 16384256,
      availableKib: 9420232,
      swapTotalKib: 2097152,
      swapFreeKib: 1048576,
    });
    // loadavg's `3/1234` is running over SCHEDULER ENTITIES — threads, not
    // processes; the process count is the ps table's length.
    expect(sample.load).toEqual({ one: 0.52, five: 0.48, fifteen: 0.41, running: 3, threads: 1234 });
    expect(sample.uptimeS).toBe(987654.32);
  });

  it('keeps the process table on a host where /proc answered nothing', () => {
    const macish = `==ps==\n${PS_BODY}==stat==\n==mem==\n==load==\n==up==\n`;
    const headless = parseMonitorSample(macish);
    expect(headless.processes).toHaveLength(3);
    expect(headless.cpus).toEqual([]);
    expect(headless.memory).toBeNull();
    expect(headless.load).toBeNull();
    expect(headless.uptimeS).toBeNull();
  });

  it('answers an entirely empty stdout with an empty sample, never a throw', () => {
    const empty = parseMonitorSample('', 12345);
    expect(empty).toEqual({
      at: 12345,
      processes: [],
      cpus: [],
      memory: null,
      load: null,
      uptimeS: null,
    });
  });

  it('falls back to free+buffers+cached when the kernel has no MemAvailable', () => {
    const old = FULL_TRANSCRIPT.replace('MemAvailable:    9420232 kB\n', '');
    const { memory } = parseMonitorSample(old);
    // 16384256 - 8123456 - 524288 - 2097152
    expect(memory?.availableKib).toBe(5639360);
  });

  it('never lets the fallback availability go negative', () => {
    const hogged = FULL_TRANSCRIPT
      .replace('MemAvailable:    9420232 kB\n', '')
      .replace('Cached:          2097152 kB', 'Cached:          19999999 kB');
    expect(parseMonitorSample(hogged).memory?.availableKib).toBe(0);
  });

  it('refuses a nonsense uptime instead of reporting it', () => {
    expect(parseMonitorSample(FULL_TRANSCRIPT.replace('987654.32', '0.00')).uptimeS).toBeNull();
    expect(parseMonitorSample(FULL_TRANSCRIPT.replace('987654.32', 'ugly')).uptimeS).toBeNull();
  });
});

describe('cpuPercent', () => {
  it('is the non-idle share of the ticks that elapsed', () => {
    expect(cpuPercent({ idle: 0, total: 0 }, { idle: 250, total: 1000 })).toBe(75);
    expect(cpuPercent({ idle: 0, total: 0 }, { idle: 1000, total: 1000 })).toBe(0);
    expect(cpuPercent({ idle: 0, total: 0 }, { idle: 0, total: 1000 })).toBe(100);
  });

  it('answers null when the counter did not move — unset, not 0%', () => {
    expect(cpuPercent({ idle: 10, total: 100 }, { idle: 10, total: 100 })).toBeNull();
    // A wrapped or reset counter moves BACKWARDS; that is not a load figure.
    expect(cpuPercent({ idle: 10, total: 200 }, { idle: 10, total: 100 })).toBeNull();
  });
});

describe('cpuPercentages', () => {
  const second = (p: number): number => p * 1000;

  it('pads the first sample with nulls — no previous, no percentages', () => {
    const now = [{ idle: 0, total: second(1) }, { idle: 0, total: second(2) }];
    expect(cpuPercentages(null, now)).toEqual([null, null]);
  });

  it('diffes matching cores and null-pads a core that appeared', () => {
    const prev = [{ idle: 0, total: second(1) }];
    const now = [
      { idle: second(0.25), total: second(2) },
      { idle: 0, total: second(5) },
    ];
    expect(cpuPercentages(prev, now)).toEqual([75, null]);
  });
});

describe('killCommand', () => {
  it('builds the two whitelisted signals from a positive integer pid', () => {
    expect(killCommand(1234, 'TERM')).toBe('kill -TERM 1234');
    expect(killCommand(1234, 'KILL')).toBe('kill -KILL 1234');
  });

  it('refuses anything that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(killCommand(bad, 'TERM')).toBeNull();
    }
  });
});

describe('sortProcesses', () => {
  const row = (over: Partial<ProcessRow>): ProcessRow => ({
    pid: 1,
    ppid: 0,
    user: 'u',
    state: 'S',
    cpu: 0,
    mem: 0,
    vszKib: 0,
    rssKib: 0,
    timeS: 0,
    command: 'c',
    ...over,
  });
  const rows = [
    row({ pid: 2, cpu: 5, mem: 1, user: 'zed', command: 'b', timeS: 9, rssKib: 10 }),
    row({ pid: 1, cpu: 9, mem: 3, user: 'amy', command: 'a', timeS: 4, rssKib: 30 }),
    row({ pid: 3, cpu: 9, mem: 2, user: 'amy', command: 'c', timeS: 4, rssKib: 20 }),
  ];

  it('orders numerically descending for the meter columns', () => {
    expect(sortProcesses(rows, 'cpu', true).map((r) => r.pid)).toEqual([1, 3, 2]);
    expect(sortProcesses(rows, 'mem', true).map((r) => r.pid)).toEqual([1, 3, 2]);
    expect(sortProcesses(rows, 'rssKib', true).map((r) => r.pid)).toEqual([1, 3, 2]);
    expect(sortProcesses(rows, 'timeS', false).map((r) => r.pid)).toEqual([1, 3, 2]);
  });

  it('orders strings ascending when the flip asks for it, ties by pid', () => {
    expect(sortProcesses(rows, 'user', false).map((r) => r.pid)).toEqual([1, 3, 2]);
    expect(sortProcesses(rows, 'command', true).map((r) => r.pid)).toEqual([3, 2, 1]);
  });

  it('breaks remaining ties by pid so the order is total', () => {
    expect(sortProcesses(rows, 'cpu', true).map((r) => r.pid)).toEqual([1, 3, 2]);
  });

  it('sorts a copy — the previous order survives a flip', () => {
    const before = rows.map((r) => r.pid);
    sortProcesses(rows, 'cpu', true);
    expect(rows.map((r) => r.pid)).toEqual(before);
  });
});

describe('parseProcessTime', () => {
  it('reads all three procps spellings', () => {
    expect(parseProcessTime('3:45')).toBe(225);
    expect(parseProcessTime('02:03:04')).toBe(2 * 3600 + 3 * 60 + 4);
    expect(parseProcessTime('1-02:03:04')).toBe(26 * 3600 + 3 * 60 + 4);
  });

  it('answers 0 for anything else — a TIME column is never load-bearing', () => {
    expect(parseProcessTime('')).toBe(0);
    expect(parseProcessTime('soon')).toBe(0);
  });
});

describe('the formatters', () => {
  it('uptime takes the two biggest units and no zeros', () => {
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(8 * 60 + 40)).toBe('8m 40s');
    expect(formatUptime(2 * 3600 + 15 * 60)).toBe('2h 15m');
    expect(formatUptime(5 * 86400 + 3 * 3600)).toBe('5d 3h');
  });

  it('process time round-trips procps spellings', () => {
    expect(formatProcessTime(225)).toBe('03:45');
    expect(formatProcessTime(2 * 3600 + 204)).toBe('02:03:24');
    expect(formatProcessTime(26 * 3600 + 204)).toBe('1-02:03:24');
  });

  it('memory figures go through the one shared byte ladder', () => {
    expect(formatKib(1)).toBe('1.0 KB');
    expect(formatKib(16384256)).toBe('15.6 GB');
  });

  it('a used/total pair speaks ONE unit, the total\'s', () => {
    expect(formatKibPair(512000, 1024000)).toBe('500.0 / 1000.0 MB');
    expect(formatKibPair(33390000, 64225000)).toBe('31.8 / 61.2 GB');
    expect(formatKibPair(512, 1000)).toBe('512.0 / 1000.0 KB');
  });
});
