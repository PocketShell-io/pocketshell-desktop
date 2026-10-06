/**
 * Host bootstrap probe — the sequence run on connect to detect the
 * `pocketshell` helper, `tmux`, and the uv/pipx installer, plus daemon status.
 *
 * The probe itself lives in core (`runHostBootstrap`) so the desktop, the web
 * transport and the Android adapter run one identical sequence. This wrapper
 * adapts it to {@link SshService} and hands it the host's platform — probed
 * once per connection and cached there — so a Windows host skips the
 * helper/tmux probes it can never answer instead of burning five round trips
 * reporting the absence of binaries that cannot exist.
 */

import type { SshService } from '../ssh/SshService.js';
import type { BootstrapResult } from '@pocketshell/core';
import { runHostBootstrap } from '@pocketshell/core';
import { pathAwareCommand } from '@pocketshell/core';

// The PATH wrapper itself is shared code now (`shared/aplexerCommands.ts`) —
// the same lines the browser builds before every probe and join. Re-exported
// so the helper's existing importers keep one import path.
export { pathAwareCommand };

/**
 * Run the full bootstrap probe against a connected host.
 *
 * Never throws for a missing tool — those are reported as `installed: false`.
 * A dead or unknown connection still rejects (the exec underneath does), and
 * the caller treats a rejected bootstrap as "not ready yet", not as an error.
 */
export async function runBootstrap(
  ssh: SshService,
  connectionId: string,
): Promise<BootstrapResult> {
  return runHostBootstrap((command) => ssh.exec(connectionId, command), {
    platform: await ssh.hostPlatform(connectionId),
  });
}
