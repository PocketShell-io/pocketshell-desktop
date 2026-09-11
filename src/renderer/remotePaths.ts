/**
 * Turning a remote path someone did not browse to into one this connection's
 * SFTP channel can resolve.
 *
 * Pure string functions — no store, no IPC — because the resolution rule is
 * one fact applied uniformly: an SFTP session's relative root IS the login
 * home (that is why `realpath(".")` is how the home is found), so `~/x` and
 * plain relatives need no home lookup anywhere.
 *
 * Lives beside `fileKind.ts` in the renderer's logic layer; the files store
 * and the tree are its callers, not its home.
 */

/**
 * Turn a possibly-tilde-prefixed path into one an SFTP channel can resolve.
 *
 * A session's cwd comes from tmux and can be a literal, unexpanded `~/git`
 * (helper/parsers.ts says so explicitly, and canonicalisation there
 * deliberately never expands it). SFTP has no shell to do the expanding, so
 * `realpath("~/git")` looks for a DIRECTORY NAMED `~` and fails.
 *
 * No home lookup is needed to fix it: an SFTP session's relative root is the
 * login home — that is why `realpath(".")` is how the home is found in the
 * first place — so dropping the `~/` leaves a relative path that resolves to
 * exactly the same place, in the same single round trip.
 *
 * Only a leading `~` that refers to OUR home is handled. `~other/x` is left
 * alone: it means another user's home, which relative resolution would get
 * wrong, and failing honestly beats opening the wrong directory.
 */
export function stripTilde(path: string | undefined): string {
  if (path == null || path === '') return '.';
  if (path === '~') return '.';
  if (path.startsWith('~/')) {
    const rest = path.slice(2);
    return rest === '' ? '.' : rest;
  }
  return path;
}

/**
 * Turn a path someone did not browse to — printed by a program, or typed into
 * the path bar — into one this connection's SFTP channel can resolve.
 *
 * The output is either absolute or relative-to-the-login-home, which are the
 * two things `sftp.realPath` understands — an SFTP session's relative root IS
 * the login home, which is the same fact {@link stripTilde} is built on and
 * the reason no home lookup is needed anywhere in here.
 *
 * THREE anchorings, and the first two ignore [base] completely:
 *
 *   - absolute (`/tmp/olya-v3tts.mp3`) is already complete. It is returned
 *     untouched — never joined to anything, which is the bug this shape of
 *     function is famous for (`/home/alexey/git/foo//tmp/olya-v3tts.mp3`);
 *   - `~/x` is anchored on the login home, so it goes through `stripTilde`
 *     and lands relative to the SFTP root, which is that same home;
 *   - anything else is relative, and only then does [base] matter.
 *
 * What [base] is depends on who is asking, and it is the caller's job to know:
 * a path in a session's output is relative to where that SESSION runs
 * (`SessionSummary.path`), while a path typed into the Files tab is relative
 * to the directory being BROWSED. Either can itself be a literal, unexpanded
 * `~/git/foo` (helper/parsers.ts says so of session paths), which is why the
 * base goes through `stripTilde` rather than being used as it came.
 *
 * `..` and `.` inside the path are left for the remote `realpath` to fold:
 * doing it here would mean guessing about symlinks the host knows about and we
 * do not.
 */
export function resolveRemotePath(raw: string, base?: string | null): string {
  if (raw.startsWith('/')) return raw;
  if (raw === '~' || raw.startsWith('~/')) return stripTilde(raw);

  const rel = raw.startsWith('./') ? raw.slice(2) : raw;
  if (rel === '') return '.';
  const from = stripTilde(base ?? undefined);
  // No base at all leaves it at '.', where joining would produce a leading
  // './'. Relative-to-home is the best guess available and is exactly what
  // the files store's `open()` falls back to for the same missing fact.
  return from === '.' ? rel : joinPosix(from, rel);
}

/**
 * The same resolution, for a path a HUMAN typed or pasted into the path bar.
 *
 * The only difference is the cleanup in front of it, and every part of that
 * cleanup is there because of how paths reach a clipboard. A path copied out
 * of a shell arrives quoted (`'/tmp/my file.mp3'`) because that is how the
 * shell needed it written; a path copied out of a log or a chat arrives with
 * whitespace around it. Neither is a typo worth an error message.
 *
 * Returns null for an empty field, which is "do nothing" rather than an error:
 * pressing Enter on a blank path bar should dismiss it, not complain.
 *
 * A SPACE INSIDE THE PATH IS FINE HERE, and that is a deliberate difference
 * from the terminal-output detector, which refuses any candidate containing one
 * (see terminalPaths.ts). The refusal there is about ambiguity: a space in a
 * line of output could be the end of the path or a character in it, and there
 * is no way to know. In a path bar there is no ambiguity at all — the whole
 * field is the path, the user said so by typing it there — so `/tmp/my
 * file.mp3` is accepted exactly as written.
 */
export function normaliseTypedPath(raw: string, base?: string | null): string | null {
  const cleaned = stripQuotes(raw.trim()).trim();
  if (cleaned === '') return null;
  return resolveRemotePath(cleaned, base);
}

/**
 * Drop ONE matched pair of surrounding quotes. Only a matched pair, and only
 * one: a filename may legitimately start or end with a quote, and stripping
 * greedily would mangle it.
 */
function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s.charAt(0);
  if (first !== '"' && first !== "'" && first !== '`') return s;
  return s.endsWith(first) ? s.slice(1, -1) : s;
}

/** The containing directory of an absolute path; `/` has no parent but itself. */
export function parentOf(path: string): string {
  return path.replace(/\/[^/]+$/, '') || '/';
}

/** POSIX join (the remote is always unix, even on a Windows client). */
export function joinPosix(base: string, rel: string): string {
  if (rel === '.') return base;
  if (rel === '..') return base.replace(/\/[^/]+$/, '') || '/';
  if (base.endsWith('/')) return base + rel;
  return base + '/' + rel;
}
