// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The short-draft hand-off: dismissing the composer
 * with fewer than five characters in the draft puts that text at the shell
 * prompt — raw, no Enter — and stands the typing intercept down, so the user
 * keeps typing in the terminal. Escape AND Ctrl+` both do it, because every user close behaves like every other.
 *
 * The five-character line is the user's own: "it should be less than 5
 * characters put in composer for that, if more than esc doesn't bring the
 * chars to the terminal."
 */

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    attachments: { stage: vi.fn(), pickFiles: vi.fn(async () => []), readLocal: vi.fn() },
    shell: { input: vi.fn(async () => true) },
    sftp: { readBinary: vi.fn() },
  },
}));

const PromptComposer = (await import('../../src/renderer/components/PromptComposer.vue')).default;
const { useComposerStore } = await import('../../src/renderer/stores/composer');
const { useShellsStore } = await import('../../src/renderer/stores/shells');
const { api } = await import('../../src/renderer/ipc');

type Store = ReturnType<typeof useComposerStore>;
let composer: Store;
let wrapper: VueWrapper;
let key: string;

beforeEach(async () => {
  document.body.innerHTML = '';
  vi.mocked(api.shell.input).mockClear();
  setActivePinia(createPinia());
  composer = useComposerStore();
  useShellsStore().register('main', 'shell-1');
  wrapper = mount(PromptComposer, {
    attachTo: document.body,
    // `connected` is passed explicitly: Vue casts an absent Boolean prop to
    // `false`, which would read as "connection down" and silence the hand-off.
    props: { connectionId: 'conn-1' as never, sessionName: 'main', connected: true },
  });
  key = composer.targetKey('conn-1', 'main');
  composer.setMode('docked');
  await nextTick();
});

afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = '';
});

/** Escape pressed in the draft — the rung that closes the panel. */
function pressEscape(): Promise<void> {
  return wrapper.find('.draft').trigger('keydown', { key: 'Escape' });
}

/** Ctrl+` pressed anywhere — caught by the window-level capture handler. */
function pressToggleChord(): Promise<void> {
  return wrapper.find('.draft').trigger('keydown', { key: '`', ctrlKey: true });
}

describe('a short draft is handed to the shell on close', () => {
  it('Escape writes it to the pane, raw, and clears the draft', async () => {
    composer.setDraft(key, 'ls');
    await pressEscape();
    // Fenced on the session (name, no workspace: a tmux row), so a stale
    // shell id refuses main-side instead of writing into a stranger's pane.
    expect(api.shell.input).toHaveBeenCalledWith('shell-1', 'ls', 'main', undefined);
    expect(composer.states[key]?.draft).toBe('');
    expect(composer.mode).toBe('hidden');
  });

  it('Ctrl+` does exactly what Escape does', async () => {
    composer.setDraft(key, 'ls');
    await pressToggleChord();
    expect(api.shell.input).toHaveBeenCalledWith('shell-1', 'ls', 'main', undefined);
    expect(composer.states[key]?.draft).toBe('');
    expect(composer.mode).toBe('hidden');
  });

  it('the write carries no Enter — the user continues typing there', async () => {
    composer.setDraft(key, 'ls');
    await pressEscape();
    const written = vi.mocked(api.shell.input).mock.calls[0]?.[1] ?? '';
    expect(written.includes('\r')).toBe(false);
    expect(written.includes('\n')).toBe(false);
  });

  it('typing keeps going to the shell until the composer is summoned again', async () => {
    composer.setDraft(key, 'ls');
    await pressEscape();
    expect(composer.terminalOwnsTyping).toBe(true);
    composer.setMode('docked');
    expect(composer.terminalOwnsTyping).toBe(false);
  });
});

describe('what must NOT be handed over', () => {
  it('five characters or more — the draft stays a draft', async () => {
    composer.setDraft(key, 'hello');
    await pressEscape();
    expect(api.shell.input).not.toHaveBeenCalled();
    expect(composer.states[key]?.draft).toBe('hello');
    expect(composer.mode).toBe('hidden');
  });

  it('a draft with a line break in it', async () => {
    composer.setDraft(key, 'a\nb');
    await pressEscape();
    expect(api.shell.input).not.toHaveBeenCalled();
    expect(composer.states[key]?.draft).toBe('a\nb');
  });

  it('anything at all when no shell is registered — an ordinary dismissal', async () => {
    useShellsStore().unregister('main', 'shell-1');
    composer.setDraft(key, 'ls');
    await pressEscape();
    expect(api.shell.input).not.toHaveBeenCalled();
    expect(composer.states[key]?.draft).toBe('ls');
  });

  it('anything at all when the connection is down', async () => {
    await wrapper.setProps({ connected: false });
    composer.setDraft(key, 'ls');
    await pressEscape();
    expect(api.shell.input).not.toHaveBeenCalled();
    expect(composer.states[key]?.draft).toBe('ls');
  });
});

describe('the hand-off is a gesture, not a preference', () => {
  it('nothing about it reaches the persisted blob', async () => {
    composer.setDraft(key, 'ls');
    await pressEscape();
    composer.persistNow();
    const layout = JSON.parse(
      localStorage.getItem('pocketshell.composer.visibility.v1') ?? '{}',
    ) as Record<string, unknown>;
    expect(layout).not.toHaveProperty('terminalOwnsTyping');
  });
});
