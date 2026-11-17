import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { usePersistedState } from "./persist";
import { useDrag } from "./useDrag";

/** The expanded session rail's width until the user drags it — the width it was
 *  fixed at before it could be resized. */
export const RAIL_DEFAULT_WIDTH = 200;

/**
 * The narrowest the expanded rail goes. Not a taste call: a row's hover
 * controls (four mark buttons, rename, close) are fixed-size, and on Windows the
 * list also reserves a classic scrollbar gutter. Measured there, they need 167px
 * — any narrower and the last button spills out of the row, and the list grows
 * a horizontal scrollbar. 180 leaves a margin for a wider gutter. Narrower than
 * this is what the collapsed rail is for.
 */
export const RAIL_MIN_WIDTH = 180;

/** `.terminals { min-width }` in App.css — keep the two in step. No divider may
 *  squeeze the terminal past it: the row cannot shrink any further, so it
 *  overflows instead, and whatever sits at the right edge leaves the window. */
export const TERMINALS_MIN_WIDTH = 200;

/**
 * How wide a side pane may get: what it has now, plus whatever the terminal can
 * still give up. While a divider is dragged the pane and the terminal share one
 * fixed stretch of the row, so this holds for the whole drag whichever moment it
 * is measured at.
 */
export function paneRoom(paneWidth: number, terminalsWidth: number): number {
  return paneWidth + Math.max(0, terminalsWidth - TERMINALS_MIN_WIDTH);
}

/** A dragged rail width, held between the rail's minimum and its `room`. */
export function clampRailWidth(desired: number, room: number): number {
  const max = Math.max(RAIL_MIN_WIDTH, room);
  return Math.round(Math.min(Math.max(desired, RAIL_MIN_WIDTH), max));
}

/** The stored width, or the default for anything that is not a usable one. No
 *  upper bound on purpose: what fits depends on the window, which the layout
 *  settles on every frame (see `.session-rail.expanded` in App.css). */
export function parseRailWidth(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= RAIL_MIN_WIDTH ? Math.round(n) : RAIL_DEFAULT_WIDTH;
}

/**
 * The expanded session rail's width, remembered across launches, plus the
 * `onMouseDown` for its resize handle — the divider that sits directly AFTER the
 * rail in the workspace row (the handler measures the element before it).
 *
 * The drag moves the rail by the pointer's travel from where the rail actually
 * IS, not from the stored width. They differ when the window is too small for
 * the stored width and the layout has squeezed the rail: starting from the
 * stored number would leave a dead stretch where the pointer moves and the rail
 * does not.
 */
export function useRailWidth(
  terminalsRef: RefObject<HTMLElement | null>
): [number, (e: ReactMouseEvent<HTMLElement>) => void] {
  const [width, setWidth] = usePersistedState(
    "beecork.railWidth",
    RAIL_DEFAULT_WIDTH,
    parseRailWidth,
    (v) => String(Math.round(v))
  );
  // Where the drag began: the pointer, the rail's rendered width, and its room.
  const from = useRef({ x: 0, width: RAIL_DEFAULT_WIDTH, room: RAIL_DEFAULT_WIDTH });

  const startDrag = useDrag({
    cursor: "col-resize",
    onMove: (e) => {
      const { x, width: startWidth, room } = from.current;
      setWidth(clampRailWidth(startWidth + e.clientX - x, room));
    },
  });

  const onHandleMouseDown = (e: ReactMouseEvent<HTMLElement>) => {
    const rail = e.currentTarget.previousElementSibling;
    // The used value of `width` itself, so a border or padding on the rail can
    // never make each grab nudge it by that many pixels.
    const measured = rail ? parseFloat(getComputedStyle(rail).width) : NaN;
    const rendered = Number.isFinite(measured) ? measured : width;
    const terminals = terminalsRef.current?.getBoundingClientRect().width;
    from.current = {
      x: e.clientX,
      width: rendered,
      // No terminal to measure (never in the real layout): don't grow blind.
      room: terminals === undefined ? rendered : paneRoom(rendered, terminals),
    };
    startDrag(e);
  };

  return [width, onHandleMouseDown];
}
