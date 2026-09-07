/**
 * Makes a plain mouse drag select IN THE PANE even while the remote owns the
 * mouse — the fix for "I select some code and the highlight disappears".
 *
 * ## The gesture that vanished
 *
 * This pane is always a tmux client, and tmux (with the agent TUIs inside it)
 * turns mouse reporting on. With reporting on, xterm hands every button event
 * to the remote, so a plain drag never selected here at all: it selected in
 * TMUX, whose copy-mode highlight is painted by tmux and dismissed by tmux's
 * own drag-end (`copy-pipe; cancel`) the instant the button goes up. From the
 * user's seat the selection appeared and evaporated under the hand, and
 * copy-paste felt broken even after the yank itself was made real
 * (osc52.ts) — the copy landed, but nothing on screen said so.
 *
 * ## The lever
 *
 * xterm already contains a bypass for exactly this situation: with mouse
 * reporting active, a mousedown is still routed to the LOCAL selection service
 * whenever `SelectionService.shouldForceSelection(event)` answers true —
 * `CoreBrowserTerminal._bindMouse` returns before `sendEvent` on that answer,
 * and `SelectionService.handleMouseDown` is written to select while disabled
 * on the same answer (the drag listeners it then installs never re-check
 * enablement). Off macOS that predicate is `event.shiftKey` — the Shift+drag
 * convention. This module replaces the predicate instead:
 *
 *   - **Plain button-1 forces local selection.** The highlight is xterm's own:
 *     it persists after the release, and TerminalView's mouse-up copies it.
 *   - **Shift forces local selection too.** Shift+drag is the older muscle
 *     memory — the very convention xterm's stock bypass was built on — and
 *     handing it to tmux brought the vanishing-highlight bug back under that
 *     grip. Both grips now behave identically.
 *   - **Alt hands the gesture to the remote.** tmux runs its copy-mode
 *     selection, its drag-end yanks, and the yank reaches the clipboard
 *     through the OSC 52 handler (osc52.ts). This is also the door back to
 *     tmux's own mouse gestures — focusing a pane inside a split, say.
 *
 * Wheel and hover-motion reporting never went through this predicate and are
 * untouched, so tmux keeps scrolling pane history under the wheel.
 *
 * Alt is the remote door because both grips the hand actually uses — plain
 * and Shift — belong to the local selection now, and no click gesture
 * anywhere else in the renderer claims Alt (the app's Alt guards exist for
 * chords and for AltGr, never for the mouse).
 *
 * ## The shape checks
 *
 * `_core._selectionService` is xterm private API. The names survive the
 * minifier (they are property names), but an xterm upgrade could restructure
 * them. Every access is checked first, and anything unexpected answers `false`
 * — a plain no-op — rather than a half-applied patch. The caller records a
 * diag line on that `false`: a silently missing patch is the user's bug back
 * again after an upgrade, with no trace anywhere. The same pattern as
 * xtermWriteBuffer.ts, which is where the convention is documented.
 */

/** Anything at all — the shape checks below are the whole contract. */
type TermLike = unknown;

/** The slice of SelectionService's shape this module needs, verified before use. */
interface SelectionServiceLike {
  shouldForceSelection: (event: MouseEvent) => boolean;
}

function selectionService(term: TermLike): SelectionServiceLike | null {
  const svc = (term as { _core?: { _selectionService?: unknown } } | null | undefined)
    ?._core?._selectionService;
  if (typeof svc !== 'object' || svc === null) return null;
  if (typeof (svc as Record<string, unknown>)['shouldForceSelection'] !== 'function') return null;
  return svc as SelectionServiceLike;
}

/**
 * Make button-1 select locally regardless of mouse reporting — with Shift or
 * without; only Alt leaves the event to the remote.
 *
 * Returns `true` when the predicate was replaced, `false` when xterm's
 * internals did not match the expected shape (an upgraded xterm — the caller
 * reports it). One call per terminal: the selection service lives as long as
 * the terminal and the patch is an instance property, so a session re-point
 * needs no re-application.
 */
export function forceLocalMouseSelection(term: TermLike): boolean {
  const svc = selectionService(term);
  if (!svc) return false;
  svc.shouldForceSelection = (event) => !event.altKey;
  return true;
}
