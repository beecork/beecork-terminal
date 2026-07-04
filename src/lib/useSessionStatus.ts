import { useCallback, useEffect, useRef, useState } from "react";
import { getRoot, ptyStatus, ptyStatusAll, type PtyStatus } from "./api";
import { wantsAttention, type Session } from "./sessions";

function addId(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set;
  const n = new Set(set);
  n.add(id);
  return n;
}
function delId(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const n = new Set(set);
  n.delete(id);
  return n;
}

/**
 * Owns the per-session cwd / running-command / attention-dot state machine that
 * used to live inline in App: the `terminalCwd` shown in the title bar, the
 * `wantsYou` set behind the blinking dots, and the polling that keeps them fresh
 * (a 2s batched poll, an immediate refresh on session switch, and an on-demand
 * hint after output settles). Writes back into the session list via setCwd /
 * setRunning. Returns the callbacks TerminalPane/App wire up.
 */
export function useSessionStatus(
  sessions: Session[],
  activeId: string,
  setCwd: (id: string, cwd: string) => void,
  setRunning: (id: string, running: string | undefined) => void
) {
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [wantsYou, setWantsYou] = useState<Set<string>>(() => new Set());
  const prevRunning = useRef<Record<string, string | undefined>>({});

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const applyCwd = useCallback(
    (id: string, cwd: string) => {
      setCwd(id, cwd);
      if (id === activeIdRef.current) {
        setTerminalCwd((prev) => (prev === cwd ? prev : cwd));
      }
    },
    [setCwd]
  );

  const applyStatus = useCallback(
    (id: string, st: PtyStatus) => {
      // Drop late responses for a session that's already closed (else a stale
      // {running:null} could re-flag a gone session as "wants you").
      if (!sessionsRef.current.some((s) => s.id === id)) return;
      if (st.cwd) applyCwd(id, st.cwd);
      const nowRunning = st.running ?? undefined;
      const was = prevRunning.current[id];
      // A background command that just finished → "wants you" (come look).
      if (wantsAttention(was, nowRunning, id === activeIdRef.current)) {
        setWantsYou((prev) => addId(prev, id));
      }
      prevRunning.current[id] = nowRunning;
      setRunning(id, nowRunning);
    },
    [applyCwd, setRunning]
  );

  const onCwd = useCallback((id: string, path: string) => applyCwd(id, path), [applyCwd]);

  const onStatusHint = useCallback(
    (id: string) => {
      if (id !== activeIdRef.current) return;
      ptyStatus(id).then((st) => applyStatus(id, st)).catch(() => {});
    },
    [applyStatus]
  );

  const onBell = useCallback((id: string) => {
    if (id !== activeIdRef.current) setWantsYou((prev) => addId(prev, id));
  }, []);

  const onSeen = useCallback((id: string) => {
    setWantsYou((prev) => delId(prev, id));
  }, []);

  // Forget a closed session so nothing leaks or resurrects its id.
  const markClosed = useCallback((id: string) => {
    delete prevRunning.current[id];
    setWantsYou((prev) => delId(prev, id));
  }, []);

  useEffect(() => {
    getRoot().then(setTerminalCwd).catch(() => {});
  }, []);

  // Immediate status on session switch.
  useEffect(() => {
    const known = sessionsRef.current.find((s) => s.id === activeId)?.cwd;
    if (known) setTerminalCwd(known);
    ptyStatus(activeId).then((st) => applyStatus(activeId, st)).catch(() => {});
  }, [activeId, applyStatus]);

  // Poll every session for cwd + running command — one batched call per tick.
  useEffect(() => {
    const t = setInterval(() => {
      const ids = sessionsRef.current.map((s) => s.id);
      if (!ids.length) return;
      ptyStatusAll(ids)
        .then((map) => {
          for (const [id, st] of Object.entries(map)) applyStatus(id, st);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [applyStatus]);

  return { terminalCwd, wantsYou, onCwd, onStatusHint, onBell, onSeen, markClosed };
}
