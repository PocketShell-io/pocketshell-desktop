<script setup lang="ts">
// DoodleSheet: the composer's draw-or-annotate overlay — the five image
// sources, the step machine that routes between them, and the DoodleCanvas
// sheet itself, modal over the pane. Extracted from PromptComposer.vue with
// its reasoning; the composer's toolbar button and the tiles' Annotate action
// open it through the exposed `open` and `startFromAttachment`, and the
// finished drawing reaches the staged tiles through the `stageSources` prop —
// the composer's own staging path, so an annotated screenshot is an
// attachment like any other by the time it leaves this component.
//
// FIVE sources, one canvas. Whatever the origin, the image reaches
// DoodleCanvas as a URL and leaves it as PNG bytes, which drop straight into
// the `{kind:'bytes'}` staging path the clipboard already uses. No new upload
// code, no new remote-path logic.
//
// The fifth source is an image the user ALREADY ATTACHED, and it is the one
// that behaves differently on the way out. The other four produce a NEW tile;
// this one REPLACES an existing one, because "annotate the screenshot I just
// pasted" is an edit, not a second attachment. See `replaceWithAnnotation`
// for why that has to be a swap in place rather than a remove-and-reattach.
import { computed, ref } from 'vue';
import { api } from '../ipc';
import { useComposerStore } from '../stores/composer';
import AppIcon from './AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import DoodleCanvas from './DoodleCanvas.vue';
import RemoteImagePicker from './RemoteImagePicker.vue';
import { attachmentDisplayName, COMPOSER_STRINGS } from '../../shared/composerText';
import {
  absoluteAttachmentPath,
  attachmentScopeKey,
  replaceStagedAttachment,
} from '../../shared/composerAttachments';
import type { AttachmentSource, ConnectionId } from '../../shared/types';
import type { StagedAttachment } from '../stores/composer';

const props = defineProps<{
  connectionId: ConnectionId;
  sessionName: string;
  workspace?: string | null;
  /** The staged tiles, so an attached image can be opened for annotation. */
  attachments: StagedAttachment[];
  /** The composer's per-session key — the replacement swap files through it. */
  keyValue: string;
  /**
   * The composer's staging path, shared with paste/drop/pick so a new doodle
   * lands exactly where any other attachment lands.
   */
  stageSources: (sources: AttachmentSource[], previews?: (string | undefined)[]) => Promise<void>;
}>();

const composer = useComposerStore();

type DoodleStep = 'closed' | 'source' | 'loading' | 'remote' | 'draw';

const doodleStep = ref<DoodleStep>('closed');
const doodleBackdrop = ref<string | null>(null);
const doodleName = ref<string | null>(null);
const doodleError = ref<string | null>(null);

/**
 * The remote path of the staged attachment this drawing will REPLACE, or null
 * when the drawing is a new attachment.
 *
 * A path rather than an index: the tile list is the user's, and it can change
 * shape under a long-running upload. Matching on identity means a replacement
 * either lands on the right tile or lands nowhere at all, where an index could
 * quietly overwrite whatever slid into that position.
 */
const doodleReplacing = ref<string | null>(null);

/** The annotated PNG is on its way to the host; the sheet stays open for it. */
const doodleSaving = ref(false);

/**
 * The live sheet, for the one thing the parent cannot decide on its own:
 * whether closing is safe. See `dismissDoodle`.
 *
 * Typed by the one method it is reached for rather than by
 * `InstanceType<typeof DoodleCanvas>`: the SFC's instance type resolves to
 * `any` outside vue-tsc, which turns every use of it into an unsafe-call lint
 * error. Naming the contract explicitly is both stricter and more honest about
 * what the parent is allowed to do with the child.
 */
const doodleCanvas = ref<{ requestClose: () => void } | null>(null);

const doodleTitle = computed(() =>
  doodleStep.value === 'remote'
    ? 'Choose an image on the host'
    : doodleStep.value === 'loading'
      ? 'Annotate'
      : doodleStep.value === 'draw'
        ? doodleBackdrop.value
          ? 'Annotate'
          : 'Doodle'
        : 'Draw or annotate',
);

