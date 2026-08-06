import { useCallback, useEffect, useRef, useState } from "react";

interface PaneState {
  /** open file per pane; null = an empty pane */
  panes: (string | null)[];
  /** index of the pane that receives the next opened file */
  focused: number;
}

const EMPTY: PaneState = { panes: [null], focused: 0 };

/**
 * The editor's open files, remembered per terminal session.
 *
 * Switching tabs should feel like switching desks: the files you had open in
 * session A are still there when you come back, and session B starts with its
 * own. So the outgoing session's pane state is saved and the incoming one's
 * restored, keyed by session id — and dropped when a session closes, so the map
 * doesn't grow an entry per session for the life of the app.
 *
 * Pulled out of SidePanel, which was carrying this alongside the file tree, the
 * git status, the navigation history and three modal flows.
 */
export function useEditorPanes(sessionId: string, liveSessionIds: string[]) {
  const [panes, setPanes] = useState<(string | null)[]>(EMPTY.panes);
  const [focused, setFocused] = useState(EMPTY.focused);

  // Latest state, readable from callbacks and from the save-on-switch effect
  // without making them depend on every keystroke of it.
  const latest = useRef<PaneState>({ panes, focused });
  latest.current = { panes, focused };

  const memory = useRef<Record<string, PaneState>>({});
  const prevSession = useRef(sessionId);

  useEffect(() => {
    const prev = prevSession.current;
    if (prev === sessionId) return;
    memory.current[prev] = latest.current; // save outgoing
    const saved = memory.current[sessionId];
    setPanes(saved?.panes ?? EMPTY.panes);
    setFocused(saved?.focused ?? EMPTY.focused);
    prevSession.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const live = new Set(liveSessionIds);
    for (const id of Object.keys(memory.current)) {
      if (!live.has(id)) delete memory.current[id];
    }
  }, [liveSessionIds]);

  /** Show `path` in the focused pane. */
  const openInFocused = useCallback((path: string) => {
    setPanes((prev) => {
      const next = [...prev];
      next[latest.current.focused] = path;
      return next;
    });
  }, []);

  /** Split into two panes (focusing the new empty one), or collapse back to the
   *  focused pane's file. */
  const toggleSplit = useCallback(() => {
    setPanes((prev) => {
      if (prev.length === 1) {
        setFocused(1);
        return [prev[0], null];
      }
      const keep = prev[latest.current.focused];
      setFocused(0);
      return [keep];
    });
  }, []);

  return { panes, focused, setFocused, openInFocused, toggleSplit, split: panes.length > 1 };
}
