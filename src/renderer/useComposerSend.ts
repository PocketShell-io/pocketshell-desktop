import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { api } from './ipc';
import { useComposerStore } from './stores/composer';
import { useSettingsStore } from './stores/settings';
import { useShellsStore } from './stores/shells';
import { composerTiming, deliverPayload, sendRoute, type ComposerAgentKind } from '../shared/composerSend';
import type { useComposerDraft } from './useComposerDraft';

/** The component's reactive props, as the send paths read them. */
export interface ComposerSendProps {
  readonly agentKind?: ComposerAgentKind | null;
  readonly sessionName: string;
  readonly workspace?: string | null;
}

export interface ComposerSendDeps {
  composer: ReturnType<typeof useComposerStore>;
  shells: ReturnType<typeof useShellsStore>;
  settings: ReturnType<typeof useSettingsStore>;
  /** The model half: the key, the session key, the state record, and focus. */
  draft: Pick<ReturnType<typeof useComposerDraft>, 'key' | 'sessionKey' | 'state' | 'focusDraft'>;
  props: ComposerSendProps;
  /** Hand the keyboard to the terminal after a delivered, closed send. */
  focusTerminal: () => void;
}

/**
 * Sending the prompt, and the armed Discard beside it. Extracted from
 * PromptComposer.vue with its reasoning; the controls row binds the returned
 * handlers, and the Escape/Enter keyboard paths call `onSend` and `onDiscard`
 * so no keystroke can drift from its button.
 */
export function useComposerSend(deps: ComposerSendDeps): {
  canSend: ComputedRef<boolean>;
  discardArmed: Ref<boolean>;
  onDiscardClick: () => void;
  onSend: () => Promise<void>;
  onDiscard: () => void;
} {
  const composer = deps.composer;
  const settings = deps.settings;
  const { key, sessionKey, state, focusDraft } = deps.draft;

  const canSend = computed(() => {
    const st = state.value;
    return (st.draft.length > 0 || st.attachments.length > 0) && !st.sendInFlight;
  });

  async function onSend(): Promise<void> {
    const k = key.value;
    const shellId = deps.shells.shellIdFor(sessionKey.value);
    const route = sendRoute({
      liveAgent: deps.props.agentKind ?? null,
      presumedAgent: null,
      // Inside the composer there is exactly one Send verb and it submits.
      withEnter: true,
    });
    // Codex's TUI needs a longer gap before Enter (TmuxSessionViewModel.kt:12135).
    const submitDelayMs =
      route === 'agent-payload'
        ? Math.max(250, composerTiming.submitDelayMs)
        : composerTiming.submitDelayMs;

    const delivered = await composer.send(
      k,
      async (payload) => {
        if (!shellId) return false;
        // Both arms write into the pane's PTY; they differ only in how long
        // they wait before Enter (codex's TUI needs the longer gap).
        return deliverPayload(payload, {
          // Fenced on name AND workspace: the shellId came out of the
          // workspace-qualified registry, and the fence re-checks it main-side
          // so a stale id can refuse instead of writing into a stranger's pane.
          write: (data) => api.shell.input(shellId, data, deps.props.sessionName, deps.props.workspace ?? undefined),
          submitDelayMs,
        });
      },
      { closeOnDelivery: settings.closeComposerOnSend },
    );
    // The store has already closed it on a delivered send when the setting is on;
    // all that is left here is where the keyboard goes. Sent and shut means the
    // terminal — which is also what makes the next keystroke re-open the panel.
    // A failed send leaves the card up with its banner, so the caret goes back to
    // the draft the user still has to deal with.
    if (delivered && settings.closeComposerOnSend) deps.focusTerminal();
    else focusDraft();
  }

  /**
   * Discard lives in the control row, behind a two-click arm. The reported trap
   * that put it there: the button used to sit inside the error banner, so a user
   * staring at "Attachment upload failed" read Discard as "remove the failed
   * attachment" — and lost a dictated prompt for it. The banner now dismisses
   * (the store's `dismissError`, message only), and the control that genuinely
   * throws work away says so in the place actions live and asks twice. A dictated
   * prompt is expensive to re-speak; one extra click to clear a stray character
   * is not, so the arm is unconditional rather than gated on draft length.
   */
  const DISCARD_ARM_MS = 5000;
  const discardArmed = ref(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  function disarmDiscard(): void {
    discardArmed.value = false;
    if (disarmTimer !== null) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  }

  function onDiscardClick(): void {
    if (!discardArmed.value) {
      discardArmed.value = true;
      disarmTimer = setTimeout(disarmDiscard, DISCARD_ARM_MS);
      return;
    }
    onDiscard();
  }

  /** Content or session moved under the armed click — what it aimed at is gone. */
  watch([() => state.value.draft, () => state.value.attachments.length, key], disarmDiscard);

  function onDiscard(): void {
    disarmDiscard();
    composer.discard(key.value);
    focusDraft(0);
  }

  // The timer is this cluster's own; it dies with the mount.
  onBeforeUnmount(disarmDiscard);

  return { canSend, discardArmed, onDiscardClick, onSend, onDiscard };
}
