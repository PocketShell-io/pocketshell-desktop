import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The main-process boundary, driven the way the renderer drives it.
 *
 * Each registrar under `src/main/ipc/` registers its handlers into ipcMain;
 * the mock below captures those registrations so a test can INVOKE a handler
 * directly and assert the policy it enforces — the composer's session fence,
 * the SFTP read ceiling, the update URL allow-list — rather than re-asserting
 * the delegation the preload walker already covers from the other side.
 *
 * Services in the IpcContext are fakes whose every method is a fresh vi.fn
 * (a Proxy, so no signature has to be spelled), and `__mock(name)` hands a
 * test the spy to assert against.
 */

const handlers = new Map<string, (...args: never[]) => unknown>();
const events = new Map<string, (...args: never[]) => void>();
const openExternal = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => void) => events.set(channel, fn),
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openExternal },
}));

vi.mock('../../src/main/log', () => ({ log: vi.fn() }));
vi.mock('../../src/main/ssh-config/SshConfigParser', () => ({ readSshConfig: vi.fn(() => [{ name: 'hetzner' }]) }));
vi.mock('../../src/main/update/ReleaseChecker', () => ({ checkForUpdate: vi.fn(async () => ({ status: 'up-to-date' })) }));

type Fakes = Record<string, ReturnType<typeof vi.fn>>;

function fakeService(): Fakes {
  const mocks = new Map<string, ReturnType<typeof vi.fn>>();
  const proxy = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === '__mock') {
          // Creating on demand: a test arms a method before the handler ever
          // touched it, and both paths must land on the SAME spy.
          return (name: string) => {
            if (!mocks.has(name)) mocks.set(name, vi.fn());
            return mocks.get(name);
          };
        }
        if (!mocks.has(prop)) mocks.set(prop, vi.fn());
        return mocks.get(prop);
      },
    },
  );
  return proxy;
}

const { ipc } = await import('../../src/shared/channels');
const { registerAppIpc } = await import('../../src/main/ipc/appIpc');
const { registerTerminalIpc } = await import('../../src/main/ipc/terminalIpc');
const { registerHelperIpc } = await import('../../src/main/ipc/helperIpc');
const { registerProjectsIpc } = await import('../../src/main/ipc/projectsIpc');
const { registerSftpIpc } = await import('../../src/main/ipc/sftpIpc');
const { registerPortsIpc } = await import('../../src/main/ipc/portsIpc');
const { registerPreviewIpc } = await import('../../src/main/ipc/previewIpc');

const ssh = fakeService();
const helper = fakeService();
const aplexer = fakeService();
const sftp = fakeService();
const forwards = fakeService();
const projects = fakeService();
const preview = fakeService();
const tmuxClients = fakeService();
const attachments = fakeService();
const localFiles = fakeService();
const getWindows = vi.fn(() => []);
const broadcast = vi.fn();

const ctx = {
  ssh: ssh as never,
  helper: helper as never,
  aplexer: aplexer as never,
  sftp: sftp as never,
  forwards: forwards as never,
  projects: projects as never,
  preview: preview as never,
  getWindows,
  broadcast,
  tmuxClients: tmuxClients as never,
  attachments: attachments as never,
  localFiles: localFiles as never,
};

function mockOf(service: Fakes, name: string): ReturnType<typeof vi.fn> {
  return (service as unknown as { __mock(n: string): ReturnType<typeof vi.fn> }).__mock(name);
}

beforeEach(() => {
  handlers.clear();
  events.clear();
  openExternal.mockClear();
  broadcast.mockClear();
  registerAppIpc(ctx);
  registerTerminalIpc(ctx);
  registerHelperIpc(ctx);
  registerProjectsIpc(ctx);
  registerSftpIpc(ctx);
  registerPortsIpc(ctx);
  registerPreviewIpc(ctx);
});

