import { shellQuote, shellQuoteRemotePath } from '../../shared/shellQuote.js';
import { LOOPBACK_HOST } from '../../shared/net.js';
import { splitSections } from './PortScanner.js';
import { LISTENER_SCAN_COMMAND, mergeScanSections } from './scanRemotePorts.js';

/**
 * "Serve this folder": the pure half.
 *
 * Command construction, port selection, URL building and failure
 * classification for the remote static file server. Everything in here is a
 * string in / string out so it can be tested without a host — see
 * `tests/unit/serveCommand.test.ts`. The stateful half (channels, forwards,
 * lifetime) is {@link ../portfwd/ServeService.ts}.
 *
 * ---------------------------------------------------------------------------
 * WHICH SERVER, AND WHY IT IS THE STDLIB ONE
 * ---------------------------------------------------------------------------
 *
 * The feature was requested as "use the server in ~/git/ai-buildcamp" —
 * `~/git/ai-engineering-buildcamp/mdtohtml/http_server.py`, a 79-line ASGI app
 * run under `uv run --with 'uvicorn[standard]' uvicorn http_server:app`. We
 * deliberately do NOT use it, and we do not add a `pocketshell serve`
 * subcommand either. Reasons, in the order that decided it:
 *
 *  1. **It is not on the host.** That file lives in ONE repo on ONE machine.
 *     A Files-tab action has to work in any folder on any host the app can
 *     reach, so a server that ships with the interpreter beats a server that
 *     ships with a checkout. `python3 -m http.server` has been in the stdlib
 *     with `--bind` since 3.4 and `--directory` since 3.7; the probe below
 *     checks for it rather than assuming it.
 *
 *  2. **It needs `uv` and a network round trip.** `uv run --with
 *     'uvicorn[standard]'` resolves and downloads uvicorn on first use. That
 *     is a multi-second, network-dependent, failure-prone step in front of an
 *     action whose whole value is being instant.
 *
 *  3. **It is not actually better at the job.** For static files the stdlib
 *     handler is a superset: it serves directory INDEXES (the buildcamp app
 *     404s a directory with no `index.html`), falls back to `index.html` when
 *     one exists (same), guesses content types from the same `mimetypes`
 *     table (same), and streams the file with `shutil.copyfileobj` instead of
 *     `Path.read_bytes()`-ing the whole thing into memory (better — the Files
 *     tab is pointed at build outputs, which contain video and source maps).
 *
 *  4. **Its traversal guard is the weak spelling of the idiom.**
 *     `str(file_path).startswith(str(root))` also accepts `/rootabc` for a
 *     root of `/root`. `SimpleHTTPRequestHandler.translate_path` normalises
 *     the URL path, drops `..` segments and `os.path.join`s the survivors onto
 *     the root, so there is no prefix comparison to get wrong. Since the thing
 *     being served is on the user's live box, the containment check is not a
 *     detail we want to own a copy of.
 *
 * A `pocketshell serve` subcommand — the shape the user actually asked for —
 * is the right long-term home and is written up in `docs/SERVE.md` as a
 * follow-up. It is not the thing to build first because the helper is a
 * SEPARATELY released Python project: hosts run 0.4.44 and this project
 * takes "hard cuts only, no shims", so the day this shipped against a
 * subcommand it would work on exactly zero hosts until every one of them
 * upgraded. The stdlib path ships today and costs nothing to retire later:
 * only {@link serveCommand} would change.
 */

/** Sentinel names for the sections {@link serveProbeCommand} emits. */
const SECTION_PY = 'PS_SERVE_PY';
const SECTION_VER = 'PS_SERVE_VER';
const SECTION_DIR = 'PS_SERVE_DIR';

