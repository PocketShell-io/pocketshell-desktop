import { beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/main/log';
import { checkForUpdate } from '../../src/main/update/ReleaseChecker';
import { runBootstrap } from '../../src/main/helper/bootstrap';
import { MAX_IMAGE_READ_BYTES } from '../../src/main/attachments/LocalFileReader';
import { KnownHosts } from '../../src/main/ssh-config/KnownHosts';
import { APP_TITLE } from '../../src/shared/windowTitle';

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

// vi.hoisted: the electron mock factory below runs during import hoisting,
// before this module's own statements execute.
const { openExternal, showOpenDialog, showSaveDialog, fromWebContents } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: never[]) => void) => events.set(channel, fn),
  },
  dialog: { showSaveDialog, showOpenDialog },
  shell: { openExternal },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { fromWebContents },
}));

vi.mock('../../src/main/log', () => ({ log: vi.fn() }));
vi.mock('../../src/main/ssh-config/SshConfigParser', () => ({ readSshConfig: vi.fn(() => [{ name: 'hetzner' }]) }));
vi.mock('../../src/main/update/ReleaseChecker', () => ({ checkForUpdate: vi.fn(async () => ({ status: 'up-to-date' })) }));
vi.mock('../../src/main/helper/bootstrap', () => ({ runBootstrap: vi.fn(async () => ({ ok: true })) }));
// Real crypto would only slow these tests down, and the config writer would
// touch the real ~/.ssh/config — the cache tests replace both with canned
// answers and drive the handlers directly.
vi.mock('../../src/main/sync/SyncCrypto', () => ({
  decryptEnvelope: vi.fn(),
  encryptToEnvelope: vi.fn(),
  SyncCryptoError: class SyncCryptoError extends Error {},
}));
vi.mock('../../src/main/ssh-config/SshConfigWriter', () => ({
  applyHostsToConfig: vi.fn(() => ({ added: [] })),
}));

type Fakes = Record<string, ReturnType<typeof vi.fn>>;

function fakeService(): Fakes {
  const mocks = new Map<string, ReturnType<typeof vi.fn>>();
  const proxy = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === '__clearAll') {
          // beforeEach wipes call history; the registrar fakes live for the
          // whole file, so an assertion like "never called" is only honest
          // against a spy that was reset.
          return () => {
            for (const fn of mocks.values()) fn.mockClear();
          };
        }
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
const { registerSyncIpc } = await import('../../src/main/ipc/syncIpc');
const { decryptEnvelope, encryptToEnvelope } = await import('../../src/main/sync/SyncCrypto');

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
const syncAuth = fakeService();
const sync = fakeService();
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
  syncAuth: syncAuth as never,
  sync: sync as never,
  openAccountWindow: vi.fn(),
  getWindows,
  broadcast,
  tmuxClients: tmuxClients as never,
  attachments: attachments as never,
  localFiles: localFiles as never,
};

function mockOf(service: Fakes, name: string): ReturnType<typeof vi.fn> {
  return (service as unknown as { __mock(n: string): ReturnType<typeof vi.fn> }).__mock(name);
}

function clearServiceMocks(): void {
  for (const service of [ssh, helper, aplexer, sftp, forwards, projects, preview, tmuxClients, attachments, localFiles]) {
    (service as unknown as { __clearAll(): void }).__clearAll();
  }
}

