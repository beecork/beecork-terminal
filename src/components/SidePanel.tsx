import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitStatus,
  revealPath,
  renamePath,
  createPath,
  deletePath,
  type ChangeStatus,
  type FileStatus,
  type Entry,
} from "../lib/api";
import { onFsChanged } from "../lib/events";
import { useSettings, zoomFont, type Surface } from "../lib/settings";
import type { OpenRequest } from "../App";
import FileTree from "./FileTree";
import ZoomControl from "./ZoomControl";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import PromptModal from "./PromptModal";
import ConfirmModal from "./ConfirmModal";
// Lazy so the ~750 kB CodeMirror editor stack loads on first file-open, not at
// app startup (the terminal is the star).
const FileEditor = lazy(() => import("./FileEditor"));
const MediaViewer = lazy(() => import("./MediaViewer"));
import { basename, dirname, joinPath, relativePath, breadcrumbs, changedAncestors, mediaKind } from "../lib/paths";
import { usePersistedState } from "../lib/persist";
import { useDrag } from "../lib/useDrag";
import { useContextMenu } from "../lib/useContextMenu";
import { copyText } from "../lib/clipboard";
import { Folder, Refresh, LayoutRows, LayoutColumns, Chevron, Diff, ArrowLeft, ArrowRight } from "./icons";

interface Props {
  openRequest: OpenRequest | null;
  /** The active terminal's working directory — the browser follows it. */
  root: string | null;
  /** The active session id — the editor remembers open files per session. */
  sessionId: string;
  /** All live session ids — remembered pane state is pruned when a session closes. */
  liveSessionIds: string[];
  onFocusSurface: (s: Surface) => void;
  /** right-click → "Open in terminal": cd the active session into a folder */
  onOpenInTerminal: (dir: string) => void;
  /** collapse the whole panel back to the thin strip */
  onCollapse: () => void;
}

/** State for the new-file / new-folder / rename prompt. */
interface PromptState {
  title: string;
  label: string;
  initial: string;
  selectTo?: number;
  confirmLabel: string;
  onSubmit: (value: string) => void;
}

type PanelLayout = "stacked" | "sideBySide";

