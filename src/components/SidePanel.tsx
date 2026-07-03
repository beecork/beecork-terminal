import { useCallback, useEffect, useMemo, useState } from "react";
import { getRoot, gitStatus, type ChangeStatus, type FileStatus } from "../lib/api";
import { onFsChanged } from "../lib/events";
import FileTree from "./FileTree";
import FileEditor from "./FileEditor";

interface Props {
  openFile: string | null;
  onOpenFile: (path: string) => void;
}

export default function SidePanel({ openFile, onOpenFile }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [treeKey, setTreeKey] = useState(0);

  useEffect(() => {
    getRoot().then(setRoot).catch(() => setRoot("/"));
  }, []);

  const refresh = useCallback(() => {
    gitStatus()
      .then(setStatuses)
      .catch(() => setStatuses([]));
  }, []);

  useEffect(() => {
    refresh();
    return onFsChanged(refresh);
  }, [refresh]);

  const statusByPath = useMemo(() => {
    const m = new Map<string, ChangeStatus>();
    for (const s of statuses) m.set(s.path, s.status);
    return m;
  }, [statuses]);

  // Every ancestor directory of a changed file, so folders can be flagged.
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
  const changedCount = statuses.length;

  return (
    <div className="side-panel-inner">
      <div className="section-header" title={root ?? ""}>
        <span className="section-title">{rootName || "Files"}</span>
        {changedCount > 0 && <span className="change-badge">{changedCount}</span>}
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
          selectedPath={openFile}
          onOpenFile={onOpenFile}
          statusByPath={statusByPath}
          changedDirs={changedDirs}
        />
      )}
      {openFile ? (
        <FileEditor key={openFile} path={openFile} />
      ) : (
        <div className="editor-region editor-empty">Select a file to view or edit</div>
      )}
    </div>
  );
}
