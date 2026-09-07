// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * Dropping a file on the TERMINAL, ROUTED — the composer half of the join.
 *
 * TerminalView recognises the gesture and emits the bare File objects
 * (terminalFileDrop.test.ts); this file pins what happens from there. The
 * assertion that matters most is the shape one: `stage` must be called with
 * the sources a drop on the card's own zone would produce, because the whole
 * constraint on this feature is that the terminal is a new PLACE to drop, not
 * a new PATH to stage. If these assertions ever have to name a different IPC
 * shape than the card drop or the paste use, the paths have forked.
 *
 * The second pinned behaviour is the summons: the panel may be hidden when the
 * file lands, and a drop is an explicit instruction like Ctrl+V — it opens the
 * panel rather than staging silently into a sheet the user cannot see.
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
  paths: ['~/.pocketshell/attachments/main/0001-report.pdf'],
  failedCount: 0,
}));

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    attachments: { stage, pickFiles: vi.fn(async () => []), readLocal: vi.fn() },
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

/** The exposed method TerminalView's `drop-into-composer` is wired to. */
function acceptDroppedFiles(files: File[]): Promise<void> {
  return (wrapper.vm as unknown as { acceptDroppedFiles: (files: File[]) => Promise<void> })
    .acceptDroppedFiles(files);
}

/** A dropped file, as much of one as `sourceFor` reads: name, type, bytes. */
function droppedFile(name: string, type: string, bytes = new Uint8Array([1, 2, 3])): File {
  return new File([bytes], name, { type });
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
  // Start from the hard case: the panel is away. The drop happens at the
  // terminal, where the composer's own drop zone is not.
  composer.dismiss();
  await nextTick();
});

describe('a file dropped on the terminal pane', () => {
  it('stages it through the same path a drop on the card uses', async () => {
    await acceptDroppedFiles([droppedFile('report.pdf', 'application/pdf')]);

    expect(stage).toHaveBeenCalledTimes(1);
    const call = stage.mock.calls[0]![0];
    expect(call.connectionId).toBe('conn-1');
    expect(call.scopeKey).toBe('main');
    expect(call.sources).toHaveLength(1);
    expect(call.sources[0]!.kind).toBe('bytes');
    expect(call.sources[0]!.name).toBe('report.pdf');
    expect(call.sources[0]!.mimeType).toBe('application/pdf');
    expect(Array.from(call.sources[0]!.data ?? [])).toEqual([1, 2, 3]);
  });

  it('summons the panel — a hidden composer must not swallow the file', async () => {
    await acceptDroppedFiles([droppedFile('shot.png', 'image/png')]);

    expect(composer.mode).not.toBe('hidden');
  });

  it('opens the panel BEFORE the upload runs, so the wait is visible', async () => {
    // The ordering rule pasteFromSystemClipboard documents: opening after the
    // await leaves the user staring at an unchanged terminal for the length of
    // an SFTP put with no sign the drop registered. Hold the stager open and
    // check the mode while the upload is still in flight.
    let release!: (result: { ok: boolean; paths: string[]; failedCount: number }) => void;
    stage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = acceptDroppedFiles([droppedFile('big.zip', 'application/zip')]);
    // Let the awaits in front of the stager (the File read, the store's
    // single-flight check) drain before the panel's state is judged.
    await new Promise((r) => setTimeout(r, 0));
    expect(composer.mode).not.toBe('hidden');
    release({ ok: true, paths: ['~/.pocketshell/attachments/main/0001-big.zip'], failedCount: 0 });
    await pending;
  });

  it("keeps the file's own name — no clipboard-style stand-in is invented", async () => {
    // The clipboard path stages under 'clipboard' because a paste has no name.
    // A dropped file does, and `sourceFor` preserves it; the sanitiser and the
    // mime table downstream only ever default what is missing.
    await acceptDroppedFiles([droppedFile('my notes.txt', 'text/plain')]);

    expect(stage.mock.calls[0]![0].sources[0]!.name).toBe('my notes.txt');
  });

  it('attaches the tile it just uploaded', async () => {
    await acceptDroppedFiles([droppedFile('report.pdf', 'application/pdf')]);
    await nextTick();

    expect(composer.states[key]!.attachments.map((a) => a.remotePath)).toEqual([
      '~/.pocketshell/attachments/main/0001-report.pdf',
    ]);
  });
});

describe('a drop carrying nothing stageable', () => {
  it('opens nothing and stages nothing', async () => {
    // Mirrors the clipboard rule: a panel that pops open empty is worse than a
    // gesture that does nothing, because the user has to put it away again.
    // (In practice TerminalView filters empty drags before emitting; the
    // exposed entry refuses them at its own door too.)
    await acceptDroppedFiles([]);

    expect(stage).not.toHaveBeenCalled();
    expect(composer.mode).toBe('hidden');
  });
});