/**
 * THE bind address. Not a setting, not a parameter, not a default.
 *
 * `python3 -m http.server` binds **all interfaces** when `--bind` is omitted
 * ("default: all interfaces" in its own `--help`). The hosts this app talks to
 * are internet-facing dev boxes; the folders it is pointed at are whatever the
 * user right-clicked, which on a dev box means source trees, `.env` siblings,
 * build outputs and `~/git` in general. Omitting `--bind`, or letting it be
 * configurable, means one mis-click publishes a directory listing of the
 * user's home directory to the internet, with no auth, for as long as the app
 * is open — and, because nothing in the UI would look different, with no
 * indication that it had happened.
 *
 * 127.0.0.1 makes that impossible at the socket. The only route in is the SSH
 * connection the app already holds, which is authenticated, and the tunnel it
 * opens listens on 127.0.0.1 locally as well (`AutoForwarder.startPass`), so
 * the served bytes never touch a network interface at either end.
 *
 * If a future "share this on my LAN" feature is ever wanted, it must be a
 * separate, explicitly-named, explicitly-confirmed action — never a widening
 * of this constant.
 */
export const SERVE_BIND_ADDRESS = LOOPBACK_HOST;

/**
 * Remote ports the server may land on, inclusive.
 *
 * Chosen to sit **inside** `DEFAULT_AUTO_CONFIG`'s auto-forward window
 * (>= `skipPortsBelow` 1024, <= `maxAutoPort` 10000) so the port is one the
 * existing engine is already willing to forward and show, and away from the
 * numbers dev servers squat on (3000, 5173, 8000 — which is `http.server`'s
 * own default — and 8080). A hundred slots is far more than the "how many
 * folders is one person serving at once" number, and the range being small
 * and fixed is what makes a served port recognisable in the Ports panel.
 */
export const SERVE_PORT_RANGE: readonly [number, number] = [8081, 8180];

/** What {@link parseServeProbe} could learn about the host. */
export interface ServeProbe {
  /** Absolute path to a python3, or null when the host has none. */
  python: string | null;
  /** Raw `python -V` output, e.g. `Python 3.12.3`. Null when python is null. */
  versionLine: string | null;
  /** Verdict on the directory the user right-clicked. */
  dir: 'ok' | 'missing' | 'not-a-directory' | 'unreadable' | 'unknown';
  /** Every TCP port already listening on the host, from the shared scan. */
  taken: number[];
}

/**
 * One exec that answers everything `start()` needs to know before it commits.
 *
 * Three questions plus the listener scan, sentinel-delimited, in a single
 * channel open — the same trick and the same reason as
 * {@link LISTENER_SCAN_COMMAND}, whose text is appended verbatim rather than
 * re-derived so the two can never drift and `mergeScanSections` can parse this
 * output unmodified.
 *
 * Asking all three up front is what turns the three interesting failures
 * ("no python on the host", "that folder is not readable", "that folder is
 * gone") into a sentence in the UI instead of a server that silently is not
 * running.
 */
export function serveProbeCommand(dir: string): string {
  const d = shellQuoteRemotePath(dir);
  return [
    // `python3` first, `python` only as a fallback: on a modern host a bare
    // `python` is either absent or python3 anyway, and on an old one it is
    // python2, which has no `http.server` module — the version check below is
    // what catches that rather than this lookup.
    'py=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true);',
    `echo "<<<${SECTION_PY}>>>"; [ -n "$py" ] && printf '%s\\n' "$py";`,
    `echo "<<<${SECTION_VER}>>>"; [ -n "$py" ] && "$py" -V 2>&1;`,
    `echo "<<<${SECTION_DIR}>>>";`,
    `if [ ! -e ${d} ]; then echo missing;`,
    `elif [ ! -d ${d} ]; then echo not-a-directory;`,
    // Both bits matter: `r` to list it, `x` to descend into it. A directory
    // with one and not the other produces a server that starts fine and then
    // 403s everything, which is the least legible outcome available.
    `elif [ ! -r ${d} ] || [ ! -x ${d} ]; then echo unreadable;`,
    'else echo ok; fi;',
    LISTENER_SCAN_COMMAND,
  ].join(' ');
}

