// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent } from 'vue';
import type { HostEntry, SessionSummary } from '@pocketshell/core';

/**
 * The session panel's quick search and sort, against the REAL component.
 *
 * The search is a SUMMONED row — hidden until `sessions.filterTree`
 * (Ctrl+Shift+F), dismissed by Escape — and these tests pin both halves of
 * that contract: the space stays the rows' while no search is running, and
 * the row that appears actually filters. The sort rides in the same row and
 * is also reachable from Settings; its menu and its store write are pinned
 * here.
 *
 * This file exists because the first shipped version of the filter was
 * broken in exactly the way unit tests on the pure functions could not see:
 * the query ref was created per-composable-call, so the input wrote one ref
 * and the rows read another. Component-level assertions are the floor for
 * this feature.
 */

const sessionsList = vi.fn<() => Promise<SessionSummary[]>>();
const projectsHome = vi.fn<() => Promise<{ ok: boolean; home?: string; error?: string }>>();

vi.mock('@ui/app/ipc', () => ({
  api: {
    helper: { sessionsList: () => sessionsList() },
    projects: {
      home: () => projectsHome(),
      killSession: vi.fn(),
      onCloneProgress: vi.fn(),
    },
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
  },
}));

const SessionTree = (await import('@ui/app/components/SessionTree.vue')).default;
const { useConnectionStore } = await import('@ui/app/stores/connection');
const { useSettingsStore } = await import('@ui/app/stores/settings');

function session(name: string, path: string | null, activity = 100): SessionSummary {
  return { name, created: activity, activity, attached: false, path };
}

const HOME = '/home/alexey';

const DialogStub = defineComponent({
  props: { startIn: { type: String, default: undefined } },
  template: '<div class="dialog-stub" />',
});

const MenuStub = {
  props: ['anchor', 'label'],
  template: '<div class="menu-stub" :aria-label="label"><slot /></div>',
};

const mounted: VueWrapper[] = [];

async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
  // openSearch focuses on nextTick; one more spin so the assertion sees it.
  await wrapper.vm.$nextTick();
}

/** The summoning chord, dispatched the way the real window listener hears it. */
async function summon(wrapper: VueWrapper): Promise<void> {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }),
  );
  await flush(wrapper);
}

