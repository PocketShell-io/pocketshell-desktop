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
 *   2. **The eye is the reveal, in ONE press.** The first press fetches the
 *      value AND shows it — the click is the ask — and the same eye puts the
 *      mask back. Reveal all fetches the whole env in one call (the helper
 *      charges `env list` + one `env get` for it; the panel must not pay per
 *      row), and Hide all masks the panel in one gesture without un-fetching:
 *      the eye re-shows a masked row for free, and only Reveal all pays for a
 *      fresh read.
 *   3. **Editing unmasks and ghosts the eye** (there is no editing a secret
 *      you cannot see), **the write is the field's Enter — only the dirty
 *      row, only to the file it came from; a stray blur never writes**, and a
 *      rejection lands as a sentence next to the form rather than a throw.
 *      The rows carry no Save button: a reserved button column spent every
 *      row's right edge on chrome only a dirty row ever used.
 *   4. **The new-key form refuses a key that would mangle the dotenv file**
 *      (whitespace, `=`) before the host ever sees it.
 *
 * Rows are one line each — key, file chip, value field, one action — the
 * Ports table's construction; the tests walk the rows by key, not by index,
 * so the layout can keep changing without rewriting the behaviour claims.
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

/** A row line by its key — the tests walk the rows, never raw indexes. */
function rowByKey(wrapper: VueWrapper, key: string) {
  const row = wrapper.findAll('.env-row').find((tr) => tr.text().includes(key));
  if (!row) throw new Error(`no row for ${key}`);
  return row;
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
    // The names are on screen; no field holds a value yet. Fetched-value rows
    // wait disabled behind the dots placeholder; the unset row is an empty
    // field ready to type into (absence is not a secret).
    const text = wrapper.text();
    expect(text).toContain('API_KEY');
    expect(text).toContain('DIRENV_VAR');
    expect(text).toContain('EMPTY_ONE');
    const apiKey = rowByKey(wrapper, 'API_KEY').find('input.value-input').element as HTMLInputElement;
    expect(apiKey.value).toBe('');
    expect(apiKey.disabled).toBe(true);
    const unset = rowByKey(wrapper, 'EMPTY_ONE').find('input.value-input').element as HTMLInputElement;
    expect(unset.disabled).toBe(false);
    expect(unset.placeholder).toBe('not set');
  });

  it('the eye fetches and shows a value in ONE press, and hides it again', async () => {
    envGet.mockResolvedValue({ API_KEY: 's3cr3t' });
    const wrapper = await show();

    const eye = rowByKey(wrapper, 'API_KEY').find('button.eye-btn');
    await eye.trigger('click');
    await flush(wrapper);

    expect(envGet).toHaveBeenCalledTimes(1);
    expect(envGet).toHaveBeenCalledWith('conn-1', '$HOME/bug', ['API_KEY']);
    const input = rowByKey(wrapper, 'API_KEY').find('input.value-input').element as HTMLInputElement;
    expect(input.value).toBe('s3cr3t');
    expect(input.type).toBe('text');
    expect(eye.attributes('aria-pressed')).toBe('true');

    // The same eye closes again — the mask is a toggle, not a one-way door.
    await eye.trigger('click');
    expect(input.type).toBe('password');
  });

  it('Reveal all fills every row in ONE host round trip and shows them', async () => {
    envGet.mockResolvedValue({ API_KEY: 'a', DIRENV_VAR: 'd', EMPTY_ONE: '' });
    const wrapper = await show();

    await wrapper.find('button.reveal-all').trigger('click');
    await flush(wrapper);

    expect(envGet).toHaveBeenCalledTimes(1);
    // Omitted `keys` = the whole env (main's envGet then runs `env list` itself).
    expect(envGet).toHaveBeenCalledWith('conn-1', '$HOME/bug', undefined);
    for (const key of ['API_KEY', 'DIRENV_VAR']) {
      const input = rowByKey(wrapper, key).find('input.value-input').element as HTMLInputElement;
      expect(input.type).toBe('text');
      expect(input.value).not.toBe('');
    }
  });

  it('Hide all masks every row in one gesture; the eye re-shows for free', async () => {
    envGet.mockResolvedValue({ API_KEY: 'a', DIRENV_VAR: 'd' });
    const wrapper = await show();

    await wrapper.find('button.reveal-all').trigger('click');
    await flush(wrapper);
    for (const key of ['API_KEY', 'DIRENV_VAR']) {
      const input = rowByKey(wrapper, key).find('input.value-input').element as HTMLInputElement;
      expect(input.type).toBe('text');
    }

    await wrapper.find('button.hide-all').trigger('click');
    for (const key of ['API_KEY', 'DIRENV_VAR']) {
      const row = rowByKey(wrapper, key);
      expect((row.find('input.value-input').element as HTMLInputElement).type).toBe('password');
      // Masked, but still fetched: the eye's state says so.
      expect(row.find('button.eye-btn').attributes('aria-pressed')).toBe('false');
    }
    expect(envGet).toHaveBeenCalledTimes(1);

    // The mask is not the forget — the eye puts a value back with no round
    // trip, because the row was already fetched.
    await rowByKey(wrapper, 'API_KEY').find('button.eye-btn').trigger('click');
    await flush(wrapper);
    expect(envGet).toHaveBeenCalledTimes(1);
    const input = rowByKey(wrapper, 'API_KEY').find('input.value-input').element as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('a');
  });

  it('writes on Enter — never on blur — to its own file, and a refusal shows as text', async () => {
    envGet.mockResolvedValue({ API_KEY: 'old' });
    const wrapper = await show();
    const row = rowByKey(wrapper, 'API_KEY');
    await row.find('button.eye-btn').trigger('click');
    await flush(wrapper);

    const input = row.find('input.value-input');
    await input.setValue('new-value');
    // The stray click that means "copy this value" must not be able to
    // commit a corrupted one: blur is not a write.
    await input.trigger('blur');
    await flush(wrapper);
    expect(envSet).not.toHaveBeenCalled();

    await input.trigger('keyup.enter');
    await flush(wrapper);

    expect(envSet).toHaveBeenCalledTimes(1);
    expect(envSet).toHaveBeenCalledWith('conn-1', '$HOME/bug', { API_KEY: 'new-value' }, '.env');

    // Now the helper refuses a second write.
    envSet.mockRejectedValue(new Error('permission denied'));
    const row2 = rowByKey(wrapper, 'API_KEY');
    await row2.find('input.value-input').setValue('newer');
    await row2.find('input.value-input').trigger('keyup.enter');
    await flush(wrapper);
    expect(wrapper.text()).toContain('API_KEY: permission denied');
  });

  it('editing unmasks the field and ghosts the eye, its box kept', async () => {
    envGet.mockResolvedValue({ API_KEY: 's3cr3t' });
    const wrapper = await show();
    await rowByKey(wrapper, 'API_KEY').find('button.eye-btn').trigger('click');
    await flush(wrapper);

    const row = rowByKey(wrapper, 'API_KEY');
    const input = row.find('input.value-input');
    await input.setValue('s3cr3t-edited');
    await flush(wrapper);

    expect((input.element as HTMLInputElement).type).toBe('text');
    // The eye is ghosted — visibility, not display — so its box holds and
    // the field's right edge cannot shift under the caret.
    expect(row.find('button.eye-btn').classes()).toContain('ghosted');
    // And the row carries no Save button at all: the write is the Enter.
    expect(row.find('button.row-save').exists()).toBe(false);
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
