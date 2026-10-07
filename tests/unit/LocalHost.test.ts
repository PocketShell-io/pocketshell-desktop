import { describe, expect, it } from 'vitest';
import { SshService } from '../../src/main/ssh/SshService';
import { execLocal, localBash, localHostPlatform } from '../../src/main/local/LocalHost';

/**
 * The local ("self") transport, against THIS machine's real bash — the exec
 * surface is one spawn, so a real child answers everything the fake could
 * only assert about plumbing, and the plumbing is the behaviour.
 *
 * Skipped where no bash exists (the exec tests), never for the service-level
 * tests: a local dial itself cannot fail — no transport, no keys.
 */

describe('execLocal', () => {
  it.skipIf(!localBash())('runs a POSIX command and carries stdout and the exit code', async () => {
    const res = await execLocal('echo self-ok');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('self-ok');
    expect(res.stderr).toBe('');
  });

  it.skipIf(!localBash())('treats a non-zero exit as a result, not a rejection', async () => {
    const res = await execLocal('echo boom >&2; exit 3');
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('boom');
  });

  it.skipIf(!localBash())('writes opts.stdin and closes it', async () => {
    const res = await execLocal('cat', { stdin: 'secret-value' });
    expect(res.stdout).toBe('secret-value');
  });

  it.skipIf(!localBash())('kills a wedged command at the timeout and settles', async () => {
    const res = await execLocal('sleep 10', { timeoutMs: 300 });
    expect(res.exitCode).toBe(-1);
    expect(res.stderr).toContain('timed out');
  }, 10_000);

  it.skipIf(!localBash())('resolves the wrapped PATH command form the shared builders emit', async () => {
    // `pathAwareCommand` wraps in `/bin/sh -lc '...'` — the exact shape
    // aplexer's probe and snapshot ride. It must survive a local spawn.
    const res = await execLocal("/bin/sh -lc 'echo wrapped-ok'");
    expect(res.stdout.trim()).toBe('wrapped-ok');
  });
});

describe('SshService — a local dial', () => {
  it('connects without a transport and answers isLocal', async () => {
    const ssh = new SshService();
    const result = await ssh.connect({ host: 'self', user: 'me', local: true });
    expect(result.ok).toBe(true);
    expect(ssh.isLocal(result.ok ? result.connectionId : '')).toBe(true);
    ssh.close(result.ok ? result.connectionId : '');
  });

  it('answers hostPlatform from the process, no probe exec', async () => {
    const ssh = new SshService();
    const { connectionId } = await ssh.connect({ host: 'self', user: 'me', local: true });
    expect(await ssh.hostPlatform(connectionId)).toBe(localHostPlatform());
    expect(localHostPlatform()).toBe(process.platform === 'win32' ? 'windows' : 'posix');
    ssh.close(connectionId);
  });

  it('execs through the local bash', async () => {
    const ssh = new SshService();
    const { connectionId } = await ssh.connect({ host: 'self', user: 'me', local: true });
    const res = await ssh.exec(connectionId, 'echo routed-locally');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('routed-locally');
    ssh.close(connectionId);
  });

  it('close forgets the record', async () => {
    const ssh = new SshService();
    const { connectionId } = await ssh.connect({ host: 'self', user: 'me', local: true });
    ssh.close(connectionId);
    expect(ssh.isLocal(connectionId)).toBe(false);
    await expect(ssh.exec(connectionId, 'true')).rejects.toThrow(/Unknown connection/);
  });

  it('openTrackedShell refuses a local record until the PTY work lands', async () => {
    const ssh = new SshService();
    const { connectionId } = await ssh.connect({ host: 'self', user: 'me', local: true });
    await expect(
      ssh.openTrackedShell(connectionId, { onData: () => undefined }),
    ).rejects.toThrow(/not available on a local connection/);
    ssh.close(connectionId);
  });
});