/** Read the sections {@link serveProbeCommand} emitted. Never throws. */
export function parseServeProbe(stdout: string): ServeProbe {
  const sections = splitSections(stdout);
  const python = firstLine(sections[SECTION_PY]);
  const versionLine = firstLine(sections[SECTION_VER]);
  const dirRaw = firstLine(sections[SECTION_DIR]);
  const dir =
    dirRaw === 'ok' || dirRaw === 'missing' || dirRaw === 'not-a-directory' || dirRaw === 'unreadable'
      ? dirRaw
      : 'unknown';
  return {
    python,
    versionLine,
    dir,
    taken: mergeScanSections(stdout).map((p) => p.port),
  };
}

/**
 * `Python 3.12.3` -> `[3, 12]`. Null for anything unparseable, which the
 * callers treat as "assume the oldest thing we support".
 */
export function parsePythonVersion(versionLine: string | null): [number, number] | null {
  if (!versionLine) return null;
  const m = /Python\s+(\d+)\.(\d+)/i.exec(versionLine);
  if (!m) return null;
  return [Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10)];
}

/**
 * Is this python usable at all?
 *
 * `--directory` landed in 3.7 and without it we would have to `cd` into the
 * folder first, which is a second failure mode for no gain. Python 2 has no
 * `http.server` module whatsoever. Both are reported as one refusal.
 */
export function pythonIsUsable(versionLine: string | null): boolean {
  const v = parsePythonVersion(versionLine);
  if (!v) return false;
  const [major, minor] = v;
  return major > 3 || (major === 3 && minor >= 7);
}

/**
 * `--protocol HTTP/1.1` is only accepted from 3.11 onward.
 *
 * Worth the version check rather than hardcoding either answer. The default is
 * HTTP/1.0, which closes the TCP connection after every response; a real site
 * pulls dozens of assets and issues `fetch` calls, and each one paying a fresh
 * SSH channel open through the tunnel is the difference between "the page
 * loads" and "the page loads eventually". On an older python the flag is an
 * argparse error (exit 2, "unrecognized arguments"), i.e. a server that does
 * not start — so it is asked for only when it will be understood.
 */
export function supportsProtocolFlag(versionLine: string | null): boolean {
  const v = parsePythonVersion(versionLine);
  if (!v) return false;
  const [major, minor] = v;
  return major > 3 || (major === 3 && minor >= 11);
}

/**
 * The first port in {@link SERVE_PORT_RANGE} nothing is listening on.
 *
 * `taken` is the host's listener list from the probe, plus any port this
 * process has already handed to another served folder in the same session —
 * two right-clicks in quick succession can both read a scan taken before
 * either server existed.
 *
 * Null when the whole range is occupied, which the caller reports rather than
 * papering over: a hundred busy ports in a range nothing else uses means
 * something is wrong that picking a hundred-and-first will not fix.
 *
 * There is an unavoidable TOCTOU between this and the server's own bind. That
 * is handled by retrying the NEXT candidate when the bind actually loses (see
 * {@link classifyServeOutput}), not by pretending the race is closed.
 */
export function choosePort(
  taken: Iterable<number>,
  range: readonly [number, number] = SERVE_PORT_RANGE,
): number | null {
  const busy = new Set(taken);
  const [lo, hi] = range;
  for (let port = lo; port <= hi; port++) {
    if (!busy.has(port)) return port;
  }
  return null;
}

export interface ServeCommandOptions {
  /** Absolute path to the interpreter, from {@link ServeProbe.python}. */
  python: string;
  /** Absolute remote directory to serve. */
  dir: string;
  /** Port on the host. Bound to {@link SERVE_BIND_ADDRESS} only. */
  port: number;
  /** {@link ServeProbe.versionLine}; decides the `--protocol` flag. */
  versionLine: string | null;
}

/**
 * The line typed into the remote PTY.
 *
 * Three deliberate pieces beyond the obvious:
 *
 *  - `stty -echo` so the command does not come back at us as output, which
 *    would otherwise be the first thing {@link classifyServeOutput} sees.
 *  - `exec` so the login shell is REPLACED by python rather than sitting
 *    around as its parent. The server is then the session leader on the pty,
 *    which is what makes closing the channel a hangup that actually kills it —
 *    the whole cleanup story (see ServeService) rests on this word.
 *  - `-u` so the "Serving HTTP on" line and any traceback reach us
 *    immediately instead of sitting in a stdio buffer while the UI waits.
 *
 * Every interpolated value is either a number we chose or shell-quoted.
 */
