import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import TerminalPane from "./components/TerminalPane";
import SidePanel from "./components/SidePanel";
import SettingsModal from "./components/SettingsModal";
import FirstRunModal from "./components/FirstRunModal";
import SessionRail from "./components/SessionRail";
import UpdateBanner from "./components/UpdateBanner";
import ConfirmModal from "./components/ConfirmModal";
import RenameInput from "./components/RenameInput";
import PaneHeader from "./components/PaneHeader";
import { Folder, Chevron, Pencil, Split } from "./components/icons";
import { useSessions, displayName, type Session } from "./lib/sessions";
import { useSessionStatus } from "./lib/useSessionStatus";
import { basename } from "./lib/paths";
import { setWatchRoot } from "./lib/api";
import { usePersistedState } from "./lib/persist";
import { useDrag } from "./lib/useDrag";
import { initNotifications } from "./lib/notify";
import * as sound from "./lib/sound";
import { useSettings, zoomFont, type Surface } from "./lib/settings";
import { noFocusSteal } from "./lib/keepFocus";
import "./App.css";

export interface OpenRequest {
  path: string;
  line?: number;
  n: number;
}

/** Single-quote a path for a POSIX shell (bash/zsh/fish/sh) — safe for `cd`. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export default function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(380);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const [confirmClose, setConfirmClose] = useState<Session | null>(null);
  const [confirmCloseOthers, setConfirmCloseOthers] = useState<string | null>(null);
  const [railExpanded, setRailExpanded] = usePersistedState(
    "beecork.railExpanded",
    false,
    (r) => r === "1",
    (v) => (v ? "1" : "0")
  );
  const [editingTop, setEditingTop] = useState(false);
  const [splitPct, setSplitPct] = usePersistedState(
    "beecork.splitPct",
    50,
    (r) => {
      const n = Number(r);
      return n >= 20 && n <= 80 ? n : 50;
    },
    (v) => String(Math.round(v))
  );

  const reqN = useRef(0);
  const zoomTargetRef = useRef<Surface>("terminal");
  const terminalsRef = useRef<HTMLDivElement>(null);

  // Bump to pull keyboard focus back to the active terminal (after an overlay closes).
  const [focusNonce, setFocusNonce] = useState(0);
  const focusTerminal = useCallback(() => setFocusNonce((n) => n + 1), []);

  const { settings, update } = useSettings();
  const {
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
  } = useSessions();

  // A pair is symmetric and lives on the session (`partner`), so it's remembered.
  // `activeId` is the focused session; its partner (if any) is shown beside it.
  // Left/right order is stable (by rail position), so focus can move between the
  // panes without the layout jumping. Everything derives from these two.
  // First run (or a user who never set one): ask for a default startup folder.
  const needsDefaultFolder = settings.defaultCwd === undefined;

  const active = sessions.find((s) => s.id === activeId);
  const partnerId =
    active?.partner && active.partner !== activeId && sessions.some((s) => s.id === active.partner)
      ? active.partner
      : null;
  let leftId = activeId;
  let rightId: string | null = null;
  if (partnerId) {
    const ai = sessions.findIndex((s) => s.id === activeId);
    const pi = sessions.findIndex((s) => s.id === partnerId);
    [leftId, rightId] = ai <= pi ? [activeId, partnerId] : [partnerId, activeId];
  }
  const split = rightId != null;
  // Sessions on screen right now: both panes in split, else just the focused one.
  const visibleIds = rightId ? [leftId, rightId] : [activeId];
  // Live session ids, for pruning per-session memory (e.g. the panel's editor
  // state) when a session closes. Recomputed only when the session set changes.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  // Terminal panes render in a STABLE order (by id), independent of the rail's
  // display order. Layout is driven by CSS (order/display), not DOM order, so this
  // is invisible — but it means reordering tabs never moves a pane's DOM node,
  // which would otherwise blank its xterm WebGL canvas until the next repaint.
  const terminalOrder = useMemo(
    () => [...sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [sessions]
  );

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // cwd / running-command / attention-dot state machine + polling.
  const { terminalCwd, wantsYou, busy, onCwd, onStatusHint, onActivity, onBell, onSeen, markClosed } =
    useSessionStatus(sessions, activeId, visibleIds, setCwd, setRunning);

  // A soft chime the instant a session newly needs you — agent finished, bell
  // rang, or a background command ended. `wantsYou` is already gated on the
  // session being off-screen, so this only ever fires when you're not looking
  // (exactly when an audible nudge helps). One chime per batch of new attention.
  const prevWantsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let fresh = false;
    for (const id of wantsYou) {
      if (!prevWantsRef.current.has(id)) {
        fresh = true;
        break;
      }
    }
    prevWantsRef.current = wantsYou;
    if (fresh) sound.attention();
  }, [wantsYou]);

  const onFocusSurface = useCallback((s: Surface) => {
    zoomTargetRef.current = s;
  }, []);

  const activeName = active ? displayName(active) : "Beecork Terminal";
  const cwdName = terminalCwd ? basename(terminalCwd) : "";

  // A new session inherits the focused session's cwd and opens right below it —
  // so it lands in the same rail section. (Action before sound, so a throwing
  // sound call can never swallow the action — same rule as the send path.)
  const newSession = useCallback(() => {
    const cur = activeIdRef.current;
    create(sessionsRef.current.find((s) => s.id === cur)?.cwd, true, cur);
    sound.create();
  }, [create]);

  // Drag the split divider — updates the left pane's width %.
  const startSplitDrag = useDrag((e) => {
    const el = terminalsRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pct = ((e.clientX - r.left) / r.width) * 100;
    setSplitPct(Math.min(80, Math.max(20, pct)));
  }, "col-resize");

  // Replace one pane's session with `id`, keeping the other pane and re-pairing.
  // Focus moves to `id` only if you edited the pane you were focused on.
  function setPaneSession(paneSessionId: string, id: string) {
    if (!rightId) return;
    const otherShown = paneSessionId === leftId ? rightId : leftId;
    if (id === otherShown || id === paneSessionId) return;
    pairSessions(otherShown, id);
    if (paneSessionId === activeId) setActiveId(id);
  }

  // Split the active session with its neighbour (or a new one), or unsplit it.
  // Sound trails the action so a throwing sound call can't drop the split/unsplit.
  function toggleSplit() {
    if (partnerId) {
      unpairSession(activeId);
      sound.panelClose(); // collapsing back to a single pane
      return;
    }
    const idx = sessions.findIndex((s) => s.id === activeId);
    const next = sessions[idx + 1] ?? sessions.find((s) => s.id !== activeId);
    const partner = next?.id ?? create(active?.cwd, false, activeId);
    pairSessions(activeId, partner);
    setPanelOpen(false);
    sound.split();
  }
  const toggleSplitRef = useRef(toggleSplit);
  toggleSplitRef.current = toggleSplit;

  // Closing always goes through the confirmation modal.
  function requestClose(id: string) {
    const s = sessions.find((x) => x.id === id);
    if (s) setConfirmClose(s);
  }

  // Right-click → "Split with active": pair the clicked session with the focused
  // one (or plain split-toggle when you right-click the active one itself).
  function splitWith(id: string) {
    if (id === activeIdRef.current) {
      toggleSplitRef.current();
      return;
    }
    pairSessions(activeIdRef.current, id);
    setPanelOpen(false);
  }

  // Right-click → "Close others": tear down every session but `keepId`.
  function closeOthers(keepId: string) {
    for (const s of sessionsRef.current) {
      if (s.id !== keepId) {
        close(s.id);
        markClosed(s.id);
      }
    }
    setActiveId(keepId);
  }

  const onOpenPath = useCallback((path: string, line?: number) => {
    setOpenRequest({ path, line, n: ++reqN.current });
    setPanelOpen(true);
    sound.blip(); // a file was opened into the editor (sound after the open)
  }, []);

  // File-browser right-click → "Open folder in terminal": cd the active session there.
  const openInTerminal = useCallback(
    (dir: string) => {
      invoke("pty_write", { id: activeIdRef.current, data: `cd ${shellQuote(dir)}\n` }).catch(
        () => {}
      );
      focusTerminal();
    },
    [focusTerminal]
  );

  function newWindow() {
    const label = "win-" + Date.now();
    new WebviewWindow(label, {
      url: "index.html",
      title: "Beecork Terminal",
      width: 1100,
      height: 720,
    });
  }

  // Ask for notification permission once so background-agent pings can fire.
  useEffect(() => {
    initNotifications();
  }, []);

  // Keep the (context-free) sound engine in sync with the user's preferences.
  // Lives here rather than in settings.tsx so that editing sound.ts doesn't force
  // a full page reload (settings.tsx can't Fast-Refresh; App.tsx can).
  useEffect(() => {
    sound.setSoundConfig({
      enabled: settings.sound,
      volume: settings.soundVolume,
      uiSounds: settings.uiSounds,
      keyClicks: settings.keyClicks,
    });
  }, [settings.sound, settings.soundVolume, settings.uiSounds, settings.keyClicks]);

  // (Sound needs no warm-up anymore — it's played natively by the Rust backend,
  // which has no webview AudioContext to keep alive or resume. See lib/sound.ts.)

  // Keep the terminal focused — the terminal is "home". Keyboard focus should live
  // there unless a real input legitimately holds it (the editor, a rename field,
  // search, a modal). Whenever focus lands on nothing — the window regains OS
  // focus with nothing selected (back from Finder/another app), an inline rename
  // commits, a file prompt closes, or you click a non-input surface like a file
  // row or chrome — pull it back to the active terminal. We never steal focus from
  // a modal or a genuine input: those keep it until you're done, then this returns
  // it. This is why selecting a file leaves you typing in the terminal, and why
  // finishing a rename drops you straight back into it.
  useEffect(() => {
    let raf = 0;
    const rescue = () => {
      if (document.querySelector(".modal-overlay")) return; // a dialog owns focus
      const el = document.activeElement;
      // Only rescue when nothing meaningful is focused (body/root). An input,
      // textarea, contenteditable (the editor), a button, or a menu keeps focus.
      if (el && el !== document.body && el !== document.documentElement) return;
      focusTerminal();
    };
    // focusout fires *before* focus settles on the next target, so defer a frame
    // and re-check activeElement — reading it during the event sees the element
    // being left, not the one being entered.
    const onFocusOut = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(rescue);
    };
    window.addEventListener("focus", rescue);
    window.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("focus", rescue);
      window.removeEventListener("focusout", onFocusOut);
      cancelAnimationFrame(raf);
    };
  }, [focusTerminal]);

  // Drop a file / screenshot onto the window → paste its (shell-quoted) path into
  // the active terminal, like dropping onto a native terminal (hand an agent an
  // image by dragging it in). Tauri intercepts the OS drop — native HTML drop
  // never fires — so we handle its drag-drop event and write to the PTY ourselves.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths.length) return;
        const data = paths.map(shellQuote).join(" ") + " ";
        invoke("pty_write", { id: activeIdRef.current, data }).catch(() => {});
        focusTerminal();
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [focusTerminal]);

  // Keep the file watcher on the active terminal's directory, so the live diff
  // keeps updating after the terminal cd's outside the launch folder.
  useEffect(() => {
    if (terminalCwd) setWatchRoot(terminalCwd).catch(() => {});
  }, [terminalCwd]);

  // ⌘T new session (inherits cwd), ⌘N new window, ⌘D toggle split view.
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
      } else if (k === "d") {
        e.preventDefault();
        toggleSplitRef.current();
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
        <button
          className={`tb-action${split ? " on" : ""}`}
          title={split ? "Unsplit (⌘D)" : "Split — pair with another session (⌘D)"}
          onClick={toggleSplit}
          {...noFocusSteal}
        >
          <Split size={15} />
        </button>
      </div>

      <UpdateBanner />

      <div className="workspace">
        <SessionRail
          items={items}
          activeId={activeId}
          wantsYou={wantsYou}
          busy={busy}
          expanded={railExpanded}
          onSelect={(id) => {
            const switching = id !== activeId;
            setActiveId(id);
            if (switching) sound.blip();
          }}
          onCreate={newSession}
          onClose={requestClose}
          onToggleExpand={() => {
            // Schedule the visual first (so a throwing sound can't drop the toggle),
            // then play — withVisual holds the visual back to land with the sound.
            sound.withVisual(() => setRailExpanded((e) => !e));
            railExpanded ? sound.panelClose() : sound.panelOpen();
          }}
          onRename={rename}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateIn={(cwd, afterId) => create(cwd, true, afterId)}
          onSplitWith={splitWith}
          onUnsplit={unpairSession}
          onCloseOthers={(id) => setConfirmCloseOthers(id)}
          onReorder={reorder}
          onAddDivider={addDivider}
          onRenameDivider={renameDivider}
          onRemoveDivider={removeDivider}
        />

        <div className={`terminals${split ? " split" : ""}`} ref={terminalsRef}>
          {terminalOrder.map((s) => {
            const isLeftPane = s.id === leftId;
            const isRightPane = split && s.id === rightId;
            const visible = split ? isLeftPane || isRightPane : s.id === activeId;
            const isFocused = s.id === activeId;
            return (
              <div
                key={s.id}
                className={`terminal-slot${split && visible && isFocused ? " focused" : ""}`}
                style={
                  split && visible
                    ? {
                        display: "flex",
                        order: isRightPane ? 2 : 0,
                        flex: isLeftPane ? `0 0 ${splitPct}%` : "1 1 0",
                      }
                    : { display: visible ? "block" : "none" }
                }
                onMouseDown={() => {
                  if (split && s.id !== activeId) {
                    setActiveId(s.id);
                    sound.blip();
                  }
                }}
              >
                {split && visible && (
                  <PaneHeader
                    sessions={sessions}
                    currentId={s.id}
                    otherId={isRightPane ? leftId : rightId}
                    focused={isFocused}
                    onPick={(id) => setPaneSession(s.id, id)}
                    onClose={() => requestClose(s.id)}
                  />
                )}
                <TerminalPane
                  sessionId={s.id}
                  visible={visible}
                  active={isFocused && visible}
                  startCwd={s.startCwd}
                  onOpenPath={onOpenPath}
                  onBell={onBell}
                  onSeen={onSeen}
                  onTitle={setDynamic}
                  onCwd={onCwd}
                  onStatusHint={onStatusHint}
                  onActivity={onActivity}
                  onFocusSurface={onFocusSurface}
                  focusSignal={focusNonce}
                  onNewSession={newSession}
                  onToggleSplit={() => toggleSplitRef.current()}
                  onCloseSession={() => requestClose(s.id)}
                  onRequestClose={!split && isFocused ? () => requestClose(s.id) : undefined}
                  resumeAgent={s.resumeAgent}
                  onResumeConsumed={clearResume}
                />
              </div>
            );
          })}
          {split && (
            <div className="term-divider" style={{ order: 1 }} onMouseDown={startSplitDrag} />
          )}
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
                sessionId={activeId}
                liveSessionIds={sessionIds}
                onFocusSurface={onFocusSurface}
                onOpenInTerminal={openInTerminal}
                onCollapse={() => {
                  sound.withVisual(() => {
                    setPanelOpen(false);
                    focusTerminal();
                  });
                  sound.panelClose();
                }}
              />
            </div>
          </>
        ) : (
          <div className="panel-strip">
            <button
              className="panel-strip-btn expand"
              title="Expand panel"
              onClick={() => {
                sound.withVisual(() => setPanelOpen(true));
                sound.panelOpen();
              }}
              {...noFocusSteal}
            >
              <Chevron size={16} />
            </button>
            <button
              className="panel-strip-btn"
              title="Files"
              onClick={() => {
                sound.withVisual(() => setPanelOpen(true));
                sound.panelOpen();
              }}
              {...noFocusSteal}
            >
              <Folder size={16} />
            </button>
            <button
              className="panel-strip-btn"
              title="Editor"
              onClick={() => {
                sound.withVisual(() => setPanelOpen(true));
                sound.panelOpen();
                onFocusSurface("editor");
              }}
              {...noFocusSteal}
            >
              <Pencil size={15} />
            </button>
          </div>
        )}
      </div>

      {needsDefaultFolder && (
        <FirstRunModal
          onChoose={(path) => {
            update({ defaultCwd: path });
            // Move the already-spawned first shell there right away (fresh prompt).
            invoke("pty_write", { id: activeId, data: `cd ${shellQuote(path)}\n` }).catch(() => {});
            focusTerminal();
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            focusTerminal();
          }}
        />
      )}
      {confirmClose && (
        <ConfirmModal
          title="Close session?"
          message={`“${displayName(confirmClose)}” and its running process will be terminated.`}
          confirmLabel="Close session"
          danger
          onCancel={() => {
            setConfirmClose(null);
            focusTerminal();
          }}
          onConfirm={() => {
            close(confirmClose.id);
            markClosed(confirmClose.id);
            setConfirmClose(null);
            focusTerminal();
            sound.closeSession();
          }}
        />
      )}
      {confirmCloseOthers && (
        <ConfirmModal
          title="Close other sessions?"
          message={`Every session except this one — and their running processes — will be terminated.`}
          confirmLabel="Close others"
          danger
          onCancel={() => {
            setConfirmCloseOthers(null);
            focusTerminal();
          }}
          onConfirm={() => {
            closeOthers(confirmCloseOthers);
            setConfirmCloseOthers(null);
            focusTerminal();
            sound.closeSession();
          }}
        />
      )}
    </div>
  );
}
