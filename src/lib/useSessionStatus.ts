import { useCallback, useEffect, useRef, useState } from "react";
import { getRoot, ptyStatus, ptyStatusAll, type PtyStatus } from "./api";
import { wantsAttention, displayName, type Session } from "./sessions";
import { notify } from "./notify";
import * as sound from "./sound";

// Output must pause at least this long for the busy dot to turn off.
const QUIET_MS = 1500;
// …but inferring "needs you" from silence takes much longer. An agent stalls
// output mid-turn all the time — API latency between tool rounds, a silent tool
// run, its event loop blocked on a big result — easily past QUIET_MS while still
// working. Flagging at QUIET_MS lit tabs amber and chimed in the MIDDLE of turns
// (then output resumed, cleared it, and the next stall chimed again). Only a
// pause this long reads as "finished / waiting for you".
const ATTN_QUIET_MS = 6000;
// The just-ended output streak must have lasted at least this long to count
// as a real turn of work worth a "come look". Below it, the burst was a stray
// redraw (a spinner tick, a clock/statusline repaint) — nagging on those lit up
// every quiet background agent in amber at once and drowned the real signal.
const WORK_MIN_MS = 2500;
// A quiet-INFERRED "needs you" that got disproven (output resumed) must not
// chime again right away — at most one inferred chime per session per this
// window. The amber dot still lights; only the repeat sound is suppressed.
// Precise signals (bell, command exit) are exempt and always chime.
const INFER_RECHIME_MS = 60_000;

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
  setRunning: (id: string, running: string | undefined) => void,
  setAgentId: (id: string, agentId: string | undefined) => void
) {
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [wantsYou, setWantsYou] = useState<Set<string>>(() => new Set());
  // Sessions producing output right now — the busy dot. Output activity reflects
  // an agent actually working, which the OS foreground check can't see (a TUI
  // agent is "running" the whole time it's open, working or waiting).
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Second-stage timers: armed when the busy dot goes off, fire when the silence
  // has lasted ATTN_QUIET_MS total — only then does a session read as "needs you".
  const attnTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // When each session's current output streak began — so the quiet-timer can tell
  // a real turn of work (worth a "needs you") from a one-frame redraw.
  const busySince = useRef<Record<string, number>>({});
  // Last time each session chimed off a quiet-inferred flag (rate-limits repeats).
  const inferredChimeAt = useRef<Record<string, number>>({});
  const prevRunning = useRef<Record<string, string | undefined>>({});
  // Mirror of wantsYou, so flag/clear can decide-and-chime synchronously instead
  // of inside a setState updater (which must stay side-effect free).
  const wantsRef = useRef<Set<string>>(new Set());

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

  const clearWants = useCallback((id: string) => {
    const next = delId(wantsRef.current, id);
    if (next === wantsRef.current) return;
    wantsRef.current = next;
    setWantsYou(next);
  }, []);

  // Flag a session as needing you, chiming once at the moment it newly flips.
  // Precise producers (bell, command exit) always chime; the quiet-inferred
  // proxy rate-limits its chime so a session that flaps (stall → flag → output
  // resumes → clear → stall…) can't keep calling you. The dot always lights.
  const flagWants = useCallback((id: string, inferred: boolean) => {
    if (wantsRef.current.has(id)) return;
    const now = performance.now();
    if (!inferred || now - (inferredChimeAt.current[id] ?? -Infinity) >= INFER_RECHIME_MS) {
      if (inferred) inferredChimeAt.current[id] = now;
      sound.attention();
    }
    wantsRef.current = addId(wantsRef.current, id);
    setWantsYou(wantsRef.current);
  }, []);

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
        flagWants(id, false); // a command really exited — precise, always chimes
      }
      prevRunning.current[id] = nowRunning;
      setRunning(id, nowRunning);
      // Pin the running agent's conversation id. When the agent exits (running →
      // idle) clear it too; while it runs but a single poll fails to resolve the
      // id (Claude closes its transcript between writes), keep the last known one
      // rather than flapping it to nothing.
      const agentId = st.agent_session ?? undefined;
      if (agentId || !nowRunning) setAgentId(id, agentId);
    },
    [applyCwd, setRunning, setAgentId, flagWants]
  );

  const onCwd = useCallback((id: string, path: string) => applyCwd(id, path), [applyCwd]);

  const onStatusHint = useCallback(
    (id: string) => {
      if (id !== activeIdRef.current) return;
      ptyStatus(id).then((st) => applyStatus(id, st)).catch(() => {});
    },
    [applyStatus]
  );

  // Every output chunk marks the session busy and (re)arms the quiet timers.
  // Stage one (QUIET_MS): the busy dot turns off. Stage two (ATTN_QUIET_MS
  // total): if the session is STILL silent and off-screen, the ended streak
  // becomes a "come look". The long confirmation window is what separates a
  // finished turn from a mid-turn stall (API latency, a silent tool run), which
  // used to flag-and-chime while the agent was still working. Resumed output
  // disproves a quiet-inferred "come look", so clear it here — unless a bell
  // rang (a real "I need you" that waits until you look).
  const onActivity = useCallback(
    (id: string) => {
      const now = performance.now();
      setBusy((prev) => {
        if (prev.has(id)) return prev;
        busySince.current[id] = now; // idle → working: a fresh streak begins
        return addId(prev, id);
      });
      if (!bellRang.current.has(id)) clearWants(id);
      clearTimeout(idleTimers.current[id]);
      clearTimeout(attnTimers.current[id]);
      delete attnTimers.current[id];
      idleTimers.current[id] = setTimeout(() => {
        const workedMs = now - (busySince.current[id] ?? now);
        delete busySince.current[id];
        setBusy((prev) => delId(prev, id));
        // Only nag when a *real* turn of work ended. A brief blip (spinner tick,
        // statusline repaint) isn't a completion, so it must never flip an idle
        // background agent to blinking amber. Genuine "come look" signals — a
        // bell, or a foreground command going running→idle — come from the other
        // two producers and are unaffected by this gate. Visibility is checked
        // when the timer FIRES: a pane you can see never nags.
        if (workedMs >= WORK_MIN_MS) {
          attnTimers.current[id] = setTimeout(() => {
            delete attnTimers.current[id];
            if (!visibleIdsRef.current.includes(id)) flagWants(id, true);
          }, ATTN_QUIET_MS - QUIET_MS);
        }
      }, QUIET_MS);
    },
    [clearWants, flagWants]
  );

  // The bell is the agent's explicit "I need you" — the precise attention signal.
  // No nag for a session already on screen; a bell stays sticky until onSeen.
  const onBell = useCallback(
    (id: string) => {
      if (visibleIdsRef.current.includes(id)) return;
      bellRang.current.add(id);
      flagWants(id, false); // explicit "I need you" — precise, always chimes
      // If you're in another app, ping the OS so you don't miss it.
      if (!document.hasFocus()) {
        const s = sessionsRef.current.find((x) => x.id === id);
        notify(`${s ? displayName(s) : "A session"} needs you`, "Your agent is waiting for you.");
      }
    },
    [flagWants]
  );

  const onSeen = useCallback(
    (id: string) => {
      bellRang.current.delete(id);
      clearWants(id);
    },
    [clearWants]
  );

  // Forget a closed session so nothing leaks or resurrects its id.
  const markClosed = useCallback(
    (id: string) => {
      delete prevRunning.current[id];
      delete busySince.current[id];
      delete inferredChimeAt.current[id];
      clearTimeout(idleTimers.current[id]);
      delete idleTimers.current[id];
      clearTimeout(attnTimers.current[id]);
      delete attnTimers.current[id];
      bellRang.current.delete(id);
      clearWants(id);
      setBusy((prev) => delId(prev, id));
    },
    [clearWants]
  );

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
