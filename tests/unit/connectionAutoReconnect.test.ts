import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry } from '../../src/shared/types';

/**
 * The automatic reconnect FSM in the connection store.
 *
 * The drop path is the store's `ssh.onState` subscription, so the tests grab
 * the listener off the mocked bridge and fire it — the same way the real main
 * process would. Everything after that is timers: the schedule (5s → 10s →
 * 20s → …, MAX_ATTEMPTS tries) is advanced with fake timers, and each dial is
 * driven by what `ssh.connect` resolves with.
 */

const onState =
  vi.fn<(handler: (payload: { connectionId: string; state: string }) => void) => void>();
const sshConnect =
  vi.fn<(opts: unknown) => Promise<{ ok: boolean; connectionId?: string; error?: string }>>();
const sshClose = vi.fn<(id: string) => Promise<void>>();
const sshExec = vi.fn<(id: string, cmd: string) => Promise<{ exitCode: number }>>();
const sessionsList = vi.fn<(id: string, sort: string) => Promise<never[]>>();
const fwdIsAutoEnabled = vi.fn<(id: string) => Promise<boolean>>();
const fwdStartAuto = vi.fn<(id: string, forwards: unknown[]) => Promise<void>>();
const fwdList = vi.fn<(id: string) => Promise<never[]>>();
const fwdDiscovered = vi.fn<(id: string) => Promise<never[]>>();
const fwdStatus = vi.fn<(id: string) => Promise<null>>();
const fwdScan = vi.fn<(id: string) => Promise<never[]>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    ssh: {
      onState: (h: unknown) => onState(h as never),
      listConfigHosts: vi.fn().mockResolvedValue([]),
      connect: (opts: unknown) => sshConnect(opts),
      close: (id: string) => sshClose(id),
      exec: (id: string, cmd: string) => sshExec(id, cmd),
    },
    helper: {
      sessionsList: (id: string, sort: string) => sessionsList(id, sort),
      bootstrap: vi.fn().mockResolvedValue(null),
    },
    forwards: {
      isAutoEnabled: (id: string) => fwdIsAutoEnabled(id),
      startAuto: (id: string, f: unknown[]) => fwdStartAuto(id, f),
      list: (id: string) => fwdList(id),
      discovered: (id: string) => fwdDiscovered(id),
      status: (id: string) => fwdStatus(id),
      scan: (id: string) => fwdScan(id),
    },
    // The files store (pulled in by `disconnect`) subscribes to this at setup.
    preview: { onStats: vi.fn() },
  },
}));

const { useConnectionStore } = await import('../../src/renderer/stores/connection');

const HOST: HostEntry = {
  name: 'hetzner',
  hostname: '135.181.114.209',
  port: 22,
  user: 'alexey',
  identityFile: null,
  proxyJump: null,
  forwardAgent: false,
  localForwards: [],
  remoteForwards: [],
  fromConfig: true,
};

const HOST_WITH_LOCAL_FORWARD: HostEntry = {
  ...HOST,
  localForwards: [
    {
      kind: 'local',
      listenHost: '127.0.0.1',
      listenPort: 9000,
      destHost: '127.0.0.1',
      destPort: 9000,
    },
  ],
};

/** The CURRENT store's onState listener — each test's pinia registers a new one. */
function stateHandler(): (payload: { connectionId: string; state: string }) => void {
  return onState.mock.calls.at(-1)![0];
}

