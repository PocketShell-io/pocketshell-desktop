// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry } from '../../src/shared/types';

/**
 * The Keyboard section of Settings — THE PART THE USER ASKED FOR FIRST.
 *
 * "i also want to see the shortcuts … but I don't know what we have". The
 * configurability is the second half of that sentence; the first half is a
 * list, and this file pins the list on its own terms: every binding in the
 * registry appears, including the ones no control here can change, and the
 * chords shown are the ones actually in force rather than the shipped
 * defaults.
 *
 * The assertions are on rendered TEXT rather than on component internals,
 * because the failure being guarded against is "the user still cannot see it",
 * and a binding that is in the DOM but not in the text is not visible.
 */

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    ssh: {
      onState: vi.fn(() => () => {}),
      listConfigHosts: vi.fn(async () => []),
      close: vi.fn(async () => true),
    },
    helper: { sessionsList: vi.fn(async () => []) },
    projects: { home: vi.fn(async () => ({ ok: false })) },
    // SettingsView's mount asks main who is signed in; signed out with no
    // keychain is the answer every assertion here assumes.
    sync: { status: vi.fn(async () => ({ loggedIn: false, email: null, keychainAvailable: false })) },
  },
}));

const SettingsView = (await import('../../src/renderer/views/SettingsView.vue')).default;
const { useSettingsStore } = await import('../../src/renderer/stores/settings');
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { SHORTCUTS, formatChord, parseChord } = await import('../../src/shared/shortcuts');

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

/**
 * Mounting is wrapped so the helpers below can be typed off it. `mount()` on a
 * `*.vue` default export widens to `VueWrapper<any>` (env.d.ts types every SFC
 * as `DefineComponent<…, any>`), which the lint rules reject at a call site —
 * so the type is taken from the one place that produces it.
 */
function mountSettings() {
  return mount(SettingsView);
}
type Wrapper = ReturnType<typeof mountSettings>;

/** The section's text, with runs of whitespace flattened so a `<kbd>` run reads. */
function text(wrapper: Wrapper): string {
  return wrapper.text().replace(/\s+/g, ' ');
}

describe('Settings — the shortcut list', () => {
  it('lists EVERY binding in the registry, fixed ones included', () => {
    // A list showing only what the renderer implements would omit the zoom
    // chords and CodeMirror's undo — both of which are keys that do something
    // in this app, which is the only question the user is asking.
    const wrapper = mountSettings();
    const rendered = text(wrapper);
    const missing = SHORTCUTS.filter((spec) => !rendered.includes(spec.label));
    expect(missing.map((spec) => spec.id)).toEqual([]);
    wrapper.unmount();
  });

  it('groups them by surface and says when each group is live', () => {
    const wrapper = mountSettings();
    const rendered = text(wrapper);
    for (const heading of ['Terminal', 'Prompt composer', 'Files', 'Tabs', 'Annotate']) {
      expect(rendered, heading).toContain(heading);
    }
    // The blurb is the part no code comment could ever have told a user.
    expect(rendered).toContain('stay live while the panel is closed');
    wrapper.unmount();
  });

  it('renders each chord as separate keys, never as one run of text', () => {
    // `<kbd>` per key is what makes a chord read as keys. It is also the rule
    // that keeps a ⌘ or an ↑ from being pressed into service as an icon here —
    // see tests/unit/designGates.test.ts.
    const wrapper = mountSettings();
    const caps = wrapper.findAll('kbd').map((el) => el.text());
    expect(caps).toContain('Ctrl');
    expect(caps).toContain('Shift');
    expect(caps).toContain('V');
    // Arrows are words, not glyphs.
    expect(caps).toContain('Up');
    expect(caps).toContain('Down');
    wrapper.unmount();
  });

  it('shows the chord IN FORCE, not the one that shipped', () => {
    const settings = useSettingsStore();
    settings.rebindShortcut('files.filterTree', parseChord('Ctrl+Shift+G')!);
    const wrapper = mountSettings();
    const row = wrapper
      .findAll('.key-row')
      .find((el) => el.text().includes('Filter this folder'))!;
    expect(row.findAll('kbd').map((el) => el.text())).toEqual(['Ctrl', 'Shift', 'G']);
    wrapper.unmount();
  });

  it('carries the WHY that used to live only in a code comment', () => {
    const wrapper = mountSettings();
    const rendered = text(wrapper);
    expect(rendered).toContain('XOFF');
    expect(rendered).toContain('literal-next (quoted-insert)');
    expect(rendered).toContain('tmux’s default prefix');
    wrapper.unmount();
  });

  it('says what the surviving tab chord costs the shell, both ways round', () => {
    // Derived from the chord in force, not written down — and the unflattering
    // half is shown too. The cycle chords (Ctrl+Tab / Ctrl+Shift+Tab) were
    // briefed as free and were not — xterm encodes Ctrl+Tab as a plain tab —
    // which measurement is part of why they were released back to the shell.
    // The step chord survives with the same honest labelling.
    const wrapper = mountSettings();
    const next = wrapper
      .findAll('.key-row')
      .find((el) => el.text().includes('tab to the left'))!;
    expect(next.text()).toContain('A terminal CAN send this key');

    const copy = wrapper
      .findAll('.key-row')
      .find((el) => el.text().includes('Copy the selection'))!;
    expect(copy.text()).toContain('the shell loses nothing');
    wrapper.unmount();
  });

  it('names what it will not take, and why', () => {
    const wrapper = mountSettings();
    const rendered = text(wrapper);
    expect(rendered).toContain('SIGINT');
    expect(rendered).toContain('tmux’s default prefix');
    expect(rendered).toContain('readline wants it for delete-word');
    wrapper.unmount();
  });

  it('offers a change control only for a binding that can be changed', () => {
    const wrapper = mountSettings();
    for (const spec of SHORTCUTS) {
      const row = wrapper.findAll('.key-row').find((el) => el.text().includes(spec.label));
      expect(row, spec.id).toBeTruthy();
      const editable = row!.findAll('button').length > 0;
      expect(editable, spec.id).toBe(spec.rebindable);
      if (!spec.rebindable) expect(row!.text(), spec.id).toContain('Fixed');
    }
    wrapper.unmount();
  });
});

