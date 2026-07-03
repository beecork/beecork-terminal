import { useEffect, useState } from "react";
import { listDir, type ChangeStatus, type Entry } from "../lib/api";

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
  const icon = entry.is_dir ? (open ? "▾" : "▸") : "";
  const fileStatus = entry.is_dir ? undefined : statusByPath.get(entry.path);
  const dirChanged = entry.is_dir && changedDirs.has(entry.path);
  const changed = fileStatus ? `status-${fileStatus}` : dirChanged ? "dir-changed" : "";

  return (
    <>
      <div
        className={`tree-row ${changed}${selected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={activate}
        title={entry.name}
      >
        <span className="tree-twisty">{icon}</span>
        <span className="tree-glyph">{entry.is_dir ? "📁" : "📄"}</span>
        <span className="tree-name">{entry.name}</span>
        {fileStatus && <span className="tree-badge">{badgeChar(fileStatus)}</span>}
        {dirChanged && <span className="tree-dot">●</span>}
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

function badgeChar(status: ChangeStatus): string {
  switch (status) {
    case "untracked":
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}
