import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function svg(size: number | undefined, extra: Partial<SVGProps<SVGSVGElement>>) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...extra,
  };
}

export function Split({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

export function Gear({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function Refresh({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <path d="M4 12a8 8 0 0 1 14-5.3L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-14 5.3L4 16" />
      <path d="M4 20v-4h4" />
    </svg>
  );
}

export function Plus({ size, ...p }: P) {
  return (
    <svg {...svg(size, { ...p, strokeWidth: 1.8 })}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function Close({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function Pencil({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function Chevron({ open, size, ...p }: P & { open?: boolean }) {
  return (
    <svg {...svg(size, { ...p, strokeWidth: 2 })}>
      {open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

export function Folder({ size, ...p }: P) {
  return (
    <svg {...svg(size, { ...p, strokeWidth: 1.5 })}>
      <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function File({ size, ...p }: P) {
  return (
    <svg {...svg(size, { ...p, strokeWidth: 1.5 })}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/** plus over minus — git diff / change markers */
export function Diff({ size, ...p }: P) {
  return (
    <svg {...svg(size, { ...p, strokeWidth: 1.8 })}>
      <path d="M12 3.5v7M8.5 7h7" />
      <path d="M8.5 18h7" />
    </svg>
  );
}

/** square split by a horizontal line — stacked / rows */
export function LayoutRows({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 12h16" />
    </svg>
  );
}

/** square split by a vertical line — side-by-side / columns / editor split */
export function LayoutColumns({ size, ...p }: P) {
  return (
    <svg {...svg(size, p)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}