async function open(sessions: SessionSummary[]): Promise<VueWrapper> {
  sessionsList.mockResolvedValue(sessions);
  projectsHome.mockResolvedValue({ ok: true, home: HOME });
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  connection.activeHost = { name: 'hetzner' } as HostEntry;
  useSettingsStore().sessionRoots = {};

  const wrapper = mount(SessionTree, {
    global: { stubs: { NewSessionDialog: DialogStub, PopupMenu: MenuStub } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flush(wrapper);
  return wrapper;
}

function dirLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.dir-header .label').map((l) => l.text());
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('the summoned search row', () => {
  it('is not on screen until summoned', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(wrapper.find('.tree-filter').exists()).toBe(false);
  });

  it('the chord summons it with the keyboard in the field', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await summon(wrapper);
    expect(wrapper.find('.tree-filter').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.find('.tree-filter input').element);
  });

  it('typing cuts the tree to the matching folders', async () => {
    const wrapper = await open([
      session('git-pocketshell', `${HOME}/git/pocketshell`),
      session('git-dtc', `${HOME}/git/dtc-website`),
      session('tmp-scratch', `${HOME}/tmp/scratch`),
    ]);
    await summon(wrapper);
    await wrapper.find('.tree-filter input').setValue('pocket');
    await flush(wrapper);
    expect(dirLabels(wrapper)).toEqual(['pocketshell']);
  });

  it('matching a session name inside a folder keeps the folder', async () => {
    const wrapper = await open([session('custom-name', `${HOME}/git/wye`)]);
    await summon(wrapper);
    await wrapper.find('.tree-filter input').setValue('custom');
    await flush(wrapper);
    expect(dirLabels(wrapper)).toEqual(['wye']);
  });

  it('Escape clears the query AND closes the row', async () => {
    const wrapper = await open([
      session('git-a', `${HOME}/git/a`),
      session('git-b', `${HOME}/git/b`),
    ]);
    await summon(wrapper);
    const input = wrapper.find('.tree-filter input');
    await input.setValue('a');
    await flush(wrapper);
    expect(dirLabels(wrapper)).toEqual(['a']);

    await input.trigger('keydown.esc');
    await flush(wrapper);
    expect(wrapper.find('.tree-filter').exists()).toBe(false);
    expect(dirLabels(wrapper)).toEqual(['a', 'b']);
  });

  it('Enter opens the first match and ends the search', async () => {
    const wrapper = await open([
      session('git-zeta', `${HOME}/git/zeta`),
      session('git-alpha', `${HOME}/git/alpha`),
    ]);
    await summon(wrapper);
    await wrapper.find('.tree-filter input').setValue('alpha');
    await flush(wrapper);
    await wrapper.find('.tree-filter input').trigger('keydown.enter');
    await flush(wrapper);

    expect(wrapper.find('.tree-filter').exists()).toBe(false);
    const selects = wrapper.emitted('select');
    expect(selects).toHaveLength(1);
    expect((selects![0]![0] as { label: string }).label).toBe('alpha');
  });
});

describe('the sort menu — in the summoned row, and in Settings', () => {
  it('opens on the chevron and offers the four keys', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await summon(wrapper);
    await wrapper.find('button.sort-btn').trigger('click');
    await flush(wrapper);

    const items = wrapper.findAll('.menu-stub .menu-item').map((b) => b.text().trim());
    expect(items).toEqual(['Host order', 'Newest activity', 'Name', 'Created']);
  });

  it('picking Name reorders the rows and writes the setting', async () => {
    // Listed wye, ate, zed: host order differs from name order.
    const wrapper = await open([
      session('git-wye', `${HOME}/git/wye`, 300),
      session('git-ate', `${HOME}/git/ate`, 100),
      session('git-zed', `${HOME}/git/zed`, 200),
    ]);
    expect(dirLabels(wrapper)).toEqual(['wye', 'ate', 'zed']);

    await summon(wrapper);
    await wrapper.find('button.sort-btn').trigger('click');
    await flush(wrapper);
    const nameItem = wrapper
      .findAll('.menu-stub .menu-item')
      .find((b) => b.text().includes('Name'))!;
    await nameItem.trigger('click');
    await flush(wrapper);

    expect(dirLabels(wrapper)).toEqual(['ate', 'wye', 'zed']);
    expect(useSettingsStore().sessionTreeSort).toBe('name');
  });

  it('picking a sort clears a dragged arrangement instead of being vetoed by it', async () => {
    // The measured failure this guards: with a manual ranking stored, the
    // sorted projection used to be re-ranked by the stale arrangement, so
    // "Name" moved nothing and looked broken. Ranks and sorts are one mode
    // at a time now — the pick clears the ranks.
    const settings = useSettingsStore();
    settings.folderOrder = { hetzner: ['~/git/wye', '~/git/ate', '~/git/zed'] };

    const wrapper = await open([
      session('git-wye', `${HOME}/git/wye`, 300),
      session('git-ate', `${HOME}/git/ate`, 100),
      session('git-zed', `${HOME}/git/zed`, 200),
    ]);
    await summon(wrapper);
    await wrapper.find('button.sort-btn').trigger('click');
    await flush(wrapper);
    const nameItem = wrapper
      .findAll('.menu-stub .menu-item')
      .find((b) => b.text().includes('Name'))!;
    await nameItem.trigger('click');
    await flush(wrapper);

    expect(settings.sessionTreeSort).toBe('name');
    expect(settings.folderOrder).toEqual({});
    // Alphabetical, NOT rank order (which would still be wye, ate, zed).
    expect(dirLabels(wrapper)).toEqual(['ate', 'wye', 'zed']);
  });
});
