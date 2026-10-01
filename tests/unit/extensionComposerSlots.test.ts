// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick, type PropType } from 'vue';

/**
 * The shared PromptComposer's two extension slots (@ui/app/extensions):
 * `composer.accessory` (a chip row above the draft) and
 * `composer.inputSources` (sources beside the built-in controls). Empty,
 * neither leaves any element in the card; contributed, each gets a context
 * whose `insertText` types into this draft and whose `attachFiles` stages
 * through the drop's path.
 */

const stage = vi.fn(async () => ({ paths: ['~/.pocketshell/attachments/main/note.txt'], failures: [] }));

vi.mock('@ui/app/ipc', () => ({
  api: {
    attachments: { stage: (...a: unknown[]) => stage(...(a as [])), pickFiles: vi.fn(async () => []), readLocal: vi.fn() },
    shell: { input: vi.fn(async () => true) },
    sftp: { readBinary: vi.fn() },
  },
}));

const PromptComposer = (await import('@ui/app/components/PromptComposer.vue')).default;
const { useComposerStore } = await import('@ui/app/stores/composer');
const { provideExtensions } = await import('@ui/app/extensions');
type Ctx = import('@ui/app/extensions').ComposerExtensionContext;

let captured: Ctx | null = null;
const Snippet = defineComponent({
  props: { context: { type: Object as PropType<Ctx>, required: true } },
  setup(props) {
    captured = props.context;
    return () =>
      h('button', { class: 'snippet-chip', onClick: () => props.context.insertText('git status') }, props.context.sessionName);
  },
});
let wrapper: VueWrapper | null = null;

async function mountComposer(): Promise<VueWrapper> {
  const composer = useComposerStore();
  wrapper = mount(PromptComposer, { attachTo: document.body, props: { connectionId: 'conn-1' as never, sessionName: 'main' } });
  composer.setMode('docked');
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  setActivePinia(createPinia());
  captured = null;
  stage.mockClear();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  provideExtensions({});
});

describe('PromptComposer extension slots', () => {
  it('renders no slot element when nothing is contributed', async () => {
    const w = await mountComposer();
    expect(w.find('.composer').exists()).toBe(true);
    expect(w.find('.ps-extension-slot').exists()).toBe(false);
    expect(w.find('.composer-accessory').exists()).toBe(false);
    expect(w.find('.composer-input-sources').exists()).toBe(false);
  });

  it('renders the accessory above the draft and the source beside the controls', async () => {
    provideExtensions({
      'composer.accessory': [{ id: 'snippets', component: Snippet }],
      'composer.inputSources': [{ id: 'mic', component: Snippet }],
    });
    const w = await mountComposer();
    const accessory = w.get('[data-extension-slot="composer.accessory"]');
    expect(accessory.get('.snippet-chip').text()).toBe('main');
    // Above the draft: the accessory precedes the draft inside the panel body.
    const body = w.get('.panel-body').element;
    expect(body.firstElementChild?.getAttribute('data-extension-slot')).toBe('composer.accessory');
    expect(w.get('[data-extension-slot="composer.inputSources"]').find('.snippet-chip').exists()).toBe(true);
  });

  it('insertText types into this session draft at the caret', async () => {
    provideExtensions({ 'composer.accessory': [{ id: 'snippets', component: Snippet }] });
    const w = await mountComposer();
    await w.get('.snippet-chip').trigger('click');
    await nextTick();
    const composer = useComposerStore();
    expect(composer.states[composer.targetKey('conn-1', 'main')]?.draft).toBe('git status');
    expect((w.get('textarea.draft').element as HTMLTextAreaElement).value).toBe('git status');
  });

  it('attachFiles stages through the same pipeline as a drop', async () => {
    provideExtensions({ 'composer.inputSources': [{ id: 'mic', component: Snippet }] });
    await mountComposer();
    expect(captured).not.toBeNull();
    captured!.attachFiles([new File(['hi'], 'note.txt', { type: 'text/plain' })]);
    await vi.waitFor(() => expect(stage).toHaveBeenCalled());
    const composer = useComposerStore();
    const key = composer.targetKey('conn-1', 'main');
    await vi.waitFor(() =>
      expect(composer.states[key]?.attachments.map((a) => a.remotePath)).toEqual(['~/.pocketshell/attachments/main/note.txt']),
    );
  });
});