/** Drop the link the way main reports it. */
function drop(connectionId: string): void {
  stateHandler()({ connectionId, state: 'lost' });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  sshConnect.mockResolvedValue({ ok: true, connectionId: 'conn-1' });
  sshClose.mockResolvedValue(undefined);
  sshExec.mockResolvedValue({ exitCode: 0 });
  sessionsList.mockResolvedValue([]);
  fwdIsAutoEnabled.mockResolvedValue(false);
  fwdList.mockResolvedValue([]);
  fwdDiscovered.mockResolvedValue([]);
  fwdStatus.mockResolvedValue(null);
  fwdScan.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connection store — the automatic reconnect FSM', () => {
  it('restores persisted auto-forwarding before exposing the initial connection', async () => {
    fwdIsAutoEnabled.mockResolvedValue(true);
    const connection = useConnectionStore();
    fwdStartAuto.mockImplementationOnce(async () => {
      expect(connection.connectionId).toBeNull();
    });

    await connection.connect(HOST_WITH_LOCAL_FORWARD, undefined);

    expect(fwdIsAutoEnabled).toHaveBeenCalledWith('conn-1');
    expect(fwdStartAuto).toHaveBeenCalledWith('conn-1', HOST_WITH_LOCAL_FORWARD.localForwards);
    expect(connection.connectionId).toBe('conn-1');
  });

  it('schedules the first retry 5s out when the link drops', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();

    drop('conn-1');
    expect(connection.state).toBe('lost');
    expect(connection.recovering).toBe(true);
    expect(connection.autoRetry).toEqual({ attempt: 1, retryAt: Date.now() + 5_000 });
    expect(connection.retryIn).toBe(5);

    await vi.advanceTimersByTimeAsync(5_000);
    // The dial went out on schedule.
    expect(sshConnect).toHaveBeenCalledTimes(1);
  });

  it('keeps the old connection id while the replacement dial is in flight', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);

    let resolveConnect!: (result: { ok: boolean; connectionId?: string }) => void;
    sshConnect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );
    const reconnect = connection.reconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.state).toBe('connecting');
    expect(connection.connectionId).toBe('conn-1');
    // Closing the old transport reports `idle`; it must not overwrite the
    // replacement attempt while the mounted workspace is still using its id.
    stateHandler()({ connectionId: 'conn-1', state: 'idle' });
    expect(connection.state).toBe('connecting');

    resolveConnect({ ok: true, connectionId: 'conn-2' });
    await reconnect;
    expect(connection.connectionId).toBe('conn-2');
    expect(connection.state).toBe('connected');
  });

  it('a successful retry revives the connection and the surfaces keyed by the NEW id', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();
    fwdIsAutoEnabled.mockResolvedValue(true);

    drop('conn-1');
    sshConnect.mockResolvedValue({ ok: true, connectionId: 'conn-2' });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(connection.state).toBe('connected');
    expect(connection.connectionId).toBe('conn-2');
    // The dead id was closed best-effort before re-dialling.
    expect(sshClose).toHaveBeenCalledWith('conn-1');
    // Surfaces re-read against the NEW id: sessions…
    expect(sessionsList).toHaveBeenCalledWith('conn-2', expect.anything());
    // …and the host's remembered auto-forward restarted on it.
    expect(fwdIsAutoEnabled).toHaveBeenCalledWith('conn-2');
    expect(fwdStartAuto).toHaveBeenCalledWith('conn-2', HOST.localForwards);
    // The schedule is spent: the banner's countdown is gone, recovering is over.
    expect(connection.autoRetry).toBeNull();
    expect(connection.recovering).toBe(false);
  });

  it('a failed retry re-arms the curve and lands the state back on lost', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();

    drop('conn-1');
    sshConnect.mockResolvedValue({ ok: false, error: 'auth failed' });
    await vi.advanceTimersByTimeAsync(5_000);

    // connect() lands a failure on 'idle' — the FSM refuses that: the link is
    // still gone and the banner still needs to stand.
    expect(connection.state).toBe('lost');
    expect(connection.recovering).toBe(true);
    expect(connection.error).toBe('auth failed');
    // Second step of the curve: 10s.
    expect(connection.autoRetry?.attempt).toBe(2);
    expect(connection.autoRetry?.retryAt).toBe(Date.now() + 10_000);
  });

  it('doubles the delay up to the 60s cap and gives up after MAX_ATTEMPTS', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();
    sshConnect.mockResolvedValue({ ok: false, error: 'still down' });

    drop('conn-1');
    // Walk the schedule to exhaustion, recording the gap before each attempt.
    const gaps: number[] = [];
    let prevRetryAt = Date.now();
    while (connection.autoRetry) {
      const cur = connection.autoRetry;
      gaps.push(cur.retryAt - prevRetryAt);
      prevRetryAt = cur.retryAt;
      await vi.advanceTimersByTimeAsync(cur.retryAt - Date.now());
    }

    expect(gaps).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(sshConnect).toHaveBeenCalledTimes(10);
    // Given up, honestly: state 'lost' with a sentence that says so, and no
    // more dials no matter how long the user waits.
    expect(connection.state).toBe('lost');
    expect(connection.error).toContain('Could not reconnect');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sshConnect).toHaveBeenCalledTimes(10);
  });

  it('disconnect() cancels the schedule — a dropped timer must not re-dial', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();

    drop('conn-1');
    await connection.disconnect();
    expect(connection.recovering).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sshConnect).not.toHaveBeenCalled();
  });

  it('retryNow() skips the wait and dials immediately', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();
    sshConnect.mockResolvedValue({ ok: true, connectionId: 'conn-2' });

    drop('conn-1');
    await connection.retryNow();

    expect(sshConnect).toHaveBeenCalledTimes(1);
    expect(connection.state).toBe('connected');
    // And nothing fires on the original schedule afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sshConnect).toHaveBeenCalledTimes(1);
  });

  it('the wake probe treats a failed `true` as the drop it almost always is', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();

    let resolveProbe: (r: { exitCode: number }) => void = () => {};
    sshExec.mockReturnValue(
      new Promise((r) => {
        resolveProbe = r;
      }),
    );

    const run = connection.onOsResume();
    resolveProbe({ exitCode: -1 }); // exec failed — transport is gone
    await run;

    // The immediate dial succeeded (default mock), and it went out BEFORE the
    // first scheduled step — no 5s wait after a wake.
    expect(connection.state).toBe('connected');
    expect(connection.autoRetry).toBeNull();
    expect(sshConnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sshConnect).toHaveBeenCalledTimes(1);
  });

  it('a healthy wake probe changes nothing', async () => {
    const connection = useConnectionStore();
    await connection.connect(HOST, undefined);
    sshConnect.mockClear();

    await connection.onOsResume();

    expect(connection.state).toBe('connected');
    expect(sshConnect).not.toHaveBeenCalled();
  });
});

describe('connection store connect — a rejected invoke', () => {
  it('reports failure and returns to idle instead of sticking at "connecting"', async () => {
    // The IPC layer does not promise never to reject: a transport error can
    // surface as a rejected invoke rather than an `{ ok: false }` result. The
    // store used to let that escape, leaving `state` at 'connecting' forever —
    // the picker's rows disabled, no error anywhere.
    const connection = useConnectionStore();
    sshConnect.mockRejectedValueOnce(new Error('channel open failed'));

    const ok = await connection.connect(HOST);

    expect(ok).toBe(false);
    expect(connection.state).toBe('idle');
    expect(connection.error).toBe('channel open failed');
  });
});
