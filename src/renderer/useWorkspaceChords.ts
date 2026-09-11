import { onBeforeUnmount, onMounted, type ComputedRef, type Ref } from 'vue';
import { adjacentIndex } from '../shared/listNavigation';
import type { LaunchChoice } from '../shared/agentLaunch';
import { isShortcut } from '../shared/shortcuts';
import { editingTarget } from './editingTarget';
import type { WorkspaceTab } from '../shared/workspaceTabs';
import type { useSettingsStore } from './stores/settings';

export interface WorkspaceChordsDeps {
  /** The tab being renamed, if any — a rename in progress owns the keyboard. */
  renaming: Ref<{ id: string; session: string } | null>;
  tabs: ComputedRef<WorkspaceTab[]>;
  activeTab: ComputedRef<WorkspaceTab | null>;
  settings: ReturnType<typeof useSettingsStore>;
  /** The ONE selection path a chord steps through. */
  goToTab: (id: string) => void;
  /** The `+`'s create, which the quick chord shares rather than re-implements. */
  createSession: (choice: LaunchChoice | null) => Promise<void>;
}

/**
 * The folder workspace's window chords: `Ctrl+[` / `Ctrl+]` to step one tab
 * left or right, and `Ctrl+N` for a plain shell in this folder. Extracted from
 * FolderWorkspaceView.vue with its reasoning; the listener registers itself for
 * the mount's lifetime, exactly where the view's used to.
 */
