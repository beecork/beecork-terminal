import { useEffect, useState } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  /** May reject: the dialog then stays open and shows the message. */
  onConfirm: () => void | Promise<void>;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await onConfirm(); // resolves → the caller closes the dialog
    } catch (e) {
      // The backend's message is the useful one ("Permission denied", a trash
      // failure). Show it and stay open rather than closing on a no-op.
      setError(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  useEffect(() => {
    // Escape only. Enter is deliberately NOT handled here: this listener is on
    // `window`, so it fired regardless of what was focused — Enter confirmed even
    // with Cancel focused, destroying the very session the user was trying to
    // save, and it double-fired with the default focus (once here, once from the
    // browser activating the autoFocus'd confirm button). Native activation of
    // the focused button is the whole mechanism; let it do its job.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
        </div>
        <div className="modal-body">
          <p className="confirm-msg">{message}</p>
          {error && <p className="modal-error">{error}</p>}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            autoFocus
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
