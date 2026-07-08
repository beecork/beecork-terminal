import { describe, it, expect } from "vitest";
import { scrollbarGeometry, viewportYForFraction } from "./scroll";

describe("scrollbarGeometry", () => {
  it("is hidden when there's no scrollback", () => {
    expect(scrollbarGeometry(0, 40, 0).visible).toBe(false);
  });

  it("is hidden when rows is zero (not yet laid out)", () => {
    expect(scrollbarGeometry(100, 0, 0).visible).toBe(false);
  });

  it("sits at the top when viewport is scrolled all the way up", () => {
    const g = scrollbarGeometry(100, 40, 0);
    expect(g.visible).toBe(true);
    expect(g.topPct).toBeCloseTo(0);
  });

  it("sits at the bottom when pinned to the newest output", () => {
    const g = scrollbarGeometry(100, 40, 100);
    // thumb bottom edge reaches 100%
    expect(g.topPct + g.heightPct).toBeCloseTo(100);
  });

  it("thumb height reflects the visible fraction of the buffer", () => {
    // 40 visible of 140 total ≈ 28.57%
    const g = scrollbarGeometry(100, 40, 50);
    expect(g.heightPct).toBeCloseTo((40 / 140) * 100);
  });

  it("enforces a minimum thumb height on huge buffers", () => {
    const g = scrollbarGeometry(100000, 40, 0);
    expect(g.heightPct).toBe(8);
  });

  it("clamps an out-of-range viewportY instead of overflowing", () => {
    const g = scrollbarGeometry(100, 40, 999);
    expect(g.topPct + g.heightPct).toBeLessThanOrEqual(100.0001);
  });
});

describe("viewportYForFraction", () => {
  it("maps 0 to the top of scrollback", () => {
    expect(viewportYForFraction(0, 500)).toBe(0);
  });
  it("maps 1 to the bottom (baseY)", () => {
    expect(viewportYForFraction(1, 500)).toBe(500);
  });
  it("rounds to a whole line", () => {
    expect(viewportYForFraction(0.5, 501)).toBe(251);
  });
  it("clamps fractions outside 0–1", () => {
    expect(viewportYForFraction(-2, 500)).toBe(0);
    expect(viewportYForFraction(5, 500)).toBe(500);
  });
});
