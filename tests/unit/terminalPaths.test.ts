import { describe, expect, it } from 'vitest';
import {
  continuesPath,
  findPaths,
  type PathMatch,
} from '../../src/renderer/terminalPaths';

/**
 * The path detector's rules, one false positive at a time.
 *
 * The property under test is asymmetric on purpose, and it is why this file is
 * mostly rejections: a path we fail to linkify costs the user a copy-paste,
 * while a word we wrongly linkify makes the whole terminal look broken. So
 * every "must not match" case below is a shape that really does appear in
 * terminal output next to real paths, and each one exists because the naive
 * "anything with a slash" rule swallows it.
 */

/** The paths a line yields, in order. */
function paths(line: string): string[] {
  return findPaths(line).map((m) => m.path);
}

/** The exact text each match spans, for checking the underline's extent. */
function spans(line: string): string[] {
  return findPaths(line).map((m) => line.slice(m.start, m.end));
}

describe('findPaths — the screenshot that started this', () => {
  // Both lines are transcribed from the user's ffprobe/voice-preview output.
  it('finds the path in front of a colon', () => {
    const line = 'tmp/voice-previews/olya-merin/preview-1.mp3: duration=9.613042';
    expect(paths(line)).toEqual(['tmp/voice-previews/olya-merin/preview-1.mp3']);
  });

  it('does not underline the colon it stopped at', () => {
    const line = 'tmp/voice-previews/olya-merin/preview-1.mp3: duration=9.613042';
    expect(spans(line)).toEqual(['tmp/voice-previews/olya-merin/preview-1.mp3']);
  });

  it('ignores the bullet, the tag and the parenthesised size around it', () => {
    const line = '\u203a [file] tmp/voice-previews/olya-merin/preview-2.mp3 (222.9KB)';
    expect(paths(line)).toEqual(['tmp/voice-previews/olya-merin/preview-2.mp3']);
  });

  it('strips a call-like writer label attached directly to the path', () => {
    const line = 'Write(docs/runbooks/production-data-migration.md).';
    expect(paths(line)).toEqual(['docs/runbooks/production-data-migration.md']);
    expect(spans(line)).toEqual(['docs/runbooks/production-data-migration.md']);
  });
});

describe('findPaths — absolute paths, verbatim from the user', () => {
  // "/tmp/olya-v3tts.mp3 also files like that with absolute path".
  //
  // Two segments and a single leading slash is the shortest useful absolute
  // shape there is, and it is exactly what a detector tuned for
  // `a/b/c.ext` drops: a "needs two separators" or "needs a slash after the
  // first character" rule would throw all of these away.
  it('matches a two-segment absolute path', () => {
    expect(paths('/tmp/olya-v3tts.mp3')).toEqual(['/tmp/olya-v3tts.mp3']);
  });

  it('matches a deep absolute path', () => {
    expect(paths('/home/alexey/git/pocketshell/README.md')).toEqual([
      '/home/alexey/git/pocketshell/README.md',
    ]);
  });

  it('matches an absolute path with no extension at all', () => {
    expect(paths('/var/log/syslog')).toEqual(['/var/log/syslog']);
  });

  it('does not read the leading slash as a command flag', () => {
    // The flag rule fires on a leading `-`; `/` anchors a path and is the one
    // thing that exempts a candidate from every relative-shape heuristic.
    expect(findPaths('/tmp/olya-v3tts.mp3')[0]?.start).toBe(0);
  });

  it('does not mistake a dashed, digit-bearing filename for version noise', () => {
    // `olya-v3tts` has the dash-and-digits shape of a version string. The
    // numeric rule only fires when EVERY named segment is a bare number, so it
    // cannot reach a name like this one.
    expect(paths('/tmp/olya-v3tts.mp3')).toEqual(['/tmp/olya-v3tts.mp3']);
    expect(paths('/srv/v1.2.3/build-2024-x86_64.tar.gz')).toEqual([
      '/srv/v1.2.3/build-2024-x86_64.tar.gz',
    ]);
  });

  it('finds them in the sentences tools actually print them in', () => {
    expect(paths('wrote /tmp/olya-v3tts.mp3 (222.9KB)')).toEqual(['/tmp/olya-v3tts.mp3']);
    expect(paths('/tmp/olya-v3tts.mp3: duration=9.613042')).toEqual(['/tmp/olya-v3tts.mp3']);
    expect(spans('ls -l /var/log/syslog')).toEqual(['/var/log/syslog']);
  });
});

