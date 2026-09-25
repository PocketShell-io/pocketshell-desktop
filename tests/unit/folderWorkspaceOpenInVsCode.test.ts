// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

/**
 * The bar's VS Code button, against a folder key the deep link cannot carry
 * as-is: a `~/`-spelled one. Expanding it needs the remote `$HOME`, and the
 * ref the handler used to read is only as good as the last mount-time
 * resolution — which can still be in flight or have failed once (the store
 * does not cache failures). What this file pins is the contract that came
 * out of the report "no absolute path for ~/tmp/rasa" fired at a user whose
 * folder was perfectly openable:
 *
 *  - a click resolves `$HOME` itself when the ref cannot expand the path,
 *    and the link then carries the expanded folder;
 *  - a resolution that failed ONCE does not poison the next click — the
 *    store's failures are uncached by contract, and the click is a next
 *    caller;
 *  - only a `$HOME` that still will not resolve (or a path no link can
 *    carry) refuses, and the strip says WHICH of the two it was.
 */

const route = ref({ params: { name: 'host', folder: '~/tmp/rasa' }, query: {} });

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const openVsCode = vi.fn().mockResolvedValue(true);

const overrides: Record<string, unknown> = {
  'helper.usage': vi.fn().mockResolvedValue([]),
  'helper.sessionsList': vi.fn().mockResolvedValue([]),
  'agent.profiles': vi.fn().mockResolvedValue([]),
  'ssh.listConfigHosts': vi.fn().mockResolvedValue([]),
  'projects.killSession': vi.fn().mockResolvedValue({ ok: true }),
  'editors.openVsCode': openVsCode,
  'preview.onStats': () => () => undefined,
};

/** Api groups the CURRENT test pretends the platform does not provide —
 * the seam's optional capabilities, omitted the way the web omits them. */
const omittedGroups = new Set<string>();

/** The `$HOME` RPC, replaced per-test: some cases need to fail first. */
let homeRpc: ReturnType<typeof vi.fn>;

function channel(group: string): unknown {
  if (omittedGroups.has(group)) return undefined;
  return new Proxy(
    {},
    {
      get: (_t, key: string) =>
        overrides[`${group}.${key}`] ?? ((): Promise<unknown> => Promise.resolve(undefined)),
    },
  );
}

vi.mock('@ui/app/ipc', () => ({
  api: new Proxy({}, { get: (_t, key: string) => channel(key) }),
}));

const FolderWorkspaceView = (await import('@ui/app/views/FolderWorkspaceView.vue'))
  .default;
const { useConnectionStore } = await import('@ui/app/stores/connection');
const { useSessionsStore } = await import('@ui/app/stores/sessions');
const { useProjectsStore } = await import('@ui/app/stores/projects');
const { diagErrors } = await import('@ui/app/diag');

const stubs = {
  TerminalView: { template: '<div class="stub-terminal" />', methods: { focus: () => undefined } },
  PromptComposer: { template: '<div class="stub-composer" />' },
  FilesView: { template: '<div class="stub-files" />' },
  OverlayPanel: { template: '<div class="stub-overlay"><slot /></div>' },
  PopupMenu: { template: '<div><slot /></div>' },
  LaunchSessionDialog: { template: '<div />' },
};

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function openWorkspace(): Promise<VueWrapper> {
  const wrapper = mount(FolderWorkspaceView, { global: { stubs } });
  await flush();
  return wrapper;
}

/** The VS Code button is the bar's far-right corner hook, outside the strip. */
function codeButton(wrapper: VueWrapper): ReturnType<VueWrapper['find']> {
  return wrapper.find('.tab.vscode-open');
}

