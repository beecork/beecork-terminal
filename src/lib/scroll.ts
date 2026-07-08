// Pure geometry for the terminal's custom scrollbar overlay. Kept out of the
// component so it's unit-testable and framework-free.

export interface ScrollbarGeometry {
  /** false when there's no scrollback to indicate (thumb hidden) */
  visible: boolean;
  /** thumb top edge, 0–100 (% of the track) */
  topPct: number;
  /** thumb height, 0–100 (% of the track) */
  heightPct: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Thumb geometry from xterm's scroll state. `baseY` is the max scroll offset
 * (lines of scrollback above the viewport when pinned to the bottom), `rows` the
 * visible rows, `viewportY` the current top line of the viewport (0…baseY).
 * `minHeightPct` keeps the thumb grabbable on huge buffers. Hidden when there's
 * nothing to scroll.
 */
export function scrollbarGeometry(
  baseY: number,
  rows: number,
  viewportY: number,
  minHeightPct = 8
): ScrollbarGeometry {
  if (baseY <= 0 || rows <= 0) return { visible: false, topPct: 0, heightPct: 100 };
  const total = baseY + rows; // top of scrollback → bottom of current screen
  const heightPct = Math.min(100, Math.max(minHeightPct, (rows / total) * 100));
  const pos = clamp01(viewportY / baseY); // 0 at top, 1 at bottom
  const topPct = pos * (100 - heightPct);
  return { visible: true, topPct, heightPct };
}

/**
 * Inverse of the position mapping: a 0–1 fraction down the track's travel maps to
 * a target viewport line (0…baseY). Used while dragging the thumb / clicking the
 * track.
 */
export function viewportYForFraction(fraction: number, baseY: number): number {
  return Math.round(clamp01(fraction) * Math.max(0, baseY));
}
