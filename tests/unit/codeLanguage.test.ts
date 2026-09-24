import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINE_CHARS,
  PLAIN_TEXT,
  basename,
  languageIdForFilename,
  shouldHighlight,
} from '@ui/app/codeLanguage';

/**
 * The filename -> language rules, which is where every edge case in the Files
 * editor lives. Deliberately no DOM and no CodeMirror import: the module under
 * test is pure so that the interesting decisions ("a `.zshrc` is a shell
 * script", "an unknown file gets an editor, not a guess") are asserted as
 * product behaviour rather than through a mounted component.
 */

describe('basename', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(basename('/home/alexey/git/app/main.py')).toBe('main.py');
  });

  it('leaves a bare filename alone', () => {
    expect(basename('main.py')).toBe('main.py');
  });

  /**
   * The remote is always unix, so this is not a path we should ever see — but
   * a filename is only used to pick colours, and being lenient is free.
   */
  it('also splits on backslashes', () => {
    expect(basename('C:\\Users\\alexey\\notes.md')).toBe('notes.md');
  });

  it('returns empty for a trailing slash rather than the parent directory', () => {
    expect(basename('/var/log/')).toBe('');
  });
});

describe('languageIdForFilename — extensions', () => {
  const cases: [string, string][] = [
    ['app.js', 'javascript'],
    ['app.mjs', 'javascript'],
    ['App.jsx', 'jsx'],
    ['store.ts', 'typescript'],
    ['App.tsx', 'tsx'],
    ['App.vue', 'vue'],
    ['package.json', 'json'],
    ['main.py', 'python'],
    ['README.md', 'markdown'],
    ['index.html', 'html'],
    ['app.css', 'css'],
    ['theme.scss', 'css'],
    ['pom.xml', 'xml'],
    ['compose.yml', 'yaml'],
    ['compose.yaml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['setup.cfg', 'ini'],
    ['sshd.conf', 'ini'],
    ['fix.patch', 'diff'],
    ['schema.sql', 'sql'],
    ['main.rs', 'rust'],
    ['main.go', 'go'],
    ['Main.java', 'java'],
    ['main.cpp', 'cpp'],
    ['main.c', 'c'],
    ['index.php', 'php'],
    ['app.rb', 'ruby'],
    ['script.pl', 'perl'],
    ['init.lua', 'lua'],
    ['deploy.ps1', 'powershell'],
    ['analysis.R', 'r'],
    ['App.swift', 'swift'],
    ['build.gradle', 'groovy'],
    ['Main.hs', 'haskell'],
    ['core.clj', 'clojure'],
    ['api.proto', 'protobuf'],
    ['backup.sh', 'shell'],
  ];

  for (const [file, expected] of cases) {
    it(`maps ${file} to ${expected}`, () => {
      expect(languageIdForFilename(file)).toBe(expected);
    });
  }

  it('is case-insensitive about the extension', () => {
    expect(languageIdForFilename('SCRIPT.PY')).toBe('python');
    expect(languageIdForFilename('Notes.MD')).toBe('markdown');
  });

  it('resolves against the basename, not the directory', () => {
    // The directory contains ".py"; the file does not. Matching on the whole
    // path would colour this YAML file as Python.
    expect(languageIdForFilename('/srv/app.py/config.yml')).toBe('yaml');
  });
});

describe('languageIdForFilename — compound extensions', () => {
  it('prefers the longest matching extension', () => {
    expect(languageIdForFilename('index.d.ts')).toBe('typescript');
  });

  it('falls through an unknown leading segment to a known one', () => {
    expect(languageIdForFilename('bundle.min.js')).toBe('javascript');
    expect(languageIdForFilename('docker-compose.override.yml')).toBe('yaml');
  });
});

describe('languageIdForFilename — extensionless and dotfiles', () => {
  it('recognises a Dockerfile by name', () => {
    expect(languageIdForFilename('Dockerfile')).toBe('dockerfile');
    expect(languageIdForFilename('/srv/app/Dockerfile')).toBe('dockerfile');
  });

  it('recognises a suffixed Dockerfile', () => {
    expect(languageIdForFilename('Dockerfile.dev')).toBe('dockerfile');
  });

  /** A leading dot is part of the name; `.gitignore` has no extension. */
  it('treats a dotfile name as a name, not as an extension', () => {
    expect(languageIdForFilename('.gitignore')).toBe('ini');
    expect(languageIdForFilename('.bashrc')).toBe('shell');
    expect(languageIdForFilename('.zshrc')).toBe('shell');
    expect(languageIdForFilename('.profile')).toBe('shell');
  });

  it('handles a dotfile that does have an extension', () => {
    expect(languageIdForFilename('.eslintrc.json')).toBe('json');
  });

  it('handles the env-suffix convention', () => {
    expect(languageIdForFilename('.env')).toBe('ini');
    expect(languageIdForFilename('.env.production')).toBe('ini');
  });

  it('recognises nginx.conf specifically, not just as a .conf file', () => {
    expect(languageIdForFilename('/etc/nginx/nginx.conf')).toBe('nginx');
  });

  /**
   * A makefile's rule syntax is not shell even though its recipes are, and
   * mis-colouring the majority of the file to catch the minority is worse than
   * leaving it plain.
   */
  it('leaves a Makefile plain rather than pretending it is shell', () => {
    expect(languageIdForFilename('Makefile')).toBe(PLAIN_TEXT);
  });
});

describe('languageIdForFilename — the fallback', () => {
  it('returns plain text for an unknown extension', () => {
    expect(languageIdForFilename('output.qqq')).toBe(PLAIN_TEXT);
  });

  it('returns plain text for a file with no extension at all', () => {
    expect(languageIdForFilename('/usr/local/bin/mytool')).toBe(PLAIN_TEXT);
  });

  it('returns plain text rather than throwing on null, undefined or empty', () => {
    expect(languageIdForFilename(null)).toBe(PLAIN_TEXT);
    expect(languageIdForFilename(undefined)).toBe(PLAIN_TEXT);
    expect(languageIdForFilename('')).toBe(PLAIN_TEXT);
    expect(languageIdForFilename('/var/log/')).toBe(PLAIN_TEXT);
  });
});

describe('shouldHighlight', () => {
  it('highlights an ordinary source file', () => {
    expect(shouldHighlight('def f():\n    return 1\n')).toBe(true);
  });

  it('highlights an empty file', () => {
    expect(shouldHighlight('')).toBe(true);
  });

  /** Short lines throughout, so it is the total size that decides. */
  const shortLines = (chars: number): string => {
    const line = 'x'.repeat(79) + '\n';
    return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
  };

  it('refuses a document past the size ceiling', () => {
    expect(shouldHighlight(shortLines(HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
  });

  it('accepts a document exactly at the size ceiling', () => {
    expect(shouldHighlight(shortLines(HIGHLIGHT_MAX_CHARS))).toBe(true);
  });

  /** A minified bundle or a base64 blob: one line, no newlines, unreadable. */
  it('refuses a document containing one enormous line', () => {
    expect(shouldHighlight('x'.repeat(HIGHLIGHT_MAX_LINE_CHARS + 1))).toBe(false);
  });

  it('checks every line, not just the first', () => {
    const doc = 'short\n'.repeat(10) + 'y'.repeat(HIGHLIGHT_MAX_LINE_CHARS + 1) + '\nshort\n';
    expect(shouldHighlight(doc)).toBe(false);
  });

  it('accepts a long file made of many short lines', () => {
    expect(shouldHighlight('const a = 1;\n'.repeat(20_000))).toBe(true);
  });
});
