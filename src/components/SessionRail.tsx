import { useState } from "react";
import { displayName, type Session } from "../lib/sessions";
import { Plus, Close, Pencil, Chevron, Gear } from "./icons";
import { noFocusSteal } from "../lib/keepFocus";
import { useContextMenu } from "../lib/useContextMenu";
import { copyText } from "../lib/clipboard";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import RenameInput from "./RenameInput";

interface Props {
  sessions: Session[];
  activeId: string;
  /** background sessions that finished / rang the bell and haven't been seen */
  wantsYou: Set<string>;
  /** sessions producing output right now (busy) */
  busy: Set<string>;
  expanded: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onToggleExpand: () => void;
  onRename: (id: string, name: string) => void;
  onOpenSettings: () => void;
  /** new session started in a specific folder (right-click → "New session here") */
  onCreateIn: (cwd?: string) => void;
  /** pair this session with the active one in split view */
  onSplitWith: (id: string) => void;
  /** dissolve this session's split pair */
  onUnsplit: (id: string) => void;
  /** close every session except this one */
  onCloseOthers: (id: string) => void;
  /** drag-to-reorder: move a session to just before `beforeId` (null = to the end) */
  onReorder: (id: string, beforeId: string | null) => void;
}

// The dot tells the truth about the session's state on EVERY row — which one is
// active is shown by the row highlight, not the dot, so you can see that the
// session you're on is busy too.
function dotClass(isBusy: boolean, wants: boolean): string {
  if (wants) return "rail-dot dot-attention"; // finished / waiting — blinks amber
  if (isBusy) return "rail-dot dot-busy"; // a command is running — steady blue
  return "rail-dot dot-idle"; // at the prompt — grey
}

export default function SessionRail({
  sessions,
  activeId,
  wantsYou,
  busy,
  expanded,
  onSelect,
  onCreate,
  onClose,
  onToggleExpand,
  onRename,
  onOpenSettings,
  onCreateIn,
  onSplitWith,
  onUnsplit,
  onCloseOthers,
  onReorder,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Drag-to-reorder state: which row is being dragged, and where it would drop
  // (a session id to insert before, or "end" for after the last one).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | "end" | null>(null);
  const { menu, openMenu, closeMenu } = useContextMenu<Session>();

  function endDrag() {
    setDragId(null);
    setDropBefore(null);
  }

  function sessionMenu(s: Session): MenuEntry[] {
    const isActive = s.id === activeId;
    const items: MenuEntry[] = [
      { label: "New session here", onSelect: () => onCreateIn(s.cwd) },
      {
        label: "Rename",
        onSelect: () => {
          if (!expanded) onToggleExpand();
          setEditingId(s.id);
        },
      },
      s.partner
        ? { label: "Unsplit", onSelect: () => onUnsplit(s.id) }
        : {
            label: isActive ? "Split view" : "Split with active",
            onSelect: () => onSplitWith(s.id),
          },
      { label: "Copy folder path", disabled: !s.cwd, onSelect: () => s.cwd && copyText(s.cwd) },
      "separator",
      { label: "Close session", danger: true, onSelect: () => onClose(s.id) },
    ];
    if (sessions.length > 1) {
      items.push({ label: "Close others", danger: true, onSelect: () => onCloseOthers(s.id) });
    }
    return items;
  }

  return (
    <div className={`session-rail ${expanded ? "expanded" : "collapsed"}`}>
      <div className="rail-top">
        <button
          className="icon-btn sm"
          onClick={onToggleExpand}
          title={expanded ? "Collapse" : "Expand"}
          {...noFocusSteal}
        >
          <span className={`rail-expand-icon${expanded ? " open" : ""}`}>
            <Chevron size={16} />
          </span>
        </button>
        {expanded && <span className="rail-top-label">Sessions</span>}
      </div>

      <div className="rail-list">
        {sessions.map((s, i) => {
          const name = displayName(s);
          const isActive = s.id === activeId;
          const isBusy = busy.has(s.id);
          const wants = wantsYou.has(s.id);
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={`rail-item${isActive ? " active" : ""}${wants ? " needs-you" : ""}${
                dragId === s.id ? " dragging" : ""
              }${dropBefore === s.id ? " drop-before" : ""}`}
              // Drag to reorder (works collapsed or expanded); disabled while
              // renaming so text selection in the input still works.
              draggable={!editing}
              onDragStart={(e) => {
                setDragId(s.id);
                e.dataTransfer.effectAllowed = "move";
                try {
                  e.dataTransfer.setData("text/plain", s.id);
                } catch {
                  /* some platforms disallow setData; drag still works via state */
                }
              }}
              onDragOver={(e) => {
                if (dragId === null || dragId === s.id) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > r.top + r.height / 2;
                setDropBefore(after ? sessions[i + 1]?.id ?? "end" : s.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dropBefore !== null) {
                  onReorder(dragId, dropBefore === "end" ? null : dropBefore);
                }
                endDrag();
              }}
              onDragEnd={endDrag}
              onClick={() => onSelect(s.id)}
              onDoubleClick={() => expanded && setEditingId(s.id)}
              onContextMenu={(e) => openMenu(e, s)}
              title={expanded ? name : `${i + 1}. ${name}`}
            >
              <span className={dotClass(isBusy, wants)} />
              {expanded ? (
                editing ? (
                  <RenameInput
                    className="rail-rename"
                    initialValue={name}
                    onCommit={(v) => {
                      onRename(s.id, v);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <span className="rail-name">{name}</span>
                    <button
                      className="rail-close"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(s.id);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="rail-close"
                      title="Close session"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(s.id);
                      }}
                    >
                      <Close size={14} />
                    </button>
                  </>
                )
              ) : (
                // Collapsed = pure navigation. No close × here (too easy to
                // mis-hit); close from the expanded rail or the terminal window.
                <span className="rail-num">{i + 1}</span>
              )}
            </div>
          );
        })}

        <div
          className={`rail-item rail-add-item${dropBefore === "end" ? " drop-before" : ""}`}
          onClick={onCreate}
          onDragOver={(e) => {
            if (dragId === null) return;
            e.preventDefault();
            setDropBefore("end");
          }}
          onDrop={(e) => {
            if (dragId === null) return;
            e.preventDefault();
            onReorder(dragId, null);
            endDrag();
          }}
          title="New session (⌘T)"
        >
          <span className="rail-add-plus">
            <Plus size={16} />
          </span>
          {expanded && <span className="rail-name">New session</span>}
        </div>
      </div>

      <div className="rail-footer">
        <button className="rail-gear" onClick={onOpenSettings} title="Settings">
          <span className="rail-gear-ic">
            <Gear size={16} />
          </span>
          {expanded && <span className="rail-name">Settings</span>}
        </button>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={sessionMenu(menu.payload)} onClose={closeMenu} />
      )}
    </div>
  );
}
