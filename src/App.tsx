import { useCallback, useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalPane from "./components/TerminalPane";
import SidePanel from "./components/SidePanel";
import SettingsModal from "./components/SettingsModal";
import SessionRail from "./components/SessionRail";
import UpdateBanner from "./components/UpdateBanner";
import ConfirmModal from "./components/ConfirmModal";
import { Folder, Chevron, Pencil } from "./components/icons";
import { useSessions, displayName, wantsAttention, type Session } from "./lib/sessions";
import { getRoot, ptyStatus, ptyStatusAll, type PtyStatus } from "./lib/api";
import { useSettings, clampFont, DEFAULT_FONT_SIZE } from "./lib/settings";
import "./App.css";

export interface OpenRequest {
  path: string;
  line?: number;
  n: number;
}

type Surface = "terminal" | "editor";

function addId(set: Set<string>, id: string) {
  if (set.has(id)) return set;
  const n = new Set(set);
  n.add(id);
  return n;
}
function delId(set: Set<string>, id: string) {
  if (!set.has(id)) return set;
  const n = new Set(set);
  n.delete(id);
  return n;
}

export default function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(380);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [wantsYou, setWantsYou] = useState<Set<string>>(() => new Set());
  const [confirmClose, setConfirmClose] = useState<Session | null>(null);
  const [railExpanded, setRailExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("beecork.railExpanded") === "1";
    } catch {
      return false;
    }
  });
  const [editingTop, setEditingTop] = useState(false);
  const [topEditValue, setTopEditValue] = useState("");

  const dragging = useRef(false);
  const reqN = useRef(0);
  const zoomTargetRef = useRef<Surface>("terminal");
  const prevRunning = useRef<Record<string, string | undefined>>({});

  const { update } = useSettings();
  const {
    sessions,
    activeId,
    setActiveId,
    create,
    close,
    rename,
    setDynamic,
    setCwd,
    setRunning,
  } = useSessions();

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const cwdBySession = useRef<Record<string, string>>({});
  const sessionIdsRef = useRef<string[]>([]);
  sessionIdsRef.current = sessions.map((s) => s.id);

  const onFocusSurface = useCallback((s: Surface) => {
    zoomTargetRef.current = s;
  }, []);

  const activeName = (() => {
    const s = sessions.find((x) => x.id === activeId);
    return s ? displayName(s) : "Beecork Terminal";
  })();
  const cwdName = terminalCwd ? terminalCwd.split("/").filter(Boolean).pop() ?? "" : "";

  const newSession = useCallback(
    () => create(cwdBySession.current[activeIdRef.current]),
    [create]
  );

  // ---- cwd + running-command tracking ----
  const applyCwd = useCallback(
    (id: string, cwd: string) => {
      cwdBySession.current[id] = cwd;
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
      if (!sessionIdsRef.current.includes(id)) return;
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

  useEffect(() => {
    getRoot().then(setTerminalCwd).catch(() => {});
  }, []);

  // Immediate status on session switch.
  useEffect(() => {
    const known = cwdBySession.current[activeId];
    if (known) setTerminalCwd(known);
    ptyStatus(activeId).then((st) => applyStatus(activeId, st)).catch(() => {});
  }, [activeId, applyStatus]);

  // Poll every session for cwd + running command (names the rail). One batched
  // call → one process refresh serves all sessions (not N full-table scans).
  useEffect(() => {
    const t = setInterval(() => {
      const ids = sessionIdsRef.current;
      if (!ids.length) return;
      ptyStatusAll(ids)
        .then((map) => {
          for (const [id, st] of Object.entries(map)) applyStatus(id, st);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [applyStatus]);

  // ---- wants-you (attention dot): bell, or a background command finishing ----
  const onBell = useCallback((id: string) => {
    if (id !== activeIdRef.current) setWantsYou((prev) => addId(prev, id));
  }, []);

  const onSeen = useCallback((id: string) => {
    setWantsYou((prev) => delId(prev, id));
  }, []);

  const onOpenPath = useCallback((path: string, line?: number) => {
    setOpenRequest({ path, line, n: ++reqN.current });
    setPanelOpen(true);
  }, []);

  function newWindow() {
    const label = "win-" + Date.now();
    new WebviewWindow(label, {
      url: "index.html",
      title: "Beecork Terminal",
      width: 1100,
      height: 720,
    });
  }

  // ⌘T new session (inherits cwd), ⌘N new window.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        newSession();
      } else if (k === "n") {
        e.preventDefault();
        newWindow();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  // Zoom the focused surface with ⌘+ / ⌘- / ⌘0.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const isPlus = e.key === "+" || e.key === "=";
      const isMinus = e.key === "-" || e.key === "_";
      const isZero = e.key === "0";
      if (!isPlus && !isMinus && !isZero) return;
      e.preventDefault();
      const editor = zoomTargetRef.current === "editor";
      update((s) => {
        const cur = editor ? s.editorFontSize : s.terminalFontSize;
        const next = isZero ? DEFAULT_FONT_SIZE : clampFont(cur + (isPlus ? 1 : -1));
        return editor ? { editorFontSize: next } : { terminalFontSize: next };
      });
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [update]);

  // Drop the stale key from the removed rail-pin feature (one-time cleanup).
  useEffect(() => {
    try {
      localStorage.removeItem("beecork.railPinned");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("beecork.railExpanded", railExpanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [railExpanded]);

  useEffect(() => {
    getCurrentWindow().setTitle(`${activeName} — Beecork`).catch(() => {});
  }, [activeName]);

  useEffect(() => {
    function move(e: MouseEvent) {
      if (!dragging.current) return;
      const w = window.innerWidth - e.clientX;
      setPanelWidth(Math.min(Math.max(w, 240), window.innerWidth - 360));
    }
    function up() {
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

  function commitTopRename() {
    rename(activeId, topEditValue);
    setEditingTop(false);
  }

  return (
    <div className="app-root">
      {/* The window's title bar: native chrome is transparent (titleBarStyle:
          Overlay), so the traffic lights float over this strip. Empty areas drag
          the window; the folder name stays double-click-to-rename. */}
      <div className="titlebar" data-tauri-drag-region>
        <span className="tb-crumb">
          <span className="tb-icon">
            <Folder size={14} />
          </span>
          {editingTop ? (
            <input
              className="tb-edit"
              autoFocus
              value={topEditValue}
              onChange={(e) => setTopEditValue(e.target.value)}
              onBlur={commitTopRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTopRename();
                else if (e.key === "Escape") setEditingTop(false);
              }}
            />
          ) : (
            <span
              className="tb-name"
              title="Double-click to rename"
              onDoubleClick={() => {
                setTopEditValue(activeName);
                setEditingTop(true);
              }}
            >
              {activeName}
            </span>
          )}
          {!editingTop && cwdName && cwdName !== activeName && (
            <span className="tb-path">— {cwdName}</span>
          )}
        </span>
      </div>

      <UpdateBanner />

      <div className="workspace">
        <SessionRail
          sessions={sessions}
          activeId={activeId}
          wantsYou={wantsYou}
          expanded={railExpanded}
          onSelect={setActiveId}
          onCreate={newSession}
          onClose={(id) => {
            const s = sessions.find((x) => x.id === id);
            if (s) setConfirmClose(s);
          }}
          onToggleExpand={() => setRailExpanded((e) => !e)}
          onRename={rename}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="terminals">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="terminal-slot"
              style={{ display: s.id === activeId ? "block" : "none" }}
            >
              <TerminalPane
                sessionId={s.id}
                active={s.id === activeId}
                startCwd={s.startCwd}
                onOpenPath={onOpenPath}
                onBell={onBell}
                onSeen={onSeen}
                onTitle={setDynamic}
                onCwd={onCwd}
                onStatusHint={onStatusHint}
                onFocusSurface={onFocusSurface}
              />
            </div>
          ))}
        </div>

        {panelOpen ? (
          <>
            <div
              className="divider"
              onMouseDown={(e) => {
                dragging.current = true;
                document.body.style.cursor = "col-resize";
                e.preventDefault();
              }}
            >
              <span className="divider-grip" />
            </div>
            <div className="side-panel" style={{ width: panelWidth }}>
              <SidePanel
                openRequest={openRequest}
                root={terminalCwd}
                onFocusSurface={onFocusSurface}
                onCollapse={() => setPanelOpen(false)}
              />
            </div>
          </>
        ) : (
          <div className="panel-strip">
            <button
              className="panel-strip-btn expand"
              title="Expand panel"
              onClick={() => setPanelOpen(true)}
            >
              <Chevron size={16} />
            </button>
            <button
              className="panel-strip-btn"
              title="Files"
              onClick={() => setPanelOpen(true)}
            >
              <Folder size={16} />
            </button>
            <button
              className="panel-strip-btn"
              title="Editor"
              onClick={() => {
                setPanelOpen(true);
                onFocusSurface("editor");
              }}
            >
              <Pencil size={15} />
            </button>
          </div>
        )}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {confirmClose && (
        <ConfirmModal
          title="Close session?"
          message={`“${displayName(confirmClose)}” and its running process will be terminated.`}
          confirmLabel="Close session"
          danger
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => {
            const id = confirmClose.id;
            close(id);
            // Prune per-session bookkeeping so it doesn't leak or resurrect the id.
            delete prevRunning.current[id];
            delete cwdBySession.current[id];
            setWantsYou((prev) => delId(prev, id));
            setConfirmClose(null);
          }}
        />
      )}
    </div>
  );
}
