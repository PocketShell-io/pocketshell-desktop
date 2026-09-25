// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { SessionSummary } from '@pocketshell/core';

/**
 * The quick-actions palette's wiring, at the view that owns it.
 *
 * The palette COMPONENT has its own suite (commandPalette.test.ts); what is
 * pinned here is the seam only this view can prove:
 *
 *   1. `workspace.quickActions` (Ctrl+P, and its shifted twin) summons it —
 *      and stands down inside a text field, like every chord that shares a
 *      surface with prose.
 *   2. The command list is built from the SAME derivation the panel draws
 *      from — one palette row per folder, spelled the way the navigation
 *      spells it — so a palette row cannot open a workspace the panel would
 *      not.
 *   3. Running a folder row is `onSelectFolder` — the panel row's own
 *      handler — so the palette navigates exactly the way a click does.
 */

const SessionTreeStub = { template: '<div class="stub-tree" />' };
/** The mount root: the ROUTE renders the view, so exactly one instance exists
 * (mounting the view itself as root would put a second, route-rendered copy
 * beside it — two window listeners, two palettes, one confusing assertion). */
const Harness = { template: '<RouterView />' };
const FakeWorkspace = { template: '<div class="fake-workspace" />' };
const SessionPlaceholder = { template: '<div class="fake-placeholder" />' };

const sessionsList = vi.fn<() => Promise<SessionSummary[]>>();

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: {
      onState: vi.fn(),
      listConfigHosts: vi.fn().mockResolvedValue([]),
      connect: vi.fn(),
      close: vi.fn(),
    },
    helper: {
      sessionsList: () => sessionsList(),
      bootstrap: vi.fn().mockResolvedValue(null),
    },
    win: { setTitle: vi.fn() },
    app: { onResumed: vi.fn() },
    forwards: {
      isAutoEnabled: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      onStates: vi.fn().mockReturnValue(() => {}),
    },
  },
}));

const HostWorkspaceView = (await import('@ui/app/views/HostWorkspaceView.vue')).default;
const { useSessionsStore } = await import('@ui/app/stores/sessions');

function session(name: string, path: string, activity: number): SessionSummary {
  return { name, created: activity, activity, attached: false, path };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

let router: Router;
let wrapper: VueWrapper | null = null;

async function mountWorkspace(): Promise<void> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/host/:name',
        component: HostWorkspaceView,
        children: [
          { path: '', component: SessionPlaceholder },
          { path: 'folder/:folder', name: 'folder', component: FakeWorkspace },
        ],
      },
    ],
  });
  await router.push({ name: 'folder', params: { name: 'hetzner', folder: '~/git/x' } });
  await router.isReady();

  wrapper = mount(Harness, {
    global: {
      plugins: [router],
      stubs: {
        SessionTree: SessionTreeStub,
        PopupMenu: {
          props: ['anchor', 'label', 'ignore'],
          template: '<div class="menu-stub" :aria-label="label"><slot /></div>',
        },
      },
    },
  });
  await flush();
}

/** The summoning chord, dispatched the way the window-capture listener hears it. */
async function summon(key = 'p', shift = false): Promise<void> {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: shift }),
  );
  await flush();
}

function paletteRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.palette-item'));
}

beforeEach(async () => {
  setActivePinia(createPinia());
  sessionsList.mockResolvedValue([
    session('git-x-1', '/home/alexey/git/x', 500),
    session('git-x-2', '/home/alexey/git/x', 400),
    session('git-y-1', '/home/alexey/git/y', 300),
  ]);
  void useSessionsStore().refresh('conn-1');
  await mountWorkspace();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the quick-actions palette wiring', () => {
  it('Ctrl+P summons it, listing each folder plus the workspace verbs', async () => {
    await summon('p');
    expect(document.querySelectorAll('.command-palette')).toHaveLength(1);

    const labels = paletteRows().map((r) => r.textContent ?? '');
    expect(labels.some((t) => t.includes('Open x'))).toBe(true);
    expect(labels.some((t) => t.includes('Open y'))).toBe(true);
    expect(labels.some((t) => t.includes('New session…'))).toBe(true);
    expect(labels.some((t) => t.includes('Settings'))).toBe(true);
    expect(labels.some((t) => t.includes('Back to the host list'))).toBe(true);
  });

  it('a folder holding several sessions gets one row per session', async () => {
    await summon('p');
    const labels = paletteRows().map((r) => r.textContent ?? '');
    // `x` holds two sessions: both get their own row, labelled by the name
    // the tab bar knows. `y` holds one — folder and session are one
    // destination, so it gets only its folder row.
    expect(labels.some((t) => t.includes('Open git-x-1'))).toBe(true);
    expect(labels.some((t) => t.includes('Open git-x-2'))).toBe(true);
    expect(labels.filter((t) => t.includes('Open git-y-1'))).toHaveLength(0);
  });

  it('running a session row opens that folder with that tab asked for', async () => {
    await summon('p');
    const row = paletteRows().find((r) => r.textContent?.includes('Open git-x-2'));
    expect(row).toBeDefined();
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(document.querySelectorAll('.command-palette')).toHaveLength(0);
    expect(decodeURIComponent(String(router.currentRoute.value.params['folder']))).toBe('~/git/x');
    expect(router.currentRoute.value.query['tab']).toBe('git-x-2');
  });

  it('Ctrl+Shift+P summons the same surface', async () => {
    await summon('P', true);
    expect(document.querySelector('.command-palette')).not.toBeNull();
  });

  it('stands down inside a text field', async () => {
    // The composer is the surface this rule protects; any editable target
    // stands for it here.
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }),
    );
    await flush();
    expect(document.querySelector('.command-palette')).toBeNull();
    field.remove();
  });

  it('running a folder row navigates the way a panel click would', async () => {
    await summon('p');
    const row = paletteRows().find((r) => r.textContent?.includes('Open y'));
    expect(row).toBeDefined();
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(document.querySelectorAll('.command-palette')).toHaveLength(0);
    const param = String(router.currentRoute.value.params['folder'] ?? '');
    expect(decodeURIComponent(param)).toBe('~/git/y');
  });

  it('Escape dismisses without running anything', async () => {
    await summon('p');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(document.querySelector('.command-palette')).toBeNull();
    // Still mounted at the folder we started at.
    expect(decodeURIComponent(String(router.currentRoute.value.params['folder']))).toBe('~/git/x');
  });
});
