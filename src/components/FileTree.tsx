import { useEffect, useState } from "react";
import { listDir, type ChangeStatus, type Entry } from "../lib/api";
import { onFsChanged } from "../lib/events";
import { Chevron, Folder, File } from "./icons";

interface Props {
  rootPath: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  statusByPath: Map<string, ChangeStatus>;
  changedDirs: Set<string>;
}

export default function FileTree({
  rootPath,
  selectedPath,
  onOpenFile,
  statusByPath,
  changedDirs,
}: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancel = false;
    listDir(rootPath)
      .then((l) => !cancel && setEntries(l.entries))
      .catch((e) => !cancel && setError(String(e)));
    return () => {
      cancel = true;
    };
  }, [rootPath]);

  // Re-list the root when files change (agent creates/deletes files). React
  // reconciles by path key, so expanded subfolders keep their state.
  useEffect(() => {
    return onFsChanged(() => {
      listDir(rootPath)
        .then((l) => setEntries(l.entries))
        .catch(() => {});
    });
  }, [rootPath]);

  if (error) return <div className="tree-error">{error}</div>;
  if (!entries) return <div className="tree-loading">Loading…</div>;

  return (
    <div className="file-tree">
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={0}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          statusByPath={statusByPath}
          changedDirs={changedDirs}
        />
      ))}
    </div>
  );
}

interface NodeProps {
  entry: Entry;
  depth: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  statusByPath: Map<string, ChangeStatus>;
  changedDirs: Set<string>;
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  onOpenFile,
  statusByPath,
  changedDirs,
}: NodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // While expanded, re-list this directory on fs changes so agent-created /
  // deleted files appear live (expansion of surviving children is preserved).
  useEffect(() => {
    if (!open) return;
    return onFsChanged(() => {
      listDir(entry.path)
        .then((l) => setChildren(l.entries))
        .catch(() => {});
    });
  }, [open, entry.path]);

  async function activate() {
    if (!entry.is_dir) {
      onOpenFile(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      setLoading(true);
      try {
        const l = await listDir(entry.path);
        setChildren(l.entries);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  }

  const selected = selectedPath === entry.path;
  const fileStatus = entry.is_dir ? undefined : statusByPath.get(entry.path);
  const dirChanged = entry.is_dir && changedDirs.has(entry.path);
  const changed = fileStatus ? `status-${fileStatus}` : dirChanged ? "dir-changed" : "";

  return (
    <>
      <div
        className={`tree-row ${changed}${entry.is_dir ? " is-dir" : ""}${
          selected ? " selected" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={activate}
        title={entry.name}
      >
        <span className="tree-chev">
          {entry.is_dir ? <Chevron open={open} size={12} /> : null}
        </span>
        <span className="tree-ic">
          {entry.is_dir ? <Folder size={15} /> : <File size={14} />}
        </span>
        <span className="tree-name">{entry.name}</span>
        {(fileStatus || dirChanged) && <span className="tree-dot" />}
      </div>
      {entry.is_dir && open && (
        <>
          {loading && (
            <div className="tree-row tree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              …
            </div>
          )}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
              statusByPath={statusByPath}
              changedDirs={changedDirs}
            />
          ))}
        </>
      )}
    </>
  );
}
