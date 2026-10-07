import type { ClientChannel } from 'ssh2';
import type { ShellId } from '@pocketshell/core';

/**
 * Tracks live PTY shell channels by id, so the renderer can address a shell
 * across separate IPC calls (open -> input -> resize -> close) without ever
 * holding the channel itself.
 *
 * The main process owns the lifecycle; the renderer only sees {@link ShellId}s
 * and byte streams arriving over the `shell:event:data` IPC channel.
 */

/**
 * The slice of a PTY channel this app drives. Both transports satisfy it
 * structurally: an ssh2 `ClientChannel` (remote) and the node-pty adapter
 * (`local/LocalHost`, this machine). 'close' carries the exit code when the
 * transport knows one.
 */
export interface ShellChannel {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'close', listener: (exitCode?: number) => void): unknown;
  write(data: string | Buffer): unknown;
  /** Resize the PTY. Argument order follows ssh2: rows first, pixel size after. */
  setWindow(rows: number, cols: number, height: number, width: number): unknown;
  end(): void;
  close(): void;
}

// An ssh2 channel IS a ShellChannel; keep the type honest without renaming
// every existing use.
export type SshShellChannel = ClientChannel;

export interface ShellRecord {
  id: ShellId;
  channel: ShellChannel;
  /** Connection this shell belongs to, for cleanup on disconnect. */
  connectionId: string;
}

let counter = 0;

export class ShellTracker {
  private readonly map = new Map<ShellId, ShellRecord>();

  register(rec: Omit<ShellRecord, 'id'>): ShellId {
    const id = `shell-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    this.map.set(id, { ...rec, id });
    return id;
  }

  get(id: ShellId): ShellRecord | undefined {
    return this.map.get(id);
  }

  /** Remove and return a shell record (does NOT close the channel). */
  remove(id: ShellId): ShellRecord | undefined {
    const rec = this.map.get(id);
    this.map.delete(id);
    return rec;
  }

  /** Close + remove every shell belonging to a connection (used on disconnect). */
  closeAllForConnection(connectionId: string): void {
    for (const [id, rec] of this.map) {
      if (rec.connectionId === connectionId) {
        try {
          rec.channel.end();
          rec.channel.close();
        } catch {
          // ignore
        }
        this.map.delete(id);
      }
    }
  }

}
