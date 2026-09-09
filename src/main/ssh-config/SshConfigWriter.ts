import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ForwardSpec, HostEntry } from '../../shared/types.js';

/**
 * The write-back side of settings sync: hosts pulled from the account are
 * added to the local ~/.ssh/config — ADDED, never merged into or rewritten.
 *
 * The local config is the user's document, edited by hand and by other
 * tools, full of directives this app does not model (Compression,
 * ServerAliveInterval, Include, …). Any attempt to rewrite an existing
 * entry would silently destroy exactly the parts we never parsed, so the
 * only operation defined here is appending a well-formed block for a host
 * whose alias does not appear in the file yet — the one change a merge
 * cannot get wrong, and the one a restoring-a-new-machine user needs.
 */

export interface AppliedHosts {
  /** Aliases this call appended to the config. */
  added: string[];
}

/**
 * Host names already claimed by the config's `Host` directives. A directive
 * may carry several patterns (`Host web web2`), and OpenSSH matches each
 * token, so each token claims a name. Patterns containing wildcards claim
 * nothing we can compare against and are ignored — a synced host under an
 * existing `Host *.example.com` will be appended, and OpenSSH's first-match
 * wins then decides which block serves it, which is the same behaviour a
 * hand-added duplicate gets.
 */
export function existingHostNames(configText: string): Set<string> {
  const names = new Set<string>();
  for (const line of configText.split('\n')) {
    const stripped = stripComment(line);
    const match = /^\s*host\s+(.+)$/i.exec(stripped);
    if (!match) continue;
    for (const token of match[1]!.trim().split(/\s+/)) {
      // Wildcards claim nothing we can compare against, and a `!`-negated
      // pattern explicitly does NOT serve its name — a synced host under
      // either is appended and OpenSSH's first-match rule decides, which is
      // the same behaviour a hand-added duplicate gets.
      if (token !== '' && !/[*?]/.test(token) && !token.startsWith('!')) names.add(token);
    }
  }
  return names;
}

/** Everything from an unescaped `#` onward is a comment; ssh ignores it. */
function stripComment(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2);
      i++;
      continue;
    }
    if (line[i] === '#') break;
    out += line[i];
  }
  return out;
}

/**
 * Merge missing hosts into [configText] in memory. Pure — the file write
 * lives in {@link applyHostsToConfig} so tests can work on strings.
 */
export function mergeSshConfigText(configText: string, hosts: readonly HostEntry[]): { text: string; added: string[] } {
  const existing = existingHostNames(configText);
  const blocks: string[] = [];
  const added: string[] = [];
  for (const host of hosts) {
    if (existing.has(host.name)) continue;
    if (added.includes(host.name)) continue;
    existing.add(host.name);
    blocks.push(renderHostBlock(host));
    added.push(host.name);
  }
  if (blocks.length === 0) return { text: configText, added };
  const prefix = configText.endsWith('\n') || configText === '' ? '' : '\n';
  return { text: `${configText}${prefix}${blocks.join('\n')}\n`, added };
}

/**
 * Add [hosts] to the user's ssh config at [configPath] (default
 * `~/.ssh/config`). Missing parent directory and file are created — a fresh
 * machine may have neither. The write is atomic (temp file + rename in the
 * same directory) so a crash mid-write cannot leave a truncated config,
 * which would take down ssh itself.
 */
export function applyHostsToConfig(configPath: string | undefined, hosts: readonly HostEntry[]): AppliedHosts {
  // Same default the parser reads (kept in step by convention; the parser's
  // own helper is module-private).
  const path = configPath ?? resolve(homedir(), '.ssh', 'config');
  const existingText = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const { text, added } = mergeSshConfigText(existingText, hosts);
  if (added.length === 0) return { added };

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  const tmp = `${path}.pocketshell-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
  return { added };
}

/** One entry, as OpenSSH reads it. Only modelled directives round-trip. */
function renderHostBlock(host: HostEntry): string {
  const lines: string[] = [
    '# Added by PocketShell settings sync',
    `Host ${host.name}`,
  ];
  const indented = (line: string): void => {
    lines.push(`  ${line}`);
  };
  indented(`HostName ${host.hostname}`);
  if (host.user) indented(`User ${host.user}`);
  if (host.port !== 22) indented(`Port ${host.port}`);
  if (host.proxyJump) indented(`ProxyJump ${host.proxyJump}`);
  if (host.identityFile) indented(`IdentityFile ${host.identityFile}`);
  if (host.forwardAgent) indented('ForwardAgent yes');
  for (const forward of host.localForwards) indented(renderForward('LocalForward', forward));
  for (const forward of host.remoteForwards) indented(renderForward('RemoteForward', forward));
  return lines.join('\n');
}

function renderForward(directive: string, forward: ForwardSpec): string {
  // The listener side is always emitted explicitly — the parser folds a bare
  // port to 127.0.0.1 on read, and writing the folded form keeps a synced
  // entry byte-stable across a pull/apply round-trip.
  const listen = `${forward.listenHost || '127.0.0.1'}:${forward.listenPort}`;
  const dest = forward.kind === 'dynamic' ? '' : ` ${forward.destHost}:${forward.destPort}`;
  return `${directive} ${listen}${dest}`;
}
