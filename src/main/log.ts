import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A file log for the main process.
 *
 * The app is normally launched from a desktop shortcut, so nothing is attached
 * to stdout and `console.log` goes nowhere anyone can read. That matters most
 * for the paths DESIGNED to fail quietly: `TmuxClientPool` turns every switch
 * failure into an ordinary re-join, which is correct behaviour and completely
 * invisible — "it still isn't fast" is the only symptom, with no error anywhere
 * to say which branch ran.
 *
 * So the interesting decisions write a line here instead. Plain text,
 * append-only, one line per event, safe to read while the app is running.
 *
 * The path is derived from `os.homedir()` rather than Electron's
 * `app.getPath('userData')` on purpose. This module is imported by code that
 * unit tests exercise (`TmuxClientPool`), and those run outside Electron
 * entirely — a static `import { app } from 'electron'` would fail to resolve,
 * and the lazy `require` that avoids it is banned by this repo's lint rules.
 * A fixed, predictable location is also easier to ask a user to paste from.
 *
 * Deliberately synchronous. These are low-frequency decision points, and a
 * synchronous append cannot lose the last line to a crash or a quit — which is
 * exactly when the log is worth having.
 */

/** `~/.pocketshell/desktop.log` — fixed, predictable, easy to ask for. */
function logPath(): string {
  return join(homedir(), '.pocketshell', 'desktop.log');
}

/** True once a write has failed, so the console warning is not repeated. */
let warnedOnce = false;

/**
 * Append one line: `2026-08-25T10:41:02.123Z [scope] message {json}`.
 *
 * Never throws. A logger that can break the feature it observes is worse than
 * no logger, so a full disk or a read-only home is swallowed after one warning.
 */
export function log(scope: string, message: string, data?: Record<string, unknown>): void {
  // Unit tests exercise the code paths that log, and they were writing into
  // the same file a user is asked to paste when something goes wrong — so a
  // real diagnosis had to be read around rows of `alpha`/`beta` fixture noise.
  // A diagnostic file is only worth having if everything in it happened to the
  // user.
  if (process.env['VITEST'] != null) return;
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatLogLine(scope, message, data), 'utf8');
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[pocketshell] file logging unavailable:', err);
    }
  }
}

/** One log record as it lands in the file — trailing newline included. */
export function formatLogLine(scope: string, message: string, data?: Record<string, unknown>): string {
  const stamp = new Date().toISOString();
  const detail = data == null ? '' : ` ${safeJson(data)}`;
  return `${stamp} [${scope}] ${message}${detail}\n`;
}

/**
 * `JSON.stringify` that cannot throw the caller's line away — a circular
 * reference in diagnostic data must not cost us the entry being written to
 * explain a bug.
 */
function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '{"_":"unserialisable"}';
  }
}
