import { nextTick, type ComputedRef, type Ref } from 'vue';
import { api } from './ipc';
import { useComposerStore, type ComposerMode, type ComposerSessionState } from './stores/composer';
import { useSettingsStore } from './stores/settings';
import { useShellsStore } from './stores/shells';
import { insertAtCaret } from '../shared/composerText';
import { isShortcut } from '../shared/shortcuts';
import type { AgentCommand } from '../shared/agentCommands';
import type { ComposerDraftProps } from './useComposerDraft';

export interface ComposerVisibilityDeps {
  composer: ReturnType<typeof useComposerStore>;
  shells: ReturnType<typeof useShellsStore>;
  settings: ReturnType<typeof useSettingsStore>;
  props: Pick<ComposerDraftProps, 'sessionName' | 'workspace' | 'connected'>;
  sessionKey: ComputedRef<string>;
  key: ComputedRef<string>;
  state: ComputedRef<ComposerSessionState>;
  mode: ComputedRef<ComposerMode>;
  /** The click-outside gate — an empty composer only ever gets out of the way. */
  isEmpty: ComputedRef<boolean>;
  caret: Ref<number>;
  slashOpen: ComputedRef<boolean>;
  slashCommands: ComputedRef<AgentCommand[]>;
  slashDismissed: Ref<boolean>;
  activeCommand: Ref<number>;
  acceptCommand: (cmd: AgentCommand) => void;
  focusDraft: (position?: number) => void;
  draftEl: Ref<HTMLTextAreaElement | null>;
  rootEl: Ref<HTMLElement | null>;
  onSend: () => Promise<void>;
  onDiscard: () => void;
  onAttachClick: () => Promise<void>;
  focusTerminal: () => void;
}

/**
 * The composer's visibility state machine and its keyboard: open, dismiss
 * (with the short-draft hand-off to the pane), the fixed toggle, maximize,
 * the Escape ladder, the outside-click dismissal, the draft's keydown (slash
 * navigation, Enter, history recall, the discard chord) and the window's
 * global chords. Extracted from PromptComposer.vue with its reasoning.
 */