beforeEach(() => {
  handlers.clear();
  events.clear();
  openExternal.mockClear();
  broadcast.mockClear();
  clearServiceMocks();
  registerAppIpc(ctx);
  registerTerminalIpc(ctx);
  registerHelperIpc(ctx);
  registerProjectsIpc(ctx);
  registerSftpIpc(ctx);
  registerPortsIpc(ctx);
  registerPreviewIpc(ctx);
  registerSyncIpc(ctx);
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
    // Plain keystrokes name no session, so the fence is not consulted — only
    // the refused invocation above ever asked.
    expect(mockOf(tmuxClients, 'isShowing')).toHaveBeenCalledTimes(1);
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

describe('terminalIpc — shell events cross the bridge as plain Uint8Array', () => {
  it('shell:open copies PTY bytes into a fresh view before broadcasting', async () => {
    let deliver: ((data: Buffer) => void) | undefined;
    mockOf(ssh, 'openTrackedShell').mockImplementation(
      async (_id: string, opts: { onData: (data: Buffer) => void }) => {
        deliver = opts.onData;
        return 'shell-9';
      },
    );

    const handler = handlers.get(ipc.shell.open)!;
    await (
      handler as (e: unknown, p: { connectionId: string }) => Promise<string>
    )({ connectionId: 'conn-1' }, { connectionId: 'conn-1' });
    expect(mockOf(ssh, 'openTrackedShell')).toHaveBeenCalled();

    const bytes = Buffer.from([1, 2, 3]);
    deliver!(bytes);
    expect(broadcast).toHaveBeenCalledWith(
      ipc.shell.data,
      expect.objectContaining({ shellId: 'shell-9' }),
    );
    const sent = broadcast.mock.calls.at(-1)![1] as { data: Uint8Array };
    expect(sent.data).toEqual(new Uint8Array([1, 2, 3]));
    // The structured clone must not be handed the ssh2 buffer's own backing
    // store — a detached view would blank the renderer's copy mid-read.
    expect(sent.data.buffer).not.toBe(bytes.buffer);
  });

  it('shell:attachSession forwards only the keys the payload carries', async () => {
    mockOf(tmuxClients, 'attach').mockResolvedValue({ shellId: 'shell-2', switched: false });

    const handler = handlers.get(ipc.shell.attachSession)!;
    await (
      handler as (
        e: unknown,
        p: { connectionId: string; sessionName: string; backend?: string; tag?: string },
      ) => Promise<unknown>
    )({}, { connectionId: 'conn-1', sessionName: 'git-demo', backend: 'aplexer', tag: 'demo' });

    expect(mockOf(tmuxClients, 'attach')).toHaveBeenCalledWith(
      'conn-1',
      'git-demo',
      expect.objectContaining({ backend: 'aplexer', tag: 'demo' }),
    );
    const opts = mockOf(tmuxClients, 'attach').mock.calls[0]![2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('workspace');
    expect(opts).not.toHaveProperty('aplexerId');
  });

  it('attachSession exit events broadcast under the shell they belong to', async () => {
    let exit: ((shellId: string, code: number) => void) | undefined;
    mockOf(tmuxClients, 'attach').mockImplementation(
      async (
        _id: string,
        _name: string,
        opts: { onExit: (shellId: string, code: number) => void },
      ) => {
        exit = opts.onExit;
        return { shellId: 'shell-3', switched: true };
      },
    );

    await (
      handlers.get(ipc.shell.attachSession)! as (e: unknown, p: unknown) => Promise<unknown>
    )({}, { connectionId: 'conn-1', sessionName: 'git-demo' });
    exit!('shell-3', 0);

    expect(broadcast).toHaveBeenCalledWith(ipc.shell.exited, { shellId: 'shell-3', exitCode: 0 });
  });
});

describe('previewIpc — release, staging defaults, the picker allow-list', () => {
  it('release ignores non-strings and releases real tokens', () => {
    // Registered with `on`: releasing is fire-and-forget on the way out of a file.
    const release = events.get(ipc.preview.release)! as (e: unknown, token: unknown) => void;
    release({}, 42);
    expect(mockOf(preview, 'release')).not.toHaveBeenCalled();
    release({}, 'tok-1');
    expect(mockOf(preview, 'release')).toHaveBeenCalledWith('tok-1');
  });

  it('openMarkdown coalesces an absent style into an empty object', async () => {
    mockOf(preview, 'openMarkdown').mockResolvedValue({ token: 't', url: 'psview://x' });
    const handler = handlers.get(ipc.preview.openMarkdown)!;
    await (
      handler as (e: unknown, id: string, p: string, style: unknown) => Promise<unknown>
    )({}, 'conn-1', '~/notes.md', null);
    expect(mockOf(preview, 'openMarkdown')).toHaveBeenCalledWith('conn-1', '~/notes.md', {});
  });

  it('stage treats missing sources as an empty batch', async () => {
    mockOf(attachments, 'stage').mockResolvedValue({ paths: [], errors: [] });
    const handler = handlers.get(ipc.attachments.stage)!;
    await (
      handler as (e: unknown, p: { connectionId: string; scopeKey: string }) => Promise<unknown>
    )({}, { connectionId: 'conn-1', scopeKey: 'host:tag' });
    expect(mockOf(attachments, 'stage')).toHaveBeenCalledWith('conn-1', 'host:tag', []);
  });

  it('pickFiles remembers what the dialog handed out, cancelled means empty', async () => {
    const handler = handlers.get(ipc.attachments.pickFiles)!;

    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(
      (handler as (e: unknown, p?: unknown) => Promise<string[]>)({}, {}),
    ).resolves.toEqual([]);
    expect(mockOf(localFiles, 'remember')).toHaveBeenCalledWith([]);

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/a.png'] });
    await (handler as (e: unknown, p?: unknown) => Promise<string[]>)({}, { multiple: false });
    expect(mockOf(localFiles, 'remember')).toHaveBeenCalledWith(['/tmp/a.png']);
  });
});

describe('projectsIpc — rename and kill move the pool with the host', () => {
  it('a successful rename moves the pooled client to the new name', async () => {
    mockOf(projects, 'renameSession').mockResolvedValue({ ok: true, sessionName: 'git-demo-2' });
    const handler = handlers.get(ipc.projects.renameSession)!;
    await (
      handler as (e: unknown, id: string, from: string, to: string) => Promise<unknown>
    )({}, 'conn-1', 'git-demo', 'git-demo-2');
    expect(mockOf(tmuxClients, 'renamed')).toHaveBeenCalledWith('conn-1', 'git-demo', 'git-demo-2', undefined);
  });

  it('a failed rename leaves the pool untouched', async () => {
    mockOf(projects, 'renameSession').mockResolvedValue({ ok: false, code: 'busy' });
    await (
      handlers.get(ipc.projects.renameSession)! as (e: unknown, id: string, f: string, t: string) => Promise<unknown>
    )({}, 'conn-1', 'a', 'b');
    expect(mockOf(tmuxClients, 'renamed')).not.toHaveBeenCalled();
  });

  it('a kill drops the pooled client even when the host says already-gone', async () => {
    const handler = handlers.get(ipc.projects.killSession)! as (
      e: unknown,
      id: string,
      name: string,
    ) => Promise<unknown>;

    mockOf(projects, 'killSession').mockResolvedValue({ ok: true });
    await handler({}, 'conn-1', 'gone');
    expect(mockOf(tmuxClients, 'killed')).toHaveBeenCalledWith('conn-1', 'gone', undefined);

    mockOf(projects, 'killSession').mockResolvedValue({ ok: false, code: 'not-found' });
    await handler({}, 'conn-1', 'gone');
    expect(mockOf(tmuxClients, 'killed')).toHaveBeenCalledTimes(2);

    mockOf(projects, 'killSession').mockResolvedValue({ ok: false, code: 'in-use' });
    await handler({}, 'conn-1', 'alive');
    expect(mockOf(tmuxClients, 'killed')).toHaveBeenCalledTimes(2);
  });

  it('reposList treats a missing request as an empty one', async () => {
    mockOf(projects, 'reposList').mockResolvedValue({ repos: [] });
    await (
      handlers.get(ipc.projects.reposList)! as (e: unknown, id: string, req?: unknown) => Promise<unknown>
    )({}, 'conn-1', undefined);
    expect(mockOf(projects, 'reposList')).toHaveBeenCalledWith('conn-1', {});
  });

  it('clone progress streams to every window under the clone channel', async () => {
    let push: ((p: unknown) => void) | undefined;
    mockOf(projects, 'cloneRepo').mockImplementation(
      async (_id: string, _req: unknown, onProgress: (p: unknown) => void) => {
        push = onProgress;
        return { ok: true };
      },
    );
    await (
      handlers.get(ipc.projects.reposClone)! as (e: unknown, id: string, req: unknown) => Promise<unknown>
    )({}, 'conn-1', { url: 'https://github.com/x/y' });
    push!({ phase: 'started' });
    expect(broadcast).toHaveBeenCalledWith(ipc.projects.cloneProgress, { phase: 'started' });
  });
});

describe('portsIpc — auto-forward defaults', () => {
  it('startAuto treats absent config forwards as none', async () => {
    const handler = handlers.get(ipc.forwards.startAuto)!;
    await expect(
      (handler as (e: unknown, id: string, f?: unknown) => Promise<boolean>)({}, 'conn-1', undefined),
    ).resolves.toBe(true);
    expect(mockOf(forwards, 'startAuto')).toHaveBeenCalledWith('conn-1', []);
  });
});

describe('sftpIpc — transfers, save-as, create defaults', () => {
  it('readBinary falls back to the image ceiling for an absent cap', async () => {
    const handler = handlers.get(ipc.sftp.readBinary)!;
    await (
      handler as (e: unknown, id: string, p: string, max?: number) => Promise<unknown>
    )({}, 'conn-1', '/home/u/a.png', undefined);
    expect(mockOf(sftp, 'readBinary')).toHaveBeenCalledWith('conn-1', '/home/u/a.png', MAX_IMAGE_READ_BYTES);
  });

  it('upload streams transfer progress under the caller-supplied id', async () => {
    let progress: ((p: unknown) => void) | undefined;
    mockOf(sftp, 'upload').mockImplementation(
      async (
        _id: string,
        _local: string,
        _remote: string,
        onProgress: (p: unknown) => void,
      ) => {
        progress = onProgress;
      },
    );

    const handler = handlers.get(ipc.sftp.upload)!;
    await (
      handler as (e: unknown, p: { connectionId: string; localPath: string; remotePath: string; transferId: string }) => Promise<boolean>
    )({}, { connectionId: 'conn-1', localPath: 'C:/a.png', remotePath: '/tmp/a.png', transferId: 'tr-1' });
    progress!({ bytesSoFar: 10, totalBytes: 100 });

    expect(broadcast).toHaveBeenCalledWith(ipc.sftp.progress, {
      transferId: 'tr-1',
      bytesSoFar: 10,
      totalBytes: 100,
    });
  });

  it('saveAs answers null on cancel and downloads to the chosen path otherwise', async () => {
    const handler = handlers.get(ipc.sftp.saveAs)! as (e: unknown, p: { connectionId: string; remotePath: string }) => Promise<string | null>;
    const payload = { connectionId: 'conn-1', remotePath: '/home/u/report.pdf' };

    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(handler({}, payload)).resolves.toBeNull();
    expect(mockOf(sftp, 'download')).not.toHaveBeenCalled();

    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:/dl/report.pdf' });
    await expect(handler({}, payload)).resolves.toBe('C:/dl/report.pdf');
    expect(mockOf(sftp, 'download')).toHaveBeenCalledWith('conn-1', '/home/u/report.pdf', 'C:/dl/report.pdf');
  });

  it('createFile writes an empty body when none is supplied', async () => {
    const handler = handlers.get(ipc.sftp.createFile)!;
    await (
      handler as (e: unknown, id: string, p: string, content?: string) => Promise<boolean>
    )({}, 'conn-1', '/home/u/new.txt', undefined);
    expect(mockOf(sftp, 'createFile')).toHaveBeenCalledWith('conn-1', '/home/u/new.txt', '');
  });
});

describe('helperIpc — create maps the outcome, not the error', () => {
  it('sessionsCreate answers with outcome.ok, and usage delegates', async () => {
    const create = handlers.get(ipc.helper.sessionsCreate)! as (
      e: unknown,
      id: string,
      name: string,
      cwd: string,
    ) => Promise<boolean>;

    mockOf(helper, 'createSession').mockResolvedValue({ ok: false, code: 'exists' });
    await expect(create({}, 'conn-1', 'dup', '~')).resolves.toBe(false);

    mockOf(helper, 'createSession').mockResolvedValue({ ok: true });
    await expect(create({}, 'conn-1', 'fresh', '~')).resolves.toBe(true);

    mockOf(helper, 'usage').mockResolvedValue([]);
    await expect(
      (handlers.get(ipc.helper.usage)! as (e: unknown, id: string) => Promise<unknown>)({}, 'conn-1'),
    ).resolves.toEqual([]);
    expect(mockOf(helper, 'usage')).toHaveBeenCalledWith('conn-1');
  });

  it('bootstrap delegates to the runner', async () => {
    await (
      handlers.get(ipc.helper.bootstrap)! as (e: unknown, id: string) => Promise<unknown>
    )({}, 'conn-1');
    expect(vi.mocked(runBootstrap)).toHaveBeenCalledWith(expect.anything(), 'conn-1');
  });
});

describe('appIpc — title validation and the update check', () => {
  it('setTitle applies a real title, falls back to APP_TITLE on blank, ignores dead windows', async () => {
    const setTitle = events.get(ipc.win.setTitle)! as (e: unknown, title: unknown) => void;
    const win = { isDestroyed: () => false, setTitle: vi.fn() };
    fromWebContents.mockReturnValue(win);

    setTitle({ sender: 'w' }, 'host: hetzner');
    expect(win.setTitle).toHaveBeenCalledWith('host: hetzner');

    setTitle({ sender: 'w' }, '   ');
    expect(win.setTitle).toHaveBeenLastCalledWith(APP_TITLE);

    fromWebContents.mockReturnValue(null);
    setTitle({ sender: 'w' }, 'no window');
    expect(win.setTitle).toHaveBeenCalledTimes(2);
  });

  it('diag:log merges stack into the detail and logs nothing when empty', async () => {
    const logMock = vi.mocked(log);
    const handler = events.get(ipc.diag.log)! as (
      e: unknown,
      entry: { kind: string; message: string; stack?: string; detail?: Record<string, unknown> },
    ) => void;

    handler({}, { kind: 'error', message: 'boom', stack: 'at x', detail: { alpha: 1 } });
    expect(logMock).toHaveBeenCalledWith('renderer', 'error: boom', { alpha: 1, stack: 'at x' });

    handler({}, { kind: 'info', message: 'fine' });
    expect(logMock).toHaveBeenLastCalledWith('renderer', 'info: fine', undefined);
  });

  it('update:check polls the Releases API with this app identity', async () => {
    await (handlers.get(ipc.update.check)! as () => Promise<unknown>)();
    expect(vi.mocked(checkForUpdate)).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: '0.0.0-test', platform: process.platform, arch: process.arch }),
    );
  });
});

