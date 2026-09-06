import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { AttachmentSource, ConnectionId } from '../../shared/types';
import {
  appendAttachmentPaths,
  appendSeededPrompt,
  attachmentDisplayName,
  canFlushDraftToTerminal,
  COMPOSER_STRINGS,
  insertCommandText,
} from '../../shared/composerText';
import { composerTiming, withTimeout } from '../../shared/composerSend';
import { defaultGeometry, type ComposerGeometry } from '../../shared/composerGeometry';

/**
 * Prompt-composer state: one record per session, plus ONE app-level visibility.
 *
 * The Android original keeps a SINGLE activity-scoped ViewModel shared by every
 * session on a host (PromptComposerViewModel.kt:813-820), which is why it needs
 * the #746 "owner stamp" that DISCARDS a draft when you switch sessions. That
 * mechanism is deliberately NOT ported (docs/COMPOSER.md §12.4): a keyed map
 * satisfies the same user-visible invariant — a draft never appears in a session
 * it was not authored in — while being strictly better, because switching away
 * and back restores your prompt instead of destroying it.
 *
 * The split between what is keyed and what is not is the whole design here:
 *
 *   per session   draft, staged attachments, caret, the error banner,
 *                 in-flight flags. These are FACTS ABOUT A SESSION — your
 *                 half-written prompt for `build` has no business showing up
 *                 in `main`.
 *   app level     open / closed / maximized, and the card's GEOMETRY. Those are
 *                 PREFERENCES ABOUT THE TOOL. Keying the mode per session meant
 *                 a session you had never opened the composer on started from
 *                 `blankState()` — open — so closing the panel and switching
 *                 sessions brought it straight back, which is what the user
 *                 reported.
 *
 * The card's size and position sit on the app-level side for the same reason,
 * and the height moved there with them (it used to be per session). Where the
 * composer sits on screen describes your WINDOW LAYOUT, not any conversation:
 * a per-session position would make the card jump around as you switch
 * sessions, which is precisely the bug just fixed for open/closed. The pane is
 * shared by every session too, so a placement that is legal for one is legal
 * for all.
 *
 * Every action below maps one-for-one onto a Kotlin method so the port stays
 * auditable; the citations are in the doc comments.
 */

/** Three modes, app-wide, persisted (docs/COMPOSER.md §12). */
export type ComposerMode = 'hidden' | 'docked' | 'expanded';

export interface StagedAttachment {
  /** Stable identity — dedupe and removal both key off this. */
  remotePath: string;
  displayName: string;
  mimeType?: string;
  /** Images only, for the tile thumbnail. Never persisted (can be megabytes). */
  previewDataUrl?: string;
}

export interface ComposerSessionState {
  draft: string;
  attachments: StagedAttachment[];
  error: string | null;
  sendInFlight: boolean;
  /** 0 = idle. Mirrors Android's AttachmentUploadState. */
  uploadingCount: number;
  connectionDegraded: boolean;
  /** Caret offset, so a session switch restores where you were typing. */
  caret: number;
  /**
   * The payloads this session DELIVERED, oldest first, capped at
   * {@link COMPOSER_HISTORY_LIMIT}. The composed text — attachment paths already
   * folded in — because that is what entered the pane, and a repeat should send
   * exactly what was sent before.
   */
  history: string[];
  /**
   * The draft as it stood when the user started walking back through history.
   * Null when not browsing. Held here rather than in the component so a session
   * switch mid-browse keeps BOTH texts — the recalled entry on top, the real
   * draft underneath — with nothing lost to the detour.
   */
  recallSaved: string | null;
  /** Where the browse sits: an index into `history` counted from the newest. */
  recallIndex: number | null;
}

/** How many sent prompts a session remembers. Oldest fall off. */
export const COMPOSER_HISTORY_LIMIT = 100;

/** Per-session fields worth surviving an app restart (§23.6). */
interface PersistedState {
  draft: string;
  attachments: Omit<StagedAttachment, 'previewDataUrl'>[];
  caret: number;
  history: string[];
  /**
   * A browse interrupted by the app going away. Restored as THE draft on the
   * next boot — the recalled entry it was shadowing has no cursor pointing at
   * it any more, so the saved draft is the only text that can come back.
   *
   * Optional, matching the write side, which omits the field entirely when
   * there is nothing parked; the read side answers null for its absence.
   */
  recallSaved?: string | null;
}

/** The app-level half: whether the panel is showing, and where its box is. */
interface PersistedLayout {
  mode: ComposerMode;
  lastOpenMode: 'docked' | 'expanded';
  geometry: ComposerGeometry;
}

