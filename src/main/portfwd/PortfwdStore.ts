import type { PortIntent } from '@pocketshell/core';
export type { PortIntent } from '@pocketshell/core';
import Store from 'electron-store';
import { MAX_PORT } from '@pocketshell/core';

/**
 * Persistence for port-forwarding preferences.
 *
 * The Python tool persists exactly one thing — `~/.ssh-auto-forward/port-names.json`
 * (`forwarder.py:27`) — and its port *remaps* are documented as persistent
 * (`forwarder.py:1009`) but only survive a reconnect, never a restart. The
 * desktop is deliberately better here: names, remaps and on/off intents all
 * outlive the process, keyed by host.
 *
 * The read/sanitise/write rules are ported from `_load_port_names` /
 * `_save_port_names` (`forwarder.py:30-56`, `:999-1006`):
 *   - corrupt or non-object data is treated as empty, never thrown;
 *   - non-numeric port keys and empty names are dropped on read;
 *   - setting an empty name DELETES the entry;
 *   - a host whose state becomes fully empty is removed entirely;
 *   - the whole document is re-read before each write, so two windows on
 *     different hosts cannot clobber each other.
 */


/** All port-forward state that outlives a run, for one host. */
export interface PortfwdState {
  /** Friendly names. Port keys are decimal strings (JSON object keys). */
  names: Record<string, string>;
  /** User-chosen local ports. Port keys are decimal strings. */
  remaps: Record<string, number>;
  /** Ports the user explicitly forced on (e.g. above maxAutoPort). */
  forceOn: number[];
  /** Ports the user explicitly silenced. */
  forceOff: number[];
  /** Whether auto-forward was left running for this host. */
  autoEnabled: boolean;
}

export interface PortfwdSchema {
  /** hostKey -> state. hostKey = ssh-config alias, else `user@host:port`. */
  hosts: Record<string, PortfwdState>;
  /** Schema version so a later shape change can migrate rather than guess. */
  version: 1;
}

/**
 * The minimum a persistence backend must do. Kept as an interface so unit
 * tests (and any non-Electron host process) can run the whole store without
 * an `app.getPath('userData')` to write into.
 */
export interface PortfwdBackend {
  read(): unknown;
  write(doc: PortfwdSchema): void;
}

/** In-memory backend: the graceful degradation when no disk store exists. */
export class MemoryBackend implements PortfwdBackend {
  private doc: PortfwdSchema = { hosts: {}, version: 1 };
  read(): unknown {
    return this.doc;
  }
  write(doc: PortfwdSchema): void {
    this.doc = doc;
  }
}

/**
 * `electron-store` backend. Writes atomically already, so the Python's
 * tmp-file + `os.replace` dance is free.
 *
 * `cwd` is only passed by tests; in the app it defaults to
 * `app.getPath('userData')`, which throws outside a running Electron app —
 * hence {@link PortfwdStore.default}'s try/catch.
 */
export function createElectronBackend(options: { cwd?: string } = {}): PortfwdBackend {
  const store = new Store<PortfwdSchema>({
    name: 'portfwd',
    ...(options.cwd ? { cwd: options.cwd } : {}),
    defaults: { hosts: {}, version: 1 },
  });
  return {
    // Read the whole document per access so concurrent windows merge rather
    // than clobber (`forwarder.py:1001`). Never cache it.
    read: () => ({ hosts: store.get('hosts'), version: store.get('version') }),
    write: (doc) => {
      store.set('hosts', doc.hosts);
      store.set('version', doc.version);
    },
  };
}

/**
 * Derive the persistence key for a connection.
 *
 * The Python keys on the **SSH config host alias** (`self.host_alias`), not
 * the hostname, so two aliases pointing at the same box keep separate name
 * sets. `ConnectionRecord.hostAlias` now carries it, so a config host keys on
 * its alias and survives the box changing IP.
 *
 * The `user@host:port` fallback stays for a manually-entered host, which has
 * no alias to key on. This function is the single place that choice is made.
 */
export function hostKeyFor(rec: {
  hostAlias?: string | null;
  user: string;
  host: string;
  port: number;
}): string {
  const alias = rec.hostAlias?.trim();
  if (alias) return alias;
  return `${rec.user}@${rec.host}:${rec.port}`;
}

export class PortfwdStore {
  constructor(private readonly backend: PortfwdBackend) {}

  /**
   * Best-effort disk-backed store; falls back to memory when there is no
   * Electron `userData` path (unit tests, integration tests, CLI harnesses).
   */
  static default(): PortfwdStore {
    try {
      return new PortfwdStore(createElectronBackend());
    } catch {
      return new PortfwdStore(new MemoryBackend());
    }
  }

