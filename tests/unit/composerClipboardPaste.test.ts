// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * Ctrl+V at the terminal, ROUTED.
 *
 * TerminalView cancels the chord and emits (terminalPasteChord.test.ts);
 * `decideClipboardPaste` says what the clipboard is worth (clipboardPaste
 * .test.ts). This file pins the join between them — that the composer reads the
 * clipboard, sends each shape down the entry point that already existed for it,
 * and opens itself only when there is something to show.
 *
 * The single most important assertion here is the negative one. `stage` must be
 * called with a `{kind:'bytes'}` source, exactly as a real paste into the
 * textarea produces, because "do not build a second attachment path" is the
 * whole design constraint on this feature. If this test ever has to assert
 * against a different IPC shape than a drop or a paste does, the paths have
 * forked.
 */

/** The IPC the staging path ends at. Typed by its ARGUMENT, which is the point:
 *  the assertions below are about the shape this feature hands the stager. */
interface StagePayload {
  connectionId: string;
  scopeKey: string;
  sources: { kind: string; data?: Uint8Array; name?: string | null; mimeType?: string | null }[];
}

const stage = vi.fn(async (_payload: StagePayload) => ({
  ok: true,
  paths: ['~/.pocketshell/attachments/main/0001-clipboard.png'],
  failedCount: 0,
}));

vi.mock('@ui/app/ipc', () => ({
  api: {
    attachments: { stage, pickFiles: vi.fn(async () => []), readLocal: vi.fn() },
    shell: { input: vi.fn(async () => true) },
    sftp: { readBinary: vi.fn() },
  },
}));

const PromptComposer = (await import('@ui/app/components/PromptComposer.vue')).default;
const { useComposerStore } = await import('@ui/app/stores/composer');

type Store = ReturnType<typeof useComposerStore>;
let composer: Store;
let wrapper: VueWrapper;
let key: string;

/** The exposed method TerminalView's `paste-into-composer` is wired to. */
function pasteFromSystemClipboard(): Promise<void> {
  return (wrapper.vm as unknown as { pasteFromSystemClipboard: () => Promise<void> })
    .pasteFromSystemClipboard();
}

/** A `ClipboardItem`, as much of one as this component actually touches. */
function clipboardItem(types: string[], bytes = new Uint8Array([137, 80, 78, 71])) {
  return {
    types,
    getType: vi.fn(async (type: string) => new Blob([bytes], { type })),
  };
}

