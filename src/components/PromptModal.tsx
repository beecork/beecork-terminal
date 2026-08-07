import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  label?: string;
  initialValue?: string;
  /** characters to preselect (e.g. a filename without its extension) */
  selectTo?: number;
  confirmLabel?: string;
  placeholder?: string;
  /** May reject: the dialog then stays open and shows the message. */
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

/** A one-field prompt (new file/folder name, rename). Enter submits, Esc cancels. */
export default function PromptModal({
  title,
  label,
  initialValue = "",
  selectTo,
  confirmLabel = "OK",
  placeholder,
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, selectTo ?? initialValue.length);
    // Mount only: this seeds the field, so re-running on a prop change would
    // yank the caret back while the user is typing.
  }, []);

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setError("");
    setBusy(true);
    try {
      await onSubmit(v); // resolves → the caller closes the dialog
    } catch (e) {
      // Show the backend's own message ("“x.ts” already exists", "Permission
      // denied") and stay open so the name can be corrected. setBusy(false) only
      // on this path — the success path unmounts, so it must not set state.
      setError(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
        </div>
        <div className="modal-body">
          {label && <span className="setting-label">{label}</span>}
          <input
            ref={inputRef}
            className="setting-text"
            value={value}
            placeholder={placeholder}
            disabled={busy}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              else if (e.key === "Escape") onCancel();
            }}
          />
          {error && <p className="modal-error">{error}</p>}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={!value.trim() || busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
