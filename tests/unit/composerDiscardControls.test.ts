// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The two controls that answer "make this go away", which used to be one
 * button with the wrong scope: the error banner's Discard destroyed the whole
 * draft on a click the user read as "remove the failed attachment". Pinned
 * here at the component level because the trap lived in the wiring — which
 * button sat in the banner and what its click called — not in either store
 * action alone.
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

type Store = ReturnType<typeof useComposerStore>;
let composer: Store;
let wrapper: VueWrapper;
let key: string;

beforeEach(async () => {
  document.body.innerHTML = '';
  setActivePinia(createPinia());
  composer = useComposerStore();
  wrapper = mount(PromptComposer, {
    attachTo: document.body,
    props: { connectionId: 'conn-1' as never, sessionName: 'main' },
  });
  key = composer.targetKey('conn-1', 'main');
  composer.setMode('docked');
  await nextTick();
});

/** A failed send plants the worst case: an error banner over a real draft. */
async function withFailedSend(): Promise<void> {
  composer.restoreFailedSend(key, 'the dictated prompt');
  await nextTick();
}

function banner(): ReturnType<typeof wrapper.get> {
  return wrapper.get('.banner');
}

function discardButton(): ReturnType<typeof wrapper.get> {
  return wrapper.get('.controls .discard');
}

describe('the error banner', () => {
  it('dismisses the message and keeps the draft', async () => {
    await withFailedSend();
    expect(banner().text()).toContain('Not sent');

    await banner().get('.banner-x').trigger('click');

    expect(composer.states[key]?.error).toBeNull();
    expect(composer.states[key]?.draft).toBe('the dictated prompt');
  });
});

describe('the control-row Discard', () => {
  it('first click only arms it — the draft survives', async () => {
    await withFailedSend();

    await discardButton().trigger('click');

    expect(discardButton().text()).toBe('Discard draft?');
    expect(composer.states[key]?.draft).toBe('the dictated prompt');
  });

  it('second click discards draft and banner together', async () => {
    await withFailedSend();
    await discardButton().trigger('click');

    await discardButton().trigger('click');

    expect(composer.states[key]?.draft).toBe('');
    expect(composer.states[key]?.error).toBeNull();
  });

  it('an edit under the armed click disarms it', async () => {
    await withFailedSend();
    await discardButton().trigger('click');

    await wrapper.get('textarea.draft').setValue('edited instead');

    expect(discardButton().text()).toBe('Discard');
    await discardButton().trigger('click');
    expect(composer.states[key]?.draft).toBe('edited instead');
  });

  it('the arm times out on its own', async () => {
    vi.useFakeTimers();
    try {
      await withFailedSend();
      await discardButton().trigger('click');
      expect(discardButton().text()).toBe('Discard draft?');

      vi.advanceTimersByTime(5000);
      await nextTick();

      expect(discardButton().text()).toBe('Discard');
      await discardButton().trigger('click');
      expect(composer.states[key]?.draft).toBe('the dictated prompt');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Discard chord', () => {
  it('still discards in one stroke, no arm', async () => {
    await withFailedSend();

    await wrapper
      .get('textarea.draft')
      .trigger('keydown', { key: 'Backspace', ctrlKey: true, shiftKey: true });

    expect(composer.states[key]?.draft).toBe('');
  });
});
