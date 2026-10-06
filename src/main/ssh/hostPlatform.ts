import { detectHostPlatform, type HostPlatform } from '@pocketshell/core';
import type { SshService } from './SshService.js';

/**
 * The OS family of each connected host, probed once and remembered.
 *
 * Everything that must not run on a Windows box — the helper/tmux probes,
 * the session-listing fallbacks, the `/proc` port attributions — asks here
 * instead of exec'ing into the wall. The answer is per CONNECTION, not per
 * host: a re-dial re-probes, because the far end may be a different machine
 * (the label/IP resolved elsewhere, a container rebuilt on another OS), and
 * the cost of being wrong is running POSIX paths on a host that has none.
 *
 * The probe is `uname -s` (one exec), with a `cmd /c ver` fallback for the
 * Windows hosts whose DefaultShell is not bash — the shared
 * `detectHostPlatform` owns the sequence and its parsers. The promise is
 * cached single-flight so the burst of callers around a fresh connect
 * (bootstrap, the first session poll, the auto-forward scan) shares one
 * probe instead of racing three.
 */
export class HostPlatformTracker {
  private readonly cache = new Map<string, Promise<HostPlatform>>();

  platformOf(ssh: SshService, connectionId: string): Promise<HostPlatform> {
    const cached = this.cache.get(connectionId);
    if (cached) return cached;
    const probe = detectHostPlatform((command) => ssh.exec(connectionId, command));
    this.cache.set(connectionId, probe);
    return probe;
  }

  /** Called when the connection goes away; a re-dial must re-probe. */
  forget(connectionId: string): void {
    this.cache.delete(connectionId);
  }
}
