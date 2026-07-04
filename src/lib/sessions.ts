import { useCallback, useEffect, useRef, useState } from "react";

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
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Priority: your rename → terminal title → running tool → folder → base name. */
export function displayName(s: Session): string {
  return s.custom || s.dynamic || s.running || (s.cwd ? basename(s.cwd) : "") || s.name;
}

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "sid-" + Math.random().toString(36).slice(2) + Date.now();
  }
}

export function useSessions() {
  const nextNum = useRef(2);
  const [sessions, setSessions] = useState<Session[]>(() => [
    { id: uid(), name: "Session 1" },
  ]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0].id);

  useEffect(() => {
    if (sessions.length && !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  const create = useCallback((startCwd?: string) => {
    const s: Session = { id: uid(), name: `Session ${nextNum.current++}`, startCwd };
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  }, []);

  const close = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      return next.length
        ? next
        : [{ id: uid(), name: `Session ${nextNum.current++}` }];
    });
  }, []);

  const rename = useCallback((id: string, custom: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, custom: custom.trim() || undefined } : s))
    );
  }, []);

  const setDynamic = useCallback((id: string, dynamic: string) => {
    const clean = dynamic.trim();
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id && s.dynamic !== clean ? { ...s, dynamic: clean || undefined } : s
      )
    );
  }, []);

  const setCwd = useCallback((id: string, cwd: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id && s.cwd !== cwd ? { ...s, cwd } : s))
    );
  }, []);

  const setRunning = useCallback((id: string, running: string | undefined) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id && s.running !== running ? { ...s, running } : s))
    );
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
  };
}
