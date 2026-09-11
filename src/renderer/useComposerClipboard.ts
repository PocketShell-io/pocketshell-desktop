import { ref, type ComputedRef, type Ref } from 'vue';
import { api } from './ipc';
import { useComposerStore } from './stores/composer';
import { decideClipboardPaste } from '../shared/clipboardPaste';
import { attachmentScopeKey } from '../shared/composerAttachments';
import type { AttachmentSource } from '../shared/types';
import type { ComposerDraftProps } from './useComposerDraft';

/**
 * A `ClipboardItem`, structurally.
 *
 * Written out rather than imported from lib.dom because src/shared compiles
 * under BOTH TS projects (see eslint.config.js) and the node one has no DOM
 * lib; keeping the shape here means the pure decision module never has to
 * mention a browser type at all.
 */
interface ReadableClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

export interface ComposerClipboardDeps {
  rootEl: Ref<HTMLElement | null>;
  composer: ReturnType<typeof useComposerStore>;
  /** Reactive props — staging reads them at call time, as the view did. */
  props: ComposerDraftProps;
  /** The composer's per-session key, for the store's staging call. */
  keyValue: ComputedRef<string>;
  /** The typing intercept's insert — the draft branch of a pasted text. */
  typeInto: (text: string) => void;
  /** The visibility half's open, so a pasted attachment summons the panel. */
  openComposer: () => void;
}

/**
 * Getting content INTO the composer: the staging pipeline every entry point
 * shares, the paste-to-attach handler, the Ctrl+V-at-the-terminal clipboard
 * reader, and the card's drag-and-drop. Extracted from PromptComposer.vue
 * with its reasoning.
 */
