// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';

/**
 * The desktop's Settings section for the local terminal's shell. The store is
 * localStorage-backed, so the mount needs no api mock — the assertions are on
 * the offered options (platform-filtered) and the write-back on change.
 */

const LocalShellSettingsSection = (await import('../../src/renderer/LocalShellSettingsSection.vue'))
  .default;
const { useSettingsStore } = await import('@ui/app/stores/settings');

function stubUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

describe('LocalShellSettingsSection', () => {
  it('offers every shell on Windows, with the default selected', async () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const wrapper = mount(LocalShellSettingsSection);
    const select = wrapper.find('select');
    const options = select.findAll('option').map((o) => o.element.value);
    expect(options).toEqual(['', 'powershell', 'pwsh', 'cmd']);
    expect((select.element as HTMLSelectElement).value).toBe('');
  });

  it('drops the Windows-only shells elsewhere', async () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const wrapper = mount(LocalShellSettingsSection);
    const options = wrapper.find('select').findAll('option').map((o) => o.element.value);
    expect(options).toEqual(['', 'pwsh']);
  });

  it('writes the choice back through the settings store', async () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const wrapper = mount(LocalShellSettingsSection);
    await wrapper.find('select').setValue('powershell');
    expect(useSettingsStore().localShell).toBe('powershell');
    // And it survives a fresh store over the same storage: persisted.
    expect(JSON.parse(window.localStorage.getItem('pocketshell.settings.v1') ?? '{}'))
      .toMatchObject({ localShell: 'powershell' });
  });
});