describe('terminalIpc — the composer session fence', () => {
  it('refuses input for a shell that is not showing the session it names', async () => {
    mockOf(tmuxClients, 'isShowing').mockReturnValue(false);
    const handler = handlers.get(ipc.shell.input)!;

    const ok = await (handler as (evt: unknown, id: string, data: string, name?: string) => Promise<boolean>)(
      {},
      'shell-1',
      'rm -rf /',
      'git-other',
    );

    expect(ok).toBe(false);
    expect(mockOf(ssh, 'shellInput')).not.toHaveBeenCalled();
  });

  it('delivers when the fence agrees, and passes plain keystrokes straight through', async () => {
    mockOf(tmuxClients, 'isShowing').mockReturnValue(true);
    mockOf(ssh, 'shellInput').mockResolvedValue(true);
    const handler = handlers.get(ipc.shell.input)!;

    await expect(
      (handler as (e: unknown, id: string, data: string, name?: string) => Promise<boolean>)({}, 'shell-1', 'ls', 'git-x'),
    ).resolves.toBe(true);
    expect(mockOf(ssh, 'shellInput')).toHaveBeenCalledWith('shell-1', 'ls');

    await (handler as (e: unknown, id: string, data: string) => Promise<boolean>)({}, 'shell-1', 'ls');
    // Both invocations consulted the fence — the refused one and this one.
    expect(mockOf(tmuxClients, 'isShowing')).toHaveBeenCalledTimes(2);
  });

  it('close disposes the shell and answers true', async () => {
    const handler = handlers.get(ipc.shell.close)!;
    await expect((handler as (e: unknown, id: string) => Promise<boolean>)({}, 'shell-1')).resolves.toBe(true);
    expect(mockOf(ssh, 'shellClose')).toHaveBeenCalledWith('shell-1');
  });

  it('listConfigHosts reads ~/.ssh/config', async () => {
    const handler = handlers.get(ipc.ssh.listConfigHosts)!;
    await expect((handler as () => Promise<unknown>)()).resolves.toEqual([{ name: 'hetzner' }]);
  });
});

describe('appIpc — the update URL allow-list', () => {
  it('opens this repo release URLs only', async () => {
    const open = handlers.get(ipc.update.open)!;
    await (open as (e: unknown, url: string) => Promise<unknown>)(
      {},
      'https://github.com/alexeygrigorev/pocketshell-desktop/releases/download/v0.1.2/x.exe',
    );
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('refuses everything else without opening a browser', async () => {
    const open = handlers.get(ipc.update.open)!;
    for (const url of [
      'https://evil.example/payload.exe',
      'http://github.com/alexeygrigorev/pocketshell-desktop/releases/x',
      'https://github.com/alexeygrigorev/other-repo/releases/download/v1/x',
    ]) {
      await (open as (e: unknown, url: string) => Promise<unknown>)({}, url);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('diag:log is fire-and-forget (registered with `on`, not `handle`)', () => {
    expect(handlers.has(ipc.diag.log)).toBe(false);
    expect(events.has(ipc.diag.log)).toBe(true);
  });
});

describe('sftpIpc — the hard read ceiling', () => {
  it('caps readBinary at 128 MiB whatever the renderer asks for', async () => {
    const handler = handlers.get(ipc.sftp.readBinary)!;
    await (handler as (e: unknown, id: string, p: string, max: number) => Promise<unknown>)(
      {},
      'conn-1',
      '/home/u/video.mp4',
      512 * 1024 * 1024,
    );
    expect(mockOf(sftp, 'readBinary')).toHaveBeenCalledWith(
      'conn-1',
      '/home/u/video.mp4',
      128 * 1024 * 1024,
    );
  });

  it('honours a smaller caller-supplied cap', async () => {
    const handler = handlers.get(ipc.sftp.readBinary)!;
    await (handler as (e: unknown, id: string, p: string, max: number) => Promise<unknown>)(
      {},
      'conn-1',
      '/home/u/a.png',
      32 * 1024 * 1024,
    );
    expect(mockOf(sftp, 'readBinary')).toHaveBeenCalledWith('conn-1', '/home/u/a.png', 32 * 1024 * 1024);
  });
});

describe('delegations the renderer depends on', () => {
  it('helper sessionsList and projects.start forward verbatim', async () => {
    mockOf(helper, 'listSessions').mockResolvedValue([]);
    mockOf(projects, 'startSession').mockResolvedValue({ ok: true });

    const list = handlers.get(ipc.helper.sessionsList)!;
    await (list as (e: unknown, id: string, sort: string) => Promise<unknown>)({}, 'conn-1', 'activity');
    expect(mockOf(helper, 'listSessions')).toHaveBeenCalledWith('conn-1', 'activity');

    const start = handlers.get(ipc.projects.startSession)!;
    const request = { folder: '~/git/demo' };
    await (start as (e: unknown, id: string, req: unknown) => Promise<unknown>)({}, 'conn-1', request);
    expect(mockOf(projects, 'startSession')).toHaveBeenCalledWith('conn-1', request);
  });

  it('shell redraw and windowSize ride the tmux client pool', async () => {
    mockOf(tmuxClients, 'redraw').mockResolvedValue(true);
    mockOf(tmuxClients, 'windowSize').mockResolvedValue({ kind: 'bare' });

    const redraw = handlers.get(ipc.shell.redraw)!;
    await (redraw as (e: unknown, id: string) => Promise<boolean>)({}, 'shell-1');
    expect(mockOf(tmuxClients, 'redraw')).toHaveBeenCalledWith('shell-1');

    const windowSize = handlers.get(ipc.shell.windowSize)!;
    await (windowSize as (e: unknown, id: string) => Promise<unknown>)({}, 'shell-1');
    expect(mockOf(tmuxClients, 'windowSize')).toHaveBeenCalledWith('shell-1');
  });
});
