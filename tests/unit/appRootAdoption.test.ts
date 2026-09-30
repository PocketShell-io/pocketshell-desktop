// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The desktop root on the SHARED app root and route map (#2949): App.vue adds
 * only what the desktop alone has — frame zoom — around @ui/app/AppRoot.vue,
 * and router.ts is `createAppRoutes()` on memory history.
 */

const setZoom = vi.fn();
vi.mock('@ui/app/ipc', () => ({
  api: {
    win: { setZoom: (f: number): void => { setZoom(f); }, onZoomCommand: vi.fn(() => () => {}) },
    diag: { log: vi.fn() },
  },
}));

// The route views are the shared app's; the root is what is under test here.
vi.mock('@ui/app/views/HostPickerView.vue', () => ({ default: { template: '<p class="picker">hosts</p>' } }));

const App = (await import('../../src/renderer/App.vue')).default;
const { router } = await import('../../src/renderer/router');
const { SHARED_ROUTE_NAMES } = await import('@ui/app/routes');
const { useSettingsStore } = await import('@ui/app/stores/settings');

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  localStorage.clear();
  setZoom.mockClear();
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('desktop root on the shared AppRoot', () => {
  it('routes by the shared map and nothing of its own', () => {
    const names = router.getRoutes().map((r) => r.name).filter(Boolean).map(String).sort();
    expect(names).toEqual([...SHARED_ROUTE_NAMES].sort());
  });

  it('renders the shared outlet, writes the theme, and keeps the desktop zoom writer', async () => {
    await router.push('/');
    await router.isReady();
    wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body });
    await nextTick();
    expect(wrapper.find('.picker').exists()).toBe(true);
    expect(document.documentElement.dataset['theme']).toBeTruthy();
    expect(setZoom).toHaveBeenCalledWith(1);

    useSettingsStore().zoomIn();
    await nextTick();
    expect(setZoom.mock.calls.at(-1)![0]).toBeGreaterThan(1);
  });
});