describe('Settings — rebinding', () => {
  /** Open the capture field on the row whose label contains [label]. */
  async function capture(wrapper: Wrapper, label: string) {
    const row = wrapper.findAll('.key-row').find((el) => el.text().includes(label))!;
    await row.findAll('button')[0]!.trigger('click');
    return wrapper.find('.capture');
  }

  it('takes the keypress rather than asking the user to spell a chord', async () => {
    const settings = useSettingsStore();
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Filter this folder');
    await field.trigger('keydown', { key: 'G', ctrlKey: true, shiftKey: true });

    expect(settings.shortcutOverrides).toEqual({ 'files.filterTree': 'Ctrl+Shift+G' });
    expect(wrapper.find('.capture').exists()).toBe(false);
    wrapper.unmount();
  });

  it('cancels every key while listening, so the chord cannot also fire', async () => {
    // The chord being pressed is by definition one that means something else in
    // this app. Letting it through would run that command in the middle of
    // moving it.
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Filter this folder');
    const event = new KeyboardEvent('keydown', {
      key: 'G',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    field.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it('ignores a modifier held on the way to the chord', async () => {
    // Ctrl arrives as its own keydown first. Refusing it would flash a
    // validation message at every rebinding.
    const settings = useSettingsStore();
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Filter this folder');
    await field.trigger('keydown', { key: 'Control', ctrlKey: true });

    expect(wrapper.find('.notice').exists()).toBe(false);
    expect(settings.shortcutOverrides).toEqual({});
    expect(wrapper.find('.capture').exists()).toBe(true);
    wrapper.unmount();
  });

  it('leaves on Escape without binding anything', async () => {
    const settings = useSettingsStore();
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Filter this folder');
    await field.trigger('keydown', { key: 'Escape' });

    expect(settings.shortcutOverrides).toEqual({});
    expect(wrapper.find('.capture').exists()).toBe(false);
    wrapper.unmount();
  });

  it('refuses a conflict and NAMES the command holding the chord', async () => {
    const settings = useSettingsStore();
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Filter this folder');
    await field.trigger('keydown', { key: 'L', ctrlKey: true });

    expect(settings.shortcutOverrides).toEqual({});
    const notice = wrapper.find('.notice');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Type a path to go to');
    // Still listening, so the user can just press something else.
    expect(wrapper.find('.capture').exists()).toBe(true);
    wrapper.unmount();
  });

  it('refuses a chord the shell needs, with the reason', async () => {
    const settings = useSettingsStore();
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Copy the selection');
    await field.trigger('keydown', { key: 'c', ctrlKey: true });

    expect(settings.shortcutOverrides).toEqual({});
    expect(wrapper.find('.notice').text()).toContain('SIGINT');
    wrapper.unmount();
  });

  it('refuses a chord Electron’s menu owns, saying you would get both', async () => {
    const settings = useSettingsStore();
    const wrapper = mountSettings();
    const field = await capture(wrapper, 'Filter this folder');
    await field.trigger('keydown', { key: 'w', ctrlKey: true });

    expect(settings.shortcutOverrides).toEqual({});
    expect(wrapper.find('.notice').text()).toContain('you would get both');
    wrapper.unmount();
  });

  it('resets one binding, and the row goes back to the shipped chord', async () => {
    const settings = useSettingsStore();
    settings.rebindShortcut('files.filterTree', parseChord('Ctrl+Shift+G')!);
    const wrapper = mountSettings();
    const row = wrapper
      .findAll('.key-row')
      .find((el) => el.text().includes('Filter this folder'))!;
    // Second button on the row is the reset; the first is change.
    await row.findAll('button')[1]!.trigger('click');

    expect(settings.shortcutOverrides).toEqual({});
    const after = wrapper
      .findAll('.key-row')
      .find((el) => el.text().includes('Filter this folder'))!;
    expect(after.findAll('kbd').map((el) => el.text()).join('+')).toBe(
      formatChord(parseChord('Ctrl+F')!),
    );
    wrapper.unmount();
  });

  it('resets everything from one control', async () => {
    const settings = useSettingsStore();
    settings.rebindShortcut('files.filterTree', parseChord('Ctrl+Shift+G')!);
    settings.rebindShortcut('files.save', parseChord('Ctrl+Shift+S')!);
    const wrapper = mountSettings();
    await wrapper.find('.add-btn.self-start').trigger('click');

    expect(settings.hasShortcutOverrides).toBe(false);
    wrapper.unmount();
  });
});

describe('Settings — project roots', () => {
  it('edits only the connected host\'s roots', async () => {
    const settings = useSettingsStore();
    settings.sessionRoots = { hetzner: ['~/git'], aws: ['~/tmp'] };
    useConnectionStore().activeHost = { name: 'aws' } as HostEntry;

    const wrapper = mountSettings();
    const input = wrapper.get('input[aria-label="Add a project root for aws"]');
    await input.setValue('~/work');
    await input.trigger('keydown', { key: 'Enter' });

    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/git']);
    expect(settings.sessionRootsFor('aws')).toEqual(['~/tmp', '~/work']);
    wrapper.unmount();
  });

  it('switches the rendered root list with the active host alias', async () => {
    const settings = useSettingsStore();
    const connection = useConnectionStore();
    settings.sessionRoots = {
      hetzner: ['~/git', '~/tmp'],
      'pocketshell-local': [],
      aws: [],
    };
    connection.activeHost = { name: 'hetzner' } as HostEntry;

    const wrapper = mountSettings();
    expect(wrapper.findAll('.root-path').map((el) => el.text())).toEqual(['~/git', '~/tmp']);

    connection.activeHost = { name: 'pocketshell-local' } as HostEntry;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.root-path')).toHaveLength(0);
    expect(wrapper.get('input[aria-label="Add a project root for pocketshell-local"]')).toBeTruthy();

    connection.activeHost = { name: 'aws' } as HostEntry;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.root-path')).toHaveLength(0);
    expect(wrapper.get('input[aria-label="Add a project root for aws"]')).toBeTruthy();
    wrapper.unmount();
  });

  it('keeps a disconnected host selection scoped when the host list refreshes', async () => {
    const settings = useSettingsStore();
    const connection = useConnectionStore();
    settings.sessionRoots = { hetzner: ['~/git', '~/tmp'], 'pocketshell-local': [], aws: [] };
    connection.hosts = [
      { name: 'hetzner' },
      { name: 'pocketshell-local' },
    ] as HostEntry[];

    const wrapper = mountSettings();
    const picker = wrapper.get('#root-host');
    await picker.setValue('pocketshell-local');
    expect(wrapper.findAll('.root-path')).toHaveLength(0);

    // Simulate HostPickerView replacing the list after re-reading ~/.ssh/config.
    connection.hosts = [
      { name: 'hetzner' },
      { name: 'pocketshell-local' },
      { name: 'aws' },
    ] as HostEntry[];
    await wrapper.vm.$nextTick();
    expect(wrapper.get('input[aria-label="Add a project root for pocketshell-local"]')).toBeTruthy();
    expect(wrapper.findAll('.root-path')).toHaveLength(0);
    wrapper.unmount();
  });
});
