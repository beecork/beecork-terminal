import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRoot, gitStatus, type ChangeStatus, type FileStatus } from "../lib/api";
import { onFsChanged } from "../lib/events";
import type { OpenRequest } from "../App";
import FileTree from "./FileTree";
import FileEditor from "./FileEditor";

interface Props {
  openRequest: OpenRequest | null;
}

type Orientation = "vertical" | "horizontal";

export default function SidePanel({ openRequest }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [treeKey, setTreeKey] = useState(0);

  const [panes, setPanes] = useState<(string | null)[]>([null]);
  const [focused, setFocused] = useState(0);
  const [orientation, setOrientation] = useState<Orientation>("vertical");
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => {
    getRoot().then(setRoot).catch(() => setRoot("/"));
  }, []);

  const refresh = useCallback(() => {
    gitStatus().then(setStatuses).catch(() => setStatuses([]));
  }, []);

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

  // Open files requested from clicked terminal paths.
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
        <span className="section-title">{rootName || "Files"}</span>
        {statuses.length > 0 && <span className="change-badge">{statuses.length}</span>}
        <button
          className="section-refresh"
          title="Refresh file tree"
          onClick={() => {
            setTreeKey((k) => k + 1);
            refresh();
          }}
        >
          ⟳
        </button>
      </div>

      {root && (
        <FileTree
          key={treeKey}
          rootPath={root}
          selectedPath={panes[focused] ?? null}
          onOpenFile={openInFocused}
          statusByPath={statusByPath}
          changedDirs={changedDirs}
        />
      )}

      <div className="editor-area-toolbar">
        <span className="ea-label">Editor</span>
        {split && (
          <button
            className="ea-btn"
            title="Split orientation"
            onClick={() =>
              setOrientation((o) => (o === "vertical" ? "horizontal" : "vertical"))
            }
          >
            {orientation === "vertical" ? "⬍" : "⬌"}
          </button>
        )}
        <button className="ea-btn" title={split ? "Unsplit" : "Split editor"} onClick={toggleSplit}>
          {split ? "▣" : "⊞"}
        </button>
      </div>

      <div className={`editor-area ${orientation}`}>
        {panes.map((p, i) => (
          <div
            key={i}
            className={`editor-pane${split && i === focused ? " focused" : ""}`}
            onMouseDown={() => setFocused(i)}
          >
            {p ? (
              <FileEditor key={p} path={p} />
            ) : (
              <div className="editor-region editor-empty">Select a file</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
