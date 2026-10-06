/**
 * The host a launch may name on its command line.
 *
 * The desktop answers a SECOND launch of the exe with a new workspace window
 * rather than a focus of the old one, and that launch can say what the window
 * is for: `PocketShell.exe win35` (or `--host win35`, or `--host=win35`)
 * opens a window that dials `win35` straight away. The same parse reads the
 * FIRST launch's `process.argv`, so a shortcut can cold-start on a host.
 *
 * The value crosses to the renderer as a query parameter and is only ever
 * MATCHED against the host list (`~/.ssh/config` aliases) — it never reaches
 * a shell or a path, so the parser's job is to be conservative about what
 * counts as a name, not to defend a boundary: anything that is not a plain
 * host-alias token (a file path from an "open with", a stray flag value)
 * reads as "no host named", which is the ordinary no-argument launch.
 */

/** A host alias as the picker would list it: one simple token, no separators. */
const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when [value] is a shape this module would accept as a host name. */
export function isValidLaunchHostName(value: string): boolean {
  return HOST_NAME_RE.test(value);
}

export interface LaunchHostOptions {
  /**
   * True for the unpackaged spellings — a dev `electron <app-path>` run, and
   * the e2e harness that passes the built main path the same way. There the
   * FIRST positional is the app's entry path, not a launch argument, so it
   * is skipped (flags before it are skipped too, Electron CLI order);
   * everything after it is the app's own argv. A packaged exe has no
   * app-path positional — `PocketShell.exe win35` names the host directly —
   * so the flag is false there and the positionals are parsed as arguments.
   */
  firstPositionalIsAppPath?: boolean;
}

/**
 * The host the launch named, or null for "none — an ordinary launch".
 *
 * `--host VALUE` and `--host=VALUE` are honoured wherever they appear; a
 * bare positional is honoured only if it is the first real one and passes
 * the name check — the first positional is where an OS "open with" drops a
 * document path, and a host name after that is not a thing any launch says.
 * An ill-formed `--host` value also reads as none: the window opens on the
 * picker, where the (missing) name is explained, rather than half-launching.
 */
export function parseLaunchHost(
  argv: readonly string[],
  options: LaunchHostOptions = {},
): string | null {
  let i = 1;
  if (options.firstPositionalIsAppPath) {
    // Electron CLI order: flags, then the app path, then the app's argv.
    while (i < argv.length && argv[i]!.startsWith('-')) i++;
    if (i < argv.length) i++;
  }
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '.') continue;
    if (arg === '--host') {
      const value = argv[i + 1];
      return value !== undefined && isValidLaunchHostName(value) ? value : null;
    }
    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length);
      return isValidLaunchHostName(value) ? value : null;
    }
    if (arg.startsWith('-')) continue;
    return isValidLaunchHostName(arg) ? arg : null;
  }
  return null;
}
