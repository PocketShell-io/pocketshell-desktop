/**
 * The prompt composer's box: where the card sits in the session pane and how
 * big it is. Pure arithmetic, no DOM — the component measures the pane and
 * feeds the numbers in, which is what makes every rule here unit-testable
 *.
 *
 * COORDINATE SPACE. Everything is measured against `.composer-dock`, which is
 * the session body inset by `--composer-inset` on all four sides. The card can
 * therefore never touch the pane's edges, and — the reason the inset lives in
 * CSS on the dock rather than as a number in here — the JS never has to know
 * what the inset is. `{ right: 0, bottom: 0 }` IS the resting corner.
 *
 * The card is a pure OVERLAY: the pane it floats in is the whole terminal, and
 * nothing here reserves any of it. The one place the card may not go is the
 * small corner box the fixed open/close toggle occupies — `PaneBox.keepOut`
 * below — because a card that could be dragged on top of the control that
 * closes it would be a trap.
 *
 * WHY right/bottom AND NOT left/top. The card's home is the bottom-right
 * corner: that is where it starts, where the collapsed pill lives, and where
 * `defaultGeometry()` returns it to. Storing the offsets from that same corner
 * means the resting state is two zeroes rather than arithmetic over the pane
 * size, and a pane that gets SHORTER carries the card up with its bottom edge
 * instead of pushing it out of sight. The left/top edges are derived when a
 * resize needs them.
 */

export interface ComposerGeometry {
  /** px from the dock's right edge to the card's right edge. */
  right: number;
  /** px from the dock's bottom edge to the card's bottom edge. */
  bottom: number;
  width: number;
  height: number;
}

/** The dock's content box — the area the card is confined to. */
export interface PaneBox {
  width: number;
  height: number;
  /**
   * A box in the pane's BOTTOM-RIGHT corner the card may not cover: the fixed
   * toggle. Measured from the live element rather
   * than declared here, so the toggle's size stays a CSS decision and this is
   * simply told the answer.
   *
   * A corner box rather than the full-width band it replaced: with the reserved
   * strip gone the pane is all terminal, and forbidding the card a stripe
   * across the whole bottom would cost placement freedom for no reason. Only
   * the toggle itself is off-limits.
   */
  keepOut?: { width: number; height: number };
}

/** Which edges a drag moves. Corners carry one letter per axis. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const COMPOSER_LAYOUT = {
  /** ~80 columns of the draft's 13px mono — the width a prompt is written at. */
  defaultWidth: 720,
  defaultHeight: 240,
  /**
   * Floor. The control row needs ~220px for the tools pill, the Send button and
   * their padding; 360 leaves ~40 mono columns of draft beside that, which is
   * still a prompt rather than a slot.
   */
  minWidth: 360,
  /**
   * Floor, from docs/screenshots/composer-03-min-height.png: at 190px the
   * toolbar, two draft lines, the tile strip and the Send row all still fit.
   */
  minHeight: 190,
  /** VS Code caps its panel at ~80% of the editor area. So do we. */
  maxHeightFraction: 0.8,
  /** How near an edge a drag has to END to snap flush to it. Deliberately small. */
  snapThreshold: 12,
} as const;

function clamp(value: number, lo: number, hi: number): number {
  // `hi < lo` happens on a pane smaller than the floor; the floor wins, and the
  // caller's own max-height/width caps keep the card inside the window.
  return Math.max(lo, Math.min(value, hi));
}

/**
 * The tallest the card may be in this pane.
 *
 * The 80% cap, but never below the floor — a card shorter than its own control
 * row is not a smaller composer, it is a broken one. On a pane shorter than the
 * floor the PANE wins anyway: a card taller than the space it lives in would
 * push Send off the bottom, which is the one durable lesson of the not-ported list says
 * must never happen.
 */
export function maxHeightIn(pane: PaneBox): number {
  return Math.min(
    pane.height,
    Math.max(COMPOSER_LAYOUT.minHeight, Math.round(pane.height * COMPOSER_LAYOUT.maxHeightFraction)),
  );
}

/** The resting card: default size, tucked into the dock's bottom-right corner. */
export function defaultGeometry(): ComposerGeometry {
  return {
    right: 0,
    bottom: 0,
    width: COMPOSER_LAYOUT.defaultWidth,
    height: COMPOSER_LAYOUT.defaultHeight,
  };
}

/**
 * Force a geometry to be legal for `pane`: at least the floor, no bigger than
 * the pane, and entirely inside it.
 *
 * Applied for DISPLAY on every render rather than written back to the store, so
 * that shrinking the window and restoring it puts the card back where the user
 * left it instead of permanently rewriting their layout to fit the smallest
 * window they ever had.
 */
