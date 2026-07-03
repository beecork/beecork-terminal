import { useCallback, useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalPane from "./components/TerminalPane";
import SidePanel from "./components/SidePanel";
import SettingsModal from "./components/SettingsModal";
import SessionRail from "./components/SessionRail";
import UpdateBanner from "./components/UpdateBanner";
import ConfirmModal from "./components/ConfirmModal";
import { Gear, PanelToggle, Folder } from "./components/icons";
import { useSessions, displayName, type Session } from "./lib/sessions";
import { getRoot, ptyCwd } from "./lib/api";
import { useSettings, clampFont } from "./lib/settings";
import "./App.css";

type Surface = "terminal" | "editor";

export interface OpenRequest {
  path: string;
  line?: number;
  n: number;
}

export default function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(380);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [activity, setActivity] = useState<Set<string>>(() => new Set());
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [railPinned, setRailPinned] = useState<boolean>(() => {
    try {
      return localStorage.getItem("beecork.railPinned") === "1";
    } catch {
      return false;
    }
  });
  const [confirmClose, setConfirmClose] = useState<Session | null>(null);
  const dragging = useRef(false);
  const reqN = useRef(0);
  const zoomTargetRef = useRef<Surface>("terminal");

  const { update } = useSettings();
  const { sessions, activeId, setActiveId, create, close, rename, setDynamic, setCwd } =
    useSessions();

  const onFocusSurface = useCallback((s: Surface) => {
    zoomTargetRef.current = s;
  }, []);

  const activeName = (() => {
    const s = sessions.find((x) => x.id === activeId);
    return s ? displayName(s) : "Beecork Terminal";
  })();
  const cwdName = terminalCwd
    ? terminalCwd.split("/").filter(Boolean).pop() ?? ""
    : "";

  const cwdBySession = useRef<Record<string, string>>({});
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const applyCwd = useCallback(
    (id: string, cwd: string) => {
      cwdBySession.current[id] = cwd;
      setCwd(id, cwd); // names the session after its folder
      if (id === activeIdRef.current) {
        setTerminalCwd((prev) => (prev === cwd ? prev : cwd));
      }
    },
    [setCwd]
  );

  // OSC 7 (instant, shells with integration).
  const onCwd = useCallback((id: string, path: string) => applyCwd(id, path), [applyCwd]);
  // Output settled — re-check cwd for shells that don't emit OSC 7 (covers plain zsh/bash).
  const onCwdHint = useCallback(
    (id: string) => {
      if (id !== activeIdRef.current) return;
      ptyCwd(id).then((cwd) => cwd && applyCwd(id, cwd)).catch(() => {});
    },
    [applyCwd]
  );

  // Initial root = where the shell starts.
  useEffect(() => {
    getRoot().then(setTerminalCwd).catch(() => {});
  }, []);

  // On session switch: show the last-known cwd immediately, confirm it, and keep a
  // slow safety poll (the OSC 7 handler + output hints do the responsive work).
  useEffect(() => {
    const known = cwdBySession.current[activeId];
    if (known) setTerminalCwd(known);
    ptyCwd(activeId).then((cwd) => cwd && applyCwd(activeId, cwd)).catch(() => {});
    const t = setInterval(() => {
      const id = activeIdRef.current;
      ptyCwd(id).then((cwd) => cwd && applyCwd(id, cwd)).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [activeId, applyCwd]);

  const onOpenPath = useCallback((path: string, line?: number) => {
    setOpenRequest({ path, line, n: ++reqN.current });
    setPanelOpen(true);
  }, []);

  const onActivity = useCallback((id: string) => {
    setActivity((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const onSeen = useCallback((id: string) => {
    setActivity((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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

  // Keyboard shortcuts: ⌘T new session, ⌘N new window.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        create();
      } else if (k === "n") {
        e.preventDefault();
        newWindow();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [create]);

  // Zoom the focused surface (terminal or editor) with ⌘+ / ⌘- / ⌘0.
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
        const next = isZero ? 13 : clampFont(cur + (isPlus ? 1 : -1));
        return editor ? { editorFontSize: next } : { terminalFontSize: next };
      });
    }
    // capture phase so we beat the webview's own page-zoom and xterm's key handling
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [update]);

  // Persist pinned state.
  useEffect(() => {
    try {
      localStorage.setItem("beecork.railPinned", railPinned ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [railPinned]);

  // Reflect the active session's name in the OS window title.
  useEffect(() => {
    getCurrentWindow()
      .setTitle(`${activeName} — Beecork`)
      .catch(() => {});
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

  return (
    <div className="app-root">
      <UpdateBanner />
      <div className="topbar">
        <div className="crumb">
          <span className="crumb-icon">
            <Folder size={15} />
          </span>
          <span className="crumb-name">{activeName}</span>
          {cwdName && cwdName !== activeName && (
            <span className="crumb-path">— {cwdName}</span>
          )}
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
            <Gear />
          </button>
          <button
            className={`icon-btn${panelOpen ? " on" : ""}`}
            onClick={() => setPanelOpen((o) => !o)}
            title={panelOpen ? "Hide file panel" : "Show file panel"}
          >
            <PanelToggle />
          </button>
        </div>
      </div>

      <div className="workspace">
        <SessionRail
          sessions={sessions}
          activeId={activeId}
          activity={activity}
          pinned={railPinned}
          onSelect={setActiveId}
          onCreate={create}
          onClose={(id) => {
            const s = sessions.find((x) => x.id === id);
            if (s) setConfirmClose(s);
          }}
          onTogglePin={() => setRailPinned((p) => !p)}
          onRename={rename}
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
                onOpenPath={onOpenPath}
                onActivity={onActivity}
                onSeen={onSeen}
                onTitle={setDynamic}
                onCwd={onCwd}
                onCwdHint={onCwdHint}
                onFocusSurface={onFocusSurface}
              />
            </div>
          ))}
        </div>

        {panelOpen && (
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
        )}

        {panelOpen && (
          <div className="side-panel" style={{ width: panelWidth }}>
            <SidePanel
              openRequest={openRequest}
              root={terminalCwd}
              onFocusSurface={onFocusSurface}
            />
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
            close(confirmClose.id);
            setConfirmClose(null);
          }}
        />
      )}
    </div>
  );
}