const STORAGE_KEY = 'pocketshell.composer.v1';
/**
 * Deliberately a SECOND key rather than a version bump of the first. The
 * per-session blob keeps its shape and its name, so the drafts a user already
 * has on disk survive this change; the fields that moved out of it simply stop
 * being read there. An old blob's leftover `mode`/`height` are ignored, which
 * is the correct migration — per-session visibility and size are exactly what
 * is being retired.
 *
 * The STRING keeps its old `visibility` name even though the payload has since
 * grown `geometry`: renaming it would orphan the blob and silently reopen every
 * user's composer. A stale name is cheaper than a lost preference.
 */
const LAYOUT_KEY = 'pocketshell.composer.visibility.v1';

function blankState(): ComposerSessionState {
  return {
    draft: '',
    attachments: [],
    error: null,
    sendInFlight: false,
    uploadingCount: 0,
    connectionDegraded: false,
    caret: 0,
    history: [],
    recallSaved: null,
    recallIndex: null,
  };
}

/**
 * A staging batch in flight.
 *
 * We cannot un-send an IPC call that is already on the wire, so a batch is
 * MARKED and its result dropped when it lands. One cancel reason is left:
 * 'discard' — the user hit Discard (:783-800). This is cancellation, NOT the
 * #570 partial-failure path: a result that arrives normally always keeps its
 * survivors, even when `ok` is false.
 *
 * ## 'send' is gone, and `done` is what replaced it
 *
 * There used to be a second reason: hitting Send mid-upload abandoned the batch
 * and sent the prompt with whatever was already staged. This code cited the
 * phone for it (`:684-688`) and the user — who wrote the phone app — says that
 * is not what the phone does: "that's not how the phone app works. it waits".
 * Their report of the desktop behaviour is what a dropped batch feels like from
 * the outside: "If I'm uploading an image and hit enter, I wait till image is
 * uploaded and then send the prompt" — the image simply was not in the prompt.
 *
 * Abandoning it was the worse rule on its own merits, whatever the phone does.
 * The user attached an image and then wrote a prompt ABOUT that image; sending
 * the words without the picture does not deliver a smaller version of what they
 * asked for, it delivers a question with its subject missing — to an agent that
 * will answer it anyway, having never seen the image.
 *
 * So the batch now carries a promise that settles when staging is finished, and
 * `send` awaits it. It settles on EVERY exit — success, partial failure, the
 * upload timeout, a thrown IPC — because a send parked on a promise that never
 * resolves is a composer that has silently stopped working.
 */
interface Batch {
  cancel: null | 'discard';
  /** Resolves when staging has finished, whatever the outcome. */
  done: Promise<void>;
}

