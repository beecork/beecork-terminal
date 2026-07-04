import { useState } from "react";
import { displayName, type Session } from "../lib/sessions";
import { Plus, Close, Pencil, Chevron, Gear } from "./icons";
import RenameInput from "./RenameInput";

interface Props {
  sessions: Session[];
  activeId: string;
  /** background sessions that finished / rang the bell and haven't been seen */
  wantsYou: Set<string>;
  expanded: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onToggleExpand: () => void;
  onRename: (id: string, name: string) => void;
  onOpenSettings: () => void;
}

function dotClass(isActive: boolean, isBusy: boolean, wants: boolean): string {
  if (isActive) return "rail-dot dot-active";
  if (wants) return "rail-dot dot-attention"; // the only state that blinks
  if (isBusy) return "rail-dot dot-busy"; // a program is running — steady
  return "rail-dot dot-idle";
}

export default function SessionRail({
  sessions,
  activeId,
  wantsYou,
  expanded,
  onSelect,
  onCreate,
  onClose,
  onToggleExpand,
  onRename,
  onOpenSettings,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

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
          const isBusy = !!s.running;
          const wants = wantsYou.has(s.id);
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={`rail-item${isActive ? " active" : ""}`}
              onClick={() => onSelect(s.id)}
              onDoubleClick={() => expanded && setEditingId(s.id)}
              title={expanded ? name : `${i + 1}. ${name}`}
            >
              <span className={dotClass(isActive, isBusy, wants)} />
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

        <div
          className="rail-item rail-add-item"
          onClick={onCreate}
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
    </div>
  );
}
