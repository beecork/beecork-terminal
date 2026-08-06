import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

// Guarded localStorage — every access can throw (private mode, disabled storage),
// so centralize the try/catch instead of repeating it at each call site.

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * `useState` backed by localStorage: reads once on init (falling back on any
 * error), and writes on every change — all guarded.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T,
  serialize: (value: T) => string
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const raw = lsGet(key);
    if (raw == null) return fallback;
    try {
      return parse(raw);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    lsSet(key, serialize(value));
    // `serialize` is deliberately NOT a dependency: it's a pure formatter, and
    // callers pass it inline, so depending on it would write to storage on
    // every render.
  }, [key, value]);
  return [value, setValue];
}
