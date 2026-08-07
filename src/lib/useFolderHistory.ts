import { useEffect, useRef, useState } from "react";

export interface History {
  stack: string[];
  index: number;
}

export const EMPTY_HISTORY: History = { stack: [], index: -1 };

/**
 * Record a visit to `path`, browser-style: staying put is a no-op, and a genuine
 * move truncates any forward tail before pushing. Pure, so it's unit-tested.
 */
export function recordVisit(h: History, path: string): History {
  if (h.stack[h.index] === path) return h;
  const stack = [...h.stack.slice(0, h.index + 1), path];
  return { stack, index: stack.length - 1 };
}

export const canGoBack = (h: History) => h.index > 0;
export const canGoForward = (h: History) => h.index >= 0 && h.index < h.stack.length - 1;

/**
 * Back/Forward for the file browser, one trail per terminal session.
 *
 * The browser's "current folder" IS the active terminal's cwd, so there is no
 * separate navigation state to keep in sync: every move — a breadcrumb, "..",
 * a double-clicked folder, Back/Forward, or a `cd` you typed yourself — arrives
 * here as a change to `root`, and we record it. Navigating is likewise just a
 * `cd`, via the `navigate` callback.
 *
 * `navTarget` marks the folder WE are steering to, so the `cd` that Back/Forward
 * causes isn't recorded as a brand-new step (which would make Forward
 * unreachable). Trails are dropped when their session closes.
 */
export function useFolderHistory(
  sessionId: string,
  root: string | null,
  liveSessionIds: string[],
  navigate: (dir: string) => void
) {
  const histRef = useRef<Record<string, History>>({});
  const navTargetRef = useRef<string | null>(null);
  // Which session the `root` we last saw belonged to. `root` is the ACTIVE
  // terminal's cwd, and on a tab switch it arrives a commit AFTER `sessionId`
  // (App updates it from an effect), so the first render after a switch pairs the
  // incoming session's id with the OUTGOING session's folder. Recording that put
  // another project's folder into this session's trail — and Back then typed a
  // real `cd` into a shell that had never been there.
  const prevSessionRef = useRef(sessionId);
  const [, bump] = useState(0);

  useEffect(() => {
    const switched = prevSessionRef.current !== sessionId;
    // Updated BEFORE the `!root` early return below: a switch that happens while
    // root is still null (app start, or a new session before its first status
    // lands) would otherwise leave this stale and swallow the next real record.
    prevSessionRef.current = sessionId;
    if (switched) {
      // A pending Back/Forward steer belonged to the session we just left.
      navTargetRef.current = null;
      return; // this render's `root` is still the outgoing session's cwd
    }
    if (!root) return;
    if (navTargetRef.current === root) {
      navTargetRef.current = null; // our own Back/Forward — already recorded
      return;
    }
    const prev = histRef.current[sessionId] ?? EMPTY_HISTORY;
    const next = recordVisit(prev, root);
    if (next === prev) return;
    histRef.current[sessionId] = next;
    bump((v) => v + 1);
  }, [root, sessionId]);

  // Forget the trails of sessions that have closed.
  useEffect(() => {
    const live = new Set(liveSessionIds);
    for (const id of Object.keys(histRef.current)) {
      if (!live.has(id)) delete histRef.current[id];
    }
  }, [liveSessionIds]);

  const hist = histRef.current[sessionId] ?? EMPTY_HISTORY;

  const go = (delta: -1 | 1) => {
    const h = histRef.current[sessionId];
    if (!h) return;
    const next = h.index + delta;
    if (next < 0 || next >= h.stack.length) return;
    const target = h.stack[next];
    histRef.current[sessionId] = { stack: h.stack, index: next };
    navTargetRef.current = target;
    bump((v) => v + 1);
    navigate(target);
  };

  return {
    canBack: canGoBack(hist),
    canForward: canGoForward(hist),
    back: () => go(-1),
    forward: () => go(1),
  };
}
