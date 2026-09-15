import { LOOPBACK_HOST, MAX_PORT } from './net.js';
import type { ForwardSpec, HostEntry } from './types.js';

/**
 * The environment-free half of the OpenSSH config reader: line
 * classification, directive folding, and the port/forward grammars. Nothing
 * here touches a filesystem — the desktop's SshConfigParser (main process)
 * and the web app's importer (browser tab) both run this exact code, the
 * latter vendored via pocketshell-web's scripts/sync-shared.sh.
 *
 * The platform halves live in the wrappers, and the split is the contract:
 *   - desktop wrapper: reads files, expands `Include` (fs + glob), expands
 *     `~`/relative IdentityFile paths to absolute ones;
 *   - web wrapper: no filesystem (skips `Include`), keeps `~` verbatim (it
 *     is a hint for WHICH key file to upload), drops host patterns.
 * Edits here must keep both wrappers' behaviour green:
 * tests/unit/SshConfigParser.test.ts here and pocketshell-web's
 * tests/sshConfigImport.test.ts.
 */

const DEFAULT_PORT = 22;

export interface Directive {
  key: string;
  value: string;
  line: number;
}

/** `Key value...` from one raw line; blank lines, comments, garbage -> null. */
export function parseDirectiveLine(raw: string, lineNo: number): Directive | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = /^(\S+)\s*(.*)$/.exec(trimmed);
  if (!match || match[1] === undefined) return null;
  return { key: match[1].toLowerCase(), value: (match[2] ?? '').trim(), line: lineNo };
}

/** Fold directives into HostEntry rows, applying first-wins per host. */
export function buildHosts(directives: Directive[]): HostEntry[] {
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
        // Kept verbatim: the desktop wrapper expands ~ / relative paths to
        // absolute ones, the web wrapper keeps the config's own spelling.
        current.identityFile = d.value;
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
