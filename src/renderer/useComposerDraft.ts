import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useComposerStore, type ComposerMode, type ComposerSessionState } from './stores/composer';
import { insertCommandText, railToggle, slashQueryFor } from '../shared/composerText';
import { filteredCommands, insertionTextFor, type AgentCommand } from '../shared/agentCommands';
import { sessionIdentityKey } from './sessionIdentity';
import type { ComposerAgentKind } from '../shared/composerSend';
import type { ConnectionId } from '../shared/types';

/**
 * The component's reactive props, as the draft composable reads them — the
 * props object itself is handed over, so every read stays reactive.
 */
export interface ComposerDraftProps {
  readonly connectionId: ConnectionId;
  readonly sessionName: string;
  readonly backend?: 'tmux' | 'aplexer';
  readonly workspace?: string | null;
  readonly agentKind?: ComposerAgentKind | null;
  readonly connected?: boolean;
}

export interface ComposerDraftDeps {
  composer: ReturnType<typeof useComposerStore>;
  props: ComposerDraftProps;
}

/**
 * The composer's per-session model and draft editing: the session key, the
 * state record behind the card, the pip/empty gates, the slash-command
 * palette state, and the caret/focus machinery of the textarea. Extracted from
 * PromptComposer.vue with its reasoning; the visibility and clipboard halves
 * read all of it through what this returns.
 */
export function useComposerDraft(deps: ComposerDraftDeps): {
  sessionKey: ComputedRef<string>;
  key: ComputedRef<string>;
  state: ComputedRef<ComposerSessionState>;
  mode: ComputedRef<ComposerMode>;
  attachments: ComputedRef<ComposerSessionState['attachments']>;
  hasUnsent: ComputedRef<boolean>;
  isEmpty: ComputedRef<boolean>;
  toggle: ComputedRef<ReturnType<typeof railToggle>>;
  caret: Ref<number>;
  slashDismissed: Ref<boolean>;
  activeCommand: Ref<number>;
  slashOpen: ComputedRef<boolean>;
  slashCommands: ComputedRef<AgentCommand[]>;
  acceptCommand: (cmd: AgentCommand) => void;
  onSlashButton: () => void;
  syncCaret: () => void;
  onInput: (e: Event) => void;
  focusDraft: (position?: number) => void;
  draftEl: Ref<HTMLTextAreaElement | null>;
} {
  const composer = deps.composer;
  const props = deps.props;

  /** `${connectionId}/${identity}` — mirrors the phone's `"$hostId/$sessionName"`. */
  const sessionKey = computed(() =>
    sessionIdentityKey(props.sessionName, {
      backend: props.backend,
      workspace: props.workspace ?? undefined,
    }),
  );
  const key = computed(() => composer.targetKey(props.connectionId, props.sessionName, sessionKey.value));

  watch(key, (k) => composer.ensure(k), { immediate: true });

  const FALLBACK: ComposerSessionState = {
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

  const state = computed<ComposerSessionState>(() => composer.states[key.value] ?? FALLBACK);
  /** App-level, not per session — see the store's header comment. */
  const mode = computed(() => composer.mode);
  const attachments = computed(() => state.value.attachments);

  /** Is there work in here the user would lose track of? Drives the toggle's pip. */
  const hasUnsent = computed(() => state.value.draft.length > 0 || attachments.value.length > 0);

  /**
   * Nothing in here worth keeping — the gate on click-outside dismissal
   *. Deliberately stricter than `hasUnsent`, because the question is not
   * "is there a pip to draw" but "may this vanish without telling anyone", and
   * the answer has to be no for anything the user would go looking for later.
   *
   * Whitespace-only counts as empty: the store already treats it that way at send
   * time (`payload.trim() === ''` refuses to send), so a draft of three spaces is
   * not work by any definition the app already uses.
   *
   * A send in flight, a batch still uploading and a failure banner all count as
   * NOT empty. The banner case is already covered by the restored payload sitting
   * in the draft, but it is spelled out rather than inferred: silently discarding
   * a prompt that just failed to send is the exact failure this guard exists for.
   */
  const isEmpty = computed(() => {
    const st = state.value;
    return (
      st.draft.trim() === '' &&
      st.attachments.length === 0 &&
      st.error === null &&
      !st.sendInFlight &&
      st.uploadingCount === 0
    );
  });

  /** Chevron direction and copy for the fixed toggle — pure, so it can be pinned. */
  const toggle = computed(() => railToggle(mode.value !== 'hidden', hasUnsent.value));

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------

  const caret = ref(0);
  /** Escape closes the dropdown without touching the text, so it needs a latch. */
  const slashDismissed = ref(false);
  const activeCommand = ref(0);

  const slashQuery = computed(() => slashQueryFor(state.value.draft, caret.value));
  const slashCommands = computed<AgentCommand[]>(() =>
    slashQuery.value === null ? [] : filteredCommands(props.agentKind ?? null, slashQuery.value),
  );
  const slashOpen = computed(() => !slashDismissed.value && slashCommands.value.length > 0);

  watch(slashQuery, () => {
    activeCommand.value = 0;
  });

  function acceptCommand(cmd: AgentCommand): void {
    const [text, newCaret] = insertCommandText(state.value.draft, insertionTextFor(cmd));
    composer.setDraft(key.value, text, newCaret);
    caret.value = newCaret;
    slashDismissed.value = true;
    void nextTick(() => {
      const el = draftEl.value;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
    });
  }

  /** The `/` toolbar button is not a second palette: it seeds a leading `/`. */
  function onSlashButton(): void {
    const [text, newCaret] = insertCommandText(state.value.draft, '/');
    composer.setDraft(key.value, text, newCaret);
    caret.value = newCaret;
    slashDismissed.value = false;
    focusDraft(newCaret);
  }

  // ---------------------------------------------------------------------------
  // Draft editing
  // ---------------------------------------------------------------------------

  function syncCaret(): void {
    const el = draftEl.value;
    if (!el) return;
    caret.value = el.selectionStart;
    composer.setCaret(key.value, el.selectionStart);
  }

  function onInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    slashDismissed.value = false;
    composer.setDraft(key.value, el.value, el.selectionStart);
    caret.value = el.selectionStart;
  }

  function focusDraft(position?: number): void {
    void nextTick(() => {
      const el = draftEl.value;
      if (!el) return;
      el.focus();
      const at = position ?? state.value.caret;
      const clamped = Math.min(at, el.value.length);
      el.setSelectionRange(clamped, clamped);
    });
  }

  // Switching sessions swaps which record we render; restore that record's caret.
  watch(
    () => props.sessionName,
    () => {
      caret.value = state.value.caret;
      slashDismissed.value = false;
      if (mode.value !== 'hidden') focusDraft();
    },
  );

  // Advisory "connection lost" row: it never gates Send — a composed prompt
  // is worth reconnecting for, which is why send is connect-on-action.
  watch(
    () => props.connected,
    (connected) => composer.setConnectionDegraded(key.value, connected === false),
    { immediate: true },
  );

  const draftEl = ref<HTMLTextAreaElement | null>(null);

  return {
    sessionKey,
    key,
    state,
    mode,
    attachments,
    hasUnsent,
    isEmpty,
    toggle,
    caret,
    slashDismissed,
    activeCommand,
    slashOpen,
    slashCommands,
    acceptCommand,
    onSlashButton,
    syncCaret,
    onInput,
    focusDraft,
    draftEl,
  };
}
