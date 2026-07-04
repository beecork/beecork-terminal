import { useCallback, useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalPane from "./components/TerminalPane";
import SidePanel from "./components/SidePanel";
import SettingsModal from "./components/SettingsModal";
import SessionRail from "./components/SessionRail";
import UpdateBanner from "./components/UpdateBanner";
import ConfirmModal from "./components/ConfirmModal";
import RenameInput from "./components/RenameInput";
import { Folder, Chevron, Pencil } from "./components/icons";
import { useSessions, displayName, type Session } from "./lib/sessions";
import { useSessionStatus } from "./lib/useSessionStatus";
import { basename } from "./lib/paths";
import { usePersistedState } from "./lib/persist";
import { useDrag } from "./lib/useDrag";
import { useSettings, zoomFont } from "./lib/settings";
import "./App.css";

export interface OpenRequest {
  path: string;
  line?: number;
  n: number;
}

type Surface = "terminal" | "editor";

export default function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(380);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [confirmClose, setConfirmClose] = useState<Session | null>(null);
  const [railExpanded, setRailExpanded] = usePersistedState(
    "beecork.railExpanded",
    false,
    (r) => r === "1",
    (v) => (v ? "1" : "0")
  );
  const [editingTop, setEditingTop] = useState(false);

  const reqN = useRef(0);
  const zoomTargetRef = useRef<Surface>("terminal");

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
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // cwd / running-command / attention-dot state machine + polling.
  const { terminalCwd, wantsYou, onCwd, onStatusHint, onBell, onSeen, markClosed } =
    useSessionStatus(sessions, activeId, setCwd, setRunning);

  const onFocusSurface = useCallback((s: Surface) => {
    zoomTargetRef.current = s;
  }, []);

  const activeName = (() => {
    const s = sessions.find((x) => x.id === activeId);
    return s ? displayName(s) : "Beecork Terminal";
  })();
  const cwdName = terminalCwd ? basename(terminalCwd) : "";

  // A new session inherits the active session's cwd.
  const newSession = useCallback(() => {
    create(sessionsRef.current.find((s) => s.id === activeIdRef.current)?.cwd);
  }, [create]);

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
      zoomFont(update, zoomTargetRef.current, isZero ? "reset" : isPlus ? 1 : -1);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [update]);

  useEffect(() => {
    getCurrentWindow().setTitle(`${activeName} — Beecork`).catch(() => {});
  }, [activeName]);

  const startPanelDrag = useDrag((e) => {
    const w = window.innerWidth - e.clientX;
    setPanelWidth(Math.min(Math.max(w, 240), window.innerWidth - 360));
  }, "col-resize");

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
            <RenameInput
              className="tb-edit"
              initialValue={activeName}
              onCommit={(v) => {
                rename(activeId, v);
                setEditingTop(false);
              }}
              onCancel={() => setEditingTop(false)}
            />
          ) : (
            <span
              className="tb-name"
              title="Double-click to rename"
              onDoubleClick={() => setEditingTop(true)}
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
            <div className="divider" onMouseDown={startPanelDrag}>
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
            close(confirmClose.id);
            markClosed(confirmClose.id);
            setConfirmClose(null);
          }}
        />
      )}
    </div>
  );
}