export const useComposerStore = defineStore('composer', () => {
  const states = ref<Record<string, ComposerSessionState>>(loadPersisted());
  const batches = new Map<string, Batch>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const restoredLayout = loadLayout();
  /** Open / closed / maximized — ONE value for the app, not one per session. */
  const mode = ref<ComposerMode>(restoredLayout.mode);
  /** What `hidden` re-opens into, so docked-vs-maximized survives a close. */
  const lastOpenMode = ref<'docked' | 'expanded'>(restoredLayout.lastOpenMode);
  /**
   * Where the card sits and how big it is, in dock coordinates
   * (src/shared/composerGeometry.ts). Stored RAW — never re-clamped to the
   * current pane — so shrinking the window and restoring it puts the card back
   * where the user left it instead of permanently rewriting their layout to
   * whatever fitted the smallest window they ever had. The component clamps for
   * display on every render.
   */
  const geometry = ref<ComposerGeometry>(restoredLayout.geometry);
  /**
   * Whether the typing intercept (docs/COMPOSER.md §26.1) is standing down
   * because the composer just handed a short draft to the pane (§12.2): the
   * shell is where the user's typing belongs until they summon the composer
   * again. App-level like `mode` — it describes the keyboard, not a session —
   * and deliberately NOT persisted: it is a gesture, like the recall cursor,
   * not a preference.
   */
  const terminalOwnsTyping = ref(false);

  // -------------------------------------------------------------------------
  // Persistence — the desktop replacement for SavedStateHandle (:2544, :2558).
  // -------------------------------------------------------------------------

  function loadPersisted(): Record<string, ComposerSessionState> {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, PersistedState>;
      const out: Record<string, ComposerSessionState> = {};
      for (const [key, value] of Object.entries(parsed)) {
        // A browse cannot survive the restart — its cursor is gone — so a draft
        // parked in `recallSaved` comes back as the draft itself.
        const saved = typeof value.recallSaved === 'string' ? value.recallSaved : null;
        out[key] = {
          ...blankState(),
          draft: saved ?? (value.draft ?? ''),
          attachments: (value.attachments ?? []).map((a) => ({ ...a })),
          caret: value.caret ?? 0,
          history: Array.isArray(value.history)
            ? value.history.filter((p): p is string => typeof p === 'string').slice(-COMPOSER_HISTORY_LIMIT)
            : [],
          recallSaved: null,
        };
      }
      return out;
    } catch {
      // A corrupt blob must never stop the app booting.
      return {};
    }
  }

  /** Defaults to `docked`: the composer is the app's primary surface (§11). */
  function loadLayout(): PersistedLayout {
    const fallback: PersistedLayout = {
      mode: 'docked',
      lastOpenMode: 'docked',
      geometry: defaultGeometry(),
    };
    if (typeof localStorage === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
      const g = parsed.geometry;
      return {
        mode: parsed.mode ?? fallback.mode,
        lastOpenMode: parsed.lastOpenMode ?? fallback.lastOpenMode,
        // Every field checked: a blob written before geometry existed, or one a
        // half-finished write truncated, must not put NaN into a style.
        geometry:
          g &&
          [g.right, g.bottom, g.width, g.height].every(
            (n) => typeof n === 'number' && Number.isFinite(n),
          )
            ? { right: g.right, bottom: g.bottom, width: g.width, height: g.height }
            : fallback.geometry,
      };
    } catch {
      return fallback;
    }
  }

  function schedulePersist(): void {
    if (typeof localStorage === 'undefined') return;
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
  }

  /** Drafts debounce their localStorage write; a keystroke storm costs one write. */
const PERSIST_DEBOUNCE_MS = 250;
function persistNow(): void {
    persistTimer = null;
    if (typeof localStorage === 'undefined') return;
    const out: Record<string, PersistedState> = {};
    for (const [key, s] of Object.entries(states.value)) {
      // A record that says nothing is not worth a line in the blob. `ensure()`
      // touches a key for every session merely visited, so without this the map
      // grows one empty entry per session, forever. History counts as saying
      // something: prompts the user may want to repeat are the whole point.
      if (s.draft === '' && s.attachments.length === 0 && s.history.length === 0) continue;
      out[key] = {
        draft: s.draft,
        attachments: s.attachments.map(({ remotePath, displayName, mimeType }) => ({
          remotePath,
          displayName,
          ...(mimeType === undefined ? {} : { mimeType }),
        })),
        caret: s.caret,
        history: s.history,
        ...(s.recallSaved === null ? {} : { recallSaved: s.recallSaved }),
      };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({
          mode: mode.value,
          lastOpenMode: lastOpenMode.value,
          geometry: geometry.value,
        }),
      );
    } catch {
      // Quota or a locked profile — losing a draft on restart beats throwing.
    }
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  /**
   * The key a composer record lives under: `"$connectionId/$sessionKey"`.
   *
   * `sessionKey` defaults to the session name, which is the identity for tmux
   * rows (names are host-global there). Callers with an aplexer row pass
   * `sessionIdentityKey(name, row)` instead, so same-named tags in different
   * folders keep separate drafts. See `renderer/sessionIdentity.ts`.
   */
  function targetKey(
    connectionId: string | null,
    sessionName: string,
    sessionKey: string = sessionName,
  ): string {
    return `${connectionId ?? 'none'}/${sessionKey}`;
  }

  /**
   * The record for `key`, creating a blank one on first touch. Always returns
   * the value read back OUT of the ref, so callers mutate the reactive proxy
   * rather than the raw object they just put in.
   */
  function ensure(key: string): ComposerSessionState {
    const existing = states.value[key];
    if (existing) return existing;
    states.value = { ...states.value, [key]: blankState() };
    return states.value[key] as ComposerSessionState;
  }

  // -------------------------------------------------------------------------
  // Draft
  // -------------------------------------------------------------------------

  /** Android: `onDraftChange` (:286-300). Any keystroke also CLEARS the error. */
  function setDraft(key: string, text: string, caret?: number): void {
    const s = ensure(key);
    s.draft = text;
    s.error = null;
    if (caret !== undefined) s.caret = caret;
    // Manual editing ends a history browse: whatever the user types now is the
    // prompt, not a detour through an old one. The recall actions below write
    // `draft` directly rather than through here for exactly this reason.
    endRecall(s);
    schedulePersist();
  }

  function setCaret(key: string, caret: number): void {
    ensure(key).caret = caret;
  }

  /** Android: `seedDraftPrompt` (:482-497) — Files' "attach to composer". */
  function seedPrompt(key: string, prompt: string): void {
    const s = ensure(key);
    s.draft = appendSeededPrompt(s.draft, prompt);
    s.caret = s.draft.length;
    s.error = null;
    schedulePersist();
  }

  /** Android: `prefillEngineCommand` (:508) — tapping a rendered `/clear`. */
  function prefillCommand(key: string, commandText: string): void {
    const s = ensure(key);
    const [text, caret] = insertCommandText(s.draft, commandText);
    s.draft = text;
    s.caret = caret;
    s.error = null;
    schedulePersist();
  }

  /**
   * Android: `discardDraft` (:783-800). The ONLY user control that throws work
   * away — the `×` / Escape / a session switch never do. Cancels an in-flight
   * upload first, then clears draft, tiles and banner. The composer stays open.
   */
  function discard(key: string): void {
    const batch = batches.get(key);
    if (batch) batch.cancel = 'discard';
    const s = ensure(key);
    s.draft = '';
    s.attachments = [];
    s.error = null;
    s.uploadingCount = 0;
    s.caret = 0;
    endRecall(s);
    schedulePersist();
  }

  // -------------------------------------------------------------------------
  // Sent-prompt history
  //
  // The user's report that put this here: prompts go into a tmux pane that may
  // not be the one on screen, so what happened to a prompt is not always
  // visible and re-running one means retyping it from memory. A shell answers
  // the same problem with `history` and the up arrow; this is that, per session.
  // -------------------------------------------------------------------------

  /** The user's typing ended a browse — the text on screen is theirs now. */
  function endRecall(s: ComposerSessionState): void {
    s.recallSaved = null;
    s.recallIndex = null;
  }

  /**
   * Record a payload that was CONFIRMED delivered. Called only from `send`, on
   * the success arm: a prompt that never entered the pane is not one the user
   * can repeat, and putting failures in the list would make "up arrow" resend
   * something that already failed once.
   */
  function recordSent(key: string, payload: string): void {
    const s = ensure(key);
    // A prompt sent again has ONE place in history — the top. Keeping the older
    // copy where it was would make the arrow walk step over the same text
    // twice, and a duplicate is never information here (zsh's `erasedups`
    // rather than bash's narrower ignoredups).
    s.history = [...s.history.filter((p) => p !== payload), payload].slice(
      -COMPOSER_HISTORY_LIMIT,
    );
    schedulePersist();
  }

  /**
   * Step one entry OLDER into the draft. Returns the text now in the draft, or
   * null for "nothing happened" — no history, or already at the oldest entry —
   * so the caller can leave the keystroke to the textarea.
   *
   * The first step stashes the live draft in `recallSaved`, shell-style, so
   * walking back down past the newest entry hands it back untouched.
   */
  function recallOlder(key: string): string | null {
    const s = ensure(key);
    if (s.history.length === 0) return null;
    if (s.recallIndex === null) {
      s.recallSaved = s.draft;
      s.recallIndex = s.history.length - 1;
    } else if (s.recallIndex > 0) {
      s.recallIndex -= 1;
    } else {
      return null; // already the oldest thing this session ever sent
    }
    const text = s.history[s.recallIndex] as string;
    s.draft = text;
    s.caret = text.length;
    schedulePersist();
    return text;
  }

  /**
   * Step one entry NEWER, or — from the newest — hand back the draft the browse
   * started from and end the browse. Null means "not browsing": the keystroke
   * is an ordinary Ctrl+ArrowDown and belongs to the textarea.
   */
  function recallNewer(key: string): string | null {
    const s = ensure(key);
    if (s.recallIndex === null) return null;
    if (s.recallIndex < s.history.length - 1) {
      s.recallIndex += 1;
      const text = s.history[s.recallIndex] as string;
      s.draft = text;
      s.caret = text.length;
      schedulePersist();
      return text;
    }
    const saved = s.recallSaved ?? '';
    s.draft = saved;
    s.caret = saved.length;
    endRecall(s);
    schedulePersist();
    return saved;
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  /** Android: `mergeStagedPaths` (:403-427) — de-dupe by remotePath, append. */
  function mergePaths(
    s: ComposerSessionState,
    paths: readonly string[],
    previews?: ReadonlyMap<string, string>,
  ): void {
    const seen = new Set(s.attachments.map((a) => a.remotePath));
    const added: StagedAttachment[] = [];
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const preview = previews?.get(path);
      added.push({
        remotePath: path,
        displayName: attachmentDisplayName(path),
        ...(preview === undefined ? {} : { previewDataUrl: preview }),
      });
    }
    if (added.length) s.attachments = [...s.attachments, ...added];
  }

  /**
   * Android: `attachFiles` (:311-390).
   *
   * Single-flight: a second call while a batch is in flight is a no-op (:315).
   * Partial failure (#570) keeps the survivors AND shows the error (:355-373) —
   * `StageAttachmentsResult` already encodes that contract, so never discard a
   * non-empty `paths` just because `ok` is false.
   *
   * Attaching NEVER mutates the draft (:301-309). The paths are folded in at
   * send time and only at send time.
   */
  async function stage(
    key: string,
    payload: {
      connectionId: ConnectionId;
      scopeKey: string;
      sources: AttachmentSource[];
      /** Local object/data URLs, by source index, for image tile thumbnails. */
      previews?: (string | undefined)[];
    },
  ): Promise<void> {
    const s = ensure(key);
    if (s.uploadingCount > 0) return; // single-flight
    if (payload.sources.length === 0) return;

    // `settle` is assigned synchronously by the Promise constructor, so the
    // definite-assignment assertion is a statement of fact rather than a hope.
    let settle!: () => void;
    const batch: Batch = {
      cancel: null,
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    batches.set(key, batch);
    s.uploadingCount = payload.sources.length;
    s.error = null;

    try {
      await stageBatch(key, s, batch, payload);
    } finally {
      // EVERY exit settles it, including a throw. `send` may be parked on this
      // promise, and a send that never resumes is a composer that has quietly
      // stopped working — a worse failure than any upload error it could be
      // waiting on.
      settle();
    }
  }

  /** Remove a batch by identity, even if reconnect moved its key. */
  function removeBatch(batch: Batch): void {
    for (const [key, current] of batches) {
      if (current !== batch) continue;
      batches.delete(key);
      return;
    }
  }

  /**
   * The body of {@link stage}, split out so the promise the batch publishes can
   * be settled in one `finally` rather than at each of the five ways staging
   * can end.
   */
  async function stageBatch(
    key: string,
    s: ComposerSessionState,
    batch: Batch,
    payload: {
      connectionId: ConnectionId;
      scopeKey: string;
      sources: AttachmentSource[];
      previews?: (string | undefined)[];
    },
  ): Promise<void> {
    const result = await withTimeout(
      api.attachments.stage({
        connectionId: payload.connectionId,
        scopeKey: payload.scopeKey,
        sources: payload.sources,
      }),
      composerTiming.uploadTimeoutMs,
    );

    removeBatch(batch);
    // Cancelled batches land silently: no tiles, no banner. See `Batch`.
    if (batch.cancel !== null) return;
    s.uploadingCount = 0;

    if (result === null) {
      s.error = COMPOSER_STRINGS.attachmentFailed('upload timed out');
      return;
    }

    // The stager returns paths in source order, so previews line up by index.
    const previews = new Map<string, string>();
    if (payload.previews) {
      result.paths.forEach((path, i) => {
        const preview = payload.previews?.[i];
        if (preview) previews.set(path, preview);
      });
    }
    // #570: a partial batch keeps every survivor AND shows the error.
    mergePaths(s, result.paths, previews);

    if (!result.ok) {
      s.error = COMPOSER_STRINGS.attachmentFailed(result.error ?? `${result.failedCount} failed`);
    }
    schedulePersist();
  }

  /** Android: `seedAttachment` (:443-473) — attach an already-uploaded path. */
  function seedAttachment(key: string, remotePath: string): void {
    mergePaths(ensure(key), [remotePath]);
    schedulePersist();
  }

  /** Android: `removeAttachment` (:528-546). Never touches the draft (:520-527). */
  function removeAttachment(key: string, remotePath: string): void {
    const s = ensure(key);
    s.attachments = s.attachments.filter((a) => a.remotePath !== remotePath);
    schedulePersist();
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /** Android: the Send button's enabled predicate (PromptComposerSheet.kt:1202). */
  function canSend(key: string): boolean {
    const s = states.value[key];
    if (!s) return false;
    return (s.draft.length > 0 || s.attachments.length > 0) && !s.sendInFlight;
  }

  /** The exact text that Send will deliver, for previews and for tests. */
  function composedPayload(key: string): string {
    const s = states.value[key];
    if (!s) return '';
    return appendAttachmentPaths(
      s.draft,
      s.attachments.map((a) => a.remotePath),
    );
  }

  /**
   * Android: `dispatchSendNow` (:661-712) + `markSendDelivered` (:725) +
   * `restoreFailedSend` (:746).
   *
   * The single most user-visible rule here is #745: the draft and the tiles STAY
   * ON SCREEN while the send is in flight. Clearing optimistically is what made
   * the phone "first lose the message, then keep the sheet open".
   *
   * `deliver` is injected so the transport (bracketed paste into a PTY) stays in
   * the component and this store stays unit-testable.
   */
  async function send(
    key: string,
    deliver: (payload: string) => Promise<boolean>,
    opts: {
      /**
       * The `closeComposerOnSend` setting (docs/COMPOSER.md §26). Passed in
       * rather than read here: this store has no business importing the
       * settings store, and a parameter is what lets the failure case be
       * tested without a settings fixture.
       */
      closeOnDelivery?: boolean;
    } = {},
  ): Promise<boolean> {
    const s = ensure(key);
    if (s.sendInFlight) return false; // :662

    // WAIT FOR THE UPLOAD, then send — "I wait till image is uploaded and then
    // send the prompt", and the phone does the same. See `Batch` for what this
    // replaced and why abandoning the batch was wrong.
    //
    // `sendInFlight` goes up BEFORE the wait, and that is what makes the wait
    // safe rather than a race: the Send button reads it (so it disables), the
    // guard above reads it (so a second Enter is a no-op instead of a second
    // send queued behind the same upload), and `isEmpty` reads it (so the
    // composer cannot be dismissed by a click-outside while a prompt is parked
    // waiting for its picture). The card stays on screen with its tiles the
    // whole time, which is #745's rule holding through a longer wait rather
    // than a new one.
    //
    // The batch always settles (see `Batch.done`), so there is no arm of this
    // that parks forever — the upload's own timeout is the bound.
    const batch = batches.get(key);
    if (batch) {
      s.sendInFlight = true;
      await batch.done;
      s.sendInFlight = false;
      // The upload had something to say. Do NOT send: the prompt was written
      // about the attachment, so delivering it without one is the failure this
      // whole change exists to remove — and the banner plus the intact draft is
      // the state every other refusal in this store leaves behind.
      if (s.error !== null) return false;
    }

    // Composed AFTER the wait, not before: the paths that just landed are the
    // whole point. Reading the payload first was how the old rule managed to
    // send a prompt about an image with the image missing.
    const payload = composedPayload(key);
    if (payload.trim() === '') return false; // :672

    s.sendInFlight = true;
    s.error = null;

    let ok = false;
    try {
      ok = (await withTimeout(deliver(payload), composerTiming.sendTimeoutMs)) === true;
    } catch {
      ok = false;
    }
    s.sendInFlight = false;

    if (ok) {
      recordSent(key, payload);
      markDelivered(key);
      // Only a CONFIRMED delivery may close the panel. A failure leaves it open
      // on purpose: the payload is back in the draft, the "Not sent" banner is
      // showing, and closing over the top of that would hide both — the user
      // would be told nothing and left with an invisible unsent prompt.
      if (opts.closeOnDelivery === true) setMode('hidden');
      return true;
    }
    restoreFailedSend(key, payload);
    return false;
  }

  /**
   * Android: `markSendDelivered` (:725-737), minus the dismissal.
   *
   * DELIBERATE DIVERGENCE (docs/COMPOSER.md §12.3): the phone closes the sheet
   * on delivery because a modal sheet occludes the terminal on a phone screen.
   * The desktop composer is docked and is the primary interaction surface, so it
   * stays open and focused, ready for the next prompt.
   */
  function markDelivered(key: string): void {
    const s = ensure(key);
    s.draft = '';
    s.attachments = [];
    s.error = null;
    s.uploadingCount = 0;
    s.caret = 0;
    // A sent prompt ends a browse: the entry the arrow keys were walking just
    // went out again, and the saved draft under it no longer describes anything.
    endRecall(s);
    if (mode.value === 'hidden') setMode(lastOpenMode.value);
    schedulePersist();
  }

  /**
   * Android: `restoreFailedSend` (:746-774).
   *
   * The COMPOSED payload — attachment paths already folded in — goes back into
   * the draft and the tiles are DROPPED, precisely so a resend does not
   * double-append the paths (:768-770).
   */
  function restoreFailedSend(key: string, payload: string, message?: string): void {
    const s = ensure(key);
    s.draft = payload;
    s.caret = payload.length;
    s.attachments = [];
    s.error = message ?? COMPOSER_STRINGS.notSent;
    s.sendInFlight = false;
    endRecall(s);
    schedulePersist();
  }

  /**
   * Move a session's record to a new key, because the session was RENAMED
   *
   *
   * Everything per-session in this store is keyed `"<connectionId>/<name>"`,
   * and the name is the half that just changed. Without this, renaming a tab
   * silently orphans the draft under the old key: the prompt does not appear
   * in the renamed session, it does not appear anywhere, and it stays on disk
   * forever because nothing will ever ask for that key again. That is the same
   * class of bug the keyed map was built to PREVENT — "a draft never appears
   * in a session it was not authored in" is satisfied trivially by losing it,
   * which is not what the rule meant.
   *
   * A no-op when there is nothing under [from], which is the common case: most
   * sessions have never had a composer record touched.
   *
   * If [to] is already occupied the incoming record WINS. That state should be
   * unreachable — the host refuses a rename onto a live session — but it can be
   * reached by a stale record left behind by a session that was killed and its
   * name reused, and between a draft the user just wrote and one belonging to a
   * session that no longer exists, the live one is the right answer.
   */
  function rekey(from: string, to: string): void {
    if (from === to) return;
    const existing = states.value[from];
    if (!existing) return;
    const next = { ...states.value, [to]: existing };
    delete next[from];
    states.value = next;
    schedulePersist();
  }

  /**
   * Carry every session record from a dead transport handle to its replacement.
   *
   * A connection id is deliberately part of the persisted key so two hosts
   * with a session called `main` can never share a draft. It is not, however,
   * the identity of the session itself: reconnect mints a new id for the same
   * host. Move the whole connection prefix before the connection store exposes
   * the replacement, so the mounted composer never renders a blank record in
   * between.
   *
   * Staging batches move with their state as well. The IPC request may still be
   * completing against the old transport; keeping its batch under the new key
   * means Send continues to wait for that result instead of racing it.
   */
  function rekeyConnection(fromConnectionId: ConnectionId, toConnectionId: ConnectionId): void {
    if (fromConnectionId === toConnectionId) return;

    const fromPrefix = `${fromConnectionId}/`;
    const toPrefix = `${toConnectionId}/`;
    const stateEntries = Object.entries(states.value).filter(([key]) => key.startsWith(fromPrefix));
    const batchEntries = [...batches.entries()].filter(([key]) => key.startsWith(fromPrefix));
    if (stateEntries.length === 0 && batchEntries.length === 0) return;

    const next = { ...states.value };
    for (const [key, sessionState] of stateEntries) {
      delete next[key];
      next[`${toPrefix}${key.slice(fromPrefix.length)}`] = sessionState;
    }
    states.value = next;

    for (const [key, batch] of batchEntries) {
      if (batches.get(key) !== batch) continue;
      batches.delete(key);
      batches.set(`${toPrefix}${key.slice(fromPrefix.length)}`, batch);
    }
    schedulePersist();
  }

  /**
   * Drop a session's record entirely — the session it belonged to is GONE
   *
   *
   * The counterpart of {@link rekey}, and the distinction between the two is
   * the distinction between a rename and a kill: a rename moves a record to the
   * name its session now has, a kill leaves a record no session will ever claim
   * again.
   *
   * Deliberately NOT {@link discard}, which is the user throwing away a draft
   * in a session that still exists: it blanks the fields and leaves the record,
   * so the composer can go on rendering it. Here there is nothing to render,
   * and leaving the entry behind would persist an orphan into `localStorage`
   * forever — and, worse, hand its draft to the NEXT session that takes the same
   * name, which `sessions create` produces routinely because it derives the name
   * from the folder.
   *
   * An in-flight upload batch is cancelled on the way out. Its `remotePath`s
   * were staged into a session that no longer exists, so nothing is waiting for
   * them.
   */
  function forget(key: string): void {
    const batch = batches.get(key);
    if (batch) batch.cancel = 'discard';
    if (!(key in states.value)) return;
    const next = { ...states.value };
    delete next[key];
    states.value = next;
    schedulePersist();
  }

  /** Android: `setConnectionDegraded` (:850-853). Advisory only — never a block. */
  function setConnectionDegraded(key: string, degraded: boolean): void {
    ensure(key).connectionDegraded = degraded;
  }

  // -------------------------------------------------------------------------
  // Visibility state machine (desktop only — docs/COMPOSER.md §12.1)
  //
  // NO `key` parameter, and that is the point: whether the composer is showing
  // is one answer for the whole app. Closing it on one session and finding it
  // open on the next is the bug this shape removes.
  // -------------------------------------------------------------------------

  /**
   * Hand a SHORT draft to the pane, raw and unsubmitted, on a user close
   * (docs/COMPOSER.md §12.2). Returns whether it flushed.
   *
   * The user's flow: a keystroke at a closed composer is caught by the typing
   * intercept, they type a few more, then decide this was a shell command
   * after all — Esc, and the text should be sitting at the prompt with typing
   * continuing in the pane, not re-caught by the intercept. So a dismissal
   * through here moves the text (`write`, injected exactly like `send`'s
   * `deliver`, so the transport stays in the component), clears the draft, and
   * stands the typing intercept down until the composer is next summoned.
   *
   * `write === null` means there is nowhere to put the text — no registered
   * shell, or the connection is down. Nothing is cleared and the dismissal is
   * an ordinary one, because moving text to NOWHERE is losing it, and Escape
   * never destroys work (§4.3).
   */
  function flushToTerminal(key: string, write: ((text: string) => void) | null): boolean {
    const s = states.value[key];
    if (!s || write === null) return false;
    if (
      !canFlushDraftToTerminal({
        draft: s.draft,
        attachments: s.attachments.length,
        error: s.error,
        sendInFlight: s.sendInFlight,
        uploadingCount: s.uploadingCount,
      })
    ) {
      return false;
    }
    const text = s.draft;
    // Written directly rather than through `setDraft`: there is no error to
    // clear (the gate just refused one) and the recall browse below is the
    // only side action wanted.
    s.draft = '';
    s.caret = 0;
    endRecall(s);
    terminalOwnsTyping.value = true;
    write(text);
    schedulePersist();
    return true;
  }

  function setMode(next: ComposerMode): void {
    if (next !== 'hidden') {
      lastOpenMode.value = next;
      // Summoning the composer takes the keyboard back: whatever a hand-off
      // (§12.2) stood down is re-armed by simply opening the panel again.
      terminalOwnsTyping.value = false;
    }
    mode.value = next;
    schedulePersist();
  }

  /**
   * Close it BECAUSE THE USER SAID SO — Escape, `Ctrl+\``, the toggle, the
   * card's close.
   *
   * Typing brings it back carrying the character — unless `flushToTerminal`
   * just put a short draft at the prompt on the way out (§12.2), in which case
   * the shell keeps the keyboard until the panel is summoned again. **The
   * action is kept as its own rather than a bare `setMode('hidden')`** so the
   * user-close path can be given behaviour again without hunting down four
   * call sites — the two ways the composer closes are different facts about
   * the world even when they produce the same state, which is precisely what
   * the flag's own comment says went wrong when they last shared a boolean.
   */
  function dismiss(): void {
    setMode('hidden');
  }

  /**
   * `hidden` -> the last non-hidden mode; anything else -> `hidden`.
   *
   * The closing half goes through `dismiss`: reaching for the chord to put the
   * composer away says exactly what reaching for Escape says.
   */
  function toggleHidden(): void {
    if (mode.value === 'hidden') setMode(lastOpenMode.value);
    else dismiss();
  }

  /** `hidden -> docked -> expanded`. */
  function grow(): void {
    if (mode.value === 'hidden') setMode('docked');
    else if (mode.value === 'docked') setMode('expanded');
  }

  /** `expanded -> docked -> hidden`. The last step is a user dismissal. */
  function shrink(): void {
    if (mode.value === 'expanded') setMode('docked');
    else if (mode.value === 'docked') dismiss();
  }

  /**
   * The card's box, from a move or a resize drag. Takes the already-clamped
   * result rather than clamping here: the component owns the pane measurement,
   * and a store that re-derived it would need a second copy of the DOM's idea
   * of how big the pane is.
   */
  function setGeometry(next: ComposerGeometry): void {
    geometry.value = next;
    schedulePersist();
  }

  /** Back to the resting bottom-right corner at the default size. */
  function resetGeometry(): void {
    geometry.value = defaultGeometry();
    schedulePersist();
  }

  return {
    states,
    mode,
    lastOpenMode,
    geometry,
    terminalOwnsTyping,
    targetKey,
    ensure,
    setDraft,
    setCaret,
    seedPrompt,
    prefillCommand,
    discard,
    recordSent,
    recallOlder,
    recallNewer,
    stage,
    seedAttachment,
    removeAttachment,
    rekey,
    rekeyConnection,
    forget,
    canSend,
    composedPayload,
    send,
    flushToTerminal,
    markDelivered,
    restoreFailedSend,
    setConnectionDegraded,
    setMode,
    dismiss,
    toggleHidden,
    grow,
    shrink,
    setGeometry,
    resetGeometry,
    persistNow,
  };
});
