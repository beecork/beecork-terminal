import { useCallback, useState } from "react";
import type { MouseEvent } from "react";

export interface MenuState<T> {
  x: number;
  y: number;
  payload: T;
}

/**
 * State for a right-click menu carrying a typed payload (the thing that was
 * clicked — a session, a file entry, …). `openMenu` suppresses the native menu
 * and records the pointer position; render <ContextMenu> when `menu` is set.
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<MenuState<T> | null>(null);
  const openMenu = useCallback((e: MouseEvent, payload: T) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, payload });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  return { menu, openMenu, closeMenu };
}