export function useWorkspaceChords(deps: WorkspaceChordsDeps): void {
  /**
   * `Ctrl+[` / `Ctrl+]` to step one tab left or right.
   *
   * ## Why this is a WINDOW listener and not the terminal's key handler
   *
   * The chord has to work with focus in the terminal, the Files tree or the
   * composer, and those are three different keyboard owners: xterm consults its
   * own custom handler, CodeMirror runs a keymap, and the composer's textarea is
   * an ordinary field. Routing the chord through each of them would be three
   * implementations of one gesture — and the third one added later would be the
   * one that forgot to `preventDefault`.
   *
   * A `keydown` in CAPTURE on `window` runs before ANY of them, whatever holds
   * focus, because capture descends from the window to the target. So there is
   * one handler and it cannot be reached around. It is the same shape the
   * composer's own `Ctrl+\`` uses (PromptComposer's `onGlobalKey`), deliberately.
   *
   * ## `preventDefault` AND `stopPropagation`, and why both are load-bearing
   *
   * `stopPropagation` is what stops the event ever reaching xterm's textarea, so
   * xterm never gets to encode it. `preventDefault` is what stops CHROMIUM acting
   * on it — Electron still has a browser underneath. Leaving either off is the
   * defect that has now landed three times in this app (bc86cf7's doubled first
   * letter, 3628090's doubled paste, and the Ctrl+V route after them): one
   * keystroke, two paths.
   *
   * ## The terminal is NOT a safe place to let this fall through
   *
   * The brief's premise was that a tab chord is affordable "because terminals
   * cannot encode it". Measured against the xterm this app ships (@xterm/xterm 6,
   * `evaluateKeyboardEvent`), that is not true for THIS chord either, which is why
   * TerminalView also declines it: **`Ctrl+[` is C0.ESC (`0x1B`)** — THE physical
   * escape of older keyboards and readline's meta-prefix — **and `Ctrl+]` is
   * C0.GS**. That is a real cost, in vim sessions most of all, and it is stated
   * rather than assumed; meta sequences remain reachable through Alt.
   *
   * ## What went, and what came back with it
   *
   * `Ctrl+1`..`Ctrl+9` (jump to the Nth tab), `Ctrl+Shift+PageUp`/`PageDown`
   * (move the active tab) and the CYCLE — `Ctrl+Tab` / `Ctrl+Shift+Tab` — were
   * removed at the user's request: "remove ctrl 1 2 3 hotkey", "Move the active
   * tab left or right remove this too", "remove these hotkeys let's keep only
   * ctrl left and ctrl right".
   *
   * Removing them GIVES KEYS BACK to the pane, which is the part worth writing
   * down: `Ctrl+3`..`Ctrl+8` are the C0 controls `ESC`, `FS`, `GS`, `RS`, `US`
   * and `DEL` (`Ctrl+3` is a widely used stand-in for Escape);
   * `Ctrl+Shift+PageUp`/`PageDown` reach xterm's own scrollback; and `Ctrl+Tab`
   * is C0.HT — completion at a shell prompt, since xterm ignores Ctrl on Tab —
   * while `Ctrl+Shift+Tab` is ESC [ Z, back-tab. All of them were being
   * swallowed for chords that no longer exist, so the declines in TerminalView
   * went with them (`nextWorkspaceTabId` went with the cycle).
   *
   * Moving a tab from the keyboard went with the chord. The drag
   * is unaffected and is still the way to reorder.
   *
   * ## What it deliberately does not touch
   *
   * Anything with Alt or Meta. `Ctrl+Alt` is how AltGr arrives on European
   * layouts, where `[` and `]` carry printable characters on several of them —
   * the same reason TerminalView's Ctrl+V branch demands `!e.altKey`. And a
   * rename in progress owns the keyboard: the field is a one-word edit with
   * Enter/Escape of its own, and stepping out of it would leave an orphaned edit
   * on a tab the user can no longer see.
   */
  function onWindowKeydown(e: KeyboardEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.altKey) return;
    if (deps.renaming.value !== null) return;

    // The chord is DATA (src/shared/shortcuts.ts). This copy and the decline
    // branch in TerminalView's `onCustomKey` are the two that would otherwise
    // drift; reading the same table is what keeps them saying the same thing.
    const bindings = deps.settings.shortcutBindings;

    // The old hand-spelled `if (e.shiftKey) return;` went with the inline chords:
    // it was a stand-in for "these are all Shift-free", which is now each chord's
    // own business in the registry. Keeping it would silently refuse any rebinding
    // that wears Shift.

    // `Ctrl+[` / `Ctrl+]`: the tab to the left, the tab to the right.
    //
    // First carried by `Ctrl+←`/`Ctrl+→`, moved here at the user's word —
    // "ctrl+left and right conflicts with jumping over words". The original ask
    // stands underneath: step left / step right within THIS workspace, while
    // `Ctrl+↑`/`Ctrl+↓` walks workspaces, which `HostWorkspaceView` owns. The
    // horizontal axis is the tab bar and the vertical one is the panel down the
    // side, which is where those two things actually sit on screen.
    //
    // THEY CLAMP, and that is deliberate (see `adjacentIndex`). A direction, not
    // a cycle: landing at the opposite end of the bar is not what "further left"
    // asks for.
    //
    // WHAT IT COSTS is stated rather than assumed: `Ctrl+[` is Escape at a shell
    // prompt and `Ctrl+]` is GS (see the registry note). Vim users lose the
    // bracket escape inside panes of this workspace; meta chords keep working
    // through Alt.
    //
    // Still not in a real text field — see `editingTarget`. No editing gesture
    // rides these keys, but prose being typed should not be interrupted by
    // navigation either. The direction reads off `e.key`: which HALF of the pair
    // fired, and only the registry knows that pair exists.
    if (isShortcut(bindings, 'tabs.stepLeftRight', e)) {
      if (editingTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const index = adjacentIndex(
        deps.tabs.value.length,
        deps.tabs.value.findIndex((t) => t.id === deps.activeTab.value?.id),
        e.key === ']' ? 1 : -1,
      );
      const target = index === null ? null : (deps.tabs.value[index]?.id ?? null);
      if (target !== null) deps.goToTab(target);
      return;
    }

    // `Ctrl+N`: a plain shell in THIS folder — the workspace `+`'s create with
    // the dialog taken out. `createSession(null)` is the same function the
    // launch dialog confirms into, so the quick path cannot drift from the
    // clicked one: unique name walk, pending row, new tab, keyboard in the pane,
    // and a refusal lands in the strip like any other.
    //
    // This is the app's one bare-Ctrl chord taken against a key the shell
    // receives (^N, readline next-history) — claimed at the user's word, with
    // the cost recorded in the registry entry. `e.repeat` is refused because a
    // held chord would mint a session per repeat; one press, one session.
    // Not in a text field, and not during a rename — the same stands-down as
    // the tab chords, which the early return above already carries.
    if (isShortcut(bindings, 'sessions.newInFolder', e)) {
      if (editingTarget(e.target)) return;
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      void deps.createSession(null);
    }
  }

  onMounted(() => window.addEventListener('keydown', onWindowKeydown, { capture: true }));
  onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, { capture: true }));
}