export function serveCommand(opts: ServeCommandOptions): string {
  const args = [
    shellQuote(opts.python),
    '-u',
    '-m',
    'http.server',
    String(opts.port),
    '--bind',
    SERVE_BIND_ADDRESS,
    '--directory',
    shellQuoteRemotePath(opts.dir),
  ];
  if (supportsProtocolFlag(opts.versionLine)) args.push('--protocol', 'HTTP/1.1');
  return `stty -echo 2>/dev/null; exec ${args.join(' ')}`;
}

/** The line `http.server` prints once the socket is listening. */
const SERVE_READY_MARKER = 'Serving HTTP on';

/** What the server's output means so far. Null = nothing conclusive yet. */
export type ServeOutcome =
  | { kind: 'ready' }
  | { kind: 'port-taken' }
  | { kind: 'permission-denied' }
  | { kind: 'missing-dir' }
  | { kind: 'no-python' }
  | { kind: 'failed'; message: string };

/**
 * Classify whatever the remote PTY has said so far.
 *
 * Read on every chunk against the ACCUMULATED buffer, not the chunk, because a
 * traceback arrives in pieces. `port-taken` is the one outcome the caller
 * recovers from by itself — everything else is shown to the user, because a
 * retry loop that cannot name what it is retrying is how this app has ended up
 * with servers that silently are not running.
 */
export function classifyServeOutput(buffer: string): ServeOutcome | null {
  if (buffer.includes(SERVE_READY_MARKER)) return { kind: 'ready' };
  // CPython spells it "[Errno 98] Address already in use" on Linux and
  // "[Errno 48]" on macOS; match the words, not the number.
  if (/address already in use/i.test(buffer)) return { kind: 'port-taken' };
  if (/permission denied/i.test(buffer)) return { kind: 'permission-denied' };
  if (/no such file or directory/i.test(buffer)) return { kind: 'missing-dir' };
  if (/(command not found|no module named)/i.test(buffer)) return { kind: 'no-python' };
  // A python traceback that is none of the above: report its LAST line, which
  // is the exception, rather than the frame dump above it.
  if (/^Traceback \(most recent call last\)/m.test(buffer)) {
    const lines = buffer.trim().split(/\r?\n/);
    return { kind: 'failed', message: lines[lines.length - 1]!.trim() || 'server failed to start' };
  }
  // argparse rejects a flag this python does not know (see
  // `supportsProtocolFlag`) with a usage block and exit 2.
  if (/unrecognized arguments/i.test(buffer)) {
    return { kind: 'failed', message: 'this python rejected the server arguments' };
  }
  return null;
}

/** A human sentence for an outcome, given the folder it was about. */
export function serveErrorMessage(outcome: ServeOutcome, dir: string): string {
  switch (outcome.kind) {
    case 'ready':
      return '';
    case 'port-taken':
      return `No free port in ${SERVE_PORT_RANGE[0]}-${SERVE_PORT_RANGE[1]} on the host.`;
    case 'permission-denied':
      return `Cannot read ${dir} on the host.`;
    case 'missing-dir':
      return `${dir} is not there any more.`;
    case 'no-python':
      return 'No usable python3 on the host — the folder server needs it.';
    case 'failed':
      return outcome.message;
  }
}

/**
 * The URL the user is sent to.
 *
 * Always loopback and always the LOCAL port: the remote port is an
 * implementation detail of the tunnel and typing it into a browser would
 * reach nothing. The trailing slash matters — without it a directory index
 * makes the browser resolve relative links against the parent.
 */
export function serveUrl(localPort: number): string {
  return `http://${LOOPBACK_HOST}:${localPort}/`;
}

/** The Ports-panel label for a served folder, e.g. `Serving dist/`. */
export function serveLabel(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1]! : '/';
  return `Serving ${base}/`;
}

function firstLine(section: string | undefined): string | null {
  if (!section) return null;
  for (const line of section.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}
