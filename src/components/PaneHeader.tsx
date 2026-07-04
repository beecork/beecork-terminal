import { useEffect, useRef, useState } from "react";
import { displayName, type Session } from "../lib/sessions";
import { Chevron, Close } from "./icons";

interface Props {
  sessions: Session[];
  /** the session shown in THIS pane */
  currentId: string;
  /** the session in the OTHER pane (tagged in the menu; picking it swaps) */
  otherId: string | null;
  focused: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** The small header on a split pane: shows its session, click to pick another. */
export default function PaneHeader({
  sessions,
  currentId,
  otherId,
  focused,
  onPick,
  onClose,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = sessions.find((s) => s.id === currentId);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className={`pane-header${focused ? " focused" : ""}`} ref={ref}>
      <button
        className="pane-picker"
        onClick={() => setOpen((o) => !o)}
        title="Choose the session for this pane"
      >
        <span className="pane-name">{current ? displayName(current) : "—"}</span>
        <Chevron size={12} open={open} />
      </button>
      <button className="pane-close" title="Close session" onClick={onClose}>
        <Close size={13} />
      </button>
      {open && (
        <div className="pane-menu">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`pane-menu-item${s.id === currentId ? " current" : ""}`}
              onClick={() => {
                onPick(s.id);
                setOpen(false);
              }}
            >
              <span className="pane-menu-name">{displayName(s)}</span>
              {s.id === otherId && <span className="pane-menu-tag">other pane</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