const HOST = {
  name: 'hetzner',
  hostname: '135.181.114.209',
  port: 22,
  user: 'alexey',
  identityFile: null,
  proxyJump: null,
  forwardAgent: false,
  localForwards: [],
  remoteForwards: [],
  fromConfig: true,
} as never;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  diagErrors.value = [];
  omittedGroups.clear();
  homeRpc = vi.fn().mockResolvedValue({ ok: true, home: '/home/alexey', error: null });
  overrides['projects.home'] = homeRpc;
  openVsCode.mockClear();
  useConnectionStore().connectionId = 'conn-1';
  useConnectionStore().activeHost = HOST;
  useProjectsStore().home = null;
  useSessionsStore().sessions = [
    { name: 'rasa', created: 1, activity: 1, attached: false, path: '/home/alexey/tmp/rasa' },
  ] as never;
});

describe('Open in VS Code on a tilde-spelled folder', () => {
  it('expands the folder against a $HOME resolved on the click', async () => {
    // The ref starts null — the mount-time call is parked on the mock's
    // unresolved promise, so the click is the caller that must resolve it.
    let resolveHomeRpc: (r: unknown) => void = () => undefined;
    homeRpc.mockImplementation(
      () => new Promise((res) => { resolveHomeRpc = res; }),
    );
    const wrapper = await openWorkspace();
    expect(useProjectsStore().home).toBeNull();

    await codeButton(wrapper).trigger('click');
    await flush(2);
    resolveHomeRpc({ ok: true, home: '/home/alexey', error: null });
    await flush();

    expect(openVsCode).toHaveBeenCalledWith({
      hostToken: 'hetzner',
      path: '/home/alexey/tmp/rasa',
    });
    expect(diagErrors.value).toEqual([]);
  });

  it('does not let one failed resolution poison the next click', async () => {
    // Mount's attempt fails; the store leaves the ref null and the error
    // uncached. The click retries — and succeeds.
    homeRpc
      .mockResolvedValueOnce({ ok: false, home: null, error: 'channel closed' })
      .mockResolvedValue({ ok: true, home: '/home/alexey', error: null });
    const wrapper = await openWorkspace();
    expect(useProjectsStore().home).toBeNull();

    await codeButton(wrapper).trigger('click');
    await flush();

    expect(openVsCode).toHaveBeenCalledWith({
      hostToken: 'hetzner',
      path: '/home/alexey/tmp/rasa',
    });
  });

  it('refuses with the honest reason when $HOME still will not resolve', async () => {
    homeRpc.mockResolvedValue({ ok: false, home: null, error: 'channel closed' });
    const wrapper = await openWorkspace();

    await codeButton(wrapper).trigger('click');
    await flush();

    expect(openVsCode).not.toHaveBeenCalled();
    const messages = diagErrors.value.map((e) => e.message);
    expect(messages.some((m) => m.includes('"~/tmp/rasa"') && m.includes('channel closed'))).toBe(
      true,
    );
  });

  it('spends no $HOME round trip on an already-absolute folder', async () => {
    route.value.params.folder = '/home/alexey/tmp/rasa';
    // And the RPC, if it were called, would hang forever — the assertion is
    // that the click never waits on it.
    homeRpc.mockImplementation(() => new Promise(() => undefined));
    const wrapper = await openWorkspace();

    await codeButton(wrapper).trigger('click');
    await flush(2);

    expect(openVsCode).toHaveBeenCalledWith({
      hostToken: 'hetzner',
      path: '/home/alexey/tmp/rasa',
    });
  });
});

describe('Open in VS Code when the platform omits the capability', () => {
  it('hides the bar button — the alias is only provable where ~/.ssh/config is readable', async () => {
    // The web omits `editors` at the seam: the deep link's host token
    // resolves against the dispatched machine's LOCAL config, which a
    // browser cannot see. The workspace's folder is real here, so the
    // button's absence is the capability's doing, not the path's.
    omittedGroups.add('editors');
    const wrapper = await openWorkspace();

    expect(codeButton(wrapper).exists()).toBe(false);
    expect(openVsCode).not.toHaveBeenCalled();
  });
});
