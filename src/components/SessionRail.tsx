import { useState } from "react";
import { displayName, type Session } from "../lib/sessions";
import { Plus, Close, Pencil, Chevron } from "./icons";

interface Props {
  sessions: Session[];
  activeId: string;
  /** sessions actively producing output */
  working: Set<string>;
  /** background sessions that finished / rang the bell and haven't been seen */
  wantsYou: Set<string>;
  expanded: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onToggleExpand: () => void;
  onRename: (id: string, name: string) => void;
}

function dotClass(isActive: boolean, isWorking: boolean, wants: boolean): string {
  if (isActive) return `rail-dot dot-active${isWorking ? " working" : ""}`;
  if (isWorking) return "rail-dot dot-working working";
  if (wants) return "rail-dot dot-attention";
  return "rail-dot dot-idle";
}

export default function SessionRail({
  sessions,
  activeId,
  working,
  wantsYou,
  expanded,
  onSelect,
  onCreate,
  onClose,
  onToggleExpand,
  onRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  function startRename(s: Session) {
    setEditingId(s.id);
    setEditValue(displayName(s));
  }
  function commitRename() {
    if (editingId) onRename(editingId, editValue);
    setEditingId(null);
  }

  return (
    <div className={`session-rail ${expanded ? "expanded" : "collapsed"}`}>
      <div className="rail-top">
        <button
          className="icon-btn sm"
          onClick={onToggleExpand}
          title={expanded ? "Collapse" : "Expand"}
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
          const isWorking = working.has(s.id);
          const wants = wantsYou.has(s.id);
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={`rail-item${isActive ? " active" : ""}`}
              onClick={() => onSelect(s.id)}
              onDoubleClick={() => expanded && startRename(s)}
              title={expanded ? name : `${i + 1}. ${name}`}
            >
              <span className={dotClass(isActive, isWorking, wants)} />
              {expanded ? (
                editing ? (
                  <input
                    className="rail-rename"
                    autoFocus
                    value={editValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <>
                    <span className="rail-name">{name}</span>
                    <button
                      className="rail-close"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(s);
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
                <>
                  <span className="rail-num">{i + 1}</span>
                  <button
                    className="rail-close rail-close-mini"
                    title="Close session"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(s.id);
                    }}
                  >
                    <Close size={12} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="rail-bottom">
        <button className="rail-new" onClick={onCreate} title="New session (⌘T)">
          <Plus size={16} />
          {expanded && <span>New session</span>}
        </button>
      </div>
    </div>
  );
}
