import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClientChannel } from 'ssh2';
import {
  execOnClient,
  EXEC_DEFAULT_TIMEOUT_MS,
} from '../../src/main/ssh/SshService';
import type { SshConnectionRecord } from '../../src/main/ssh/ConnectionRegistry';

/**
 * The exec round trip's failure modes.
 *
 * `execOnClient` used to settle on exactly two events: the exec callback and
 * channel `close`. Anything else was a hang — a channel wedged by a black-hole
 * transport never closes, so the promise never settled, and the single-flight
 * guards upstream (the auto-forward scan latch, the per-connection attach
 * queue) stayed shut for the life of the connection. A channel `error` after
 * the callback was worse: an uncaught `error` event is process-level in main.
 *
 * The fake stream is an EventEmitter with just the shape ssh2 channels expose
 * to this function — `stdin.end`, `stderr`, `close` — because the point is the
 * SETTLEMENT logic, not the transport.
 */

interface FakeStream extends EventEmitter {
  stdin: { end(data: string): void };
  stderr: EventEmitter;
  closed: boolean;
}

function fakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.stdin = { end: () => undefined };
  stream.stderr = new EventEmitter();
  stream.closed = false;
  (stream as unknown as { close(): void }).close = () => {
    stream.closed = true;
  };
  return stream;
}

/** A client whose exec hands the test the stream (or an error) to drive. */
function fakeClient() {
  const streams: FakeStream[] = [];
  const errors: Error[] = [];
  const client = {
    exec(_command: string, cb: (err: Error | undefined, stream: ClientChannel | null) => void) {
      if (errors.length) {
        cb(errors.shift(), null);
        return;
      }
      const stream = fakeStream();
      streams.push(stream);
      cb(undefined, stream as unknown as ClientChannel);
    },
  };
  return {
    client,
    lastStream: (): FakeStream => streams[streams.length - 1]!,
    failNext: (err: Error) => errors.push(err),
  };
}

function rec(client: unknown): SshConnectionRecord {
  return { kind: 'ssh', client } as unknown as SshConnectionRecord;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('execOnClient — settlement', () => {
  it('resolves from close with the accumulated output and exit code', async () => {
    const fake = fakeClient();
    const p = execOnClient(rec(fake.client), 'echo hi');
    const stream = fake.lastStream();
    stream.emit('data', Buffer.from('hi'));
    stream.stderr.emit('data', Buffer.from('a note'));
    stream.emit('close', 0);
    await expect(vi.waitFor(() => p, { timeout: 100 })).resolves.toEqual({
      stdout: 'hi',
      stderr: 'a note',
      exitCode: 0,
    });
  });

  it('a channel error mid-run settles instead of crashing the process', async () => {
    const fake = fakeClient();
    const p = execOnClient(rec(fake.client), 'big-job');
    const stream = fake.lastStream();
    stream.emit('data', Buffer.from('partial'));
    stream.emit('error', new Error('channel reset'));
    await expect(vi.waitFor(() => p, { timeout: 100 })).resolves.toEqual({
      stdout: 'partial',
      stderr: 'channel reset',
      exitCode: -1,
    });
  });

  it('a transport error at channel-open becomes a failed ExecResult, not a rejection', async () => {
    const fake = fakeClient();
    fake.failNext(new Error('channel open failed'));
    await expect(execOnClient(rec(fake.client), 'x')).resolves.toEqual({
      stdout: '',
      stderr: 'channel open failed',
      exitCode: -1,
    });
  });

  it('a wedged channel resolves the timeout result and frees the channel', async () => {
    const fake = fakeClient();
    const p = execOnClient(rec(fake.client), 'wedged', { timeoutMs: 5_000 });
    const stream = fake.lastStream();
    stream.emit('data', Buffer.from('some output first'));

    const result = await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      return p;
    });

    expect(result).toEqual({
      stdout: 'some output first',
      stderr: 'exec timed out after 5s',
      exitCode: -1,
    });
    // The stream is killed, so the channel slot is not held by a corpse.
    expect(stream.closed).toBe(true);
  });

  it('defaults to the five-minute cap', async () => {
    const fake = fakeClient();
    const p = execOnClient(rec(fake.client), 'wedged');
    void p;

    await vi.advanceTimersByTimeAsync(EXEC_DEFAULT_TIMEOUT_MS - 1);
    // Not settled yet would need a probe; just prove the cap fires.
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ exitCode: -1 });
  });

  it('timeoutMs 0 opts out entirely', async () => {
    const fake = fakeClient();
    const p = execOnClient(rec(fake.client), 'unbounded clone', { timeoutMs: 0 });

    await vi.advanceTimersByTimeAsync(EXEC_DEFAULT_TIMEOUT_MS * 2);
    fake.lastStream().emit('close', 0);
    await expect(p).resolves.toMatchObject({ exitCode: 0 });
  });

  it('close wins the race against a timer that is still armed', async () => {
    const fake = fakeClient();
    const p = execOnClient(rec(fake.client), 'fine', { timeoutMs: 60_000 });
    expect(vi.getTimerCount()).toBe(1);
    fake.lastStream().emit('close', 0);
    await expect(p).resolves.toMatchObject({ exitCode: 0 });
    // The armed timer was cleared on settle, not left to fire against a
    // promise that already answered.
    expect(vi.getTimerCount()).toBe(0);
  });
});
