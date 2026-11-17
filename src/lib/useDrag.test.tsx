// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useDrag } from "./useDrag";

// A resize handle with a child (the grip), and a second handle beside it, as in
// the app: several `useDrag` hooks are mounted at once.
function Handles({ onMove = () => {}, onEnd }: { onMove?: () => void; onEnd?: () => void }) {
  const start = useDrag({ cursor: "row-resize", onMove, onEnd });
  const startOther = useDrag({ onMove: () => {} });
  return (
    <div>
      <div data-testid="handle" onMouseDown={start}>
        <span data-testid="grip" />
      </div>
      <div data-testid="other" onMouseDown={startOther} />
    </div>
  );
}

// A row that is dragged to reorder: the thresholded flavour.
function Row({ onMove }: { onMove: () => void }) {
  const start = useDrag({ threshold: 5, cursor: "grabbing", onMove });
  return <div data-testid="row" onMouseDown={start} />;
}

const root = document.documentElement;
const resizing = () => root.hasAttribute("data-resizing");
const marked = (id: string) => screen.getByTestId(id).hasAttribute("data-dragging");

describe("useDrag — a resize drag keeps the pointer to itself", () => {
  beforeEach(() => {
    // Vitest runs without globals here, so RTL cannot auto-register its cleanup.
    cleanup();
    root.removeAttribute("data-resizing");
    document.body.style.cursor = "";
  });

  // The handle is redrawn a frame after the pointer moved, so for that frame the
  // pointer is on whatever lies beside it. Unmarked, that lit a folder row and
  // dropped the handle's own highlight on every mousemove of an upward drag.
  it("marks the root and the handle from the press until the release", () => {
    render(<Handles />);
    expect(resizing()).toBe(false);

    fireEvent.mouseDown(screen.getByTestId("handle"), { button: 0 });
    expect(resizing()).toBe(true);
    expect(marked("handle")).toBe(true);
    expect(document.body.style.cursor).toBe("row-resize");

    fireEvent.mouseMove(window, { clientY: 40 });
    expect(resizing()).toBe(true);

    fireEvent.mouseUp(window);
    expect(resizing()).toBe(false);
    expect(marked("handle")).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  // The press lands on the grip more often than not; the mark still belongs on
  // the handle, which is what the highlight rules in App.css name.
  it("marks the handle, not the child of it that was pressed", () => {
    render(<Handles />);
    fireEvent.mouseDown(screen.getByTestId("grip"), { button: 0 });
    expect(marked("handle")).toBe(true);
    expect(marked("grip")).toBe(false);
    fireEvent.mouseUp(window);
    expect(marked("handle")).toBe(false);
  });

  it("marks only the handle being dragged", () => {
    render(<Handles />);
    fireEvent.mouseDown(screen.getByTestId("handle"), { button: 0 });
    expect(marked("other")).toBe(false);
    fireEvent.mouseUp(window);
  });

  it("takes nothing for a right-click, which starts no drag", () => {
    render(<Handles />);
    fireEvent.mouseDown(screen.getByTestId("handle"), { button: 2 });
    expect(resizing()).toBe(false);
    expect(marked("handle")).toBe(false);
  });

  // A release that never arrives (the app lost focus mid-drag) must not leave a
  // page that ignores the pointer.
  it("ends with the window's focus, and stops following the pointer", () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    render(<Handles onMove={onMove} onEnd={onEnd} />);
    fireEvent.mouseDown(screen.getByTestId("handle"), { button: 0 });
    fireEvent.mouseMove(window, { clientY: 40 });
    expect(onMove).toHaveBeenCalledTimes(1);

    fireEvent.blur(window);
    expect(resizing()).toBe(false);
    expect(marked("handle")).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(onEnd).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientY: 90 });
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("hands the pointer back if the handle unmounts mid-drag", () => {
    const { unmount } = render(<Handles />);
    fireEvent.mouseDown(screen.getByTestId("handle"), { button: 0 });
    expect(resizing()).toBe(true);
    unmount();
    expect(resizing()).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  // The app mounts several of these hooks. One of them going away (the file
  // panel folding) must not end the shield of a drag another one is running.
  it("is not unmarked by a different hook unmounting", () => {
    render(<Handles />);
    const other = render(<Row onMove={() => {}} />);
    fireEvent.mouseDown(screen.getByTestId("handle"), { button: 0 });
    other.unmount();
    expect(resizing()).toBe(true);
    expect(marked("handle")).toBe(true);
    fireEvent.mouseUp(window);
    expect(resizing()).toBe(false);
  });
});

describe("useDrag — a reorder drag takes nothing from the page", () => {
  beforeEach(() => {
    cleanup();
    root.removeAttribute("data-resizing");
    document.body.style.cursor = "";
  });

  // Its rows are click targets and are meant to answer the pointer, before the
  // threshold and after it.
  it("never marks the root or the row", () => {
    const onMove = vi.fn();
    render(<Row onMove={onMove} />);
    fireEvent.mouseDown(screen.getByTestId("row"), { button: 0, clientX: 10, clientY: 10 });
    expect(resizing()).toBe(false);

    fireEvent.mouseMove(window, { clientX: 10, clientY: 40 }); // past the threshold
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(resizing()).toBe(false);
    expect(marked("row")).toBe(false);
    expect(document.body.style.cursor).toBe("grabbing");

    fireEvent.mouseUp(window);
    expect(document.body.style.cursor).toBe("");
  });

  it("is not ended by the window losing focus", () => {
    const onMove = vi.fn();
    render(<Row onMove={onMove} />);
    fireEvent.mouseDown(screen.getByTestId("row"), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 40 });
    fireEvent.blur(window);
    fireEvent.mouseMove(window, { clientX: 10, clientY: 80 });
    expect(onMove).toHaveBeenCalledTimes(2);
    fireEvent.mouseUp(window);
  });
});
