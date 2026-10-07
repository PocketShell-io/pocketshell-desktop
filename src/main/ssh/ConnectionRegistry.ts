import { Client } from 'ssh2';
import type { KnownHosts } from '../ssh-config/KnownHosts.js';

/**
 * In-memory registry of live connections, keyed by an opaque id.
 *
 * The renderer only ever sees {@link ConnectionId}s; it never touches a
 * `Client`. The main process owns the lifecycle (connect / reconnect /
 * close) and resolves ids back to clients here.
 *
 * A record is an SSH dial (`kind: 'ssh'`, an ssh2 client) or the platform's
 * own machine (`kind: 'local'`, no client — exec and shells run in-process;
 * see `local/LocalHost`). Everything downstream keys off `kind` where the
 * transport itself matters and reads the shared identity fields otherwise.
 */

/** Which transport a connection rides. */
export type ConnectionKind = 'ssh' | 'local';

interface ConnectionIdentity {
  /** Display label for logs/UI, e.g. "testuser@host:2222". */
  label: string;
  host: string;
  port: number;
  user: string;
  /**
   * The `~/.ssh/config` `Host` alias this connection was opened under, when
   * there is one (`HostEntry.name`). Absent for a manually-entered host.
   *
   * Load-bearing for port-forward persistence: `hostKeyFor` (PortfwdStore)
   * keys the saved names/remaps/intents on the alias, so they follow the
   * alias rather than the IP the alias currently resolves to.
   */
  hostAlias?: string;
  knownHosts: KnownHosts | null;
  /** Epoch ms the connection became ready. */
  connectedAt: number;
}

export interface SshConnectionRecord extends ConnectionIdentity {
  kind: 'ssh';
  client: Client;
}

export interface LocalConnectionRecord extends ConnectionIdentity {
  kind: 'local';
}

export type ConnectionRecord = SshConnectionRecord | LocalConnectionRecord;

/** True when [rec] rides the ssh2 transport; narrows for `.client` access. */
export function isSshRecord(rec: ConnectionRecord): rec is SshConnectionRecord {
  return rec.kind === 'ssh';
}

let counter = 0;

/** `Omit` distributes here: a fresh record literal matches its own variant. */
type NewRecord<T> = T extends unknown ? Omit<T, 'id'> : never;

export class ConnectionRegistry {
  private readonly map = new Map<string, ConnectionRecord>();

  register(rec: NewRecord<ConnectionRecord>): string {
    const id = `conn-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    this.map.set(id, { ...rec, id } as unknown as ConnectionRecord);
    return id;
  }

  get(id: string): ConnectionRecord | undefined {
    return this.map.get(id);
  }

  /** Require a connection or throw a typed error (never returns undefined). */
  require(id: string): ConnectionRecord {
    const rec = this.map.get(id);
    if (!rec) throw new UnknownConnectionError(id);
    return rec;
  }

  remove(id: string): ConnectionRecord | undefined {
    const rec = this.map.get(id);
    this.map.delete(id);
    return rec;
  }

  clear(): void {
    for (const rec of this.map.values()) {
      if (isSshRecord(rec)) {
        try {
          rec.client.end();
        } catch {
          // ignore
        }
      }
    }
    this.map.clear();
  }
}

export class UnknownConnectionError extends Error {
  constructor(id: string) {
    super(`Unknown connection: ${id}`);
    this.name = 'UnknownConnectionError';
  }
}

export function newClient(): Client {
  return new Client();
}
