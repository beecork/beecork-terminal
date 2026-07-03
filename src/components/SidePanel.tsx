import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitStatus, type ChangeStatus, type FileStatus } from "../lib/api";
import { onFsChanged } from "../lib/events";
import type { OpenRequest } from "../App";
import FileTree from "./FileTree";
import FileEditor from "./FileEditor";
import { Folder, Refresh, LayoutRows, LayoutColumns } from "./icons";

interface Props {
  openRequest: OpenRequest | null;
  /** The active terminal's working directory — the browser follows it. */
  root: string | null;
}

type Orientation = "vertical" | "horizontal";
type PanelLayout = "stacked" | "sideBySide";

export default function SidePanel({ openRequest, root }: Props) {
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [treeKey, setTreeKey] = useState(0);

  const [panes, setPanes] = useState<(string | null)[]>([null]);
  const [focused, setFocused] = useState(0);
  const [orientation, setOrientation] = useState<Orientation>("vertical");
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(() => {
    try {
      return localStorage.getItem("beecork.panelLayout") === "sideBySide"
        ? "sideBySide"
        : "stacked";
    } catch {
      return "stacked";
    }
  });
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => {
    try {
      localStorage.setItem("beecork.panelLayout", panelLayout);
    } catch {
      /* ignore */
    }
  }, [panelLayout]);

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

  const changedDirs = useMemo(() => {
    const set = new Set<string>();
    if (!root) return set;
    for (const s of statuses) {
      let p = s.path;
      const slash = p.lastIndexOf("/");
      p = slash > 0 ? p.slice(0, slash) : p;
      while (p.length >= root.length) {
        set.add(p);
        if (p === root) break;
        const idx = p.lastIndexOf("/");
        if (idx <= 0) break;
        p = p.slice(0, idx);
      }
    }
    return set;
  }, [statuses, root]);

  const rootName = root ? root.split("/").filter(Boolean).pop() ?? root : "";
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
        </div>
      </div>

      <div className={`panel-body ${panelLayout}`}>
        <div className="tree-region">
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
              />
            ) : (
              <div className="tree-loading">Waiting for the terminal…</div>
            )}
          </div>
        </div>

        <div className="editor-section">
          <div className="seclabel">
            <span>Editor</span>
            <div className="seclabel-actions">
              {split && (
                <div className="seg" title="Split orientation">
                  <button
                    className={orientation === "vertical" ? "on" : ""}
                    title="Stacked (rows)"
                    onClick={() => setOrientation("vertical")}
                  >
                    <LayoutRows size={14} />
                  </button>
                  <button
                    className={orientation === "horizontal" ? "on" : ""}
                    title="Side by side (columns)"
                    onClick={() => setOrientation("horizontal")}
                  >
                    <LayoutColumns size={14} />
                  </button>
                </div>
              )}
              <button
                className={`icon-btn sm${split ? " on" : ""}`}
                title={split ? "Unsplit editor" : "Split editor"}
                onClick={toggleSplit}
              >
                <LayoutColumns size={15} />
              </button>
            </div>
          </div>

          <div className={`editor-area ${orientation}`}>
            {panes.map((p, i) => (
              <div
                key={i}
                className={`editor-pane${split && i === focused ? " focused" : ""}`}
                onMouseDown={() => setFocused(i)}
              >
                {p ? (
                  <FileEditor
                    key={p}
                    path={p}
                    root={root}
                    line={openRequest?.path === p ? openRequest?.line : undefined}
                  />
                ) : (
                  <div className="editor-region editor-empty">Select a file to view or edit</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
