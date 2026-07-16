import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { basename } from "./paths";
import { lsGet, lsSet } from "./persist";

/** Only the primary ("main") window owns the persisted session layout. A ⌘N
 *  window loads the same origin — hence the same localStorage — so if it also
 *  restored these sessions it would re-open shells under their *same ids*, and
 *  `pty_spawn`'s same-id takeover would reap (SIGHUP) the main window's live
 *  shells out from under it. Secondary windows therefore start with their own
 *  fresh session and don't touch the shared layout. Defaults to `true` off-Tauri
 *  (tests) so the restore path stays exercised. */
const IS_MAIN_WINDOW: boolean = (() => {
  try {
    const label = getCurrentWindow().label;
    return !label || label === "main";
  } catch {
    return true;
  }
})();

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

/** A named section divider in the rail — a `── name ──` line between sessions. */
export interface Divider {
  kind: "divider";
  id: string;
  /** section label; empty renders as a plain line */
  name: string;
}

/** A row in the session rail. Dividers live IN the ordered list, so grouping is
 *  emergent from order: the sessions between two dividers form a section, and
 *  dragging a session across a divider (or the divider itself) re-sections. */
export type RailItem = Session | Divider;

export function isDivider(item: RailItem): item is Divider {
  return "kind" in item && (item as Divider).kind === "divider";
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
 * Move `id` to just before `beforeId` (or to the end when `beforeId` is null) —
 * the drag-to-reorder primitive, shared by sessions and dividers. Returns the
 * SAME array (no re-render) when already in place or an id is unknown.
 */
export function moveBefore<T extends { id: string }>(
  list: T[],
  id: string,
  beforeId: string | null
): T[] {
  if (id === beforeId) return list;
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  const inPlace = beforeId === null ? from === list.length - 1 : list[from + 1]?.id === beforeId;
  if (inPlace) return list;
  const without = [...list.slice(0, from), ...list.slice(from + 1)];
  const idx = beforeId === null ? without.length : without.findIndex((x) => x.id === beforeId);
  if (idx < 0) return list;
  return [...without.slice(0, idx), list[from], ...without.slice(idx)];
}

/**
 * Update one session's field, returning the SAME array (referentially) when the
 * value is unchanged — so React can bail out of the render. The frequent poll-
 * driven setters (cwd/running) would otherwise allocate a fresh array every tick
 * and re-render the whole app for no change.
 */
function patchSession<K extends keyof Session>(
  prev: RailItem[],
  id: string,
  key: K,
  value: Session[K]
): RailItem[] {
  const i = prev.findIndex((x) => !isDivider(x) && x.id === id);
  if (i < 0) return prev;
  const s = prev[i] as Session;
  if (s[key] === value) return prev;
  const next = [...prev];
  next[i] = { ...s, [key]: value };
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
interface PersistedDivider {
  kind: "divider";
  id: string;
  name: string;
}
/** Divider rows carry `kind: "divider"`; pre-divider saves have no `kind` field
 *  and load unchanged as sessions, so the storage key doesn't need bumping. */
type PersistedItem = PersistedSession | PersistedDivider;
interface PersistedState {
  sessions: PersistedItem[];
  activeId: string;
  nextNum: number;
}

function isPersistedDivider(i: PersistedItem): i is PersistedDivider {
  return "kind" in i && (i as PersistedDivider).kind === "divider";
}

/** Read the saved session layout (null on first run / disabled / corrupt storage
 *  / a secondary window, which never adopts the shared layout). */
function loadSessions(): PersistedState | null {
  if (!IS_MAIN_WINDOW) return null;
  const raw = lsGet(PERSIST_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PersistedState;
    if (
      p &&
      Array.isArray(p.sessions) &&
      p.sessions.some((s) => !isPersistedDivider(s)) &&
      typeof p.activeId === "string"
    ) {
      return p;
    }
  } catch {
    /* corrupt — ignore and start fresh */
  }
  return null;
}

export function useSessions() {
  // Restore the previous layout once (sessions, names, cwds, split pairing,
  // dividers); each pane re-opens its shell in the saved cwd via startCwd.
  // `running`/`dynamic` are live-only and intentionally not restored.
  const [initial] = useState(() => {
    const restored = loadSessions();
    if (restored) {
      const items: RailItem[] = restored.sessions.map((s) => {
        if (isPersistedDivider(s)) return { kind: "divider" as const, id: s.id, name: s.name };
        return {
          id: s.id,
          name: s.name,
          custom: s.custom,
          cwd: s.cwd,
          startCwd: s.cwd,
          partner: s.partner,
          resumeAgent: s.agent,
        };
      });
      const first = items.find((i) => !isDivider(i)) as Session;
      const activeId = items.some((i) => !isDivider(i) && i.id === restored.activeId)
        ? restored.activeId
        : first.id;
      return { items, activeId, nextNum: restored.nextNum ?? 2 };
    }
    const id = uid();
    return { items: [{ id, name: "Session 1" }] as RailItem[], activeId: id, nextNum: 2 };
  });

  const nextNum = useRef(initial.nextNum);
  const [items, setItems] = useState<RailItem[]>(initial.items);
  const [activeId, setActiveId] = useState<string>(initial.activeId);

  // The sessions in display order, dividers stripped — what everything outside
  // the rail consumes. Stable (same array) as long as `items` doesn't change.
  const sessions = useMemo(() => items.filter((i): i is Session => !isDivider(i)), [items]);

  useEffect(() => {
    if (sessions.length && !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  // Persist the layout so a relaunch restores your sessions. Runs only on real
  // changes (patchSession keeps the poll from churning the list). Secondary
  // windows never write it — their sessions are ephemeral and must not clobber
  // the main window's saved layout.
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    lsSet(
      PERSIST_KEY,
      JSON.stringify({
        sessions: items.map((i) =>
          isDivider(i)
            ? { kind: "divider" as const, id: i.id, name: i.name }
            : {
                id: i.id,
                name: i.name,
                custom: i.custom,
                cwd: i.cwd,
                partner: i.partner,
                agent: i.running ?? i.resumeAgent,
              }
        ),
        activeId,
        nextNum: nextNum.current,
      } satisfies PersistedState)
    );
  }, [items, activeId]);

  // Returns the new session's id. `activate` (default true) also switches to it;
  // pass false to create a session without stealing focus (e.g. a split pane).
  // `afterId` inserts the session right below that rail item (so a session spawned
  // from another lands in the same section) instead of at the end of the list.
  const create = useCallback((startCwd?: string, activate = true, afterId?: string): string => {
    const s: Session = { id: uid(), name: `Session ${nextNum.current++}`, startCwd };
    setItems((prev) => {
      const at = afterId ? prev.findIndex((i) => i.id === afterId) : -1;
      return at < 0 ? [...prev, s] : [...prev.slice(0, at + 1), s, ...prev.slice(at + 1)];
    });
    if (activate) setActiveId(s.id);
    return s.id;
  }, []);

  const close = useCallback((id: string) => {
    setItems((prev) => {
      const next = prev
        .filter((i) => i.id !== id)
        // dissolve any pair that included the closed session (keeps it symmetric)
        .map((i) => (!isDivider(i) && i.partner === id ? { ...i, partner: undefined } : i));
      // dividers may remain, but there must always be at least one session
      return next.some((i) => !isDivider(i))
        ? next
        : [...next, { id: uid(), name: `Session ${nextNum.current++}` }];
    });
  }, []);

  const rename = useCallback((id: string, custom: string) => {
    setItems((prev) => patchSession(prev, id, "custom", custom.trim() || undefined));
  }, []);

  const setDynamic = useCallback((id: string, dynamic: string) => {
    setItems((prev) => patchSession(prev, id, "dynamic", dynamic.trim() || undefined));
  }, []);

  const setCwd = useCallback((id: string, cwd: string) => {
    setItems((prev) => patchSession(prev, id, "cwd", cwd));
  }, []);

  const setRunning = useCallback((id: string, running: string | undefined) => {
    setItems((prev) => patchSession(prev, id, "running", running));
  }, []);

  // Dismiss a restored session's "Resume" offer (they resumed it, or started
  // typing their own thing).
  const clearResume = useCallback((id: string) => {
    setItems((prev) => patchSession(prev, id, "resumeAgent", undefined));
  }, []);

  // Pair two sessions for split view. Symmetric and degree-≤1: each session has
  // at most one partner, so pairing a or b dissolves whatever they were paired
  // with before.
  const pairSessions = useCallback((a: string, b: string) => {
    if (a === b) return;
    setItems((prev) => {
      const oldA = (prev.find((i) => i.id === a) as Session | undefined)?.partner;
      const oldB = (prev.find((i) => i.id === b) as Session | undefined)?.partner;
      return prev.map((i) => {
        if (isDivider(i)) return i;
        if (i.id === a) return { ...i, partner: b };
        if (i.id === b) return { ...i, partner: a };
        if (i.id === oldA || i.id === oldB) return { ...i, partner: undefined };
        return i;
      });
    });
  }, []);

  // Drag-to-reorder in the rail: move an item (session OR divider) to just before
  // `beforeId` (or to the end when `beforeId` is null). The array order IS the
  // display order and the collapsed number, and it's persisted, so reordering
  // renumbers and survives relaunch.
  const reorder = useCallback((id: string, beforeId: string | null) => {
    setItems((prev) => moveBefore(prev, id, beforeId));
  }, []);

  // Dissolve `id`'s pair (clears both sides).
  const unpairSession = useCallback((id: string) => {
    setItems((prev) => {
      const other = (prev.find((i) => i.id === id) as Session | undefined)?.partner;
      return prev.map((i) =>
        !isDivider(i) && (i.id === id || i.id === other) ? { ...i, partner: undefined } : i
      );
    });
  }, []);

  // Insert a new divider before `beforeId` (null = at the end of the list).
  // Returns its id so the rail can drop straight into rename mode.
  const addDivider = useCallback((beforeId: string | null): string => {
    const d: Divider = { kind: "divider", id: uid(), name: "" };
    setItems((prev) => {
      const idx = beforeId === null ? prev.length : prev.findIndex((i) => i.id === beforeId);
      return idx < 0 ? [...prev, d] : [...prev.slice(0, idx), d, ...prev.slice(idx)];
    });
    return d.id;
  }, []);

  const renameDivider = useCallback((id: string, name: string) => {
    setItems((prev) => {
      const i = prev.findIndex((x) => isDivider(x) && x.id === id);
      if (i < 0 || (prev[i] as Divider).name === name.trim()) return prev;
      const next = [...prev];
      next[i] = { ...(prev[i] as Divider), name: name.trim() };
      return next;
    });
  }, []);

  // Removing a divider destroys nothing — its sections just merge.
  const removeDivider = useCallback((id: string) => {
    setItems((prev) =>
      prev.some((i) => isDivider(i) && i.id === id) ? prev.filter((i) => i.id !== id) : prev
    );
  }, []);

  return {
    items,
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
    addDivider,
    renameDivider,
    removeDivider,
  };
}
