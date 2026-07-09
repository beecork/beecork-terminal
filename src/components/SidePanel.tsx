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
import { basename, dirname, joinPath, relativePath, changedAncestors, mediaKind } from "../lib/paths";
import { usePersistedState } from "../lib/persist";
import { useDrag } from "../lib/useDrag";
import { useContextMenu } from "../lib/useContextMenu";
import { copyText } from "../lib/clipboard";
import { Folder, Refresh, LayoutRows, LayoutColumns, Chevron } from "./icons";

interface Props {
  openRequest: OpenRequest | null;
  /** The active terminal's working directory — the browser follows it. */
  root: string | null;
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

  const statusByPath = useMemo(() => {
    const m = new Map<string, ChangeStatus>();
    for (const s of statuses) m.set(s.path, s.status);
    return m;
  }, [statuses]);

  const changedDirs = useMemo(
    () => changedAncestors(statuses.map((s) => s.path), root ?? ""),
    [statuses, root]
  );

  const rootName = root ? basename(root) : "";
  const split = panes.length > 1;

  return (
    <div className="side-panel-inner">
      <div className="section-header" title={root ?? ""}>
        <div className="folder-chip">
          <span className="chip-icon">
            <Folder size={16} />
          </span>
          <span className="chip-name">{rootName || "Files"}</span>
          {statuses.length > 0 && <span className="count-pill">{statuses.length}</span>}
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
            <span>Files</span>
          </div>
          <div className="tree-scroll">
            {root ? (
              <FileTree
                key={treeKey}
                rootPath={root}
                selectedPath={panes[focused] ?? null}
                onOpenFile={openInFocused}
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
