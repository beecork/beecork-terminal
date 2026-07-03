import { useEffect } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
        </div>
        <div className="modal-body">
          <p className="confirm-msg">{message}</p>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
