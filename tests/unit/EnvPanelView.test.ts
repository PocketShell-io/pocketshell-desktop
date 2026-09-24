// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { EnvVarRow } from '@pocketshell/core';

/**
 * The env panel (FEATURES.md F16).
 *
 * The helper's contract forces the interesting behaviour: values are NOT in
 * the listing (`env list` is names only, D24), so the panel's default state
 * for every row is "name visible, value not fetched". What these tests pin:
 *
 *   1. **Names load; values do not travel until asked for.** A mounted panel
 *      makes exactly ONE call (`env list`) and no row holds a value.
 *   2. **Reveal fetches that row's value and only that row's.**
 *   3. **Reveal all fetches the whole env in one call** (the helper charges
 *      `env list` + one `env get` for it; the panel must not pay per row).
 *   4. **Save writes only the dirty row, targets the file it came from**, and
 *      a rejection lands as a sentence next to the form rather than a throw.
 *   5. **The new-key form refuses a key that would mangle the dotenv file**
 *      (whitespace, `=`) before the host ever sees it.
 */

const envList = vi.fn<(connectionId: string, dir: string) => Promise<EnvVarRow[]>>();
const envGet = vi.fn<
  (connectionId: string, dir: string, keys?: string[]) => Promise<Record<string, string>>
>();
const envSet = vi.fn<
  (connectionId: string, dir: string, values: Record<string, string>, file?: string) => Promise<void>
>();

vi.mock('@ui/app/ipc', () => ({
  api: {
    agent: {
      envList: (connectionId: string, dir: string) => envList(connectionId, dir),
      envGet: (connectionId: string, dir: string, keys?: string[]) => envGet(connectionId, dir, keys),
      envSet: (connectionId: string, dir: string, values: Record<string, string>, file?: string) =>
        envSet(connectionId, dir, values, file),
    },
    // The connection store subscribes to transport-state events as it is
    // created, so the mock must carry the listener hook even though no test
    // here exercises it.
    ssh: { onState: vi.fn() },
  },
}));

const EnvPanelView = (await import('@ui/app/views/EnvPanelView.vue')).default;

const ROWS: EnvVarRow[] = [
  { file: '.env', hasValue: true, key: 'API_KEY' },
  { file: '.envrc', hasValue: true, key: 'DIRENV_VAR' },
  { file: '.env', hasValue: false, key: 'EMPTY_ONE' },
];

async function flush(wrapper: VueWrapper): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

async function show(dir = '$HOME/bug'): Promise<VueWrapper> {
  const wrapper = mount(EnvPanelView, { props: { connectionId: 'conn-1', dir } });
  await flush(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  envList.mockReset().mockResolvedValue(ROWS);
  envGet.mockReset().mockResolvedValue({});
  envSet.mockReset().mockResolvedValue(undefined);
});

describe('EnvPanelView', () => {
  it('lists key names and fetches NO values on mount', async () => {
    const wrapper = await show();
    expect(envList).toHaveBeenCalledWith('conn-1', '$HOME/bug');
    expect(envGet).not.toHaveBeenCalled();
    // The names are on screen; no input carries a value yet.
    const text = wrapper.text();
    expect(text).toContain('API_KEY');
    expect(text).toContain('DIRENV_VAR');
    expect(text).toContain('EMPTY_ONE');
    expect(wrapper.findAll('input.value-input').length).toBeGreaterThan(0);
    for (const input of wrapper.findAll('input.value-input')) {
      expect((input.element as HTMLInputElement).value).toBe('');
    }
  });

  it('reveal fetches exactly that row and fills its field', async () => {
    envGet.mockResolvedValue({ API_KEY: 's3cr3t' });
    const wrapper = await show();

    await wrapper.findAll('button.reveal-btn')[0]!.trigger('click');
    await flush(wrapper);

    expect(envGet).toHaveBeenCalledTimes(1);
    expect(envGet).toHaveBeenCalledWith('conn-1', '$HOME/bug', ['API_KEY']);
    const input = wrapper.findAll('input.value-input')[0]!.element as HTMLInputElement;
    expect(input.value).toBe('s3cr3t');
  });

  it('reveal all fills every row in ONE host round trip', async () => {
    envGet.mockResolvedValue({ API_KEY: 'a', DIRENV_VAR: 'd', EMPTY_ONE: '' });
    const wrapper = await show();

    await wrapper.find('.panel-actions button.reveal-btn').trigger('click');
    await flush(wrapper);

    expect(envGet).toHaveBeenCalledTimes(1);
    // Omitted `keys` = the whole env (main's envGet then runs `env list` itself).
    expect(envGet).toHaveBeenCalledWith('conn-1', '$HOME/bug', undefined);
  });

  it('save writes the dirty row to its own file, and a refusal shows as text', async () => {
    envGet.mockResolvedValue({ API_KEY: 'old' });
    const wrapper = await show();
    await wrapper.findAll('button.reveal-btn')[0]!.trigger('click');
    await flush(wrapper);

    const input = wrapper.findAll('input.value-input')[0]!;
    await input.setValue('new-value');
    await wrapper.findAll('button.save-btn')[0]!.trigger('click');
    await flush(wrapper);

    expect(envSet).toHaveBeenCalledTimes(1);
    expect(envSet).toHaveBeenCalledWith('conn-1', '$HOME/bug', { API_KEY: 'new-value' }, '.env');

    // Now the helper refuses a second write.
    envSet.mockRejectedValue(new Error('permission denied'));
    await input.setValue('newer');
    await wrapper.findAll('button.save-btn')[0]!.trigger('click');
    await flush(wrapper);
    expect(wrapper.text()).toContain('API_KEY: permission denied');
  });

  it('refuses a key that would mangle the dotenv file, before the host sees it', async () => {
    const wrapper = await show();

    const key = wrapper.find('input.key-input');
    await key.setValue('HAS SPACE');
    await wrapper.find('form.add-row button[type="submit"]').trigger('submit');
    await flush(wrapper);
    expect(envSet).not.toHaveBeenCalled();

    await key.setValue('WITH=EQUALS');
    await wrapper.find('form.add-row button[type="submit"]').trigger('submit');
    await flush(wrapper);
    expect(envSet).not.toHaveBeenCalled();

    await key.setValue('GOOD_KEY');
    await wrapper.find('form.add-row button[type="submit"]').trigger('submit');
    await flush(wrapper);
    expect(envSet).toHaveBeenCalledTimes(1);
    expect(envSet).toHaveBeenCalledWith(
      'conn-1',
      '$HOME/bug',
      { GOOD_KEY: '' },
      undefined,
    );
  });
});
