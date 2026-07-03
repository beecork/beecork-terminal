import { useState } from "react";
import { displayName, type Session } from "../lib/sessions";

interface Props {
  sessions: Session[];
  activeId: string;
  activity: Set<string>;
  pinned: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onTogglePin: () => void;
  onRename: (id: string, name: string) => void;
}

export default function SessionRail({
  sessions,
  activeId,
  activity,
  pinned,
  onSelect,
  onCreate,
  onClose,
  onTogglePin,
  onRename,
}: Props) {
  const [hover, setHover] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const expanded = pinned || hover;

  function startRename(s: Session) {
    setEditingId(s.id);
    setEditValue(displayName(s));
  }
  function commitRename() {
    if (editingId) onRename(editingId, editValue);
    setEditingId(null);
  }

  return (
    <div className={`rail-region${pinned ? " pinned" : ""}`} style={{ width: pinned ? 200 : 48 }}>
      <div
        className={`session-rail ${expanded ? "expanded" : "collapsed"}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div className="rail-header">
          {expanded && <span className="rail-hdr-label">Sessions</span>}
          <button
            className={`rail-pin${pinned ? " on" : ""}`}
            onClick={onTogglePin}
            title={pinned ? "Unpin sidebar" : "Keep sidebar open"}
          >
            📌
          </button>
          <button className="rail-add" onClick={onCreate} title="New session (⌘T)">
            +
          </button>
        </div>

        <div className="rail-list">
          {sessions.map((s, i) => {
            const name = displayName(s);
            const isActive = s.id === activeId;
            const attention = activity.has(s.id) && !isActive;
            const editing = editingId === s.id;
            return (
              <div
                key={s.id}
                className={`rail-item${isActive ? " active" : ""}${
                  attention ? " attention" : ""
                }`}
                onClick={() => onSelect(s.id)}
                onDoubleClick={() => expanded && startRename(s)}
                title={name}
              >
                {expanded ? (
                  <>
                    <span className="rail-dot" />
                    {editing ? (
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
                      <span className="rail-name">{name}</span>
                    )}
                    {!editing && (
                      <button
                        className="rail-close"
                        title="Close session"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(s.id);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </>
                ) : (
                  <span className="rail-num">{i + 1}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