/**
 * Bytes to a `data:` URL.
 *
 * FileReader rather than btoa over a binary string: btoa needs the bytes
 * widened to a JS string first, which for a multi-megabyte screenshot means
 * building a string of a million-plus code units before any encoding starts.
 * The CSP is also the reason this is a data URL and not an object URL — see
 * index.html; blob: is granted for tile thumbnails, but data: keeps every
 * backdrop source on one path.
 */
function bytesToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL always yields a string, but `result` is typed for every
      // read mode; narrow rather than coercing, so an ArrayBuffer could never
      // stringify to "[object ArrayBuffer]" and reach an <img> as a broken src.
      if (typeof reader.result === 'string') done(reader.result);
      else fail(new Error('Could not read the image.'));
    };
    reader.onerror = () => fail(new Error('Could not read the image.'));
    reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
  });
}

/** Guess a mime type from an extension; the decoder sniffs the real one anyway. */
function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif' || ext === 'webp' || ext === 'avif' || ext === 'png') return `image/${ext}`;
  return 'application/octet-stream';
}

function openDoodle(): void {
  doodleBackdrop.value = null;
  doodleName.value = null;
  doodleError.value = null;
  doodleReplacing.value = null;
  doodleStep.value = 'source';
}

function closeDoodle(): void {
  doodleStep.value = 'closed';
  doodleBackdrop.value = null;
  doodleName.value = null;
  doodleError.value = null;
  doodleReplacing.value = null;
  doodleSaving.value = false;
}

/**
 * Every way out of the doodle overlay, funnelled through the canvas.
 *
 * `OverlayPanel` closes on Escape and on a backdrop click, and until now both
 * went straight to `closeDoodle`, which unmounts the sheet and takes the
 * drawing with it — no confirmation, no undo, because undo lives inside the
 * component that just disappeared. Backdrop clicks are the easy mouse error to
 * make against a modal, and this modal is one the user may have spent a minute
 * drawing in.
 *
 * The decision belongs to the canvas rather than here, because only the canvas
 * knows whether there is anything to lose. It answers immediately for an empty
 * sheet, so a doodle opened by mistake still closes with one Escape.
 *
 * This fixes the discard for EVERY doodle source, not just the annotate-an-
 * attachment path that prompted it: the loss is the same whether the strokes
 * were drawn over a pasted screenshot or over a blank sheet.
 */
function dismissDoodle(): void {
  const canvas = doodleCanvas.value;
  if (doodleStep.value === 'draw' && canvas) {
    canvas.requestClose();
    return;
  }
  closeDoodle();
}

function startBlank(): void {
  doodleBackdrop.value = null;
  doodleName.value = null;
  doodleStep.value = 'draw';
}

/**
 * Pull an image straight off the system clipboard.
 *
 * Separate from the composer's own paste handler: that path fires when the
 * user pastes INTO the textarea and stages the image as-is, which is still the
 * right default. This is the deliberate "take what I just copied and let me
 * draw on it" route, so it reads the clipboard on demand rather than waiting
 * for a keystroke.
 */
async function startFromClipboard(): Promise<void> {
  doodleError.value = null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      doodleBackdrop.value = await bytesToDataUrl(
        new Uint8Array(await blob.arrayBuffer()),
        type,
      );
      doodleName.value = `clipboard.${type.slice('image/'.length)}`;
      doodleStep.value = 'draw';
      return;
    }
    doodleError.value = 'No image on the clipboard.';
  } catch {
    doodleError.value = 'Could not read the clipboard.';
  }
}

async function startFromLocalFile(): Promise<void> {
  doodleError.value = null;
  const paths = await api.attachments.pickFiles({ title: 'Pick an image', multiple: false });
  const path = paths[0];
  if (path === undefined) return; // cancelled
  try {
    const bytes = await api.attachments.readLocal(path);
    const name = path.split(/[\\/]/).pop() ?? 'image';
    doodleBackdrop.value = await bytesToDataUrl(bytes, mimeForName(name));
    doodleName.value = name;
    doodleStep.value = 'draw';
  } catch (e) {
    doodleError.value = e instanceof Error ? e.message : 'Could not open that file.';
  }
}