export default function SidePanel({
  openRequest,
  root,
  sessionId,
  liveSessionIds,
  onFocusSurface,
  onOpenInTerminal,
  onCollapse,
}: Props) {
  const { settings, update } = useSettings();
  const { menu, openMenu, closeMenu } = useContextMenu<Entry>();
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Entry | null>(null);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [treeKey, setTreeKey] = useState(0);

  const [panes, setPanes] = useState<(string | null)[]>([null]);
  const [focused, setFocused] = useState(0);
  const [panelLayout, setPanelLayout] = usePersistedState<PanelLayout>(
    "beecork.panelLayout",
    "stacked",
    (r) => (r === "sideBySide" ? "sideBySide" : "stacked"),
    (v) => v
  );
  // Draggable size of the Files region (percent of the panel body).
  const [treeSize, setTreeSize] = usePersistedState(
    "beecork.treeSize",
    40,
    (r) => {
      const v = Number(r);
      return v >= 12 && v <= 80 ? v : 40;
    },
    (v) => String(Math.round(v))
  );
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const bodyRef = useRef<HTMLDivElement>(null);

  // --- folder navigation history (Back / Forward), per session ---------------
  // The browser's "current folder" IS the active terminal's cwd (`root`). Every
  // move — breadcrumb, "..", double-click, Back/Forward, or a manual `cd` typed
  // in the terminal — flows through `root`, so we record history by watching
  // `root` change. Keyed by session id (a ref map, like paneMemory) so each tab
  // keeps its own trail. `navTargetRef` marks the cwd WE are steering to via
  // Back/Forward, so the `cd` it triggers isn't recorded as a brand-new step.
  const histRef = useRef<Record<string, { stack: string[]; index: number }>>({});
  const navTargetRef = useRef<string | null>(null);
  const [, bumpHist] = useState(0);

  // Remember open files per terminal session (tab): when the active session
  // changes, save the outgoing session's editor state and restore the incoming
  // one (a fresh empty editor if it has none).
  const paneStateRef = useRef({ panes, focused });
  paneStateRef.current = { panes, focused };
  const paneMemory = useRef<Record<string, { panes: (string | null)[]; focused: number }>>({});
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev === sessionId) return;
    paneMemory.current[prev] = paneStateRef.current; // save outgoing (latest)
    const saved = paneMemory.current[sessionId];
    setPanes(saved?.panes ?? [null]);
    setFocused(saved?.focused ?? 0);
    prevSessionRef.current = sessionId;
  }, [sessionId]);

  // Drop remembered pane state for sessions that have closed, so paneMemory
  // doesn't accumulate an entry per session for the life of the app.
  useEffect(() => {
    const live = new Set(liveSessionIds);
    for (const id of Object.keys(paneMemory.current)) {
      if (!live.has(id)) delete paneMemory.current[id];
    }
    for (const id of Object.keys(histRef.current)) {
      if (!live.has(id)) delete histRef.current[id];
    }
  }, [liveSessionIds]);

  // Drag the Files/Editor divider (vertical in stacked, horizontal in side-by-side).
  const startTreeDrag = useDrag((e) => {
    if (!bodyRef.current) return;
    const r = bodyRef.current.getBoundingClientRect();
    const pct =
      panelLayout === "stacked"
        ? ((e.clientY - r.top) / r.height) * 100
        : ((e.clientX - r.left) / r.width) * 100;
    setTreeSize(Math.min(80, Math.max(12, pct)));
  }, panelLayout === "stacked" ? "row-resize" : "col-resize");

  const refresh = useCallback(() => {
    gitStatus(root ?? undefined)
      .then(setStatuses)
      .catch(() => setStatuses([]));
  }, [root]);

  useEffect(() => {
    refresh();
    return onFsChanged(refresh);
  }, [refresh]);

  // Record each new working directory this session visits, unless the change was
  // our own Back/Forward. A genuine move truncates any forward tail, like a
  // browser. (A tab switch changes `root` too, but the incoming session's cwd
  // already sits at the top of its own stack, so it records nothing.)
  useEffect(() => {
    if (!root) return;
    if (navTargetRef.current === root) {
      navTargetRef.current = null;
      return;
    }
    const h = histRef.current[sessionId] ?? { stack: [], index: -1 };
    if (h.stack[h.index] === root) return;
    const stack = [...h.stack.slice(0, h.index + 1), root];
    histRef.current[sessionId] = { stack, index: stack.length - 1 };
    bumpHist((v) => v + 1);
  }, [root, sessionId]);

  const hist = histRef.current[sessionId] ?? { stack: [], index: -1 };
  const canBack = hist.index > 0;
  const canForward = hist.index >= 0 && hist.index < hist.stack.length - 1;

  const goHistory = (delta: -1 | 1) => {
    const h = histRef.current[sessionId];
    if (!h) return;
    const next = h.index + delta;
    if (next < 0 || next >= h.stack.length) return;
    const target = h.stack[next];
    histRef.current[sessionId] = { stack: h.stack, index: next };
    navTargetRef.current = target; // don't let the resulting cd re-record
    bumpHist((v) => v + 1);
    onOpenInTerminal(target);
  };

  const openInFocused = useCallback((path: string) => {
    setPanes((prev) => {
      const next = [...prev];
      next[focusedRef.current] = path;
      return next;
    });
  }, []);

  // --- file-tree right-click menu -------------------------------------------
  function promptCreate(dir: string, isDir: boolean) {
    setPrompt({
      title: isDir ? "New folder" : "New file",
      label: `Create in ${basename(dir) || dir}`,
      initial: "",
      confirmLabel: "Create",
      onSubmit: (name) => {
        const full = joinPath(dir, name);
        createPath(full, isDir)
          .then(() => {
            if (!isDir) openInFocused(full); // open a freshly-created file
          })
          .catch((err) => console.error("create failed", err));
        setPrompt(null);
      },
    });
  }

  function promptRename(entry: Entry) {
    const dot = entry.name.lastIndexOf(".");
    setPrompt({
      title: "Rename",
      label: dirname(entry.path),
      initial: entry.name,
      selectTo: !entry.is_dir && dot > 0 ? dot : entry.name.length, // preselect the stem
      confirmLabel: "Rename",
      onSubmit: (name) => {
        renamePath(entry.path, joinPath(dirname(entry.path), name)).catch((err) =>
          console.error("rename failed", err)
        );
        setPrompt(null);
      },
    });
  }

  function fileMenu(entry: Entry): MenuEntry[] {
    const targetDir = entry.is_dir ? entry.path : dirname(entry.path);
    const items: MenuEntry[] = [];
    if (!entry.is_dir) items.push({ label: "Open", onSelect: () => openInFocused(entry.path) });
    items.push(
      {
        label: entry.is_dir ? "Open in terminal" : "Open folder in terminal",
        onSelect: () => onOpenInTerminal(targetDir),
      },
      { label: "Copy path", onSelect: () => copyText(entry.path) },
      { label: "Copy relative path", onSelect: () => copyText(relativePath(entry.path, root ?? "")) },
      "separator",
      { label: "New file…", onSelect: () => promptCreate(targetDir, false) },
      { label: "New folder…", onSelect: () => promptCreate(targetDir, true) },
      { label: "Reveal in Finder", onSelect: () => void revealPath(entry.path).catch(() => {}) },
      "separator",
      { label: "Rename…", onSelect: () => promptRename(entry) },
      { label: "Delete", danger: true, onSelect: () => setConfirmDelete(entry) }
    );
    return items;
  }

  useEffect(() => {
    if (openRequest?.path) openInFocused(openRequest.path);
  }, [openRequest?.n, openInFocused]);

  function toggleSplit() {
    setPanes((prev) => {
      if (prev.length === 1) {
        setFocused(1);
        return [prev[0], null];
      }
      const keep = prev[focused];
      setFocused(0);
      return [keep];
    });
  }

  // Empty when tree diffs are toggled off — the tree renders with no change
  // markers at all (dots, colored names, count pill).
  const statusByPath = useMemo(() => {
    const m = new Map<string, ChangeStatus>();
    if (settings.treeDiff) for (const s of statuses) m.set(s.path, s.status);
    return m;
  }, [statuses, settings.treeDiff]);

  const changedDirs = useMemo(
    () =>
      settings.treeDiff
        ? changedAncestors(statuses.map((s) => s.path), root ?? "")
        : new Set<string>(),
    [statuses, root, settings.treeDiff]
  );

  // Last crumb, not basename(): basename splits on "/" only, so it would show a
  // whole Windows path (C:\…\proj) instead of just "proj".
  const crumbs = root ? breadcrumbs(root) : [];
  const rootName = crumbs.length ? crumbs[crumbs.length - 1].name : "";
  const split = panes.length > 1;

  return (
    <div className="side-panel-inner">
      <div className="section-header" title={root ?? ""}>
        <div className="folder-chip">
          <span className="chip-icon">
            <Folder size={16} />
          </span>
          <span className="chip-name">{rootName || "Files"}</span>
          {settings.treeDiff && statuses.length > 0 && (
            <span className="count-pill">{statuses.length}</span>
          )}
        </div>
        <div className="panel-actions">
          <div className="seg" title="Panel layout">
            <button
              className={panelLayout === "stacked" ? "on" : ""}
              title="Stacked (tree over editor)"
              onClick={() => setPanelLayout("stacked")}
            >
              <LayoutRows size={15} />
            </button>
            <button
              className={panelLayout === "sideBySide" ? "on" : ""}
              title="Side by side (tree beside editor)"
              onClick={() => setPanelLayout("sideBySide")}
            >
              <LayoutColumns size={15} />
            </button>
          </div>
          <button
            className="icon-btn sm"
            title="Refresh file tree"
            onClick={() => {
              setTreeKey((k) => k + 1);
              refresh();
            }}
          >
            <Refresh size={15} />
          </button>
          <button
            className="icon-btn sm collapse-panel"
            title="Collapse panel"
            onClick={onCollapse}
          >
            <Chevron size={15} />
          </button>
        </div>
      </div>

      <div className={`panel-body ${panelLayout}`} ref={bodyRef}>
        <div className="tree-region" style={{ flexBasis: `${treeSize}%` }}>
          <div className="seclabel">
            <div className="nav-btns">
              <button
                className="icon-btn sm"
                title="Back"
                disabled={!canBack}
                onClick={() => goHistory(-1)}
              >
                <ArrowLeft size={14} />
              </button>
              <button
                className="icon-btn sm"
                title="Forward"
                disabled={!canForward}
                onClick={() => goHistory(1)}
              >
                <ArrowRight size={14} />
              </button>
            </div>
            <span>Files</span>
            <div className="seclabel-actions">
              <button
                className={`icon-btn sm${settings.treeDiff ? " on" : ""}`}
                title={
                  settings.treeDiff
                    ? "Hide change markers in the file tree"
                    : "Show change markers in the file tree"
                }
                onClick={() => update((s) => ({ treeDiff: !s.treeDiff }))}
              >
                <Diff size={15} />
              </button>
            </div>
          </div>
          {crumbs.length > 0 && (
            <div className="crumbs" title={root ?? ""}>
              {crumbs.map((c, i) => (
                <span key={c.path} className="crumb-wrap">
                  <button
                    className="crumb"
                    // The last crumb is the folder you're already in.
                    disabled={i === crumbs.length - 1}
                    title={`Go to ${c.path}`}
                    onClick={() => onOpenInTerminal(c.path)}
                  >
                    {c.name}
                  </button>
                  {i < crumbs.length - 1 && <span className="crumb-sep">›</span>}
                </span>
              ))}
            </div>
          )}
          <div className="tree-scroll">
            {root ? (
              <FileTree
                key={treeKey}
                rootPath={root}
                selectedPath={panes[focused] ?? null}
                onOpenFile={openInFocused}
                onEnterDir={onOpenInTerminal}
                statusByPath={statusByPath}
                changedDirs={changedDirs}
                onRowContextMenu={openMenu}
              />
            ) : (
              <div className="tree-loading">Waiting for the terminal…</div>
            )}
          </div>
        </div>

        <div className="tree-divider" onMouseDown={startTreeDrag} />

        <div className="editor-section">
          <div className="seclabel">
            <span>Editor</span>
            <div className="seclabel-actions">
              <ZoomControl
                label="Editor"
                size={settings.editorFontSize}
                onDec={() => zoomFont(update, "editor", -1)}
                onInc={() => zoomFont(update, "editor", 1)}
              />
              <button
                className={`icon-btn sm${settings.editorDiff ? " on" : ""}`}
                title={
                  settings.editorDiff
                    ? "Hide diffs in the editor (show files as they are)"
                    : "Show diffs vs the last commit in the editor"
                }
                onClick={() => update((s) => ({ editorDiff: !s.editorDiff }))}
              >
                <Diff size={15} />
              </button>
              <button
                className={`icon-btn sm${split ? " on" : ""}`}
                title={split ? "Unsplit editor" : "Split editor"}
                onClick={toggleSplit}
              >
                <LayoutColumns size={15} />
              </button>
            </div>
          </div>

          <div className="editor-area vertical">
            {panes.map((p, i) => (
              <div
                key={i}
                className={`editor-pane${split && i === focused ? " focused" : ""}`}
                onMouseDown={() => setFocused(i)}
              >
                {p ? (
                  <Suspense
                    fallback={<div className="editor-region editor-empty">Loading editor…</div>}
                  >
                    {mediaKind(p) ? (
                      <MediaViewer key={p} path={p} onFocusSurface={onFocusSurface} />
                    ) : (
                      <FileEditor
                        key={p}
                        path={p}
                        root={root}
                        line={openRequest?.path === p ? openRequest?.line : undefined}
                        onFocusSurface={onFocusSurface}
                      />
                    )}
                  </Suspense>
                ) : (
                  <div className="editor-region editor-empty">Select a file to view or edit</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={fileMenu(menu.payload)} onClose={closeMenu} />
      )}
      {prompt && (
        <PromptModal
          title={prompt.title}
          label={prompt.label}
          initialValue={prompt.initial}
          selectTo={prompt.selectTo}
          confirmLabel={prompt.confirmLabel}
          onSubmit={prompt.onSubmit}
          onCancel={() => setPrompt(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Move to Trash?"
          message={`“${confirmDelete.name}” will be moved to the Trash.`}
          confirmLabel="Move to Trash"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deletePath(confirmDelete.path).catch((err) => console.error("delete failed", err));
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}
