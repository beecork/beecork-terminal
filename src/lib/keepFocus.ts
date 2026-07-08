import type { MouseEvent } from "react";

/**
 * Spread onto chrome / toolbar buttons that perform an action but must NOT take
 * keyboard focus (panel expand, split, zoom, rail toggle, pane header…).
 * Preventing the default mousedown keeps focus where it was — so the terminal
 * cursor stays put and only leaves when you click a real input (the editor, a
 * rename field, search). `onClick` still fires normally.
 *
 * Do NOT use this on buttons that open a modal overlay (Settings): the modal must
 * receive focus, and the terminal would otherwise keep receiving keystrokes
 * behind it. Those refocus the terminal on close via App's focus signal instead.
 */
export const noFocusSteal = {
  onMouseDown: (e: MouseEvent) => e.preventDefault(),
};