describe('findPaths — the Codex TUI output, verbatim from the user', () => {
  /**
   * Both of these are ONE token and both match here, which is the useful thing
   * this block records: the rules never had a problem with the user's paths.
   * What the user saw unlinkified was the same path broken over two terminal
   * ROWS, and the fix for that is in terminalLinks.ts's flattening — see its
   * "why `isWrapped` is not enough" header and the tests beside it.
   */
  const ABSOLUTE =
    '/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-62ab287b-39b5-461a-9d45-69e2eae3d41a.png';
  const TILDE =
    '~/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/exec-de1a03f1-2d3f-4d2d-8a44-c5da743f849e.png';

  it('matches the absolute generated-image path in the command it appeared in', () => {
    expect(paths(`Ran for f in ${ABSOLUTE}`)).toEqual([ABSOLUTE]);
  });

  it('matches the tilde form under the TUI bullet it was printed with', () => {
    // `└` is its own whitespace-delimited token and carries no slash, so it is
    // rejected the way any bare word is and never joins the path beside it.
    expect(paths(`    └ ${TILDE}`)).toEqual([TILDE]);
  });

  it('is not fooled by the 36-character UUID segments or the dot-directory', () => {
    // Both were suspects while this was being diagnosed: a UUID is well under
    // NAME_MAX, and `.codex` is a segment like any other — only `.` and `..`
    // are treated as naming nothing.
    expect(paths('/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd')).toEqual(
      ['/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd'],
    );
  });

  it('yields only the truncated directory when the row is read on its own', () => {
    // This is what the user was hovering over. The first row of the split ends
    // at a directory, so a detector working one row at a time can only ever
    // offer the directory — correctly, and uselessly. It is the reason
    // scanBufferLine has to join the rows before the detector is asked.
    const firstRow =
      'Ran for f in /home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/';
    expect(paths(firstRow)).toEqual([
      '/home/alexey/.codex/generated_images/01a03e3d-62c0-70c1-83aa-2597285478fd/',
    ]);

    const gutterRow = '  │ exec-62ab287b-39b5-461a-9d45-69e2eae3d41a.png /home/alexey/.codex/';
    // The filename alone carries no slash, so it is a bare word and refused;
    // only the second argument's truncated directory survives.
    expect(paths(gutterRow)).toEqual(['/home/alexey/.codex/']);
  });
});

describe('findPaths — a file:// URL', () => {
  /**
   * The "Saved to:" line, reported sitting dead in the pane: WebLinksAddon
   * admits only http/https, and this detector refused every `://` — so
   * nothing underlined it and there was nowhere to click. The file it names
   * is on the SSH host like everything else in the pane, so a file URL is a
   * path wearing a scheme: opened in the Files tab, underlined whole.
   */
  const SAVED_TO =
    'file:///home/alexey/.codex/generated_images/01a06bad-05a4-7fc0-bf41-d63ece15252c/exec-aca3c94d-2a2f-4150-a501-cd1e2fd26db9.png';

  it('matches one and opens the path under the scheme', () => {
    expect(paths(`Saved to: ${SAVED_TO}`)).toEqual([
      '/home/alexey/.codex/generated_images/01a06bad-05a4-7fc0-bf41-d63ece15252c/exec-aca3c94d-2a2f-4150-a501-cd1e2fd26db9.png',
    ]);
  });

  it('underlines the whole URL, scheme included', () => {
    expect(spans(SAVED_TO)).toEqual([SAVED_TO]);
  });

  it('refuses the non-empty-authority form, which names no path on this box', () => {
    // `file://host/share/x.png` de-schemed is `host/share/x.png` — a hostname
    // wearing a path, which would resolve somewhere wrong if it resolved at
    // all. A program printing a URL for its own file prints `file:///`.
    expect(paths('file://host/share/x.png')).toEqual([]);
  });

  it('refuses one whose path breaks the ordinary rules', () => {
    // The colon rule survives the de-scheming: `/tmp/a:8080` is not a name.
    expect(paths('file:///tmp/a:8080/x.png')).toEqual([]);
  });

  it('reads the path literally, without percent-decoding', () => {
    // A `Saved to:` line prints the raw filesystem path, so decoding `%20`
    // would corrupt a name that genuinely holds it.
    expect(paths('file:///tmp/my%20file.mp3')).toEqual(['/tmp/my%20file.mp3']);
  });
});

