import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

export interface DragOptions {
  /** fires for each mousemove once the drag is live */
  onMove: (e: MouseEvent) => void;
  /** body cursor while dragging */
  cursor?: string;
  /**
   * Pixels of movement before the press counts as a drag. 0 (the default) is
   * right for a resize handle, which does nothing else on click. A row you can
   * ALSO click needs a few pixels of slop, so an ordinary click stays a click.
   */
  threshold?: number;
  /** the drag just became live (passed the threshold) */
  onStart?: () => void;
  /** the drag ended — only called if it ever became live */
  onEnd?: () => void;
}

/**
 * Window-level drag helper. Returns an `onMouseDown` to put on the handle;
 * while dragging it owns the window listeners, the body cursor, and cleanup.
 *
 * One primitive covers both drag flavours in the app — the resize dividers
 * (immediate) and the session-rail reorder (thresholded, since those rows are
 * also click targets). The rail used to hand-roll the same mousemove/mouseup
 * effect a second time; the shared part is exactly the fiddly part.
 *
 * Deliberately mouse-, not HTML5-drag-based: this is a Tauri webview with
 * OS-level drag-drop enabled (so you can drop files from Finder into the
 * terminal), and that interception stops in-page dragover/drop from ever firing.
 *
 * Every option may change on each render — the latest is always used.
 */
export function useDrag(options: DragOptions): (e: ReactMouseEvent) => void {
  const optsRef = useRef(options);
  optsRef.current = options;
  // null = nothing pressed. `live` flips once the threshold is passed.
  const drag = useRef<{ startX: number; startY: number; live: boolean } | null>(null);

  const begin = () => {
    const d = drag.current;
    if (!d) return;
    d.live = true;
    document.body.style.cursor = optsRef.current.cursor ?? "col-resize";
    optsRef.current.onStart?.();
  };

  useEffect(() => {
    function move(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      if (!d.live) {
        const t = optsRef.current.threshold ?? 0;
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < t) return;
        begin();
      }
      optsRef.current.onMove(e);
    }
    function up() {
      const d = drag.current;
      drag.current = null;
      if (!d?.live) return;
      document.body.style.cursor = "";
      optsRef.current.onEnd?.();
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // Unmounting mid-drag must not strand a "grabbing" cursor on the body.
      document.body.style.cursor = "";
    };
    // Mount only: `begin` and the handlers read everything through refs, so
    // they never go stale and must not be re-subscribed.
  }, []);

  return (e: ReactMouseEvent) => {
    if (e.button !== 0) return; // left button only; right-click opens menus
    drag.current = { startX: e.clientX, startY: e.clientY, live: false };
    if (!(optsRef.current.threshold ?? 0)) {
      // No threshold: live from the press, so the cursor changes immediately and
      // the default (text selection across the drag) is suppressed. A THRESHOLD
      // drag must not preventDefault here — that would break click and focus on
      // a row that is also a button.
      begin();
      e.preventDefault();
    }
  };
}
