import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  label?: string;
  initialValue?: string;
  /** characters to preselect (e.g. a filename without its extension) */
  selectTo?: number;
  confirmLabel?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, selectTo ?? initialValue.length);
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
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
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onCancel();
            }}
          />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