export function useComposerVisibility(deps: ComposerVisibilityDeps): {
  openComposer: () => void;
  hideComposer: () => void;
  onToggleRail: () => void;
  typeInto: (text: string) => void;
  toggleExpanded: () => void;
  onOutsidePointerDown: (e: MouseEvent) => void;
  onDraftKeydown: (e: KeyboardEvent) => void;
  onRootKeydown: (e: KeyboardEvent) => void;
  onGlobalKey: (e: KeyboardEvent) => void;
} {
  const composer = deps.composer;
  const settings = deps.settings;
  const mode = deps.mode;
  const { key, state } = deps;
  const { caret, slashDismissed, slashOpen, slashCommands, activeCommand, acceptCommand } = deps;
  const { focusDraft, draftEl } = deps;

  function openComposer(): void {
    if (mode.value === 'hidden') composer.setMode(composer.lastOpenMode);
    focusDraft();
  }

  /**
   * Put the card away, and hand the keyboard back to the terminal.
   *
   * The focus half is not a nicety: the terminal has to be usable the instant the
   * card is gone, and the toggle keeps focus otherwise.
   *
   * A SHORT draft goes with it: a dismissal hands anything under five
   * characters to the pane, raw and unsubmitted, so the keystrokes the typing
   * intercept borrowed are put back where the user was typing and continue
   * there. The store stands the intercept down for the same reason — with `ls`
   * sitting at the prompt, the next printable key must reach the shell, not be
   * re-caught. A long draft is a prompt: work the dismissal never moves.
   *
   * `dismiss` rather than `setMode('hidden')` because everything routed here is
   * the USER putting the composer away — Escape, the chord, the toggle, the
   * card's close — and that is a fact worth naming even though it changes nothing
   * about the next keystroke.
   *
   * The focus half is what keeps the terminal usable across the close. Escape
   * hands the keyboard back to the pane, so every NON-printable key (Ctrl-C, the
   * arrows, Enter, tmux's prefix) reaches the shell immediately; a printable one
   * brings the panel back, carrying the character — unless a hand-off just put
   * text at the prompt, in which case typing keeps going to the shell until the
   * composer is summoned again.
   */
  function hideComposer(): void {
    const shellId = deps.shells.shellIdFor(deps.sessionKey.value);
    composer.flushToTerminal(
      key.value,
      // Nowhere to put the text — no registered shell, or the connection is
      // down — means no hand-off: an ordinary dismissal keeps the draft.
      deps.props.connected === false || shellId === null
        ? null
        : (text) => void api.shell.input(shellId, text, deps.props.sessionName, deps.props.workspace ?? undefined),
    );
    composer.dismiss();
    deps.focusTerminal();
  }

  /**
   * Click anywhere outside an EMPTY composer and it gets out of the way.
   *
   * Three things make this safe, and each of them is load-bearing:
   *
   *  - EMPTY only. Dismissing unsent work because the user clicked the terminal
   *    to read something would be invisible data loss — the worst kind, because
   *    nothing tells you until you go looking.
   *  - MOUSEDOWN, not click, and gated on where the press LANDED. The card can be
   *    dragged and resized, and both routinely travel outside its own bounds
   *    before the button comes up; gating on the press means an interaction that
   *    STARTED inside the composer can never dismiss it, however far it goes.
   *  - Anything inside `.composer-root` is inside the composer — the card, the
   *    grips, the header, the pinned toggle and the doodle overlay are all its
   *    descendants. So the toggle's own click is never a "click outside": it is
   *    ignored here and handled by the toggle, which is what stops a close here
   *    racing a re-open there and reading as a flicker or as nothing at all.
   *
   * It does NOT suppress the typing intercept, and that is the interesting call.
   * Escape and the chord are gestures aimed AT the composer and mean "leave me
   * alone"; a dismissal still only puts the card away — the ONE exception is a
   * short draft, which `hideComposer` hands to the pane — and this
   * handler, which fires on an EMPTY composer only, can never be that exception.
   * A click elsewhere is incidental — the user reached for the terminal, not
   * against the composer — and the composer was empty, so nothing was lost. The
   * split is: a CLICK dismisses the view, and nothing at all dismisses the
   * intent.
   *
   * It does not move focus either. The click already decided where focus goes;
   * stealing it back to the terminal would fight the user's own pointer.
   */
  function onOutsidePointerDown(e: MouseEvent): void {
    const root = deps.rootEl.value;
    const target = e.target;
    const inside = root != null && target instanceof Node && root.contains(target);

    // An inside press is handled by whatever was pressed (the toggle, the draft);
    // the outside rules below exist to decide whether an OUTSIDE press dismisses.
    if (inside) return;

    if (mode.value === 'hidden' || !deps.isEmpty.value) return;
    composer.dismiss();
  }

  /**
   * THE open/close control. One handler, one screen position, both directions:
   * clicking the fixed toggle puts the card away, clicking the same pixel brings
   * it back. `toggleHidden` is what preserves docked-vs-maximized across the
   * round trip, so re-opening restores the mode the user left.
   */
  function onToggleRail(): void {
    if (mode.value === 'hidden') {
      composer.setMode(composer.lastOpenMode);
      focusDraft();
    } else {
      hideComposer();
    }
  }

  /**
   * A keystroke the terminal withheld because the composer was shut
   * (`typingOpensComposer`). Open on the session's
   * remembered mode and plant the character where the caret was left, so the
   * letter that opened the panel is the panel's first letter and nothing has to
   * be retyped.
   */
  function typeInto(text: string): void {
    const k = key.value;
    const [next, caretAt] = insertAtCaret(state.value.draft, state.value.caret, text);
    composer.setDraft(k, next, caretAt);
    caret.value = caretAt;
    if (mode.value === 'hidden') composer.setMode(composer.lastOpenMode);
    focusDraft(caretAt);
  }

  /** The panel's maximize/restore button. Restoring returns the dragged height. */
  function toggleExpanded(): void {
    composer.setMode(mode.value === 'expanded' ? 'docked' : 'expanded');
    focusDraft();
  }

  /**
   * The Escape ladder, first match wins. Escape NEVER clears the draft —
   * that is Discard's job and Discard's alone.
   *
   * It used to have four rungs, two of which were about NOT closing: restore from
   * maximized, then blur to the pane leaving the card up. The blur rung was also
   * doing duty as the typing intercept's escape hatch, since the intercept only
   * fires while the composer is closed. The user asked for the plain meaning of
   * the key — "esc should close the prompt composer" — so the hatch became an
   * explicit thing (a dismissal suppresses typing) and the rungs that stood
   * between Escape and closing went with it. Restoring from maximized is still
   * `Ctrl+Shift+↓` and the header button; a dismissal remembers the mode anyway,
   * so re-opening a maximized composer gets it back maximized.
   */
  function escapeLadder(): void {
    // The dropdown is the one thing more local than the panel: Escape closes the
    // thing you opened last, and picking a slash command is not a reason to lose
    // the whole composer.
    if (slashOpen.value) {
      slashDismissed.value = true;
      return;
    }
    hideComposer();
  }

  function onDraftKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;

    if (slashOpen.value) {
      const n = slashCommands.value.length;
      if (e.key === 'ArrowDown') {
        activeCommand.value = (activeCommand.value + 1) % n;
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        activeCommand.value = (activeCommand.value - 1 + n) % n;
        e.preventDefault();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
        const cmd = slashCommands.value[activeCommand.value];
        if (cmd) acceptCommand(cmd);
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      escapeLadder();
      return;
    }

    // CJK IME composition commits with Enter; `isComposing` is the whole of the
    // guard a DOM textarea needs (there is no TextFieldValue equivalent).
    if (e.key === 'Enter' && !e.isComposing && (mod || !e.shiftKey)) {
      e.preventDefault();
      void deps.onSend();
      return;
    }

    // Sent-prompt history, shell-style: Ctrl/Cmd+↑ walks back through what
    // this session delivered, Ctrl/Cmd+↓ walks forward, and one ↓ past the newest
    // hands the draft back that the walk started from. The chord, not the bare
    // arrows — plain ↑/↓ must stay caret keys for editing a draft, which retires
    // the old first-line/last-line and selection gates along with it: a chord is
    // an explicit history request no matter where the caret sits. A recalled
    // entry lands with the caret at its end — on its last line.
    if (!e.isComposing && mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const text =
        e.key === 'ArrowUp'
          ? composer.recallOlder(key.value)
          : composer.recallNewer(key.value);
      if (text !== null) {
        e.preventDefault();
        caret.value = text.length;
        // A recalled prompt may start with `/`, which would otherwise pop the
        // command dropdown over text the user did not just type. Typing after
        // this re-arms it (onInput), as with Escape's dismissal.
        slashDismissed.value = true;
        void nextTick(() => {
          const ta = draftEl.value;
          if (!ta) return;
          ta.setSelectionRange(text.length, text.length);
        });
      }
    }

    if (isShortcut(settings.shortcutBindings, 'composer.discard', e)) {
      e.preventDefault();
      deps.onDiscard();
    }
  }

  function onRootKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (e.target === draftEl.value) return; // already handled, and it stopped here
    e.preventDefault();
    escapeLadder();
  }

  /**
   * Global chords. Every default here is a Ctrl/Cmd+SHIFT chord on purpose (the
   * toggle's Ctrl+` excepted): bare Ctrl+K/L/A/E/R are real terminal keys and
   * must keep reaching the pane. That reasoning now lives beside each binding in
   * src/shared/shortcuts.ts; the tests read the same table, so which chord fires
   * which command is the registry's fact, not the shape of these branches.
   *
   * Capture phase + stopPropagation so xterm's textarea never sees them.
   */
  function onGlobalKey(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    const bindings = settings.shortcutBindings;

    // Two chords for one command (`composer.toggle`, `composer.toggleAlt`), so
    // the toggle takes both ids. Which of them is the "primary" one is a fact
    // about the registry now, not about the order of the branches here.
    if (isShortcut(bindings, 'composer.toggle', e) || isShortcut(bindings, 'composer.toggleAlt', e)) {
      onToggleRail();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (isShortcut(bindings, 'composer.grow', e)) {
      composer.grow();
      focusDraft();
    } else if (isShortcut(bindings, 'composer.shrink', e)) {
      const wasOpen = mode.value !== 'hidden';
      composer.shrink();
      // Shrinking past `docked` closes it, and a close is a close: routed through
      // `hideComposer` so the short-draft hand-off and the focus move are
      // the same ones Escape and the chord get. Read the store directly:
      // `mode.value` was narrowed by the line above and TS cannot see that
      // `shrink()` changed it.
      if (wasOpen && composer.mode === 'hidden') hideComposer();
    } else if (isShortcut(bindings, 'composer.attach', e)) {
      void deps.onAttachClick();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return {
    openComposer,
    hideComposer,
    onToggleRail,
    typeInto,
    toggleExpanded,
    onOutsidePointerDown,
    onDraftKeydown,
    onRootKeydown,
    onGlobalKey,
  };
}