export function clampGeometry(g: ComposerGeometry, pane: PaneBox): ComposerGeometry {
  const width = clamp(g.width, Math.min(COMPOSER_LAYOUT.minWidth, pane.width), pane.width);
  const right = clamp(g.right, 0, Math.max(0, pane.width - width));

  // Only a card whose horizontal span reaches over the corner has to clear the
  // toggle at all; one parked to the left of it may sit on the pane's floor.
  const keep = pane.keepOut;
  const overCorner = keep !== undefined && right < keep.width;

  // Clearing it means fitting ABOVE it, so the height cap tightens too —
  // otherwise raising the card would only push its top off the pane instead.
  const minH = Math.min(COMPOSER_LAYOUT.minHeight, pane.height);
  const roomAbove = overCorner && keep ? Math.max(0, pane.height - keep.height) : pane.height;
  const height = clamp(g.height, minH, Math.max(minH, Math.min(maxHeightIn(pane), roomAbove)));

  const ceiling = Math.max(0, pane.height - height);
  // `Math.min` with the ceiling is the degenerate guard: on a pane too short to
  // hold the card above the toggle, the card wins and the toggle is covered.
  // That needs a pane shorter than the 190px floor plus the toggle, which is
  // not a window anyone has — and Escape and Ctrl+` still close it.
  const floor = overCorner && keep ? Math.min(keep.height, ceiling) : 0;

  return { width, height, right, bottom: clamp(g.bottom, floor, ceiling) };
}

/**
 * Maximized. Deliberately full-width, unlike the resting card: "maximize" is an
 * explicit request for all the room there is, which is a different question
 * from how wide a prompt wants to be by default.
 */
export function maximizedGeometry(pane: PaneBox): ComposerGeometry {
  // Full width means it always spans the corner, so `clampGeometry` lifts it
  // clear of the toggle and shortens it to suit. Maximized still cannot cover
  // the control that un-maximizes it.
  return clampGeometry(
    { right: 0, bottom: 0, width: pane.width, height: maxHeightIn(pane) },
    pane,
  );
}

/**
 * Move by a pointer delta. `dx`/`dy` are screen deltas (right and down are
 * positive), so both offsets count DOWN as the card travels away from its
 * corner. Clamped fully inside the pane, which is the strongest form of "never
 * draggable off-screen": there is no partially-lost state to recover from.
 */
export function moveGeometry(
  start: ComposerGeometry,
  dx: number,
  dy: number,
  pane: PaneBox,
): ComposerGeometry {
  return clampGeometry({ ...start, right: start.right - dx, bottom: start.bottom - dy }, pane);
}

/**
 * Resize by dragging `edge`.
 *
 * Worked in edge coordinates — each edge's distance from the pane side it faces
 * — because that makes the rule trivial: the dragged edge moves and the
 * OPPOSITE edge does not. Doing it in width/offset terms instead needs the two
 * to be adjusted in lockstep, which is where sign errors live.
 */
export function resizeGeometry(
  start: ComposerGeometry,
  dx: number,
  dy: number,
  edge: ResizeEdge,
  pane: PaneBox,
): ComposerGeometry {
  const base = clampGeometry(start, pane);
  let { right, bottom, width, height } = base;
  const left = pane.width - base.right - base.width;
  const top = pane.height - base.bottom - base.height;
  const minW = Math.min(COMPOSER_LAYOUT.minWidth, pane.width);
  const minH = Math.min(COMPOSER_LAYOUT.minHeight, pane.height);
  const maxH = maxHeightIn(pane);

  if (edge.includes('w')) {
    const newLeft = clamp(left + dx, 0, pane.width - right - minW);
    width = pane.width - right - newLeft;
  } else if (edge.includes('e')) {
    right = clamp(right - dx, 0, pane.width - left - minW);
    width = pane.width - left - right;
  }

  if (edge.includes('n')) {
    const newTop = clamp(top + dy, Math.max(0, pane.height - bottom - maxH), pane.height - bottom - minH);
    height = pane.height - bottom - newTop;
  } else if (edge.includes('s')) {
    bottom = clamp(bottom - dy, Math.max(0, pane.height - top - maxH), pane.height - top - minH);
    height = pane.height - top - bottom;
  }

  return clampGeometry({ right, bottom, width, height }, pane);
}

/**
 * Pull a nearly-flush card the rest of the way to the edge it is near.
 *
 * Applied on mouse-UP only, never during the drag:  requires
 * panel drag geometry to follow the pointer 1:1, and a card that jumps under a
 * moving cursor reads as a bug rather than as help. Each axis snaps
 * independently, so the corners come out of the two edge rules rather than
 * needing four corner cases of their own.
 */
export function snapGeometry(
  g: ComposerGeometry,
  pane: PaneBox,
  threshold: number = COMPOSER_LAYOUT.snapThreshold,
): ComposerGeometry {
  const snap = (value: number, extent: number, size: number): number => {
    const far = Math.max(0, extent - size);
    for (const target of [0, far]) {
      if (Math.abs(value - target) <= threshold) return target;
    }
    return value;
  };
  const c = clampGeometry(g, pane);
  return clampGeometry(
    {
      ...c,
      right: snap(c.right, pane.width, c.width),
      bottom: snap(c.bottom, pane.height, c.height),
    },
    pane,
  );
}