describe('continuesPath — the tail a join rule may glue a row onto', () => {
  // The guard applies the detector's own standard, because the two must never
  // disagree about a token the user can already see underlined: rooted, or a
  // relative path with two or more slashes. The one-slash shapes are prose —
  // the false-positive suite above — and refusing them is what keeps a prose
  // row from picking up the row below it.
  it('accepts a rooted tail, absolute or tilde or explicit', () => {
    expect(continuesPath('/tmp/out/')).toBe(true);
    expect(continuesPath('~/.codex/generated_images/')).toBe(true);
    expect(continuesPath('./assets/')).toBe(true);
    expect(continuesPath('../shared/')).toBe(true);
    // A bare `~/` is home, and `~/` plus the fragment that follows is a path
    // the moment the rows are joined — the old guard admitted it too.
    expect(continuesPath('~/')).toBe(true);
  });

  it('accepts a relative tail with two or more slashes', () => {
    // The montage report: the TUI echoed a command whose relative path broke
    // at the margin mid-token, and the rows had to be rejoined.
    expect(continuesPath('assets/images/exam-questions-generator/')).toBe(true);
    expect(continuesPath('src/main/ipc')).toBe(true);
  });

  it('refuses `src/main`, by the same single-slash rule the detector applies', () => {
    // The whole point of borrowing the detector's standard: a tail the
    // detector would not link on its own row never earns a join either.
    expect(continuesPath('src/main')).toBe(false);
  });

  it('accepts a file:// URL, which the detector opens de-schemed', () => {
    expect(continuesPath('file:///tmp/out/exec-ac')).toBe(true);
  });

  it('refuses the one-slash prose shapes', () => {
    expect(continuesPath('and/')).toBe(false);
    expect(continuesPath('w/o')).toBe(false);
    expect(continuesPath('client/server')).toBe(false);
    expect(continuesPath('9/10')).toBe(false);
  });

  it('refuses words and fragments that are not paths at all', () => {
    expect(continuesPath('quizgen-landing-page.png')).toBe(false);
    expect(continuesPath('montage')).toBe(false);
    // A bare `/` names nothing, so unlike the old regex guard this one
    // refuses to glue a row onto it.
    expect(continuesPath('/')).toBe(false);
  });
});

describe('findPaths — shapes that are paths', () => {
  it('matches an absolute path', () => {
    expect(paths('wrote /home/alexey/notes.md')).toEqual(['/home/alexey/notes.md']);
  });

  it('matches a tilde path, which the resolver knows how to expand', () => {
    expect(paths('cd ~/git/pocketshell')).toEqual(['~/git/pocketshell']);
  });

  it('matches an explicitly relative path', () => {
    expect(paths('reading ./config/app.yml and ../shared/base.yml')).toEqual([
      './config/app.yml',
      '../shared/base.yml',
    ]);
  });

  it('matches a multi-segment relative path with no extension', () => {
    // Two slashes is already enough anchoring; only the ONE-slash case needs
    // an extension to distinguish it from `and/or`.
    expect(paths('see src/main/ipc for the handlers')).toEqual(['src/main/ipc']);
  });

  it('matches a directory by its trailing slash', () => {
    expect(paths('created tmp/voice-previews/')).toEqual(['tmp/voice-previews/']);
  });

  it('matches an absolute path with only numeric components', () => {
    // Rejected as "all numeric" only when nothing anchors it; `/proc/1234/fd`
    // has named segments and is absolute besides.
    expect(paths('open /proc/1234/fd/3')).toEqual(['/proc/1234/fd/3']);
  });

  it('finds several paths on one line, with the right offsets', () => {
    const line = 'cp tmp/a.mp3 /srv/media/b.mp3';
    expect(findPaths(line)).toEqual<PathMatch[]>([
      { start: 3, end: 12, path: 'tmp/a.mp3' },
      { start: 13, end: 29, path: '/srv/media/b.mp3' },
    ]);
  });
});

