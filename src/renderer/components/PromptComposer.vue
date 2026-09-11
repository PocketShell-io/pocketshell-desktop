<script setup lang="ts">
// PromptComposer: the app's primary interaction surface — compose a prompt,
// stage attachments, submit it into the session's tmux pane.
//
// CHROME: this is a FLOATING card, not a phone bottom sheet and no longer a
// docked bar. It hovers over the bottom-right of the session body — inset from
// the edges on every side, its own rounded corners, an elevation shadow all
// round, and only as wide as a prompt needs (~80 mono columns) so terminal
// output stays readable beside it. A sash on its top edge resizes it
// (row-resize cursor, min 190px, max 80% of the body), its height is remembered
// per session across hide/show, and a small toolbar row carries the panel title
// on the left with maximize/restore and close on the right. `Ctrl+\`` toggles
// it, matching VS Code muscle memory — and so does ONE fixed toggle pinned to
// the pane's bottom-right corner, which is present whether the card is open or
// closed and is the only control that opens and closes it. That toggle is a
// small icon button; a pip on it says a draft is waiting.
//
// NOTHING here occupies terminal space. The composer is a pure overlay: the
// pane behind it is sized as if the composer did not exist, so the terminal
// gets every row of the window.
//
// The card overlays the terminal instead of splitting the pane with it, and
// that is the point: see the block comment on `.composer-dock` in
// FolderWorkspaceView.vue. The terminal's ROW COUNT never changes when the
// composer opens, closes, moves or is dragged — no SSH window-change, no
// remote tmux reflow — because the composer contributes NOTHING to the tab
// body's layout in any state.
//
// It is mounted ONCE per session workspace, outside the tab body, so the draft,
// the caret and the staged tiles survive a tab switch.
// The draft, its attachments and the dragged height live in stores/composer.ts
// keyed by session, so switching sessions swaps records rather than destroying
// a draft; open-vs-closed does NOT, because that is a preference about the tool
// rather than a fact about a session.
//
// Three deliberate divergences from the Android original:
//
//  1. A third `hidden` mode that leaves the toggle behind, instead of
//     the phone's "the sheet is simply gone". A preserved "Not sent" draft must
//     stay discoverable; the toggle wears a pip when one is waiting.
//  2. A successful send does NOT hide the composer. The phone dismisses
//     its sheet on delivery because a modal sheet occludes the terminal on a
//     phone screen; here the composer is where the user works, so it stays open
//     and focused, ready for the next prompt.
//  3. The payload is bracketed-paste framed by this renderer. Android
//     gets that for free from `tmux -CC` control mode; we write into a plain PTY
//     running `tmux attach`, and without the framing every line of an
//     `Attached files:` block becomes a separate agent prompt.
//
// What it does NOT do, and must not grow: it never mutates the draft when you
// attach something (the paths are folded in at send time only), it never
// clears the draft optimistically on send (#745), and Escape never destroys
// work — only Discard does.
//
// The clusters moved whole, comments and all, and this file is what binds
// them: the per-session model, slash palette and draft editing to
// useComposerDraft, send and the armed Discard to useComposerSend, the
// staging/paste/drag-and-drop pipeline to useComposerClipboard, the mode
// machine and keyboard to useComposerVisibility, the move/resize machinery to
// useComposerGeometry, the draw-or-annotate overlay to DoodleSheet.vue, and
// the control row to ComposerControls.vue.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useComposerStore } from '../stores/composer';
import { useSettingsStore } from '../stores/settings';
import { useShellsStore } from '../stores/shells';
import ComposerAttachmentTiles from './ComposerAttachmentTiles.vue';
import SlashCommandDropdown from './SlashCommandDropdown.vue';
import AppIcon from './AppIcon.vue';
import DoodleSheet from './DoodleSheet.vue';
import ComposerControls from './ComposerControls.vue';
import { COMPOSER_STRINGS } from '../../shared/composerText';
import type { ComposerAgentKind } from '../../shared/composerSend';
import type { ConnectionId } from '../../shared/types';
import { useComposerDraft } from '../useComposerDraft';
import { useComposerSend } from '../useComposerSend';
import { useComposerClipboard } from '../useComposerClipboard';
import { useComposerVisibility } from '../useComposerVisibility';
import { useComposerGeometry } from '../useComposerGeometry';

