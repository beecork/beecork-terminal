// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import SessionRail from "./SessionRail";
import { RAIL_MIN_WIDTH } from "../lib/useRailWidth";

const noop = () => {};
const props = {
  items: [{ id: "s1", name: "Session 1" }],
  activeId: "s1",
  wantsYou: new Set<string>(),
  busy: new Set<string>(),
  onSelect: noop,
  onCreate: noop,
  onClose: noop,
  onToggleMark: noop,
  onClearMarks: noop,
  onToggleExpand: noop,
  onRename: noop,
  onOpenSettings: noop,
  onCreateIn: noop,
  onSplitWith: noop,
  onUnsplit: noop,
  onCloseOthers: noop,
  onReorder: noop,
  onAddDivider: () => "d1",
  onRenameDivider: noop,
  onRemoveDivider: noop,
};

const rail = (container: HTMLElement) => container.querySelector<HTMLElement>(".session-rail")!;

describe("SessionRail width", () => {
  // Vitest runs without globals here, so RTL cannot auto-register its cleanup.
  beforeEach(() => cleanup());

  it("is as wide as the user dragged it while expanded", () => {
    const { container } = render(<SessionRail {...props} expanded width={412} />);
    expect(rail(container).style.width).toBe("412px");
  });

  // A small window may squeeze the rail (it is the one pane that shrinks), but
  // never past the point where a row's hover buttons stop fitting.
  it("carries its minimum with it", () => {
    const { container } = render(<SessionRail {...props} expanded width={412} />);
    expect(rail(container).style.minWidth).toBe(`${RAIL_MIN_WIDTH}px`);
  });

  // The collapsed rail is a fixed strip (CSS). A dragged width leaking into it
  // would make "collapse" stop collapsing.
  it("ignores the dragged width while collapsed", () => {
    const { container } = render(<SessionRail {...props} expanded={false} width={412} />);
    expect(rail(container).style.width).toBe("");
    expect(rail(container).style.minWidth).toBe("");
    expect(rail(container).classList.contains("collapsed")).toBe(true);
  });

  it("applies the width again when it is expanded", () => {
    const { container, rerender } = render(
      <SessionRail {...props} expanded={false} width={412} />
    );
    rerender(<SessionRail {...props} expanded width={412} />);
    expect(rail(container).style.width).toBe("412px");
  });
});
