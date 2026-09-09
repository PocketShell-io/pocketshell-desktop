// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The chord half of sent-prompt history: Ctrl+↑ walks
 * back through what THIS session delivered, Ctrl+↓ walks forward, and one ↓
 * past the newest hands back the draft the walk started from.
 *
 * The store rules are pinned in composerStore.test.ts. What only a rendered
 * component can pin is where the keystrokes are intercepted and what they are
 * NOT: plain ↑/↓ must keep working as caret keys for editing the draft, so
 * recall only ever fires with Ctrl/Cmd held — no matter where the caret sits.
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
const { api } = (await import('../../src/renderer/ipc')) as unknown as {
  api: { shell: { input: ReturnType<typeof vi.fn> } };
};

type Store = ReturnType<typeof useComposerStore>;
let composer: Store;
let wrapper: VueWrapper;
let key: string;
let ta: HTMLTextAreaElement;

/** The draft textarea as the component holds it, focused with a set caret. */
async function caretAt(offset: number): Promise<void> {
  // Any pending draft patch must land first: writing `.value` resets the
  // selection, and the patch would silently undo the caret set below.
  await nextTick();
  ta.focus();
  ta.setSelectionRange(offset, offset);
}

function pressArrow(keyName: 'ArrowUp' | 'ArrowDown', ctrl = true): void {
  ta.dispatchEvent(
    new KeyboardEvent('keydown', { key: keyName, ctrlKey: ctrl, bubbles: true, cancelable: true }),
  );
}

beforeEach(async () => {
  document.body.innerHTML = '';
  setActivePinia(createPinia());
  composer = useComposerStore();
  const shells = useShellsStore();
  shells.register('main', 'shell-1');
  vi.mocked(api.shell.input).mockClear();
  wrapper = mount(PromptComposer, {
    attachTo: document.body,
    props: { connectionId: 'conn-1' as never, sessionName: 'main' },
  });
  key = composer.targetKey('conn-1', 'main');
  composer.setMode('docked');
  composer.recordSent(key, 'the older prompt');
  composer.recordSent(key, 'the newer prompt');
  await nextTick();
  ta = wrapper.find('textarea.draft').element as HTMLTextAreaElement;
});

describe('Ctrl+arrow recall in the draft', () => {
  it('Ctrl+↑ in an empty draft recalls the newest payload', async () => {
    await caretAt(0);
    pressArrow('ArrowUp');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the newer prompt');
    expect(ta.value).toBe('the newer prompt');
  });

  it('Ctrl+↑↑ walks older; Ctrl+↓↓ comes back through it and restores the draft', async () => {
    composer.setDraft(key, 'half-typed');
    await caretAt('half-typed'.length);

    pressArrow('ArrowUp');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the newer prompt');
    pressArrow('ArrowUp');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the older prompt');

    pressArrow('ArrowDown');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the newer prompt');
    pressArrow('ArrowDown');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('half-typed');
  });

  it('a recalled prompt resends on Enter', async () => {
    await caretAt(0);
    pressArrow('ArrowUp');
    await nextTick();
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    // The send waits out the 250ms submit gap before it can report delivery,
    // so wait for the clearance rather than for the first write.
    await vi.waitFor(() => expect(composer.states[key]?.draft).toBe(''));
    const written = String(api.shell.input.mock.calls[0]?.[1] ?? '');
    expect(written).toContain('the newer prompt');
    // The same entry still on top of the stack — one entry per prompt.
    expect(composer.states[key]?.history).toEqual(['the older prompt', 'the newer prompt']);
  });

  it('Ctrl+↑ recalls from ANY line — the chord, not the caret, decides', async () => {
    composer.setDraft(key, 'line one\nline two');
    await caretAt('line one\nline two'.length); // end: on the LAST line
    pressArrow('ArrowUp');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the newer prompt');
  });

  it('a plain ↑ never recalls — it stays a caret key for editing', async () => {
    await caretAt(0); // first line, empty otherwise: the old gate would recall here
    pressArrow('ArrowUp', false);
    await nextTick();
    expect(composer.states[key]?.draft).toBe('');
  });

  it('Ctrl+↓ does nothing when not browsing', async () => {
    composer.setDraft(key, 'just typing');
    await caretAt('just typing'.length);
    pressArrow('ArrowDown');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('just typing');
  });

  it('an edit after a recall ends the browse', async () => {
    await caretAt(0);
    pressArrow('ArrowUp');
    await nextTick();
    composer.setDraft(key, 'the newer prompt, edited');
    await nextTick();
    pressArrow('ArrowDown');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the newer prompt, edited');
  });

  it('with a selection the chord still recalls — it is an explicit request', async () => {
    composer.setDraft(key, 'select me');
    await nextTick(); // the draft patch lands, then the selection is ours
    ta.focus();
    ta.setSelectionRange(0, 6);
    pressArrow('ArrowUp');
    await nextTick();
    expect(composer.states[key]?.draft).toBe('the newer prompt');
  });
});