/** Install a clipboard. `null` for `text` means `readText()` rejects. */
function setClipboard(opts: { items?: ReturnType<typeof clipboardItem>[]; text?: string | null }) {
  const value = {
    read: vi.fn(async () => opts.items ?? []),
    readText: vi.fn(async () => {
      if (opts.text === undefined || opts.text === null) throw new Error('not text');
      return opts.text;
    }),
    writeText: vi.fn(async () => {}),
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
  return value;
}

beforeEach(async () => {
  document.body.innerHTML = '';
  localStorage.clear();
  stage.mockClear();
  setActivePinia(createPinia());
  composer = useComposerStore();
  wrapper = mount(PromptComposer, {
    attachTo: document.body,
    props: { connectionId: 'conn-1' as never, sessionName: 'main' },
  });
  key = composer.targetKey('conn-1', 'main');
  // Start from the hard case: the panel is away. An explicit Ctrl+V has to get
  // through — and the intercept is only ever a fact about the panel's mode, so
  // hidden is the whole of "away".
  composer.dismiss();
  await nextTick();
});

describe('an image on the clipboard', () => {
  it('stages it through the same path a paste into the textarea uses', async () => {
    setClipboard({ items: [clipboardItem(['image/png'])], text: null });
    await pasteFromSystemClipboard();

    expect(stage).toHaveBeenCalledTimes(1);
    const call = stage.mock.calls[0]![0];
    expect(call.connectionId).toBe('conn-1');
    expect(call.scopeKey).toBe('main');
    expect(call.sources).toHaveLength(1);
    expect(call.sources[0]!.kind).toBe('bytes');
    expect(call.sources[0]!.mimeType).toBe('image/png');
    // No extension invented here: AttachmentStager derives one from the mime
    // type (src/main/attachments/mimeTypes.ts), and a second copy of that table
    // in the renderer is exactly the duplication this feature had to avoid.
    expect(call.sources[0]!.name).toBe('clipboard');
    expect(Array.from(call.sources[0]!.data ?? [])).toEqual([137, 80, 78, 71]);
  });

  it('opens the composer', async () => {
    setClipboard({ items: [clipboardItem(['image/png'])], text: null });
    await pasteFromSystemClipboard();

    expect(composer.mode).not.toBe('hidden');
  });

  it('shows the tile it just uploaded', async () => {
    setClipboard({ items: [clipboardItem(['image/png'])], text: null });
    await pasteFromSystemClipboard();
    await nextTick();

    expect(composer.states[key]!.attachments.map((a) => a.remotePath)).toEqual([
      '~/.pocketshell/attachments/main/0001-clipboard.png',
    ]);
  });

  it('asks the item only for the type that was chosen', async () => {
    // One `getType` per pick. It copies the bytes, so a handler that asked for
    // every flavour would move several megabytes to throw most of them away.
    const item = clipboardItem(['text/html', 'image/png', 'application/pdf']);
    setClipboard({ items: [item], text: 'ignored' });
    await pasteFromSystemClipboard();

    expect(item.getType).toHaveBeenCalledTimes(1);
    expect(item.getType).toHaveBeenCalledWith('image/png');
  });
});

describe('text on the clipboard', () => {
  it('lands in the draft and opens the composer', async () => {
    setClipboard({ text: 'deploy the thing' });
    await pasteFromSystemClipboard();

    expect(composer.states[key]!.draft).toBe('deploy the thing');
    expect(composer.mode).not.toBe('hidden');
    expect(stage).not.toHaveBeenCalled();
  });

  it('inserts at the remembered caret rather than appending', async () => {
    // The same rule the typing intercept follows, because it is the same
    // function: re-opening a half-written draft continues where you left off.
    composer.setDraft(key, 'run  now', 4);
    setClipboard({ text: 'it' });
    await pasteFromSystemClipboard();

    expect(composer.states[key]!.draft).toBe('run it now');
  });

  it('lands the keyboard in the draft, so a sentence can follow the paste', async () => {
    setClipboard({ text: 'look at this' });
    await pasteFromSystemClipboard();
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(wrapper.find('textarea.draft').element);
  });
});

describe('nothing usable — nothing visible', () => {
  /** The composer must be exactly as it was: away, untouched. */
  function expectUntouched(): void {
    expect(composer.mode).toBe('hidden');
    expect(composer.states[key]?.draft ?? '').toBe('');
    expect(stage).not.toHaveBeenCalled();
  }

  it('an empty clipboard does not open an empty composer', async () => {
    setClipboard({ items: [], text: '' });
    await pasteFromSystemClipboard();
    expectUntouched();
  });

  it('a format the composer cannot stage does not open it either', async () => {
    setClipboard({ items: [clipboardItem(['text/html'])], text: null });
    await pasteFromSystemClipboard();
    expectUntouched();
  });

  it('a blob that fails to read leaves nothing behind', async () => {
    // The clipboard changed between the listing and the read. Falling through
    // to an empty `stage` would show an "Uploading 1…" row for nothing.
    const item = clipboardItem(['image/png']);
    item.getType.mockRejectedValueOnce(new Error('gone'));
    setClipboard({ items: [item], text: null });
    await pasteFromSystemClipboard();
    expectUntouched();
  });
});

describe('a clipboard the browser will not hand over', () => {
  it('degrades quietly when read() is refused but text still works', async () => {
    // `read()` needs a permission `readText()` may not. Losing images to that
    // is acceptable; losing text with them would not be.
    const clipboard = setClipboard({ text: 'plain text survives' });
    clipboard.read.mockRejectedValueOnce(new Error('denied'));

    await expect(pasteFromSystemClipboard()).resolves.toBeUndefined();
    expect(composer.states[key]!.draft).toBe('plain text survives');
  });

  it('does nothing at all when both reads are refused', async () => {
    const clipboard = setClipboard({ text: null });
    clipboard.read.mockRejectedValueOnce(new Error('denied'));

    await expect(pasteFromSystemClipboard()).resolves.toBeUndefined();
    expect(composer.mode).toBe('hidden');
  });

  it('survives a runtime with no clipboard API at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    await expect(pasteFromSystemClipboard()).resolves.toBeUndefined();
    expect(composer.mode).toBe('hidden');
  });
});