describe('every remaining channel is wired to its service call', () => {
  // Passthrough handlers carry no policy of their own; what matters is that
  // the channel maps to the right service method with the right argument
  // shape — the preload's typed surface is only as honest as this table.
  const table: {
    channel: string;
    service: Fakes;
    method: string;
    args?: unknown[];
    result?: unknown;
  }[] = [
    // terminal / ssh
    { channel: ipc.ssh.exec, service: ssh, method: 'exec', args: ['conn-1', 'ls'], result: '' },
    { channel: ipc.ssh.close, service: ssh, method: 'close', args: ['conn-1'], result: true },
    { channel: ipc.shell.resize, service: ssh, method: 'shellResize', args: ['shell-1', 80, 24], result: true },
    // sftp
    { channel: ipc.sftp.list, service: sftp, method: 'list', args: ['conn-1', '~'], result: [] },
    { channel: ipc.sftp.stat, service: sftp, method: 'stat', args: ['conn-1', '~'], result: {} },
    { channel: ipc.sftp.readFile, service: sftp, method: 'readFile', args: ['conn-1', '~/a.txt'], result: 'x' },
    { channel: ipc.sftp.writeFile, service: sftp, method: 'writeFile', args: ['conn-1', '~/a.txt', 'x'], result: true },
    { channel: ipc.sftp.mkdir, service: sftp, method: 'mkdir', args: ['conn-1', '~/d'], result: true },
    { channel: ipc.sftp.rename, service: sftp, method: 'rename', args: ['conn-1', '~/a', '~/b'], result: true },
    { channel: ipc.sftp.deleteFile, service: sftp, method: 'deleteFile', args: ['conn-1', '~/a'], result: true },
    { channel: ipc.sftp.rmdir, service: sftp, method: 'rmdir', args: ['conn-1', '~/d'], result: true },
    { channel: ipc.sftp.realPath, service: sftp, method: 'realPath', args: ['conn-1', '~'], result: '/home/u' },
    // projects
    { channel: ipc.projects.home, service: projects, method: 'home', args: ['conn-1'], result: { home: '/home/u' } },
    { channel: ipc.projects.deriveName, service: projects, method: 'deriveSessionName', args: ['conn-1', '~/git/x', undefined], result: 'git-x' },
    { channel: ipc.projects.createFolder, service: projects, method: 'createFolder', args: ['conn-1', { parent: '~', name: 'n' }], result: { ok: true } },
    { channel: ipc.projects.startSession, service: projects, method: 'startSession', args: ['conn-1', { folder: '~/git/x' }], result: { ok: true } },
    { channel: ipc.agent.kinds, service: helper, method: 'agentSubcommands', args: ['conn-1'], result: [] },
    { channel: ipc.agent.profiles, service: helper, method: 'listProfiles', args: ['conn-1'], result: [] },
    { channel: ipc.agent.envList, service: helper, method: 'envList', args: ['conn-1', '~/p'], result: [] },
    { channel: ipc.agent.envGet, service: helper, method: 'envGet', args: ['conn-1', '~/p', ['A']], result: [] },
    { channel: ipc.agent.envSet, service: helper, method: 'envSet', args: ['conn-1', '~/p', { A: '1' }, undefined], result: true },
    // forwards
    { channel: ipc.forwards.scan, service: forwards, method: 'scan', args: ['conn-1'], result: [] },
    { channel: ipc.forwards.stopAuto, service: forwards, method: 'stopAuto', args: ['conn-1'], result: true },
    { channel: ipc.forwards.addManual, service: forwards, method: 'addManual', args: ['conn-1', { kind: 'L' }], result: true },
    { channel: ipc.forwards.remove, service: forwards, method: 'remove', args: ['conn-1', 'k'], result: true },
    { channel: ipc.forwards.list, service: forwards, method: 'list', args: ['conn-1'], result: [] },
    { channel: ipc.forwards.refresh, service: forwards, method: 'refresh', args: ['conn-1'], result: true },
    { channel: ipc.forwards.discovered, service: forwards, method: 'discovered', args: ['conn-1'], result: [] },
    { channel: ipc.forwards.status, service: forwards, method: 'status', args: ['conn-1'], result: null },
    { channel: ipc.forwards.setName, service: forwards, method: 'setName', args: ['conn-1', 3000, 'api'], result: true },
    { channel: ipc.forwards.setRemap, service: forwards, method: 'setRemap', args: ['conn-1', 3000, 3001], result: true },
    { channel: ipc.forwards.clearRemap, service: forwards, method: 'clearRemap', args: ['conn-1', 3000], result: true },
    { channel: ipc.forwards.setIntent, service: forwards, method: 'setIntent', args: ['conn-1', 3000, 'on'], result: true },
    { channel: ipc.forwards.togglePort, service: forwards, method: 'togglePort', args: ['conn-1', 3000], result: true },
    { channel: ipc.forwards.isAutoEnabled, service: forwards, method: 'isAutoEnabled', args: ['conn-1'], result: false },
  ];

  it.each(table)('$channel delegates to $method', async ({ channel, service, method, args = [], result }) => {
    mockOf(service, method).mockResolvedValue(result);
    const handler = handlers.get(channel)! as (e: unknown, ...a: unknown[]) => Promise<unknown>;
    expect(handler).toBeDefined();
    await expect(handler({}, ...args)).resolves.toEqual(result);
    expect(mockOf(service, method)).toHaveBeenCalledWith(...args);
  });

  it('ssh.connect passes the payload through with a fresh KnownHosts', async () => {
    mockOf(ssh, 'connect').mockResolvedValue({ ok: true });
    const payload = { host: 'h', user: 'u', tofuDecision: 'accept-once' as const };
    await expect(
      (handlers.get(ipc.ssh.connect)! as (e: unknown, p: unknown) => Promise<unknown>)({}, payload),
    ).resolves.toEqual({ ok: true });
    const call = mockOf(ssh, 'connect').mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toEqual(expect.objectContaining(payload));
    expect(call['knownHosts']).toBeInstanceOf(KnownHosts);
  });

  it('sftp.download reports progress under the caller-supplied transfer id', async () => {
    let progress: ((p: unknown) => void) | undefined;
    mockOf(sftp, 'download').mockImplementation(
      async (_id: string, _remote: string, _local: string, onProgress: (p: unknown) => void) => {
        progress = onProgress;
      },
    );
    await (
      handlers.get(ipc.sftp.download)! as (e: unknown, p: unknown) => Promise<boolean>
    )({}, { connectionId: 'c', remotePath: '/r', localPath: '/l', transferId: 't-9' });
    progress!({ bytesSoFar: 1, totalBytes: 2 });
    expect(broadcast).toHaveBeenCalledWith(ipc.sftp.progress, { transferId: 't-9', bytesSoFar: 1, totalBytes: 2 });
  });
});

