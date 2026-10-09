// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { utils as sshUtils } from 'ssh2';
import { transportRefusalMessage, type HostEntry } from '@pocketshell/core';

/**
 * desktop#8: a gateway- or link-marked account host must never be dialled as
 * plain SSH to its display hostname.
 *
 * End to end on the real path: the shared HostPickerView (core packages/ui)
 * lists one account-only host, a click goes through the shared connection
 * store, the payload crosses the "IPC" into the REAL `ssh:connect` handler
 * registered by `registerTerminalIpc`, backed by a REAL `SshService`. The
 * host's hostname:port is a local TCP listener, so a downgrade is observable
 * as an accepted socket. Only electron's ipcMain, KnownHosts (never touch the
 * real ~/.ssh/known_hosts) and the ssh-config reader are stubbed.
 *
 * The unmarked control host proves the listener and key path are live: the
 * same setup without a marker DOES open a socket, so "0 sockets" for the
 * marked shapes is a refusal, not a broken fixture.
 */

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/pocketshell-owned-test' },
  ipcMain: {
    handle: (c: string, fn: (...a: unknown[]) => unknown) => handlers.set(c, fn),
    on: vi.fn(),
  },
}));
const { knownHostsBuilt } = vi.hoisted(() => ({ knownHostsBuilt: { count: 0 } }));
vi.mock('../../src/main/ssh-config/KnownHosts', () => ({
  KnownHosts: class {
    constructor() {
      knownHostsBuilt.count++;
    }
    verify() {
      return { trusted: false, mismatch: false };
    }
    add() {}
  },
}));
vi.mock('../../src/main/ssh-config/SshConfigParser', () => ({ readSshConfig: vi.fn(() => []) }));

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
const { registerTerminalIpc } = await import('../../src/main/ipc/terminalIpc');
const { SshService } = await import('../../src/main/ssh/SshService');

const ssh = new SshService();
const sshConnect = vi.spyOn(ssh, 'connect');
registerTerminalIpc({ ssh, broadcast: () => {}, tmuxClients: new Map() } as never);

const payloads: Record<string, unknown>[] = [];
let accountHosts: HostEntry[] = [];
const overrides: Record<string, unknown> = {
  'ssh.connect': async (payload: Record<string, unknown>) => {
    payloads.push(payload);
    // Exactly what preload's ipcRenderer.invoke(ipc.ssh.connect, payload) does.
    return handlers.get(ipc.ssh.connect)!({}, { ...payload, timeoutMs: 1500 });
  },
  'ssh.listConfigHosts': async () => [],
  'sync.status': async () => ({ loggedIn: true, email: 'me@example.com', keychainAvailable: true }),
  'sync.accountHosts': async () => accountHosts,
  hosts: { groupLabel: 'From ~/.ssh/config', sourceName: '~/.ssh/config', emptyHint: '' },
};
const channel = (g: string) =>
  new Proxy({}, { get: (_t, k: string) => overrides[`${g}.${k}`] ?? (async () => undefined) });
vi.mock('@ui/app/ipc', () => ({
  api: new Proxy({}, { get: (_t, k: string) => overrides[k] ?? channel(k) }),
}));
const HostPickerView = (await import('@ui/app/views/HostPickerView.vue')).default;

let keyPath = '';
let server: Server;
let port = 0;
let accepted = 0;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop8-'));
  keyPath = join(dir, 'id_ed25519');
  const pair = sshUtils.generateKeyPairSync('ed25519');
  writeFileSync(keyPath, pair.private, { mode: 0o600 });
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
  setActivePinia(createPinia());
  window.localStorage.clear();
  payloads.length = 0;
  accepted = 0;
  knownHostsBuilt.count = 0;
  sshConnect.mockClear();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function accountHost(markers: Record<string, unknown>): HostEntry {
  // Markers ride as raw parsed JSON (any value), exactly as sync delivers them.
  const entry: Record<string, unknown> = {
    name: 'gw-box',
    hostname: '127.0.0.1',
    port,
    user: 'me',
    identityFile: keyPath,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    ...markers,
  };
  return entry as unknown as HostEntry;
}

/** Tap the one account row; returns the error lines the picker shows. */
async function tapAccountHost(markers: Record<string, unknown>) {
  accountHosts = [accountHost(markers)];
  const w = mount(HostPickerView, { global: { stubs: { OverlayPanel: true, SettingsView: true } } });
  for (let i = 0; i < 5; i++) await flush();
  const groups = w.findAll('.group-label').map((g) => g.text());
  const rows = w.findAll('.host-list .host-row');
  expect(groups).toContain('From your account');
  expect(rows).toHaveLength(1);
  await rows[0]!.trigger('click');
  // Give a dial every chance to reach the listener before counting.
  for (let i = 0; i < 50 && accepted === 0 && payloads.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 5; i++) await flush();
  const errors = w.findAll('p.error').map((e) => e.text());
  w.unmount();
  return { errors };
}

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-123' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };

const REFUSED: Array<[string, Record<string, unknown>, string]> = [
  ['unenrolled gateway', { gateway: VALID_GATEWAY }, 'Enroll this gateway host and its trusted SSH fingerprint on this Desktop first.'],
  ['null gateway', { gateway: null }, transportRefusalMessage('gateway-invalid', null)],
  ['malformed gateway', { gateway: 'wss://surprise' }, transportRefusalMessage('gateway-invalid', null)],
  ['link + gateway', { link: VALID_LINK, gateway: VALID_GATEWAY }, transportRefusalMessage('link-and-gateway', null)],
  ['link alone', { link: VALID_LINK }, transportRefusalMessage('link-unsupported', null)],
];

describe('desktop#8: the ssh:connect boundary refuses invalid/unenrolled gateway and link hosts', () => {
  it.each(REFUSED)('%s: picker tap opens zero sockets and shows core\'s refusal', async (_label, markers, message) => {
    const { errors } = await tapAccountHost(markers);
    // The shared store forwarded the marker verbatim…
    expect(payloads).toHaveLength(1);
    for (const key of Object.keys(markers)) {
      expect(Object.prototype.hasOwnProperty.call(payloads[0], key)).toBe(true);
    }
    // …and main refused before known_hosts, key load or socket.
    expect(accepted).toBe(0);
    expect(sshConnect).not.toHaveBeenCalled();
    expect(knownHostsBuilt.count).toBe(0);
    expect(errors).toContain(message);
  });

  it('control: the same unmarked account host DOES dial (the listener is live)', async () => {
    dialClients.length = 0;
    await tapAccountHost({});
    expect(payloads).toHaveLength(1);
    expect(sshConnect).toHaveBeenCalledTimes(1);
    // Observe the dial to its end: the connect resolves with the pre-handshake
    // failure (the listener drops the socket), and the client has closed.
    const res = await (sshConnect.mock.results[0]!.value as Promise<{ ok: boolean; error?: string }>);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(PRE_HANDSHAKE);
    expect(dialClients).toHaveLength(1);
    await dialClosed(dialClients[0]!);
    expect(accepted).toBe(1);
  });
});
