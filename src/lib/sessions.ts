import { useCallback, useEffect, useRef, useState } from "react";
import { basename } from "./paths";
import { lsGet, lsSet } from "./persist";

export interface Session {
  id: string;
  /** default base name, e.g. "Session 1" */
  name: string;
  /** live title from the terminal (OSC title escape), if any */
  dynamic?: string;
  /** user-chosen name, overrides everything */
  custom?: string;
  /** the session's current working directory (follows `cd`) */
  cwd?: string;
  /** the command running at the prompt, e.g. "claude" (undefined when idle) */
  running?: string;
  /** directory the shell should start in (inherited from the active session) */
  startCwd?: string;
  /** the session this one is paired with in split view (symmetric + remembered) */
  partner?: string;
  /** on a restored session, the agent that was running — we offer to resume it */
  resumeAgent?: string;
}

/** The shell command that resumes a given agent's last conversation. */
export function resumeCommand(agent: string): string {
  const map: Record<string, string> = {
    claude: "claude --continue",
    codex: "codex resume",
  };
  return map[agent] ?? `${agent} --continue`;
}

/** Priority: your rename → terminal title → running tool → folder → base name. */
export function displayName(s: Session): string {
  return s.custom || s.dynamic || s.running || (s.cwd ? basename(s.cwd) : "") || s.name;
}

/**
 * Should a background session light its attention dot? True only when a command
 * that WAS running has now finished (running → idle) in a session you're not
 * looking at — "come look, it's done". The first observation (was === undefined)
 * and a command merely starting (idle → running) never trigger it.
 */
export function wantsAttention(
  was: string | undefined,
  now: string | undefined,
  isActive: boolean
): boolean {
  return !isActive && !!was && !now;
}

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "sid-" + Math.random().toString(36).slice(2) + Date.now();
  }
}

/**
 * Update one session's field, returning the SAME array (referentially) when the
 * value is unchanged — so React can bail out of the render. The frequent poll-
 * driven setters (cwd/running) would otherwise allocate a fresh array every tick
 * and re-render the whole app for no change.
 */
function patchSession<K extends keyof Session>(
  prev: Session[],
  id: string,
  key: K,
  value: Session[K]
): Session[] {
  const i = prev.findIndex((s) => s.id === id);
  if (i < 0 || prev[i][key] === value) return prev;
  const next = [...prev];
  next[i] = { ...prev[i], [key]: value };
  return next;
}

const PERSIST_KEY = "beecork.sessions.v1";

interface PersistedSession {
  id: string;
  name: string;
  custom?: string;
  cwd?: string;
  partner?: string;
  /** the agent detected running when we saved — used later to offer "Resume". */
  agent?: string;
}
interface PersistedState {
  sessions: PersistedSession[];
  activeId: string;
  nextNum: number;
}

/** Read the saved session layout (null on first run / disabled / corrupt storage). */
function loadSessions(): PersistedState | null {
  const raw = lsGet(PERSIST_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PersistedState;
    if (p && Array.isArray(p.sessions) && p.sessions.length && typeof p.activeId === "string") {
      return p;
    }
  } catch {
    /* corrupt — ignore and start fresh */
  }
  return null;
}