describe('findPaths — decoration around a path', () => {
  it('drops sentence punctuation', () => {
    expect(paths('failed on /etc/hosts,')).toEqual(['/etc/hosts']);
    expect(paths('see /etc/hosts.')).toEqual(['/etc/hosts']);
    expect(paths('really? /etc/hosts?')).toEqual(['/etc/hosts']);
  });

  it('drops enclosing quotes and brackets', () => {
    expect(paths('"tmp/a.mp3" and [tmp/b.mp3] and (tmp/c.mp3)')).toEqual([
      'tmp/a.mp3',
      'tmp/b.mp3',
      'tmp/c.mp3',
    ]);
  });

  it('keeps a bracket the name itself owns', () => {
    // `report(1).pdf` closes its own paren, so the trailing `)` is not junk.
    expect(paths('saved tmp/report(1).pdf')).toEqual(['tmp/report(1).pdf']);
  });

  it('drops markdown emphasis without accepting a glob', () => {
    expect(paths('**tmp/x.md**')).toEqual(['tmp/x.md']);
    expect(paths('rm tmp/*.mp3')).toEqual([]);
  });

  it('takes the value out of a flag assignment, and underlines only the value', () => {
    const line = 'ffmpeg --output=tmp/out.mp3';
    expect(paths(line)).toEqual(['tmp/out.mp3']);
    expect(spans(line)).toEqual(['tmp/out.mp3']);
  });

  it('does not cut a path at an equals sign of its own', () => {
    expect(paths('open tmp/a=b/c.txt')).toEqual(['tmp/a=b/c.txt']);
  });
});

describe('findPaths — the :line:col suffix', () => {
  it('reads a line number and underlines it with the path', () => {
    const line = 'src/renderer/ipc.ts:12: error TS2304';
    expect(findPaths(line)[0]).toEqual({
      start: 0,
      end: 22,
      path: 'src/renderer/ipc.ts',
      line: 12,
    });
  });

  it('reads a line and column', () => {
    expect(findPaths('src/main.ts:12:5 warning')[0]).toEqual({
      start: 0,
      end: 16,
      path: 'src/main.ts',
      line: 12,
      column: 5,
    });
  });

  it('accepts a one-slash extensionless path when a line number vouches for it', () => {
    // `src/Makefile` alone is refused (see the `and/or` rule); `src/Makefile:9`
    // is a compiler talking, and nothing in prose has that shape.
    expect(paths('src/Makefile:9: missing separator')).toEqual(['src/Makefile']);
  });
});

