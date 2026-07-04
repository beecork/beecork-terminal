import { useCallback, useEffect, useRef, useState } from "react";
import { getRoot, ptyStatus, ptyStatusAll, type PtyStatus } from "./api";
import { wantsAttention, displayName, type Session } from "./sessions";
import { notify } from "./notify";

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
  visibleIds: string[],
  setCwd: (id: string, cwd: string) => void,
  setRunning: (id: string, running: string | undefined) => void
) {
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [wantsYou, setWantsYou] = useState<Set<string>>(() => new Set());
  // Sessions producing output right now — the busy dot. Output activity reflects
  // an agent actually working, which the OS foreground check can't see (a TUI
  // agent is "running" the whole time it's open, working or waiting).
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const prevRunning = useRef<Record<string, string | undefined>>({});

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // The sessions on screen right now (both panes in split, else the focused one).
  // Attention keys off *visibility*, not focus — a pane you can see is "seen".
  const visibleIdsRef = useRef(visibleIds);
  visibleIdsRef.current = visibleIds;
  // Sessions with an unacknowledged bell — the agent's explicit "I need you".
  // Bell-set attention is sticky (only onSeen clears it); attention *inferred*
  // from output going quiet is a proxy that self-clears when output resumes.
  const bellRang = useRef<Set<string>>(new Set());

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
      // Two producers feed wantsYou, deliberately complementary: this process-
      // detection path catches a *silent* background command finishing
      // (running→idle) — the one case output-activity misses — while onActivity's
      // quiet-timer catches TUI agents (always the tty's foreground process). A
      // session on screen (visible in either split pane) counts as seen, so a pane
      // you can see never nags.
      if (wantsAttention(was, nowRunning, visibleIdsRef.current.includes(id))) {
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

  // Every output chunk marks the session busy and (re)arms a quiet timer. When it
  // stays quiet for ~1.5s, an *off-screen* session that was working becomes a
  // "come look". Resumed output disproves a quiet-inferred "come look", so clear
  // it here — unless a bell rang (a real "I need you" that waits until you look).
  const onActivity = useCallback((id: string) => {
    setBusy((prev) => (prev.has(id) ? prev : addId(prev, id)));
    if (!bellRang.current.has(id)) setWantsYou((prev) => delId(prev, id));
    clearTimeout(idleTimers.current[id]);
    idleTimers.current[id] = setTimeout(() => {
      setBusy((prev) => delId(prev, id));
      if (!visibleIdsRef.current.includes(id)) setWantsYou((prev) => addId(prev, id));
    }, 1500);
  }, []);

  // The bell is the agent's explicit "I need you" — the precise attention signal.
  // No nag for a session already on screen; a bell stays sticky until onSeen.
  const onBell = useCallback((id: string) => {
    if (visibleIdsRef.current.includes(id)) return;
    bellRang.current.add(id);
    setWantsYou((prev) => addId(prev, id));
    // If you're in another app, ping the OS so you don't miss it.
    if (!document.hasFocus()) {
      const s = sessionsRef.current.find((x) => x.id === id);
      notify(`${s ? displayName(s) : "A session"} needs you`, "Your agent is waiting for you.");
    }
  }, []);

  const onSeen = useCallback((id: string) => {
    bellRang.current.delete(id);
    setWantsYou((prev) => delId(prev, id));
  }, []);

  // Forget a closed session so nothing leaks or resurrects its id.
  const markClosed = useCallback((id: string) => {
    delete prevRunning.current[id];
    clearTimeout(idleTimers.current[id]);
    delete idleTimers.current[id];
    bellRang.current.delete(id);
    setWantsYou((prev) => delId(prev, id));
    setBusy((prev) => delId(prev, id));
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

  return { terminalCwd, wantsYou, busy, onCwd, onStatusHint, onActivity, onBell, onSeen, markClosed };
}