async function onRemotePick(picked: { path: string; name: string }): Promise<void> {
  doodleError.value = null;
  try {
    const bytes = await api.sftp.readBinary(props.connectionId, picked.path);
    doodleBackdrop.value = await bytesToDataUrl(bytes, mimeForName(picked.name));
    doodleName.value = picked.name;
    doodleStep.value = 'draw';
  } catch (e) {
    doodleError.value = e instanceof Error ? e.message : 'Could not open that file.';
    doodleStep.value = 'source';
  }
}

/**
 * Open an image the user ALREADY ATTACHED, so it can be marked up in place.
 *
 * ## Where the pixels come from, and why there are two answers
 *
 * Attachments are staged EAGERLY — `AttachmentStager` uploads the bytes when
 * the file is pasted, dropped or picked, not when the prompt is sent — so by
 * the time a tile exists the host already has an authoritative copy. That
 * makes the remote read a correct fallback for every tile, including ones
 * restored from localStorage in a later run of the app.
 *
 * But it is a round trip, and for the case the user actually hits most — a
 * screenshot pasted five seconds ago — the exact same bytes are already in
 * this renderer, held open by the object URL behind the tile's thumbnail. So
 * the local preview is tried first: no network, no failure mode, instant even
 * on a dead connection. The remote read only runs for tiles that never carried
 * a preview (the paperclip picker attaches by path) or lost it to a restart.
 *
 * The remote path needs un-abbreviating first. The stager hands back `~/`-form
 * display paths because that is the form worth pasting into a prompt, and SFTP
 * has no shell to expand a tilde — see `absoluteAttachmentPath`.
 */
async function startFromAttachment(remotePath: string): Promise<void> {
  const attachment = props.attachments.find((a) => a.remotePath === remotePath);
  if (!attachment) return;

  doodleError.value = null;
  doodleBackdrop.value = null;
  doodleName.value = attachment.displayName;
  doodleReplacing.value = remotePath;

  const preview = attachment.previewDataUrl;
  if (preview !== undefined) {
    doodleStep.value = 'draw';
    doodleBackdrop.value = preview;
    return;
  }

  // Only now is the overlay worth opening on its own: a remote read is the one
  // branch slow enough to need somewhere to say so, and somewhere to put an
  // error that is not the source chooser (which would be a confusing answer to
  // "annotate this tile").
  doodleStep.value = 'loading';
  try {
    const home = await api.sftp.realPath(props.connectionId, '.');
    const bytes = await api.sftp.readBinary(
      props.connectionId,
      absoluteAttachmentPath(remotePath, home),
    );
    // A tile only reaches here when `classifyByName` called it an image, so the
    // extension is a good enough mime hint; the decoder sniffs the truth.
    doodleBackdrop.value = await bytesToDataUrl(bytes, mimeForName(attachment.displayName));
    doodleStep.value = 'draw';
  } catch (e) {
    doodleError.value = e instanceof Error ? e.message : 'Could not open that image.';
  }
}

/** The finished drawing joins the staged tiles as ordinary PNG bytes. */
async function onDoodleCommit(result: {
  data: Uint8Array;
  dataUrl: string;
  name: string;
}): Promise<void> {
  const target = doodleReplacing.value;
  if (target !== null) {
    await replaceWithAnnotation(target, result);
    return;
  }
  closeDoodle();
  await props.stageSources(
    [{ kind: 'bytes', data: result.data, name: result.name, mimeType: 'image/png' }],
    [result.dataUrl],
  );
}

