import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

/**
 * Window-level drag helper for resize handles. Returns an `onMouseDown` you put
 * on the handle; while dragging, `onMove` fires for each mousemove and the body
 * cursor is set to `cursor` (reset on mouseup). Owns the listeners + cleanup, so
 * a divider doesn't hand-roll the same effect. `cursor`/`onMove` may change every
 * render — the latest are always used.
 */
export function useDrag(
  onMove: (e: MouseEvent) => void,
  cursor = "col-resize"
): (e: ReactMouseEvent) => void {
  const dragging = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    function move(e: MouseEvent) {
      if (dragging.current) onMoveRef.current(e);
    }
    function up() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (e: ReactMouseEvent) => {
    dragging.current = true;
    document.body.style.cursor = cursorRef.current;
    e.preventDefault();
  };
}