export function useComposerClipboard(deps: ComposerClipboardDeps): {
  dragActive: Ref<boolean>;
  stageSources: (sources: AttachmentSource[], previews?: (string | undefined)[]) => Promise<void>;
  stageFiles: (files: File[]) => Promise<void>;
  onAttachClick: () => Promise<void>;
  onPaste: (e: ClipboardEvent) => Promise<void>;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => Promise<void>;
  pasteFromSystemClipboard: () => Promise<void>;
  acceptDroppedFiles: (files: File[]) => Promise<void>;
} {
  const dragActive = ref(false);

  async function stageSources(
    sources: AttachmentSource[],
    previews?: (string | undefined)[],
  ): Promise<void> {
    if (sources.length === 0) return;
    await deps.composer.stage(deps.keyValue.value, {
      connectionId: deps.props.connectionId,
      scopeKey: attachmentScopeKey(deps.props.sessionName, deps.props.workspace),
      sources,
      ...(previews ? { previews } : {}),
    });
  }

  /** A local preview URL for image tiles. Never persisted. */
  function previewFor(file: File): string | undefined {
    if (!file.type.startsWith('image/')) return undefined;
    try {
      return URL.createObjectURL(file);
    } catch {
      return undefined;
    }
  }

  /** Read a File into a source. Prefers the path when Electron exposes one. */
  async function sourceFor(file: File): Promise<AttachmentSource> {
    const path = (file as File & { path?: string }).path;
    if (typeof path === 'string' && path !== '') {
      return { kind: 'file', path, name: file.name || null, mimeType: file.type || null };
    }
    // Electron >= 32 dropped `File.path`; a dropped file is read here instead and
    // crosses the bridge as bytes. Same staging path either way.
    const data = new Uint8Array(await file.arrayBuffer());
    return { kind: 'bytes', data, name: file.name || null, mimeType: file.type || null };
  }

  async function stageFiles(files: File[]): Promise<void> {
    const sources: AttachmentSource[] = [];
    const previews: (string | undefined)[] = [];
    for (const file of files) {
      sources.push(await sourceFor(file));
      previews.push(previewFor(file));
    }
    await stageSources(sources, previews);
  }

  async function onAttachClick(): Promise<void> {
    const paths = await api.attachments.pickFiles({ title: 'Attach to prompt', multiple: true });
    if (paths.length === 0) return; // cancelled
    await stageSources(paths.map((path) => ({ kind: 'file', path })));
  }

  /**
   * Paste-to-attach: a screenshot on the clipboard becomes a tile, plain
   * text pastes normally. This is the single biggest desktop ergonomics win over
   * the phone, which can only attach through the system file picker.
   */
  async function onPaste(e: ClipboardEvent): Promise<void> {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    await stageFiles(files);
  }

  // ---------------------------------------------------------------------------
  // Ctrl+V at the TERMINAL — the same paste, summoned from the other surface
  //
  // The user's request was "when I type ctrl+v in the terminal it should intercept
  // it and upload it to prompt composer". TerminalView cancels the chord and emits
  // `paste-into-composer`; everything from there is here, and deliberately so.
  //
  // The whole risk in this feature is building a SECOND clipboard-to-attachment
  // path beside `onPaste` — one that stages with slightly different rules, misses
  // the mime table `AttachmentStager` grew for PDFs and audio, or forgets the
  // single-flight guard in `composer.stage`. So nothing below stages anything: it
  // resolves the clipboard down to the two shapes this component already has an
  // entry point for, and calls them.
  //
  //    binary blobs -> `stageFiles`, the exact function `onPaste` calls
  //    text         -> `typeInto`, the exact function the typing intercept calls
  //
  // The only genuinely new work is READING the clipboard, and that is new only
  // because there is no ClipboardEvent to read it out of: a chord xterm handed us
  // is not a paste, so `clipboardData` does not exist and the asynchronous
  // `navigator.clipboard` API is the only way to ask.
  // ---------------------------------------------------------------------------

  /**
   * Every clipboard item, or none — never a throw.
   *
   * Same reasoning as `TerminalView.pasteFromClipboard`: a clipboard read needs a
   * permission the user can refuse and an API that Electron can decline to
   * expose, and neither is an error worth a banner. The user pressed a key and
   * nothing happened, which is a complete and honest outcome. An unhandled
   * rejection escaping into the void, in a handler wired to a keystroke that
   * fires as often as Ctrl+V, is not.
   *
   * The `typeof` guard is not paper over `read()` being missing in some exotic
   * browser — it is jsdom and any test double that stubs only `readText`.
   */
  async function readClipboardItems(): Promise<ReadableClipboardItem[]> {
    try {
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (typeof clipboard?.read !== 'function') return [];
      return [...((await clipboard.read()) as unknown as Iterable<ReadableClipboardItem>)];
    } catch {
      return [];
    }
  }

  /** The clipboard's text, or null when it could not be had. Never throws. */
  async function readClipboardText(): Promise<string | null> {
    try {
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (typeof clipboard?.readText !== 'function') return null;
      return await clipboard.readText();
    } catch {
      // Chromium rejects readText() outright for some non-text clipboards rather
      // than answering with ''. That is not a failure here: the item read above
      // has already told us whether there is anything to stage.
      return null;
    }
  }

  /**
   * The name every clipboard blob is staged under.
   *
   * No extension, on purpose. `AttachmentStager` derives one from the mime type
   * when a source arrives without its own (`sanitiseFilename(name, extensionFor
   * MimeType(mime))`, and src/main/attachments/mimeTypes.ts exists precisely for
   * "bytes plus a mime type and no filename"). Guessing `.png` here would be a
   * second, worse copy of that table, and it would be the copy that goes stale
   * the next time the real one grows a format.
   */
  const CLIPBOARD_ATTACHMENT_NAME = 'clipboard';

  /**
   * Put the system clipboard into THIS composer, whatever it happens to hold.
   *
   * Ordering matters in two places:
   *
   *  - The decision is taken BEFORE any blob is pulled. `getType()` copies the
   *    bytes, and a screenshot is routinely several megabytes; deciding first
   *    means a clipboard we are going to ignore costs one cheap type listing.
   *  - `openComposer()` happens BEFORE the await on `stageFiles`, so the panel is
   *    already up with its "Uploading…" row while the transfer runs. Opening
   *    afterwards would leave the user staring at an unchanged terminal for the
   *    length of an SFTP put with no sign their keystroke registered.
   *
   * And nothing opens the panel until there is something to put in it. An empty
   * clipboard — or one holding only a format the attachment path cannot use — is
   * `kind: 'none'`, and this returns having touched nothing: no mode change, no
   * focus change. A composer that pops open empty is worse than a keystroke that
   * did nothing, because the user has to put it away again.
   */
  async function pasteFromSystemClipboard(): Promise<void> {
    const items = await readClipboardItems();
    const action = decideClipboardPaste({
      items: items.map((item) => item.types),
      text: await readClipboardText(),
    });

    if (action.kind === 'none') return;

    if (action.kind === 'draft') {
      // The identical route a withheld keystroke takes: insert at the remembered
      // caret, open on the session's remembered mode, land the focus in the
      // draft. Pasting is typing that arrived all at once.
      deps.typeInto(action.text);
      return;
    }

    const files: File[] = [];
    for (const pick of action.picks) {
      const item = items[pick.item];
      if (!item) continue;
      try {
        const blob = await item.getType(pick.type);
        // A `File` rather than a bare `Blob` because `stageFiles` is the shared
        // path and it takes files — it reads `.name` and `.type` off them, and
        // `previewFor` keys the tile thumbnail off `.type`. Handing it the same
        // shape a real paste does is what keeps the two entry points on one code
        // path instead of two that merely look alike.
        files.push(new File([blob], CLIPBOARD_ATTACHMENT_NAME, { type: pick.type }));
      } catch {
        // The clipboard changed between the listing and the read, or the
        // platform refused this particular flavour. Skip it; a sibling pick may
        // still be good, and the `files.length === 0` check below is what turns
        // "all of them failed" back into "nothing visible".
      }
    }
    if (files.length === 0) return;

    deps.openComposer();
    await stageFiles(files);
  }

  /**
   * Only a drag carrying FILES may light this up.
   *
   * It used to accept any drag at all, which was harmless while nothing else in
   * the window was draggable. Tabs are now, and the tab
   * strip sits directly above this card — so dragging a tab past the composer
   * made it announce itself as a drop target for something it cannot accept. The
   * `drop` handler already found no files and did nothing; what was wrong was the
   * promise, not the outcome.
   *
   * `types.includes('Files')` is the standard test and is available during
   * `dragover`, unlike `dataTransfer.files`, which the browser deliberately keeps
   * empty until the drop. A tab drag carries only this app's own mime type, so it
   * fails the test without either side having to know about the other.
   */
  function onDragOver(e: DragEvent): void {
    if (!e.dataTransfer) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragActive.value = true;
  }

  function onDragLeave(e: DragEvent): void {
    if (deps.rootEl.value?.contains(e.relatedTarget as Node | null)) return;
    dragActive.value = false;
  }

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    dragActive.value = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    await stageFiles(files);
  }

  /**
   * Files dropped on the TERMINAL pane, routed here by `drop-into-composer`.
   *
   * A drop at the terminal is a summons, like the paste chords are: the panel
   * may be hidden, so it opens first — before the await, so the card is up with
   * its "Uploading…" row while the transfer runs (the ordering rule documented
   * on `pasteFromSystemClipboard`). Dropping ON the card never came through
   * here; that drag already found an open panel, and `onDrop` above owns it.
   */
  async function acceptDroppedFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    deps.openComposer();
    await stageFiles(files);
  }

  return {
    dragActive,
    stageSources,
    stageFiles,
    onAttachClick,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    pasteFromSystemClipboard,
    acceptDroppedFiles,
  };
}