/**
 * Upload the annotated PNG and swap it for the tile it was drawn from.
 *
 * ## Replace, not keep-alongside
 *
 * The user said "annotate the image I attached", which is a sentence about ONE
 * image. Keeping both would double every attachment anyone marks up, and the
 * prompt would then carry a clean copy and a scribbled copy of the same
 * screenshot with nothing to tell the agent which one to believe. The
 * annotated version supersedes the original, and the recovery path is the
 * sheet's own undo stack while it is still open — which is why cancelling now
 * asks before it throws that stack away.
 *
 * ## Why the swap has to be in place
 *
 * The remote paths are folded into the prompt in TILE ORDER at send time
 *. A draft that says "compare the first screenshot with the second" is
 * a statement about this list's ordering, so annotating the first must not
 * move it to the end — which is exactly what remove-then-reattach would do,
 * and is why this does not simply call `removeAttachment` and `stage`.
 *
 * ## Why the staging call is here and not in the store
 *
 * The store's `stage` is a batch APPEND with a single-flight guard and its own
 * error banner; none of those three things is right for this. A replacement is
 * one file, it must land at a known index, and its failure belongs on the
 * still-open sheet — where the drawing survives and Attach can simply be
 * pressed again — rather than in a banner behind a modal the user cannot see
 * past.
 *
 * ## What happens to the original on the host
 *
 * Nothing, deliberately. It stops being referenced by any tile, and
 * `AttachmentRetentionPolicy` is the thing that owns the lifetime of files in
 * `~/.pocketshell/attachments` — it keeps the newest 20 per scope and expires
 * the rest. Deleting eagerly would mean a new privileged IPC channel that can
 * remove remote files, to reclaim a screenshot inside a directory that already
 * prunes itself, and the pruner's 24-hour protect window means such a delete
 * would be the ONLY way that file could go early. Not worth the channel.
 */
async function replaceWithAnnotation(
  target: string,
  result: { data: Uint8Array; dataUrl: string; name: string },
): Promise<void> {
  doodleError.value = null;
  doodleSaving.value = true;
  try {
    const staged = await api.attachments.stage({
      connectionId: props.connectionId,
      scopeKey: attachmentScopeKey(props.sessionName, props.workspace),
      sources: [
        { kind: 'bytes', data: result.data, name: result.name, mimeType: 'image/png' },
      ],
    });
    const path = staged.paths[0];
    if (path === undefined) {
      doodleError.value =
        staged.error ?? COMPOSER_STRINGS.attachmentFailed('the upload did not land');
      return;
    }

    const session = composer.ensure(props.keyValue);
    const superseded = session.attachments.find((a) => a.remotePath === target)?.previewDataUrl;
    const next = replaceStagedAttachment(session.attachments, target, {
      remotePath: path,
      displayName: attachmentDisplayName(path),
      mimeType: 'image/png',
      previewDataUrl: result.dataUrl,
    });
    // The tile vanished under the upload. Unreachable through the UI today —
    // the sheet is modal, so neither `×` nor Discard nor Send is clickable
    // while it is open — but if it ever becomes reachable, doing nothing is
    // the right answer: re-adding an attachment the user has just removed
    // would be a worse surprise than losing a drawing they walked away from.
    if (next === null) {
      closeDoodle();
      return;
    }
    session.attachments = next;
    // Direct assignment, then an explicit flush. The store debounces its own
    // writes through a private scheduler; this reaches the same blob through
    // the public one. See the report note about folding this into a
    // `replaceAttachment` store action once that file is free.
    composer.persistNow();
    // The superseded tile was the last holder of its object URL, and an object
    // URL pins the whole decoded image until it is revoked. Annotating a 4 MB
    // screenshot would otherwise keep the original resident for the life of the
    // window ALONGSIDE the annotated copy that replaced it — and re-annotating
    // repeatedly would stack one such copy per pass. Safe here specifically
    // because the sheet has already finished with it: the backdrop was decoded
    // into an `HTMLImageElement` at load time and the canvas is about to
    // unmount.
    if (superseded !== undefined && superseded.startsWith('blob:')) {
      URL.revokeObjectURL(superseded);
    }
    closeDoodle();
  } catch (e) {
    doodleError.value =
      e instanceof Error
        ? COMPOSER_STRINGS.attachmentFailed(e.message)
        : COMPOSER_STRINGS.attachmentFailed('upload failed');
  } finally {
    doodleSaving.value = false;
  }
}

