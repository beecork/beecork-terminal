import { useRef, useState } from "react";

interface Props {
  /** value to seed the field with (captured once on mount) */
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

/**
 * A small inline rename field: autofocuses, commits on Enter or blur, cancels on
 * Escape. Shared by the title-bar and the session-rail rename so the two don't
 * hand-roll the same Enter/Escape/blur machine.
 */
export default function RenameInput({ initialValue, onCommit, onCancel, className }: Props) {
  const [value, setValue] = useState(initialValue);
  const cancelled = useRef(false);
  return (
    <input
      className={className}
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (!cancelled.current) onCommit(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") {
          cancelled.current = true;
          onCancel();
        }
      }}
    />
  );
}