const props = defineProps<{
  connectionId: ConnectionId;
  /**
   * Session name — the composer's identity. For attachments it is the TAG
   * half of the scope: with a workspace the uploads nest
   * `<workspace>/<name>`, without one the name is the whole scope (see
   * `attachmentScopeKey`).
   */
  sessionName: string;
  /**
   * Which runtime owns the session, and (for aplexer) which workspace.
   * Together with the name they form the registry identity: a bare tag
   * repeats across workspaces, so without these two same-named tags would
   * share one draft and one shell. Absent means tmux, whose names are
   * host-global. See `renderer/sessionIdentity.ts`.
   */
  backend?: 'tmux' | 'aplexer';
  workspace?: string | null;
  /** The engine running in this pane. Null until agent detection exists. */
  agentKind?: ComposerAgentKind | null;
  /** False while the SSH connection is down — advisory only, never a block. */
  connected?: boolean;
}>();

const emit = defineEmits<{ (e: 'focus-terminal'): void }>();

const composer = useComposerStore();
const shells = useShellsStore();
// Read through the store on every use, never copied into a local: a switch
// flipped in Settings has to take effect on the next keystroke, not the next
// mount.
const settings = useSettingsStore();

const rootEl = ref<HTMLDivElement | null>(null);

/**
 * The model half — the per-session record, the pip/empty gates, the slash
 * palette and the caret/focus machinery of the textarea — moved whole,
 * comments and all, to ../useComposerDraft.ts.
 */
const draft = useComposerDraft({ composer, props });
const {
  key,
  state,
  mode,
  attachments,
  toggle,
  caret,
  activeCommand,
  slashOpen,
  slashCommands,
  acceptCommand,
  onSlashButton,
  syncCaret,
  onInput,
  focusDraft,
  draftEl,
} = draft;

/** Hand the keyboard to the terminal — the card's one outward announce. */
const focusTerminal = (): void => emit('focus-terminal');

/**
 * Send and the armed Discard moved whole to ../useComposerSend.ts.
 */
const send = useComposerSend({
  composer,
  shells,
  settings,
  draft: { key: draft.key, sessionKey: draft.sessionKey, state: draft.state, focusDraft: draft.focusDraft },
  props,
  focusTerminal,
});
const { canSend, discardArmed, onDiscardClick, onSend } = send;

/**
 * The staging pipeline, paste-to-attach, the terminal-side clipboard reader
 * and drag-and-drop moved whole to ../useComposerClipboard.ts. `typeInto` and
 * `openComposer` belong to the visibility half below; the arrows here read
 * them lazily, at call time, exactly where the original called them.
 */
const {
  dragActive,
  stageSources,
  onAttachClick,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  pasteFromSystemClipboard,
  acceptDroppedFiles,
} = useComposerClipboard({
  rootEl,
  composer,
  props,
  keyValue: draft.key,
  typeInto: (text) => typeInto(text),
  openComposer: () => openComposer(),
});

/**
 * The visibility state machine and its keyboard — open, dismiss, the fixed
 * toggle, maximize, the Escape ladder, outside-click, the draft's keydown and
 * the window's global chords — moved whole to ../useComposerVisibility.ts.
 */
const {
  openComposer,
  hideComposer,
  onToggleRail,
  typeInto,
  toggleExpanded,
  onOutsidePointerDown,
  onDraftKeydown,
  onRootKeydown,
  onGlobalKey,
} = useComposerVisibility({
  composer,
  shells,
  settings,
  props,
  sessionKey: draft.sessionKey,
  key: draft.key,
  state: draft.state,
  mode: draft.mode,
  isEmpty: draft.isEmpty,
  caret: draft.caret,
  slashOpen: draft.slashOpen,
  slashCommands: draft.slashCommands,
  slashDismissed: draft.slashDismissed,
  activeCommand: draft.activeCommand,
  acceptCommand: draft.acceptCommand,
  focusDraft: draft.focusDraft,
  draftEl: draft.draftEl,
  rootEl,
  onSend,
  onDiscard: send.onDiscard,
  onAttachClick,
  focusTerminal,
});

