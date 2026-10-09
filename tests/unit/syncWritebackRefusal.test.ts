import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils as sshUtils } from 'ssh2';
import { transportRefusalMessage, type TransportRefusalReason } from '@pocketshell/core';

/**
 * desktop#8 round 2: Sync now must never turn a gateway- or link-marked
 * account host into an ordinary `~/.ssh/config` block — that block carries no
 * marker, so the `ssh:connect` refusal never sees it and the config row dials
 * plain SSH to the marked host's display-only hostname.
 *
 * Real `sync:applyHosts` (registerSyncIpc → core coerceHostEntries → the real
 * SshConfigWriter, pointed at a temp file) and the real `ssh:connect`
 * (registerTerminalIpc → SshService) against a local TCP listener. The
 * refusal text must be core's, the same words the tap refusal uses.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/pocketshell-owned-test' },
  ipcMain: { handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn), on: vi.fn() },
}));
vi.mock('../../src/main/ssh-config/KnownHosts', () => ({
  KnownHosts: class {
    verify() {
      return { trusted: false, mismatch: false };
    }
    add() {}
  },
}));
const { cfg } = vi.hoisted(() => ({ cfg: { path: '' } }));
vi.mock('../../src/main/ssh-config/SshConfigWriter', async (orig) => {
  const real = await orig<typeof import('../../src/main/ssh-config/SshConfigWriter')>();
  return { ...real, applyHostsToConfig: (_p: unknown, hosts: never) => real.applyHostsToConfig(cfg.path, hosts) };
});

// Capture every real ssh2 Client the service creates, so a control dial can
// be awaited to its LAST event ('close') before the test (and the listener)
// ends — nothing from the dial can land after teardown on any platform.
const { dialClients } = vi.hoisted(() => ({ dialClients: [] as import('ssh2').Client[] }));
vi.mock('../../src/main/ssh/ConnectionRegistry', async (orig) => {
  const real = await orig<typeof import('../../src/main/ssh/ConnectionRegistry')>();
  return {
    ...real,
    newClient: () => {
      const c = real.newClient();
      c.once('close', () => ((c as unknown as { psClosed: boolean }).psClosed = true));
      dialClients.push(c);
      return c;
    },
  };
});
/** Resolve when the dial's client has emitted 'close' (its last event). */
const dialClosed = (c: import('ssh2').Client): Promise<void> =>
  (c as unknown as { psClosed?: boolean }).psClosed ? Promise.resolve() : new Promise((r) => c.once('close', () => r()));
/** The listener accepts and drops the socket before any SSH ident: the dial fails pre-handshake. */
const PRE_HANDSHAKE = /^(Connection lost before handshake|Connection reset: )/;

const { ipc } = await import('../../src/shared/channels');
const { registerSyncIpc } = await import('../../src/main/ipc/syncIpc');
const { registerTerminalIpc } = await import('../../src/main/ipc/terminalIpc');
const { SshService } = await import('../../src/main/ssh/SshService');
const { parseSshConfigText } = await import('../../src/main/ssh-config/SshConfigParser');

const ssh = new SshService();
registerSyncIpc({} as never);
registerTerminalIpc({ ssh, broadcast: () => {}, tmuxClients: new Map() } as never);

type Call = (e: unknown, payload: unknown) => Promise<unknown>;
const applyHosts = (hosts: unknown): Promise<unknown> => (handlers.get(ipc.sync.applyHosts) as Call)({}, hosts);
const connect = (payload: unknown): Promise<unknown> => (handlers.get(ipc.ssh.connect) as Call)({}, payload);

let server: Server;
let port = 0;
let accepted = 0;
let keyPath = '';
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'desktop8-writeback-'));
  keyPath = join(dir, 'id_ed25519');
  writeFileSync(keyPath, sshUtils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
  server = createServer((s) => {
    accepted++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  accepted = 0;
  cfg.path = join(dir, `config-${Math.random().toString(36).slice(2)}`);
});

function accountHost(markers: Record<string, unknown>): Record<string, unknown> {
  return { name: 'nat-box', hostname: '127.0.0.1', port, user: 'me', identityFile: keyPath, ...markers };
}

const configText = (): string => (existsSync(cfg.path) ? readFileSync(cfg.path, 'utf8') : '');

/** Tap the config row for `name` exactly as the shared store sends it (no marker). */
async function tapConfigRow(name: string): Promise<unknown> {
  const row = parseSshConfigText(configText()).find((h) => h.name === name);
  if (row === undefined) return null;
  const res = await connect({
    host: row.hostname,
    port: row.port,
    user: row.user,
    privateKeyPath: row.identityFile ?? undefined,
    hostAlias: row.name,
    timeoutMs: 1500,
  });
  return res;
}

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-123' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };

const MARKED: Array<[string, Record<string, unknown>, TransportRefusalReason, string]> = [
  ['valid link', { link: VALID_LINK }, 'link-unsupported', transportRefusalMessage('link-unsupported', null)],
  ['null link', { link: null }, 'link-unsupported', transportRefusalMessage('link-unsupported', null)],
  ['malformed link', { link: 'wss://relay' }, 'link-unsupported', transportRefusalMessage('link-unsupported', null)],
  ['valid gateway', { gateway: VALID_GATEWAY }, 'gateway-unsupported', 'Enroll this gateway host and its trusted SSH fingerprint on this Desktop first.'],
  ['null gateway', { gateway: null }, 'gateway-unsupported', transportRefusalMessage('gateway-invalid', null)],
  ['malformed gateway', { gateway: 'wss://surprise' }, 'gateway-unsupported', transportRefusalMessage('gateway-invalid', null)],
  ['link + gateway', { link: VALID_LINK, gateway: VALID_GATEWAY }, 'gateway-unsupported', transportRefusalMessage('link-and-gateway', null)],
];

describe('desktop#8: Sync now never writes a transport-marked host as a plain config block', () => {
  it.each(MARKED)('%s: refused with core\'s text, nothing written, no socket', async (_l, markers, reason, dialMessage) => {
    const ordinary = { name: 'plain-box', hostname: '127.0.0.1', port, user: 'me', identityFile: keyPath };
    await expect(applyHosts([ordinary, accountHost(markers)])).rejects.toThrow(
      new Error(transportRefusalMessage(reason, 'nat-box')),
    );
    // The batch is refused whole: no Host block for either entry.
    expect(configText()).not.toMatch(/^Host /m);
    // No config row exists to tap, so nothing can dial it…
    expect(await tapConfigRow('nat-box')).toBeNull();
    // …and the account row still refuses before a socket: this native-enabled
    // build validates/enrolls gateway targets, while config can encode neither transport.
    const tap = await connect({ host: '127.0.0.1', port, user: 'me', privateKeyPath: keyPath, ...markers });
    await new Promise((r) => setTimeout(r, 300));
    expect(tap).toEqual({ ok: false, error: dialMessage });
    expect(accepted).toBe(0);
  });

  it('control: an ordinary account host IS written, and its config row dials', async () => {
    await expect(applyHosts([accountHost({})])).resolves.toEqual({ added: ['nat-box'] });
    expect(configText()).toMatch(/^Host nat-box$/m);
    dialClients.length = 0;
    const res = (await tapConfigRow('nat-box')) as { ok: boolean; error?: string };
    // Observe the dial to its end: a pre-handshake failure (the listener
    // drops the socket) and a closed client, before the listener goes away.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(PRE_HANDSHAKE);
    expect(dialClients).toHaveLength(1);
    await dialClosed(dialClients[0]!);
    expect(accepted).toBe(1);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
