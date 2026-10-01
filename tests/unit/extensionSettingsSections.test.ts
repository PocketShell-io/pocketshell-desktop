// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';

/**
 * The shared SettingsView's `settings.sections` slot (@ui/app/extensions): a
 * platform's own settings group renders after the shared ones, under its
 * title. Nothing contributed adds nothing. Harness follows
 * settingsKeyboard.test.ts.
 */

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: {
      onState: vi.fn(() => () => {}),
      listConfigHosts: vi.fn(async () => []),
      close: vi.fn(async () => true),
    },
    helper: { sessionsList: vi.fn(async () => []) },
    projects: { home: vi.fn(async () => ({ ok: false })) },
    sync: { status: vi.fn(async () => ({ loggedIn: false, email: null, keychainAvailable: false })) },
  },
}));

const SettingsView = (await import('@ui/app/views/SettingsView.vue')).default;
const { provideExtensions } = await import('@ui/app/extensions');

const Voice = defineComponent({ setup: () => () => h('p', { class: 'voice-body' }, 'Dictation language') });

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  provideExtensions({});
});

describe('SettingsView settings.sections slot', () => {
  it('adds no group when nothing is contributed', () => {
    const wrapper = mount(SettingsView);
    expect(wrapper.find('[data-testid^="settings-section-"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders a contributed section, titled, after the shared groups', () => {
    provideExtensions({ 'settings.sections': [{ id: 'voice', title: 'Voice', component: Voice }] });
    const wrapper = mount(SettingsView);
    const section = wrapper.get('[data-testid="settings-section-voice"]');
    expect(section.get('.group-title').text()).toBe('Voice');
    expect(section.get('.voice-body').text()).toBe('Dictation language');
    // After every shared group the view renders itself (Keyboard is one).
    const groups = wrapper.findAll('section.group').map((g) => g.element);
    const keyboard = groups.findIndex((g) => g.textContent?.includes('Keyboard'));
    expect(keyboard).toBeGreaterThanOrEqual(0);
    expect(groups.indexOf(section.element)).toBeGreaterThan(keyboard);
    wrapper.unmount();
  });
});