defineExpose({ open: openDoodle, startFromAttachment });
</script>

<template>
  <!-- The drawing surface is modal because it takes a pointer drag as its
       primary input: with the composer still live behind it, a stroke that
       left the canvas would land in the draft. The wrapper takes pointer
       events back: everything in this component is transparent to the mouse
       by default so the terminal underneath stays clickable. -->
  <div v-if="doodleStep !== 'closed'" class="modal-layer">
    <OverlayPanel
      :title="doodleTitle"
      size="md"
      @close="dismissDoodle"
    >
      <div v-if="doodleStep === 'source'" class="doodle-sources">
        <p v-if="doodleError" class="doodle-error">{{ doodleError }}</p>
        <button class="source" type="button" @click="startBlank">
          <AppIcon name="edit-2" />
          <span class="source-label">Blank sheet</span>
          <span class="source-hint">Sketch something from nothing</span>
        </button>
        <button class="source" type="button" @click="startFromClipboard">
          <AppIcon name="image" />
          <span class="source-label">From the clipboard</span>
          <span class="source-hint">Annotate the screenshot you just copied</span>
        </button>
        <button class="source" type="button" @click="startFromLocalFile">
          <AppIcon name="folder" />
          <span class="source-label">From this computer…</span>
          <span class="source-hint">Pick an image file to draw on</span>
        </button>
        <button class="source" type="button" @click="doodleStep = 'remote'">
          <AppIcon name="symlink" />
          <span class="source-label">From the host…</span>
          <span class="source-hint">Browse images already on the server</span>
        </button>
      </div>

      <RemoteImagePicker
        v-else-if="doodleStep === 'remote'"
        :connection-id="connectionId"
        @pick="onRemotePick"
        @close="doodleStep = 'source'"
      />

      <!-- Fetching an attached image back off the host. Its own step rather
           than a spinner over an empty canvas, because a blank sheet that
           turns into a screenshot looks like the wrong thing opened, and a
           failed read needs somewhere to be read that is not the source
           chooser. -->
      <div v-else-if="doodleStep === 'loading'" class="doodle-loading">
        <p v-if="doodleError" class="doodle-error">{{ doodleError }}</p>
        <p v-else class="muted">Opening {{ doodleName }}&hellip;</p>
      </div>

      <div v-else class="doodle-draw">
        <!-- The sheet's own `loadError` covers a backdrop that would not
             decode; this covers the upload on the way back out, which the
             canvas has no way to know about. -->
        <p v-if="doodleError" class="doodle-error">{{ doodleError }}</p>
        <DoodleCanvas
          ref="doodleCanvas"
          :backdrop="doodleBackdrop"
          :backdrop-name="doodleName"
          :saving="doodleSaving"
          @commit="onDoodleCommit"
          @close="closeDoodle"
        />
      </div>
    </OverlayPanel>
  </div>
</template>

<style scoped>
/* Everything in this block styles THIS component's markup and was carried
   verbatim from PromptComposer.vue's stylesheet — scoped styles do not cross
   the component boundary, so the rules live beside the overlay they draw. */

/* ---- Doodle source chooser --------------------------------------------- */
.doodle-sources {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* A row per source rather than a row of icon buttons: three of the four need a
   sentence to distinguish them ("from this computer" vs "from the host" is the
   whole distinction), and a tooltip is the wrong place for the only thing that
   tells them apart. */
.source {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas: 'icon label' 'icon hint';
  align-items: center;
  gap: 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.source:hover {
  background: var(--state-hover);
  border-color: var(--border-strong);
}
.source:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.source > :first-child {
  grid-area: icon;
  color: var(--fg-secondary);
}
.source-label {
  grid-area: label;
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
}
.source-hint {
  grid-area: hint;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
.doodle-error {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-200);
  color: var(--error);
}
/* The sheet's own layout is a column that must not be disturbed by the error
   line above it, so the wrapper is a column too rather than a bare div. */
.doodle-draw,
.doodle-loading {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}
</style>