/**
 * Moving and resizing the card moved whole to ../useComposerGeometry.ts; the
 * measurement lifecycle (pane box, ResizeObserver) registers itself there.
 */
const {
  RESIZE_EDGES,
  railEl,
  rootStyle,
  beginDrag,
  onHeaderDown,
  onHeaderDoubleClick,
} = useComposerGeometry({ rootEl, composer, mode: draft.mode, toggleExpanded });

/**
 * The draw-or-annotate overlay is components/DoodleSheet.vue. The toolbar's
 * pencil and the tiles' Annotate action open it through the two exposed entry
 * points, and its commits stage through the same pipeline as a paste.
 */
const doodleSheet = ref<{
  open: () => void;
  startFromAttachment: (remotePath: string) => Promise<void>;
} | null>(null);

onMounted(() => {
  window.addEventListener('keydown', onGlobalKey, { capture: true });
  // Capture, so the press is seen wherever it lands — including inside the
  // terminal, which is the case the user actually asked for.
  window.addEventListener('mousedown', onOutsidePointerDown, { capture: true });
  caret.value = state.value.caret;
  // The composer is the primary surface: land in it.
  if (mode.value !== 'hidden') focusDraft();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey, { capture: true });
  window.removeEventListener('mousedown', onOutsidePointerDown, { capture: true });
});

defineExpose({
  focusDraft,
  openComposer,
  typeInto,
  pasteFromSystemClipboard,
  acceptDroppedFiles,
});
</script>

