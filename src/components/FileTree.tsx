import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { listDir, type ChangeStatus, type Entry } from "../lib/api";
import { onFsChanged } from "../lib/events";
import { useLatestWins } from "../lib/latest";
import { isDirectChild, parentDir } from "../lib/paths";
import { Chevron, Folder, File } from "./icons";

/**
 * Only a change to a DIRECT child can alter a directory's listing — an edit two
 * levels down doesn't add or remove a row here. Without this filter every
 * expanded node re-listed on every filesystem event anywhere in the project, so
 * one agent save cost an IPC round-trip per open folder. (A re-root sends an
 * empty payload, which `onFsChanged` treats as "everything changed" regardless.)
 */
const listingAffectedBy = (dir: string) => (paths: string[]) =>
  paths.some((p) => p === dir || isDirectChild(p, dir));

interface Props {
  rootPath: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  /** cd the terminal into a folder (double-click a folder, or the ".." row) */
  onEnterDir: (path: string) => void;
  statusByPath: Map<string, ChangeStatus>;
  changedDirs: Set<string>;
  onRowContextMenu?: (e: ReactMouseEvent, entry: Entry) => void;
}

/** One key for one node's one `children` slice — same reasoning as ENTRIES. */
const CHILDREN = "children";

/** One key for the one root `entries` slice — see SidePanel's `refresh`. */
const ENTRIES = "entries";

export default function FileTree({
  rootPath,
  selectedPath,
  onOpenFile,
  onEnterDir,
  statusByPath,
  changedDirs,
  onRowContextMenu,
}: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  // One guard for BOTH listing sites. `FileTree` is keyed on `treeKey`, which
  // only changes on the Refresh button — not on a root change — so the component
  // survives a `cd` and an `fs-changed` listing issued under root A can land
  // after B's and put A's rows under B. A per-effect `cancel` flag cannot order
  // two same-root refreshes against each other; this does.
  const latest = useLatestWins();

  // `quiet` = "this is a refresh, not a first load" — see the error arm.
  const relist = useCallback(
    (quiet: boolean) => {
      const ticket = latest.take();
      listDir(rootPath).then(
        (l) => {
          if (latest.accept(ENTRIES, ticket)) setEntries(l.entries);
        },
        (e) => {
          if (!latest.accept(ENTRIES, ticket)) return;
          // A watcher-driven refresh must NEVER replace a good tree with an
          // error string: `error` short-circuits the whole render below, the
          // failure is usually transient (a folder mid-rename, an agent's
          // `rm -rf` racing the read), and the tree you already have is the
          // better answer. A FIRST listing is the opposite case — that error is
          // the only thing telling you the folder is gone or unreadable.
          if (!quiet) setError(String(e));
        }
      );
    },
    [rootPath, latest]
  );

  useEffect(() => {
    relist(false);
  }, [relist]);

  // Re-list the root when files change (agent creates/deletes files). React
  // reconciles by path key, so expanded subfolders keep their state.
  useEffect(
    () => onFsChanged(() => relist(true), { match: listingAffectedBy(rootPath) }),
    [relist, rootPath]
  );

  if (error) return <div className="tree-error">{error}</div>;
  if (!entries) return <div className="tree-loading">Loading…</div>;

  // ".." goes up one level (cd ..), unless we're already at a filesystem/drive
  // root (parentDir returns the path unchanged there).
  const up = parentDir(rootPath);
  const canGoUp = up !== rootPath;

  return (
    <div className="file-tree">
      {canGoUp && (
        <div
          className="tree-row is-dir up-row"
          style={{ paddingLeft: 8 }}
          onMouseDown={(e) => {
            if (e.button === 0) e.preventDefault();
          }}
          onClick={() => onEnterDir(up)}
          title="Up one level"
        >
          <span className="tree-chev" />
          <span className="tree-ic">
            <Folder size={15} />
          </span>
          <span className="tree-name">..</span>
        </div>
      )}
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={0}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onEnterDir={onEnterDir}
          statusByPath={statusByPath}
          changedDirs={changedDirs}
          onRowContextMenu={onRowContextMenu}
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
  onEnterDir: (path: string) => void;
  statusByPath: Map<string, ChangeStatus>;
  changedDirs: Set<string>;
  onRowContextMenu?: (e: ReactMouseEvent, entry: Entry) => void;
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  onOpenFile,
  onEnterDir,
  statusByPath,
  changedDirs,
  onRowContextMenu,
}: NodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);
  // Orders this node's listings against each other: an expand and a live
  // `fs-changed` refresh write the same state and can be in flight together.
  // One key, because one node owns exactly one listing.
  const latest = useLatestWins();

  const relistChildren = useCallback(() => {
    const ticket = latest.take();
    return listDir(entry.path).then(
      (l) => {
        if (latest.accept(CHILDREN, ticket)) setChildren(l.entries);
      },
      () => {
        // A failed RE-list keeps the rows it already had — turning a transient
        // error into "this folder is empty" is a worse lie than a stale row.
        // Only a node that has never listed falls back to empty, which is what
        // retires the `…` row.
        if (latest.accept(CHILDREN, ticket)) setChildren((prev) => prev ?? []);
      }
    );
  }, [entry.path, latest]);

  // While expanded, re-list this directory on fs changes so agent-created /
  // deleted files appear live (expansion of surviving children is preserved).
  useEffect(() => {
    if (!open) return;
    return onFsChanged(relistChildren, { match: listingAffectedBy(entry.path) });
  }, [open, entry.path, relistChildren]);

  function activate() {
    if (!entry.is_dir) {
      onOpenFile(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    // Re-list on EVERY expand, not just the first. The subscription above is
    // torn down while this node is collapsed, so anything that happened in that
    // window was missed by it — and, while the cached array was kept and the
    // expand was gated on `children === null`, ignored here too. With an agent
    // editing files continuously that is the normal case, not an edge one.
    // The cached rows stay on screen meanwhile, so nothing flashes: React
    // reconciles the arriving listing by `key={c.path}` and only the difference
    // moves.
    if (next) void relistChildren();
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
        // Selecting a file / expanding a folder is navigation, not "type here" —
        // it must not pull keyboard focus out of the terminal. Preventing the
        // mousedown default keeps the terminal cursor put (the click still opens/
        // expands via onClick); focus moves to the editor only when you click INTO
        // it. Left button only, so right-click context menus are unaffected.
        onMouseDown={(e) => {
          if (e.button === 0) e.preventDefault();
        }}
        onClick={activate}
        // Double-click a folder to cd the terminal into it (single-click still
        // just expands it inline). The tree then re-roots to the entered folder,
        // so the expand toggles from the click pair are moot.
        onDoubleClick={entry.is_dir ? () => onEnterDir(entry.path) : undefined}
        onContextMenu={(e) => onRowContextMenu?.(e, entry)}
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
          {/* Open but never listed — the only state a spinner means anything in.
              A RE-expand paints the cached rows immediately and corrects them in
              place, so it must not show this. */}
          {children === null && (
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
              onEnterDir={onEnterDir}
              statusByPath={statusByPath}
              changedDirs={changedDirs}
              onRowContextMenu={onRowContextMenu}
            />
          ))}
        </>
      )}
    </>
  );
}