  /** Sanitised state for one host. Always returns a fresh, safe object. */
  read(hostKey: string): PortfwdState {
    const hosts = this.readHosts();
    return sanitiseState(hosts[hostKey]);
  }

  /** Every host key currently stored (for diagnostics/migration). */
  hostKeys(): string[] {
    return Object.keys(this.readHosts());
  }

  /**
   * Set (or, with a blank/null name, delete) the friendly name of a port.
   * Trimmed exactly like `set_port_name` (`forwarder.py:985-992`).
   */
  setName(hostKey: string, remotePort: number, name: string | null): void {
    this.mutate(hostKey, (state) => {
      const key = String(remotePort);
      const trimmed = name?.trim() ?? '';
      if (trimmed) state.names[key] = trimmed;
      else delete state.names[key];
    });
  }

  /** Pin a remote port to a specific local port. */
  setRemap(hostKey: string, remotePort: number, localPort: number): void {
    this.mutate(hostKey, (state) => {
      state.remaps[String(remotePort)] = localPort;
    });
  }

  /** Drop a pin, returning the port to mirror-then-allocate resolution. */
  clearRemap(hostKey: string, remotePort: number): void {
    this.mutate(hostKey, (state) => {
      delete state.remaps[String(remotePort)];
    });
  }

  /** Force a port on, off, or (with null) back to the automatic policy. */
  setIntent(hostKey: string, remotePort: number, intent: PortIntent | null): void {
    this.mutate(hostKey, (state) => {
      state.forceOn = state.forceOn.filter((p) => p !== remotePort);
      state.forceOff = state.forceOff.filter((p) => p !== remotePort);
      if (intent === 'force-on') state.forceOn.push(remotePort);
      if (intent === 'force-off') state.forceOff.push(remotePort);
    });
  }

  /** Remember whether the auto-forwarder was left running for this host. */
  setAutoEnabled(hostKey: string, enabled: boolean): void {
    this.mutate(hostKey, (state) => {
      state.autoEnabled = enabled;
    });
  }

  private readHosts(): Record<string, unknown> {
    let doc: unknown;
    try {
      doc = this.backend.read();
    } catch {
      return {};
    }
    if (!isRecord(doc)) return {};
    const hosts = doc.hosts;
    return isRecord(hosts) ? hosts : {};
  }

  /**
   * Read-modify-write the whole document. A host whose state is entirely
   * default afterwards is removed, so an abandoned host does not accumulate
   * an empty entry forever (`forwarder.py:1005`).
   */
  private mutate(hostKey: string, fn: (state: PortfwdState) => void): void {
    const rawHosts = this.readHosts();
    const hosts: Record<string, PortfwdState> = {};
    for (const [key, value] of Object.entries(rawHosts)) hosts[key] = sanitiseState(value);
    const state = hosts[hostKey] ?? sanitiseState(undefined);
    fn(state);
    if (isDefaultState(state)) delete hosts[hostKey];
    else hosts[hostKey] = state;
    try {
      this.backend.write({ hosts, version: 1 });
    } catch {
      // Persistence is a convenience; a read-only disk must not break
      // forwarding. The in-memory forwarder state is unaffected.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce anything at all into a valid {@link PortfwdState}. Never throws. */
export function sanitiseState(value: unknown): PortfwdState {
  const src = isRecord(value) ? value : {};

  const names: Record<string, string> = {};
  if (isRecord(src.names)) {
    for (const [key, raw] of Object.entries(src.names)) {
      if (!/^\d+$/.test(key)) continue; // non-numeric port key
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (trimmed) names[key] = trimmed; // empty names are dropped
    }
  }

  const remaps: Record<string, number> = {};
  if (isRecord(src.remaps)) {
    for (const [key, raw] of Object.entries(src.remaps)) {
      if (!/^\d+$/.test(key)) continue;
      const port = typeof raw === 'number' ? raw : Number.NaN;
      if (Number.isInteger(port) && port > 0 && port <= MAX_PORT) remaps[key] = port;
    }
  }

  return {
    names,
    remaps,
    forceOn: sanitisePortList(src.forceOn),
    forceOff: sanitisePortList(src.forceOff),
    autoEnabled: src.autoEnabled === true,
  };
}

function sanitisePortList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item > 0 && item <= MAX_PORT) {
      out.add(item);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function isDefaultState(state: PortfwdState): boolean {
  return (
    Object.keys(state.names).length === 0 &&
    Object.keys(state.remaps).length === 0 &&
    state.forceOn.length === 0 &&
    state.forceOff.length === 0 &&
    state.autoEnabled === false
  );
}
