import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, posix } from 'node:path';
import { buildHosts, parseDirectiveLine } from '../../shared/sshConfigCore.js';
import type { Directive } from '../../shared/sshConfigCore.js';
import type { HostEntry } from '../../shared/types.js';

/**
 * Parses an OpenSSH-style config file into {@link HostEntry} rows.
 *
 * The folding itself is NOT here: directive classification, Host-block
 * folding, and the port/forward grammars live in the shared pure core
 * (src/shared/sshConfigCore.ts) — the exact code the web app vendors and
 * runs in the browser. This main-process module is the desktop half of the
 * split, everything that needs a filesystem:
 *   - `Include` expansion (reads + globs the referenced config files);
 *   - IdentityFile paths expanded to absolute (~ / process-cwd relative).
 *
 * Deliberately NOT implemented anywhere: %h/%p token expansion in HostName,
 * Match blocks, canonicalisation, ProxyCommand. These can be added later;
 * the common dev-box case (a handful of named Hosts) does not need them.
 *
 * Pure + synchronous so it is trivially unit-testable against a string.
 */

/** Parse config text into host entries. `fromConfig` is forced true. */
export function parseSshConfigText(text: string, baseDir?: string): HostEntry[] {
  const lines = text.split(/\r?\n/);
  const directives = flattenIncludes(lines, baseDir ?? homedir());
  return expandIdentityPaths(buildHosts(directives));
}

/** Read + parse ~/.ssh/config (or an explicit path). */
export function readSshConfig(configPath?: string): HostEntry[] {
  const path = configPath ?? defaultConfigPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // no config is normal; host picker shows manual-add
  }
  return parseSshConfigText(text, resolve(path, '..'));
}

/** Default ~/.ssh/config path. Exported for tests/mocking. */
function defaultConfigPath(): string {
  return resolve(homedir(), '.ssh', 'config');
}

/** Strip comments + blank lines, lower-case keys, expand `Include`. */
function flattenIncludes(lines: string[], baseDir: string): Directive[] {
  const out: Directive[] = [];
  for (let i = 0; i < lines.length; i++) {
    const directive = parseDirectiveLine(lines[i] ?? '', i + 1);
    if (!directive) continue;

    if (directive.key === 'include') {
      // Resolve relative to baseDir, support ~ and globs, single-level only.
      for (const file of resolveIncludeGlobs(directive.value, baseDir)) {
        try {
          const included = readFileSync(file, 'utf8');
          out.push(...flattenIncludes(included.split(/\r?\n/), resolve(file, '..')));
        } catch {
          // missing include -> skip silently, like openssh
        }
      }
      continue;
    }
    out.push(directive);
  }
  return out;
}

function resolveIncludeGlobs(spec: string, baseDir: string): string[] {
  const parts = spec.split(/\s+/).filter(Boolean);
  const files: string[] = [];
  for (const part of parts) {
    const expanded = part.startsWith('~') ? tildeExpand(part) : resolve(baseDir, part);
    // Simple glob: only support trailing * (the common ~/.ssh/conf.d/* case).
    if (expanded.includes('*')) {
      files.push(...globSimple(expanded));
    } else {
      files.push(expanded);
    }
  }
  return files;
}

/** Minimal glob: expands a single trailing `*`. Returns sorted matches. */
function globSimple(pattern: string): string[] {
  const idx = pattern.lastIndexOf('*');
  if (idx < 0) return [pattern];
  const dir = resolve(pattern.slice(0, idx), '..');
  const prefix = pattern.slice(0, idx);
  let entries: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry);
    if ((prefix + entry).startsWith(pattern.slice(0, idx)) && full.startsWith(prefix)) {
      matches.push(full);
    }
  }
  matches.sort();
  return matches;
}

/**
 * The desktop half of the IdentityFile split: the core keeps the config's
 * own spelling; a desktop dialer needs a real path, so ~ and relative
 * entries become absolute here (relative to the process cwd, as before).
 */
function expandIdentityPaths(hosts: HostEntry[]): HostEntry[] {
  for (const host of hosts) {
    if (host.identityFile !== null) host.identityFile = tildeExpand(host.identityFile);
  }
  return hosts;
}

function tildeExpand(p: string): string {
  if (!p.startsWith('~')) return resolve(p);
  // Strip the leading separator too. resolve() treats a segment that begins with
  // a slash as absolute and discards homedir(), so `~/.ssh/k` would collapse to
  // `/.ssh/k` (drive root `C:\.ssh\k` on Windows) instead of the user's home.
  const rest = p.slice(1).replace(/^[/\\]+/, '');
  // Joined POSIX-style, not resolve(): the expansion is written back into
  // OpenSSH config text, which ssh builds other than Windows-native (Git's,
  // WSL's) read with `/` as the only separator, and what the parser produces is
  // what the writer later writes. Node's fs reads either spelling on Windows,
  // so `~/.ssh/k` comes back as `<home>/.ssh/k` everywhere — the identityFile
  // round-trip the parser tests assert. Identical to resolve() on POSIX.
  const home = homedir();
  return rest ? posix.join(home, rest) : home;
}