describe('syncIpc — the session account-host cache', () => {
  // Module-level state in syncIpc.ts outlives a single test, so each test
  // establishes the cache contents it needs rather than assuming a fresh one.
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)! as (e: unknown, ...a: unknown[]) => Promise<unknown>;
    return handler({}, ...args);
  };
  const payloadWith = (name: string): string => JSON.stringify({ hosts: [{ name, hostname: `${name}.example` }] });

  it('answers null until some window has decrypted the account copy', async () => {
    // First handler query of the file: no pull or push has run yet.
    await expect(invoke(ipc.sync.accountHosts)).resolves.toBeNull();
  });

  it('a pull leaves the parsed copy readable without a passphrase', async () => {
    mockOf(sync, 'pull').mockResolvedValue({ slot: 'main', version: 3, data: 'envelope' });
    (decryptEnvelope as ReturnType<typeof vi.fn>).mockReturnValue(payloadWith('alpha'));

    await expect(invoke(ipc.sync.pull, 'main', 'passphrase')).resolves.toEqual({
      kind: 'ok',
      version: 3,
      plaintext: payloadWith('alpha'),
    });
    await expect(invoke(ipc.sync.accountHosts)).resolves.toEqual([
      { name: 'alpha', hostname: 'alpha.example' },
    ]);
  });

  it('an absent slot reads as an empty account, not "unknown"', async () => {
    mockOf(sync, 'pull').mockResolvedValue(null);
    await expect(invoke(ipc.sync.pull, 'main', 'passphrase')).resolves.toEqual({ kind: 'absent' });
    await expect(invoke(ipc.sync.accountHosts)).resolves.toEqual([]);
  });

  it('a successful push caches the set it just stored', async () => {
    mockOf(sync, 'push').mockResolvedValue({ version: 4 });
    (encryptToEnvelope as ReturnType<typeof vi.fn>).mockReturnValue('envelope');

    await expect(invoke(ipc.sync.push, 'main', payloadWith('beta'), 'passphrase', 3)).resolves.toEqual({
      kind: 'ok',
      version: 4,
    });
    await expect(invoke(ipc.sync.accountHosts)).resolves.toEqual([
      { name: 'beta', hostname: 'beta.example' },
    ]);
  });

  it('a failed push leaves the previous copy standing', async () => {
    mockOf(sync, 'pull').mockResolvedValue({ slot: 'main', version: 5, data: 'envelope' });
    (decryptEnvelope as ReturnType<typeof vi.fn>).mockReturnValue(payloadWith('alpha'));
    await invoke(ipc.sync.pull, 'main', 'passphrase');

    // The service signals failure by throwing, not by resolving an error shape.
    mockOf(sync, 'push').mockRejectedValue(new Error('denied'));
    await expect(invoke(ipc.sync.push, 'main', payloadWith('beta'), 'passphrase', 5)).resolves.toEqual({
      kind: 'error',
      message: 'denied',
    });
    await expect(invoke(ipc.sync.accountHosts)).resolves.toEqual([
      { name: 'alpha', hostname: 'alpha.example' },
    ]);
  });

  it('sign-out drops the copy along with the tokens', async () => {
    mockOf(sync, 'pull').mockResolvedValue({ slot: 'main', version: 6, data: 'envelope' });
    (decryptEnvelope as ReturnType<typeof vi.fn>).mockReturnValue(payloadWith('alpha'));
    await invoke(ipc.sync.pull, 'main', 'passphrase');

    await invoke(ipc.sync.logout);
    await expect(invoke(ipc.sync.accountHosts)).resolves.toBeNull();
    expect(mockOf(syncAuth, 'logout')).toHaveBeenCalled();
  });
});
