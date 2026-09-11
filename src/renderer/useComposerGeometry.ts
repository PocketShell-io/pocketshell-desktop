import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue';
import { useComposerStore, type ComposerMode } from './stores/composer';
import {
  clampGeometry,
  maximizedGeometry,
  moveGeometry,
  resizeGeometry,
  snapGeometry,
  type ComposerGeometry,
  type PaneBox,
  type ResizeEdge,
} from '../shared/composerGeometry';

export interface ComposerGeometryDeps {
  rootEl: Ref<HTMLDivElement | null>;
  composer: ReturnType<typeof useComposerStore>;
  mode: ComputedRef<ComposerMode>;
  /** Maximize/restore — the same toggle the header button and the chord call. */
  toggleExpanded: () => void;
}

/** What a press on the card intends to do with the drag that follows. */
type DragIntent = { kind: 'move' } | { kind: 'resize'; edge: ResizeEdge };

/**
 * Moving and resizing the composer card: the measured pane it lives in, the
 * one drag loop that serves both the header's move and the grips' resize, the
 * painted box, and the ResizeObserver that keeps it all clamped. The
 * arithmetic for each lives in shared/composerGeometry.ts, so the rules that
 * keep the card on-screen and usable are unit-tested rather than re-derived
 * from mouse events here. Extracted from PromptComposer.vue with its
 * reasoning; the measurement lifecycle registers itself for the mount's
 * lifetime, exactly where the view's used to.
 */
export function useComposerGeometry(deps: ComposerGeometryDeps): {
  RESIZE_EDGES: readonly ResizeEdge[];
  railEl: Ref<HTMLElement | null>;
  card: ComputedRef<ComposerGeometry>;
  rootStyle: ComputedRef<{ right: string; bottom: string; width: string; height: string }>;
  beginDrag: (e: MouseEvent, intent: DragIntent) => void;
  onHeaderDown: (e: MouseEvent) => void;
  onHeaderDoubleClick: (e: MouseEvent) => void;
} {
  const composer = deps.composer;
  const mode = deps.mode;

  /**
   * Every edge and every corner, so the card resizes the way a window does.
   *
   * Edges first, corners last: they are siblings at one z-index, so DOM order is
   * the hit-test tiebreak, and a corner has to come after the two edges it
   * overlaps or it would never be reachable.
   *
   * The sizes and floors these drags clamp against live in
   * src/shared/composerGeometry.ts, with the reasoning for each number.
   */
  const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  /**
   * The card's world: the whole dock, plus the one corner it may not have.
   *
   * The card used to be confined to the dock MINUS a full-width strip along the
   * bottom, because that strip was reserved out of the terminal and the toggle
   * lived in it. The strip is gone — the composer takes no terminal space at
   * all now — so the card gets the whole pane, and the only thing it must still
   * clear is the toggle's own small box.
   *
   * That box is MEASURED from the live element rather than declared as a
   * constant: its size is a CSS decision, and measuring is what keeps the two
   * from drifting apart the next time the toggle is restyled.
   */
  const paneBox = ref<PaneBox | null>(null);
  const railEl = ref<HTMLElement | null>(null);
  let paneObserver: ResizeObserver | null = null;

  function measurePane(): void {
    const el = deps.rootEl.value;
    if (!el) return;
    const root = el.getBoundingClientRect();
    const rail = railEl.value?.getBoundingClientRect();
    paneBox.value = {
      width: el.clientWidth,
      height: el.clientHeight,
      ...(rail
        ? { keepOut: { width: root.right - rail.left, height: root.bottom - rail.top } }
        : {}),
    };
  }

  let drag: (DragIntent & { x: number; y: number; from: ComposerGeometry }) | null = null;

  /**
   * The box to PAINT, which is not always the box that is stored: `expanded`
   * ignores the remembered geometry entirely (that is what restore returns to),
   * and every other mode is clamped to the current pane for display only. The
   * store keeps the raw numbers, so shrinking the window and restoring it puts
   * the card back where the user left it.
   */
  const card = computed<ComposerGeometry>(() => {
    const pane = paneBox.value;
    // One frame, before the first measurement lands: the stored box is the best
    // guess available, and it was legal for the last pane this window had.
    if (!pane) return composer.geometry;
    if (mode.value === 'expanded') return maximizedGeometry(pane);
    return clampGeometry(composer.geometry, pane);
  });

  function beginDrag(e: MouseEvent, intent: DragIntent): void {
    if (mode.value === 'hidden' || e.button !== 0) return;
    // Also stops the press from moving focus, so dragging the card by its header
    // never costs the caret its place in the draft.
    e.preventDefault();
    measurePane();
    drag = { ...intent, x: e.clientX, y: e.clientY, from: card.value };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e: MouseEvent): void {
    const pane = paneBox.value;
    if (!drag || !pane) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    composer.setGeometry(
      drag.kind === 'move'
        ? moveGeometry(drag.from, dx, dy, pane)
        : resizeGeometry(drag.from, dx, dy, drag.edge, pane),
    );
    // A drag always produces a concrete remembered box, so it leaves the
    // maximized state — exactly like dragging a maximized OS window restores it
    // under the cursor. `drag.from` IS the maximized box, so nothing jumps.
    if (mode.value !== 'docked') composer.setMode('docked');
  }

  function onDragEnd(): void {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    const pane = paneBox.value;
    // Snap on release only, and only after a MOVE. During the drag the card
    // follows the pointer 1:1, and snapping a RESIZE would
    // silently change the size the user had just chosen.
    if (drag?.kind === 'move' && pane) {
      composer.setGeometry(snapGeometry(composer.geometry, pane));
    }
    drag = null;
  }

  /**
   * The header strip is the card's title bar: press it and the card follows the
   * pointer. Presses that land on a button are left alone — maximize and close
   * are the two things in this strip that are not the handle.
   */
  function onHeaderDown(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('button')) return;
    beginDrag(e, { kind: 'move' });
  }

  /** Double-clicking a title bar maximizes the window, everywhere. Same here. */
  function onHeaderDoubleClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('button')) return;
    deps.toggleExpanded();
  }

  /**
   * Where the card is painted. Only ever read while the card exists: `hidden`
   * removes it from the tree entirely, because the rail is now a separate element
   * that stays put rather than the same box collapsed.
   */
  const rootStyle = computed(() => {
    const g = card.value;
    return {
      right: `${g.right}px`,
      bottom: `${g.bottom}px`,
      width: `${g.width}px`,
      height: `${g.height}px`,
    };
  });

  onMounted(() => {
    measurePane();
    if (deps.rootEl.value && typeof ResizeObserver !== 'undefined') {
      // The pane changes without a window resize too — the session panel's
      // splitter moves it — and a card clamped to a stale pane would hang off
      // the edge. Nothing in here resizes the root, so this cannot feed back.
      // The root and the toggle are rendered in every mode, so the measurement
      // stays live while the card is closed and re-opening lands clamped.
      paneObserver = new ResizeObserver(measurePane);
      paneObserver.observe(deps.rootEl.value);
    }
  });

  onBeforeUnmount(() => {
    paneObserver?.disconnect();
    paneObserver = null;
    onDragEnd();
  });

  return {
    RESIZE_EDGES,
    railEl,
    card,
    rootStyle,
    beginDrag,
    onHeaderDown,
    onHeaderDoubleClick,
  };
}
