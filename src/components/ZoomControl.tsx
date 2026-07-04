interface Props {
  /** current font size to display */
  size: number;
  onDec: () => void;
  onInc: () => void;
  /** prefix for the button tooltips, e.g. "Editor" */
  label?: string;
  /** extra class on the wrapper (e.g. "term-zoom" for the floating terminal one) */
  className?: string;
}

/** The −/size/+ font zoom widget, shared by the terminal and editor panes. */
export default function ZoomControl({ size, onDec, onInc, label, className }: Props) {
  const what = label ? `${label} ` : "";
  return (
    <div className={`zoom-ctl${className ? " " + className : ""}`}>
      <button className="zoom-btn" title={`${what}zoom out (⌘−)`} onClick={onDec}>
        −
      </button>
      <span className="zoom-size">{size}</span>
      <button className="zoom-btn" title={`${what}zoom in (⌘+)`} onClick={onInc}>
        +
      </button>
    </div>
  );
}
