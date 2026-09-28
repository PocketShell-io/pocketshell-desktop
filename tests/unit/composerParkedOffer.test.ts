// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The parked-attachment offer, as rendered. The store tests pin the state
 * rules (what parks, what Include and Discard do); these pin the surface the
 * user actually answers the question on: the row exists, it is NOT staged
 * state (Send must not light up for it), and its two buttons do what they say.
 */

vi.mock('@ui/app/ipc', () => ({
  api: {
    attachments: { stage: vi.fn(), pickFiles: vi.fn(async () => []), readLocal: vi.fn() },
    shell: { input: vi.fn(async () => true) },
    sftp: { readBinary: vi.fn() },
  },
}));

const PromptComposer = (await import('@ui/app/components/PromptComposer.vue')).default;
const { useComposerStore } = await import('@ui/app/stores/composer');
const { COMPOSER_STRINGS } = await import('../../src/shared/composerText');

const A = '~/.pocketshell/attachments/main/20260824-101500-01-shot.png';

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

/** Park one attachment the way a bare dismissal would have. */
async function parkA(): Promise<void> {
  composer.seedAttachment(key, A);
  composer.parkAttachments(key);
  await nextTick();
}

describe('the parked offer row', () => {
  it('shows the file name, the caption, and the two answers', async () => {
    await parkA();
    const row = wrapper.find('.parked-row');
    expect(row.exists()).toBe(true);
    expect(row.find('.parked-name').text()).toBe('20260824-101500-01-shot.png');
    expect(row.find('.parked-caption').text()).toBe(COMPOSER_STRINGS.parkedCaption);
    expect(row.find('.parked-include').text()).toBe(COMPOSER_STRINGS.includeParked);
    expect(row.find('.parked-discard').text()).toBe(COMPOSER_STRINGS.discardParked);
  });

  it('is not staged state: no tile list, and Send stays dark until Include', async () => {
    await parkA();
    expect(wrapper.find('.tiles-wrap').exists()).toBe(false);
    expect(composer.canSend(key)).toBe(false);
    expect(composer.composedPayload(key)).toBe('');
  });

  it('Include moves the tile into the staged list and takes the offer down', async () => {
    await parkA();
    await wrapper.find('.parked-include').trigger('click');
    await nextTick();
    expect(wrapper.find('.parked-row').exists()).toBe(false);
    expect(wrapper.find('.tiles-wrap').exists()).toBe(true);
    expect(wrapper.find('.tiles-wrap').text()).toContain('20260824-101500-01-shot.png');
    expect(composer.canSend(key)).toBe(true);
    expect(composer.states[key]?.parked).toEqual([]);
  });

  it('Discard takes the offer down for good', async () => {
    await parkA();
    await wrapper.find('.parked-discard').trigger('click');
    await nextTick();
    expect(wrapper.find('.parked-row').exists()).toBe(false);
    expect(composer.states[key]?.parked).toEqual([]);
    expect(composer.canSend(key)).toBe(false);
  });

  it('is absent when nothing is parked', () => {
    expect(wrapper.find('.parked-wrap').exists()).toBe(false);
  });
});
