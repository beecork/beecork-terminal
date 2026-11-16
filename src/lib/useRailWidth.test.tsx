// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  useRailWidth,
  clampRailWidth,
  parseRailWidth,
  paneRoom,
  RAIL_DEFAULT_WIDTH,
  RAIL_MIN_WIDTH,
  TERMINALS_MIN_WIDTH,
} from "./useRailWidth";

describe("paneRoom", () => {
  it("is the pane's own width plus what the terminal can still give up", () => {
    expect(paneRoom(200, 1000)).toBe(200 + 1000 - TERMINALS_MIN_WIDTH);
  });
  // A terminal already at (or somehow under) its minimum has nothing to give:
  // the pane keeps what it has and cannot grow. It must never come out SMALLER
  // than the pane is now — that would shrink a pane the user only clicked on.
  it("leaves no room to grow once the terminal is at its minimum", () => {
    expect(paneRoom(380, TERMINALS_MIN_WIDTH)).toBe(380);
    expect(paneRoom(380, TERMINALS_MIN_WIDTH - 50)).toBe(380);
  });
});

describe("clampRailWidth", () => {
  it("passes a width that fits, as whole pixels", () => {
    expect(clampRailWidth(321.4, 1000)).toBe(321);
  });
  it("stops at the minimum", () => {
    expect(clampRailWidth(40, 1000)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(-500, 1000)).toBe(RAIL_MIN_WIDTH);
  });
  it("stops at the room", () => {
    expect(clampRailWidth(5000, 900)).toBe(900);
  });
  // A window too small to give the rail even its minimum: the minimum wins (the
  // CSS min-width says the same), rather than the two bounds crossing.
  it("lets the minimum win when the room is smaller than it", () => {
    expect(clampRailWidth(300, RAIL_MIN_WIDTH - 60)).toBe(RAIL_MIN_WIDTH);
  });
});

describe("parseRailWidth", () => {
  it("reads back what was stored", () => {
    expect(parseRailWidth("412")).toBe(412);
  });
  // Storage is untrusted input: anything that is not a usable width is the
  // default, never a rail drawn at NaN or zero pixels.
  it("falls back to the default for anything unusable", () => {
    for (const raw of ["", "abc", "NaN", "Infinity", "-300", "0", String(RAIL_MIN_WIDTH - 1)]) {
      expect(parseRailWidth(raw), JSON.stringify(raw)).toBe(RAIL_DEFAULT_WIDTH);
    }
  });
  it("accepts the minimum itself", () => {
    expect(parseRailWidth(String(RAIL_MIN_WIDTH))).toBe(RAIL_MIN_WIDTH);
  });
});

// The layout the hook expects: the rail, then its handle, then the terminals.
function Harness() {
  const terminalsRef = useRef<HTMLDivElement>(null);
  const [width, startDrag] = useRailWidth(terminalsRef);
  return (
    <div>
      <div data-testid="rail" style={{ width }} />
      <div data-testid="handle" onMouseDown={startDrag} />
      <div data-testid="terminals" ref={terminalsRef} />
    </div>
  );
}

const KEY = "beecork.railWidth";
const railWidth = () => screen.getByTestId("rail").style.width;

/** jsdom has no layout: say how wide the terminal area is drawn. */
function terminalsAre(width: number) {
  vi.spyOn(screen.getByTestId("terminals"), "getBoundingClientRect").mockReturnValue({
    width,
  } as DOMRect);
}

/** Press the handle at `from`, move the pointer to each of `to`, and release. */
function drag(from: number, ...to: number[]) {
  fireEvent.mouseDown(screen.getByTestId("handle"), { clientX: from, button: 0 });
  for (const x of to) fireEvent.mouseMove(window, { clientX: x });
  fireEvent.mouseUp(window);
}

describe("useRailWidth", () => {
  beforeEach(() => {
    // Vitest runs without globals here, so RTL cannot auto-register its cleanup.
    cleanup();
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts at the width the rail always had", () => {
    render(<Harness />);
    expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
  });

  it("moves the rail by the pointer's travel, and remembers it", () => {
    render(<Harness />);
    terminalsAre(1000);
    // Grabbed 4px into the handle: the rail must not jump by those 4px.
    drag(204, 254, 324);
    expect(railWidth()).toBe("320px");
    expect(localStorage.getItem(KEY)).toBe("320");

    cleanup();
    render(<Harness />); // the next launch
    expect(railWidth()).toBe("320px");
  });

  it("stops at the minimum however far left the pointer goes", () => {
    render(<Harness />);
    terminalsAre(1000);
    drag(204, -400);
    expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  });

  // The whole point of the upper bound: past it the terminal is at its
  // min-width, the row overflows, and the right panel's edge leaves the window.
  it("stops when the terminal is down to its minimum width", () => {
    render(<Harness />);
    terminalsAre(1000);
    drag(204, 5000);
    expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 1000 - TERMINALS_MIN_WIDTH}px`);
  });

  // A small window squeezes the rail below its stored width (flex-shrink in
  // App.css). Dragging from the STORED number would leave a dead stretch — the
  // pointer moving, the rail not — until the two met.
  it("drags from where the rail is drawn, not from the stored width", () => {
    localStorage.setItem(KEY, "900");
    render(<Harness />);
    const rail = screen.getByTestId("rail");
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
      el === rail ? ({ width: "504px" } as CSSStyleDeclaration) : real(el, pseudo)
    );
    terminalsAre(TERMINALS_MIN_WIDTH); // squeezed: the terminal is at its minimum

    drag(508, 408);
    expect(railWidth()).toBe("404px"); // 504 − 100, immediately

    // …and with the terminal at its minimum there was no room to grow at all.
    localStorage.setItem(KEY, "900");
    cleanup();
    render(<Harness />);
    const rail2 = screen.getByTestId("rail");
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
      el === rail2 ? ({ width: "504px" } as CSSStyleDeclaration) : real(el, pseudo)
    );
    terminalsAre(TERMINALS_MIN_WIDTH);
    drag(508, 900);
    expect(railWidth()).toBe("504px");
  });

  it("ends with the release — later pointer moves change nothing", () => {
    render(<Harness />);
    terminalsAre(1000);
    drag(204, 304);
    expect(railWidth()).toBe("300px");
    fireEvent.mouseMove(window, { clientX: 700 });
    expect(railWidth()).toBe("300px");
  });

  it("ignores a right-click on the handle", () => {
    render(<Harness />);
    terminalsAre(1000);
    fireEvent.mouseDown(screen.getByTestId("handle"), { clientX: 204, button: 2 });
    fireEvent.mouseMove(window, { clientX: 500 });
    fireEvent.mouseUp(window);
    expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
  });

  it("restores the default for a stored width it cannot use", () => {
    localStorage.setItem(KEY, "banana");
    render(<Harness />);
    expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
  });
});
