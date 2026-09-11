import { readFileSync } from 'node:fs';
import { LOOPBACK_HOST, MAX_PORT } from '../../shared/net.js';
import { homedir } from 'node:os';
import { resolve, posix } from 'node:path';
import type { ForwardSpec, HostEntry } from '../../shared/types.js';

/**
 * Parses an OpenSSH-style config file into {@link HostEntry} rows.
 *
 * The Android app has no ~/.ssh/config parser (hosts come from QR/manual
 * entry). Desktop users expect config, so this is net-new. It implements the
 * subset that matters for connection: Host, HostName, Port, User,
 * IdentityFile, ProxyJump, ForwardAgent, LocalForward, RemoteForward. It also
 * honours `Include` relative to the file's directory (single level, glob-aware).
 *
 * Deliberately NOT implemented: %h/%p token expansion in HostName, Match
 * blocks, canonicalisation, ProxyCommand. These can be added later; the
 * common dev-box case (a handful of named Hosts) does not need them.
 *
 * Pure + synchronous so it is trivially unit-testable against a string.
 */

const DEFAULT_PORT = 22;

/** Parse config text into host entries. `fromConfig` is forced true. */
export function parseSshConfigText(text: string, baseDir?: string): HostEntry[] {
  const lines = text.split(/\r?\n/);
  const directives = flattenIncludes(lines, baseDir ?? homedir());
  return buildHosts(directives);
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

interface Directive {
  key: string;
  value: string;
  line: number;
}

/** Strip comments + blank lines, lower-case keys, expand `Include`. */
function flattenIncludes(lines: string[], baseDir: string): Directive[] {
  const out: Directive[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // A directive is `Key value...`; the key is the first whitespace-run.
    const match = /^(\S+)\s*(.*)$/.exec(trimmed);
    if (!match || match[1] === undefined) continue;
    const key = match[1].toLowerCase();
    const value = (match[2] ?? '').trim();

    if (key === 'include') {
      // Resolve relative to baseDir, support ~ and globs, single-level only.
      for (const file of resolveIncludeGlobs(value, baseDir)) {
        try {
          const included = readFileSync(file, 'utf8');
          out.push(...flattenIncludes(included.split(/\r?\n/), resolve(file, '..')));
        } catch {
          // missing include -> skip silently, like openssh
        }
      }
      continue;
    }
    out.push({ key, value, line: i + 1 });
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

/** Fold directives into HostEntry rows, applying first-wins per host. */
function buildHosts(directives: Directive[]): HostEntry[] {
  const hosts: HostEntry[] = [];
  let current: Partial<HostEntry> & { names: string[] } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    for (const name of current.names) {
      hosts.push(finalizeHost(current, name));
    }
    current = null;
  };

  for (const d of directives) {
    if (d.key === 'host') {
      pushCurrent();
      current = {
        names: d.value.split(/\s+/).filter(Boolean),
        localForwards: [],
        remoteForwards: [],
        forwardAgent: false,
      };
      continue;
    }
    if (!current) continue; // global option before any Host; ignored

    switch (d.key) {
      case 'hostname':
        current.hostname = d.value;
        break;
      case 'port':
        current.port = parsePort(d.value);
        break;
      case 'user':
        current.user = d.value;
        break;
      case 'identityfile':
        current.identityFile = tildeExpand(d.value);
        break;
      case 'proxyjump':
        current.proxyJump = d.value;
        break;
      case 'forwardagent':
        current.forwardAgent = d.value.toLowerCase() === 'yes';
        break;
      case 'localforward':
        current.localForwards?.push(parseForward(d.value, 'local'));
        break;
      case 'remoteforward':
        current.remoteForwards?.push(parseForward(d.value, 'remote'));
        break;
      default:
        // Ignore the many directives we don't model (Ciphers, MACs, ...).
        break;
    }
  }
  pushCurrent();
  return hosts;
}

function finalizeHost(
  partial: Partial<HostEntry> & { names: string[] },
  name: string,
): HostEntry {
  return {
    name,
    hostname: partial.hostname ?? name,
    port: partial.port ?? DEFAULT_PORT,
    user: partial.user ?? '', // ssh defaults to current user; left blank for the UI
    identityFile: partial.identityFile ?? null,
    proxyJump: partial.proxyJump ?? null,
    forwardAgent: partial.forwardAgent ?? false,
    localForwards: partial.localForwards ?? [],
    remoteForwards: partial.remoteForwards ?? [],
    fromConfig: true,
  };
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= MAX_PORT ? n : DEFAULT_PORT;
}

function parseForward(value: string, kind: ForwardSpec['kind']): ForwardSpec {
  // Forms: "listenPort" | "listenHost:listenPort" | "listen destHost:destPort"
  // For local/remote the second token is the destination; we model both.
  const tokens = value.split(/\s+/).filter(Boolean);
  const [listenPart, destPart] = tokens;
  const listen = splitHostPort(listenPart ?? value);
  if (destPart) {
    const dest = splitHostPort(destPart);
    return {
      kind,
      listenHost: listen.host,
      listenPort: listen.port,
      destHost: dest.host,
      destPort: dest.port,
    };
  }
  // No destination (dynamic, or single-token form).
  return {
    kind,
    listenHost: listen.host,
    listenPort: listen.port,
    destHost: '',
    destPort: 0,
  };
}

function splitHostPort(part: string): { host: string; port: number } {
  // "[::1]:8080" | "127.0.0.1:8080" | "8080"
  if (part.startsWith('[')) {
    const close = part.indexOf(']');
    const host = part.slice(1, close);
    const portPart = part.slice(close + 2); // skip "]:"
    return { host, port: Number.parseInt(portPart, 10) || 0 };
  }
  const colon = part.lastIndexOf(':');
  if (colon < 0) return { host: LOOPBACK_HOST, port: Number.parseInt(part, 10) || 0 };
  const host = part.slice(0, colon);
  const port = Number.parseInt(part.slice(colon + 1), 10) || 0;
  return { host: host || LOOPBACK_HOST, port };
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