describe('findPaths — rejections (each one seen next to a real path)', () => {
  it('rejects a URL, which belongs to WebLinksAddon', () => {
    expect(paths('see https://example.com/a/b.html for details')).toEqual([]);
    expect(paths('http://localhost:5173/index.html')).toEqual([]);
  });

  it('rejects a URL even when a query looks like an assignment', () => {
    // The `://` test runs before the `key=value` split precisely so that
    // `b/c.txt` cannot be salvaged out of a URL.
    expect(paths('https://host/a=b/c.txt')).toEqual([]);
  });

  it('rejects a scheme-less domain that happens to have a file on it', () => {
    expect(paths('www.example.com/index.html')).toEqual([]);
  });

  it('rejects bare numbers and measurements', () => {
    expect(paths('9.613042')).toEqual([]);
    expect(paths('took 2m 19s')).toEqual([]);
    expect(paths('222.9KB')).toEqual([]);
  });

  it('rejects ffprobe-style key=value output', () => {
    expect(paths('-of default=noprint_wrappers=1:nokey=1')).toEqual([]);
    expect(paths('duration=9.613042')).toEqual([]);
  });

  it('rejects command flags', () => {
    expect(paths('ffprobe -v error -of csv=p=0')).toEqual([]);
    expect(paths('gcc -I/usr/include foo.c')).toEqual([]);
  });

  it('rejects a bare word, however extension-like', () => {
    expect(paths('run manage.py to start it')).toEqual([]);
    expect(paths('edit Makefile')).toEqual([]);
    expect(paths('README.md')).toEqual([]);
  });

  it('rejects English that happens to contain a slash', () => {
    expect(paths('this is a read/write mount')).toEqual([]);
    expect(paths('and/or w/o n/a y/N')).toEqual([]);
    expect(paths('TODO/FIXME in the client/server split')).toEqual([]);
  });

  it('rejects counters, ratios and dates', () => {
    expect(paths('[3/10] building')).toEqual([]);
    expect(paths('9/10 passed')).toEqual([]);
    expect(paths('2026/08/25 09:41:02')).toEqual([]);
    expect(paths('available 24/7')).toEqual([]);
  });

  it('rejects a bare slash and paths that name nothing', () => {
    expect(paths('a / b')).toEqual([]);
    expect(paths('// comment')).toEqual([]);
    expect(paths('cd ../..')).toEqual([]);
  });

  it('rejects a colon list or an scp target', () => {
    expect(paths('PATH=/usr/local/bin:/usr/bin:/bin')).toEqual([]);
    expect(paths('scp alexey@hetzner:/tmp/x.mp3 .')).toEqual([]);
    expect(paths('git@github.com:user/repo.git')).toEqual([]);
  });

  it('rejects another user home, which relative resolution would get wrong', () => {
    expect(paths('~alexey/git/foo')).toEqual([]);
  });

  it('admits `~/` without admitting the tilde on its own', () => {
    // `~` is punctuation in prose and a home directory in a path, and only the
    // slash tells them apart. Both of these fall to THE rule — a candidate with
    // no slash in it is a word — which is what keeps the tilde form from
    // widening the detector when it is the shape an agent TUI prints.
    expect(paths('roughly ~ 40 seconds')).toEqual([]);
    expect(paths('~ and ~foo and ~bar')).toEqual([]);
  });

  it('rejects shell metacharacters and escapes', () => {
    expect(paths('echo $HOME/x.txt')).toEqual([]);
    expect(paths('C:\\Users\\alexey\\x.txt')).toEqual([]);
    // Only the token carrying the metacharacter is refused. `b/c.txt` on the
    // other side of the pipe is a real path and stays a link.
    expect(paths('cat a/b.txt|tee c/d.txt')).toEqual(['c/d.txt']);
  });

  it('rejects a segment no filesystem could hold', () => {
    expect(paths(`tmp/${'a'.repeat(300)}.mp3`)).toEqual([]);
  });

  it('rejects an empty line and refuses to scan a pathological one', () => {
    expect(findPaths('')).toEqual([]);
    expect(findPaths('/a/b.txt '.repeat(600))).toEqual([]);
  });
});

describe('findPaths — a markdown link a transcript prints', () => {
  // The agent transcripts wrap their outputs in `[label](target)` markdown;
  // the label is prose (often itself a filename-shaped word) and the target
  // is the address a click can open.
  it('opens the target under the label, not the bracketed junk', () => {
    const line =
      'Changed: - [02-accuracy-02-accuracy-example-crisp.png](/home/alexey/git/mlops-zoomcamp/img.png) noted';
    expect(paths(line)).toEqual(['/home/alexey/git/mlops-zoomcamp/img.png']);
  });

  it('underlines the target alone, leaving the label and brackets out', () => {
    const line = 'see [the guide](docs/setup.md) for details';
    expect(spans(line)).toEqual(['docs/setup.md']);
  });

  it('still refuses a token whose target is no path', () => {
    expect(paths('jump to [the section](#setup) first')).toEqual([]);
    expect(paths('jump to [the section](README) first')).toEqual([]);
  });

  it('does not swallow a plain path that merely sits in brackets', () => {
    expect(paths('see (docs/setup.md) for details')).toEqual(['docs/setup.md']);
  });
});