export function useSessions() {
  // Restore the previous layout once (sessions, names, cwds, split pairing); each
  // pane re-opens its shell in the saved cwd via startCwd. `running`/`dynamic` are
  // live-only and intentionally not restored.
  const [initial] = useState(() => {
    const restored = loadSessions();
    if (restored) {
      const sessions: Session[] = restored.sessions.map((s) => ({
        id: s.id,
        name: s.name,
        custom: s.custom,
        cwd: s.cwd,
        startCwd: s.cwd,
        partner: s.partner,
        resumeAgent: s.agent,
      }));
      const activeId = sessions.some((s) => s.id === restored.activeId)
        ? restored.activeId
        : sessions[0].id;
      return { sessions, activeId, nextNum: restored.nextNum ?? 2 };
    }
    const id = uid();
    return { sessions: [{ id, name: "Session 1" }] as Session[], activeId: id, nextNum: 2 };
  });

  const nextNum = useRef(initial.nextNum);
  const [sessions, setSessions] = useState<Session[]>(initial.sessions);
  const [activeId, setActiveId] = useState<string>(initial.activeId);

  useEffect(() => {
    if (sessions.length && !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  // Persist the layout so a relaunch restores your sessions. Runs only on real
  // changes (patchSession keeps the poll from churning the list).
  useEffect(() => {
    lsSet(
      PERSIST_KEY,
      JSON.stringify({
        sessions: sessions.map((s) => ({
          id: s.id,
          name: s.name,
          custom: s.custom,
          cwd: s.cwd,
          partner: s.partner,
          agent: s.running ?? s.resumeAgent,
        })),
        activeId,
        nextNum: nextNum.current,
      } satisfies PersistedState)
    );
  }, [sessions, activeId]);

  // Returns the new session's id. `activate` (default true) also switches to it;
  // pass false to create a session without stealing focus (e.g. a split pane).
  const create = useCallback((startCwd?: string, activate = true): string => {
    const s: Session = { id: uid(), name: `Session ${nextNum.current++}`, startCwd };
    setSessions((prev) => [...prev, s]);
    if (activate) setActiveId(s.id);
    return s.id;
  }, []);

  const close = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev
        .filter((s) => s.id !== id)
        // dissolve any pair that included the closed session (keeps it symmetric)
        .map((s) => (s.partner === id ? { ...s, partner: undefined } : s));
      return next.length
        ? next
        : [{ id: uid(), name: `Session ${nextNum.current++}` }];
    });
  }, []);

  const rename = useCallback((id: string, custom: string) => {
    setSessions((prev) => patchSession(prev, id, "custom", custom.trim() || undefined));
  }, []);

  const setDynamic = useCallback((id: string, dynamic: string) => {
    setSessions((prev) => patchSession(prev, id, "dynamic", dynamic.trim() || undefined));
  }, []);

  const setCwd = useCallback((id: string, cwd: string) => {
    setSessions((prev) => patchSession(prev, id, "cwd", cwd));
  }, []);

  const setRunning = useCallback((id: string, running: string | undefined) => {
    setSessions((prev) => patchSession(prev, id, "running", running));
  }, []);

  // Dismiss a restored session's "Resume" offer (they resumed it, or started
  // typing their own thing).
  const clearResume = useCallback((id: string) => {
    setSessions((prev) => patchSession(prev, id, "resumeAgent", undefined));
  }, []);

  // Pair two sessions for split view. Symmetric and degree-≤1: each session has
  // at most one partner, so pairing a or b dissolves whatever they were paired
  // with before.
  const pairSessions = useCallback((a: string, b: string) => {
    if (a === b) return;
    setSessions((prev) => {
      const oldA = prev.find((s) => s.id === a)?.partner;
      const oldB = prev.find((s) => s.id === b)?.partner;
      return prev.map((s) => {
        if (s.id === a) return { ...s, partner: b };
        if (s.id === b) return { ...s, partner: a };
        if (s.id === oldA || s.id === oldB) return { ...s, partner: undefined };
        return s;
      });
    });
  }, []);

  // Drag-to-reorder in the rail: move `id` to just before `beforeId` (or to the
  // end when `beforeId` is null). The array order IS the display order and the
  // collapsed number, and it's persisted, so reordering renumbers and survives
  // relaunch. Returns the same array (no re-render) when already in place.
  const reorder = useCallback((id: string, beforeId: string | null) => {
    setSessions((prev) => {
      if (id === beforeId) return prev;
      const from = prev.findIndex((s) => s.id === id);
      if (from < 0) return prev;
      const inPlace =
        beforeId === null ? from === prev.length - 1 : prev[from + 1]?.id === beforeId;
      if (inPlace) return prev;
      const without = [...prev.slice(0, from), ...prev.slice(from + 1)];
      const idx = beforeId === null ? without.length : without.findIndex((s) => s.id === beforeId);
      if (idx < 0) return prev;
      return [...without.slice(0, idx), prev[from], ...without.slice(idx)];
    });
  }, []);

  // Dissolve `id`'s pair (clears both sides).
  const unpairSession = useCallback((id: string) => {
    setSessions((prev) => {
      const other = prev.find((s) => s.id === id)?.partner;
      return prev.map((s) =>
        s.id === id || s.id === other ? { ...s, partner: undefined } : s
      );
    });
  }, []);

  return {
    sessions,
    activeId,
    setActiveId,
    create,
    close,
    rename,
    setDynamic,
    setCwd,
    setRunning,
    clearResume,
    pairSessions,
    unpairSession,
    reorder,
  };
}
