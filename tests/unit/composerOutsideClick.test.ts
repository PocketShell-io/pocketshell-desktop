// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * Click outside an EMPTY composer and it gets out of the way
 *.
 *
 * Every test here is really about the guard rather than the dismissal: the
 * dismissal is one line, and all the risk is in the cases that must NOT
 * dismiss. Losing a draft because the user clicked the terminal to read
 * something would be invisible until they went looking for it.
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

/** A press on `target`, the way the browser delivers one. */
function pressOn(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

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

/** Something in the app that is not the composer — the terminal, in effect. */
function outsideElement(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('click outside an empty composer', () => {
  it('closes it — the case the user asked for', () => {
    pressOn(outsideElement());
    expect(composer.mode).toBe('hidden');
  });

  it('does NOT suppress typing: a click dismisses the view, not the intent', () => {
    // Closing is all this press does, and there is no second, invisible state
    // it touches — the plain-terminal hatch that used to be armed by a press
    // in the terminal is gone (the user reported it as "when I start typing it
    // stopped showing the prompt composer"). Typing afterwards means the same
    // thing it means from any other closed state, which is the intercept's
    // business (FolderWorkspaceView's `interceptTyping`), not this handler's.
    pressOn(outsideElement());
    expect(composer.mode).toBe('hidden');
  });
});

describe('what must NOT dismiss it', () => {
  it('a draft — however casual the click', async () => {
    composer.setDraft(key, 'half a thought');
    await nextTick();
    pressOn(outsideElement());
    expect(composer.mode).toBe('docked');
  });

  it('a staged attachment, even with no text', async () => {
    composer.seedAttachment(key, '~/.pocketshell/attachments/main/shot.png');
    await nextTick();
    pressOn(outsideElement());
    expect(composer.mode).toBe('docked');
  });

  it('a failure banner, whose restored payload is the whole point', async () => {
    composer.restoreFailedSend(key, 'the prompt that did not go');
    await nextTick();
    pressOn(outsideElement());
    expect(composer.mode).toBe('docked');
  });

  it('whitespace, which IS empty — the store refuses to send it either', async () => {
    composer.setDraft(key, '   \n  ');
    await nextTick();
    pressOn(outsideElement());
    expect(composer.mode).toBe('hidden');
  });

  it('a press on the card itself', async () => {
    const card = wrapper.find('.composer').element;
    pressOn(card);
    await nextTick();
    expect(composer.mode).toBe('docked');
  });

  it('a press on the pinned toggle — no close-then-reopen flicker', async () => {
    // The toggle lives OUTSIDE the card but INSIDE the composer's layer. If the
    // outside handler fired on it, this press would close the panel and the
    // toggle's own click would reopen it, which reads as nothing happening.
    const rail = wrapper.find('.rail');
    pressOn(rail.element);
    await nextTick();
    expect(composer.mode).toBe('docked');

    // ...and the toggle's actual click still closes it, exactly once.
    await rail.trigger('click');
    expect(composer.mode).toBe('hidden');
  });

  it('a press on the card’s close button', async () => {
    const close = wrapper.findAll('.panel-action').at(-1)!;
    pressOn(close.element);
    await nextTick();
    expect(composer.mode).toBe('docked');
  });

  it('a press on a resize grip', async () => {
    pressOn(wrapper.find('.grip').element);
    await nextTick();
    expect(composer.mode).toBe('docked');
  });

  it('a DRAG that starts on the header and ends outside', async () => {
    // The card is movable: a move or resize routinely travels past its own
    // bounds before the button comes up. Gating on where the press LANDED is
    // what makes that safe, so this must not dismiss.
    pressOn(wrapper.find('.panel-header').element);
    const away = outsideElement();
    away.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    away.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(composer.mode).toBe('docked');
  });

  it('a press while it is already closed', () => {
    composer.setMode('hidden');
    pressOn(outsideElement());
    expect(composer.mode).toBe('hidden');
  });
});