<template>
  <div
    ref="rootEl"
    :class="['composer-root', { 'drag-over': dragActive }]"
    @keydown="onRootKeydown"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="mode !== 'hidden'" :class="['composer', mode]" :style="rootStyle">
      <!-- Every edge and corner is a resize grip. The top one keeps the sash's
           look and its double-click, so that affordance is where it always was. -->
      <div
        v-for="edge in RESIZE_EDGES"
        :key="edge"
        :class="['grip', `grip-${edge}`, { sash: edge === 'n' }]"
        :title="edge === 'n' ? 'Drag to resize · double-click to maximize' : undefined"
        aria-hidden="true"
        @mousedown="beginDrag($event, { kind: 'resize', edge })"
        @dblclick="edge === 'n' && toggleExpanded()"
      ></div>

      <!-- Panel toolbar, and the card's title bar: press it to move the card.
           Maximize/restore, then close, in that order — the conventional
           window arrangement, with the dismissing one last so it is not what
           the cursor lands on by accident.
           On that close button: an earlier pass REMOVED it, on the grounds that
           a second closer riding on a draggable card was the "the control
           moved" complaint all over again. That reasoning
           no longer holds — in short, dismissing the surface you are
           looking at and re-opening from a pinned icon are different acts, and
           only the second one needs a fixed address. -->
      <div class="panel-header" @mousedown="onHeaderDown" @dblclick="onHeaderDoubleClick">
        <span class="panel-title">Prompt</span>
        <span class="spacer"></span>
        <button
          class="panel-action"
          type="button"
          :title="mode === 'expanded' ? 'Restore panel (Ctrl+Shift+↓)' : 'Maximize panel (Ctrl+Shift+↑)'"
          :aria-label="mode === 'expanded' ? 'Restore panel' : 'Maximize panel'"
          @click="toggleExpanded"
        >
          <AppIcon :name="mode === 'expanded' ? 'chevron-down' : 'chevron-up'" />
        </button>
        <button
          class="panel-action"
          type="button"
          title="Close the prompt panel (Ctrl+`)"
          aria-label="Close the prompt panel"
          @click="hideComposer"
        >
          <AppIcon name="close" />
        </button>
      </div>

      <!-- Above the field, never below: the list must not be pushed off-screen. -->
      <SlashCommandDropdown
        v-if="slashOpen"
        class="slash-anchor"
        :commands="slashCommands"
        :active="activeCommand"
        @pick="acceptCommand"
        @hover="(i: number) => (activeCommand = i)"
      />

      <!-- Everything between the toolbar and the Send row lives in one
           scroller: the draft absorbs slack when the panel is tall, and when it
           is at the floor (or a banner appears) this scrolls instead of
           squeezing the Send row out of reach. -->
      <div class="panel-body">
        <div class="draft-wrap">
          <textarea
            ref="draftEl"
            class="draft"
            :value="state.draft"
            :placeholder="COMPOSER_STRINGS.placeholder"
            spellcheck="false"
            aria-label="Prompt draft"
            @input="onInput"
            @keyup="syncCaret"
            @click="syncCaret"
            @keydown="onDraftKeydown"
            @paste="onPaste"
          />
        </div>

        <div v-if="state.error" class="banner" role="alert">
          <span class="banner-text">{{ state.error }}</span>
          <button
            class="banner-x"
            type="button"
            title="Dismiss"
            aria-label="Dismiss the error"
            @click="composer.dismissError(key)"
          >
            <AppIcon name="close" />
          </button>
        </div>

        <p v-if="state.uploadingCount > 0" class="uploading muted">
          {{ COMPOSER_STRINGS.uploading(state.uploadingCount) }}
        </p>

        <!-- Own scroller: 20 attachments must not cost Send its slot. -->
        <div v-if="attachments.length" class="tiles-wrap">
          <ComposerAttachmentTiles
            :attachments="attachments"
            :disabled="state.sendInFlight"
            @remove="(p: string) => composer.removeAttachment(key, p)"
            @annotate="(p: string) => doodleSheet?.startFromAttachment(p)"
          />
        </div>
      </div>

      <p v-if="state.connectionDegraded" class="conn-lost">
        {{ COMPOSER_STRINGS.connectionLost }}
      </p>

      <ComposerControls
        :uploading-count="state.uploadingCount"
        :agent-kind="agentKind"
        :can-send="canSend"
        :send-in-flight="state.sendInFlight"
        :draft-length="state.draft.length"
        :attachment-count="attachments.length"
        :discard-armed="discardArmed"
        @attach="onAttachClick"
        @doodle="doodleSheet?.open()"
        @slash="onSlashButton"
        @discard-click="onDiscardClick"
        @send="onSend"
      />
    </div>

    <!-- THE open/close control.
         Anchored to the PANE, not to the card: the card moves, so a control on
         it could not be the fixed point the user asked for. It is the same
         element, the same size and the same pixel whether the card is open,
         closed, dragged elsewhere or maximized — `keepOut` is what stops the
         card ever landing on top of it.
         It is a bare icon now. Everything the collapsed rail used to spell out
         — the PROMPT label, the draft's first line, the attachment count, the
         Ctrl+` hint — sat on top of terminal output at rest, which made the
         quietest state the most intrusive one. The hint moved into the tooltip
         and the draft moved into the pip. -->
    <button
      ref="railEl"
      :class="['rail', { unsent: toggle.unsent }]"
      type="button"
      :title="toggle.title"
      :aria-label="toggle.label"
      :aria-expanded="mode !== 'hidden'"
      @click="onToggleRail"
    >
      <AppIcon :name="toggle.icon" />
      <span v-if="toggle.unsent" class="unsent-pip" aria-hidden="true"></span>
    </button>

    <!-- The draw-or-annotate overlay: DoodleSheet.vue, mounted inside this
         root so an open sheet is still "inside the composer" to the
         outside-click rule. -->
    <DoodleSheet
      ref="doodleSheet"
      :connection-id="connectionId"
      :session-name="sessionName"
      :workspace="workspace"
      :attachments="attachments"
      :key-value="key"
      :stage-sources="stageSources"
    />
  </div>
</template>

<style scoped>
/* ---- the two layers -----------------------------------------------------
 * root    fills `.composer-dock`, i.e. the session body inset on all sides.
 *         It IS the card's world: with the reserved strip gone, the card may
 *         be dragged anywhere in the pane except the toggle's own corner,
 *         which `keepOut` handles in JS rather than by walling off a band.
 * rail    the fixed toggle, pinned to that corner.
 *
 * Both are `pointer-events: none` at the top and the two real controls take
 * their own events back, because this layer covers the whole pane and would
 * otherwise swallow every click meant for the terminal. Drag-and-drop still
 * works: pointer-events governs hit-testing, not the propagation of an event
 * that started on a descendant which does accept them.
 */
.composer-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.composer,
.rail,
.modal-layer {
  pointer-events: auto;
}

/* ---- the floating card --------------------------------------------------
 * The card is absolutely positioned inside `.composer-dock`, which is the
 * workspace body inset on all four sides (FolderWorkspaceView.vue). Its box —
 * right, bottom, width, height — is computed in JS and arrives as an inline
 * style, because the user can now drag all four of those numbers and they have
 * to be clamped against the pane by rules a unit test can check
 * (src/shared/composerGeometry.ts).
 *
 * What is left here is only what makes it read as HOVERING rather than as a
 * bar: its own corners, an opaque surface, and a shadow on every side.
 */
.composer {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  /* OverlayPanel's elevation, with the Y offset pulled in: that panel is
     centred and can afford to cast 16px downward, while this one can sit right
     against the bottom of its dock and would throw most of its shadow off the
     pane — leaving the TOP edge, the one that has terminal text behind it,
     with no separation at all. Same colour, same blur, so both read as one
     material. */
  box-shadow: var(--shadow-card);
}
/* Chromium follows the element's own corners here, so the dashed accent traces
   the card's radius (or the rail's pill) rather than boxing it. The flag is on
   the root because a file may be dropped on either, and when the card is closed
   the rail is the only target there is. */
.composer-root.drag-over .composer,
.composer-root.drag-over .rail {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}

/* ---- the fixed toggle ---------------------------------------------------
 * ONE control, two states, ONE position. Pinned to the pane's bottom-right
 * corner and the only thing that opens and closes the panel, so the user aims
 * at a single unmoving pixel and it alternates — which a control living on
 * the card could never do, because the card moves.
 *
 * It is SMALL but it is not SHY, and that distinction cost a revision. It began
 * as a 24px mark at `opacity: 0.55`, on the reasoning that an overlay drawing
 * over tmux's status line should defer to it until wanted. The user, running
 * it: *"the ^ icon should be an overlay over the terminal not hiding in the
 * corner it's almost invisible."* They were right, and the error was one of
 * category: this is not decoration that can afford to recede, it is the ONLY
 * way to summon the composer once it is closed. A control nobody can find is
 * broken, not subtle.
 *
 * So it is a CHIP, not a mark: an opaque `--surface-2` fill, a `--border-strong`
 * edge and the card's own elevation shadow. `--border-strong` is not a taste
 * call —  requires it (4.12:1) wherever a boundary is the only
 * thing identifying a control, and here it is the only thing separating a chip
 * from the terminal behind it. At 28px/16px it is on the icon default scale
 * rather than a dense one, which is right for a primary affordance.
 *
 * It is inset a further `--sp-3` from the dock's own corner, so it visibly
 * floats ON the terminal instead of hugging the pane's edge, and that offset
 * also lifts it clear of almost the whole status row rather than sitting in it.
 *
 * What it is NOT is the old wide rail: the user asked for "smaller and an icon"
 * and liked that; the fix was contrast and placement, not size.
 *
 * It is pinned, so it is never dragged: a click here is unambiguously a click.
 */
.rail {
  position: absolute;
  right: var(--sp-3);
  bottom: var(--sp-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h);
  height: var(--control-h);
  padding: 0;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  /* The card's own elevation, so the two read as one floating material and the
     chip lifts off the terminal rather than sitting flat on it. */
  box-shadow: var(--shadow-card);
  color: var(--fg-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
/* The elevation ladder's next step up, which is what --surface-3 is for. */
.rail:hover,
.rail:focus-visible {
  background: var(--surface-3);
  color: var(--fg);
}
/* A waiting draft earns one more step of presence: the pip carries the fact,
   the brighter mark makes it register without a second glance. */
.rail.unsent {
  color: var(--fg);
}
/* A status mark is a CSS circle, not a glyph, so it stops
   scaling with font metrics. The ring is the chip's own surface, so the pip
   reads against the chip rather than against whatever is behind it. */
.unsent-pip {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--surface-2);
}

/* ---- resize grips -------------------------------------------------------
 * Overlays on the card's edges, NOT rows in its flex column: an edge strip that
 * took part in the layout would steal 6px from the draft on every side it
 * touched, and the corners could not exist at all. Each sits over the card's
 * own padding, so none of them covers the textarea.
 *
 * Corners are declared after edges here as well as in the template, so they win
 * the hit test at the four points where both would answer.
 */
.grip {
  position: absolute;
  z-index: 2;
}
.grip-n,
.grip-s {
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
}
.grip-n {
  top: 0;
}
.grip-s {
  bottom: 0;
}
.grip-e,
.grip-w {
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
}
.grip-w {
  left: 0;
}
.grip-e {
  right: 0;
}
.grip-nw,
.grip-ne,
.grip-sw,
.grip-se {
  width: 14px;
  height: 14px;
}
.grip-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}
.grip-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}
.grip-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
.grip-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}
/* The top edge keeps the sash's look: transparent until the cursor rests on it,
   then VS Code's accent bar. The card is not `overflow: hidden` — the slash
   dropdown deliberately escapes above it — so this closes its own corners. */
.grip.sash {
  background: transparent;
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  transition: background var(--dur-fast) var(--ease);
}
.grip.sash:hover {
  background: var(--accent-dim);
}
/* Anything clickable that reaches into the 6px edge band has to sit above the
   grips, or the grip swallows a click that was aimed at the button. The Send
   half of this rule lives in ComposerControls.vue, its side of the boundary. */
.panel-action {
  position: relative;
  z-index: 3;
}
.sash:hover {
  background: var(--accent-dim);
}

/* ---- panel toolbar, and the card's title bar ---------------------------- */
.panel-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--tabbar-h);
  padding: 0 var(--sp-2) 0 var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
  /* It is the move handle. `user-select` matters as much as the cursor: without
     it a drag that starts on the title paints a text selection across the strip
     while the card moves. */
  cursor: move;
  user-select: none;
}
.panel-title {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg);
  flex: 0 0 auto;
}
.panel-action {
  flex: 0 0 auto;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  line-height: 1;
  cursor: pointer;
}
.panel-action:hover {
  background: var(--state-active);
  color: var(--fg);
}
.spacer {
  flex: 1 1 auto;
  min-width: 0;
}

/* ---- floating dropdown ------------------------------------------------- */
.slash-anchor {
  position: absolute;
  left: var(--sp-3);
  right: var(--sp-3);
  bottom: calc(100% - 4px);
  z-index: 20;
}

/* ---- the flexible middle ----------------------------------------------- */
.panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.draft-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  padding: var(--sp-2) var(--sp-3);
}
.draft {
  flex: 1 1 auto;
  width: 100%;
  /* Two lines is the floor. Below that the caret line gets clipped in half —
     see the 150px capture this replaced. Past the floor .panel-body scrolls
     instead, so the toolbar and the Send row never move. */
  min-height: 46px;
  resize: none;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.draft::placeholder {
  color: var(--fg-muted);
}

/* ---- banners ----------------------------------------------------------- */
.banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 var(--sp-3) var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--error-soft);
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  color: var(--fg);
  font-size: var(--fs-200);
}
.banner-text {
  flex: 1;
  min-width: 0;
}
/* The banner's dismiss. Scoped to the message: the trap this replaces put
   Discard inside the banner, and its click took the draft down with the
   error text. */
.banner-x {
  flex: 0 0 auto;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
}
.banner-x:hover {
  background: var(--state-active);
  color: var(--fg);
}
.uploading {
  flex: 0 0 auto;
  margin: 0 0 var(--sp-2);
  padding: 0 var(--sp-3);
  font-size: var(--fs-200);
}

/* Exactly two rows of tiles (28px each + an 8px gap), then it scrolls. An
   uncapped wrapping list would push the Send row off the bottom; a fractional
   cap sliced the third row in half. */
.tiles-wrap {
  flex: 0 0 auto;
  max-height: 72px;
  overflow-y: auto;
  padding: 0 var(--sp-3) var(--sp-2);
}
.conn-lost {
  flex: 0 0 auto;
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  background: var(--warning-soft);
  border-top: 1px solid var(--border-soft);
  color: var(--warning);
  font-size: var(--fs-200);
}
</style>
