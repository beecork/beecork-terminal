// Clipboard shortcuts the terminal has to claim itself on Windows.
//
// On macOS ⌘C/⌘V never reach the shell: xterm ignores meta chords and the
// webview's native copy/paste handles them. On Windows the same shortcuts are
// Ctrl chords, and xterm turns those into control bytes — Ctrl+C sent ^C even
// with text selected, Ctrl+V sent a literal ^V — so copy and paste simply did
// not work. This follows Windows Terminal's convention:
//
//   Ctrl+C        copy if there is a selection, otherwise ^C (interrupt) as usual
//   Ctrl+Shift+C  always copy
//   Ctrl+V        paste
//   Ctrl+Shift+V  paste
//   Ctrl+Insert / Shift+Insert   copy / paste (classic Windows console keys)

export type ClipboardKeyAction = "copy" | "paste" | null;

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

export function clipboardKeyAction(
  e: KeyLike,
  hasSelection: boolean,
  isWindows: boolean,
): ClipboardKeyAction {
  if (!isWindows || e.altKey || e.metaKey) return null;
  const k = e.key.toLowerCase();

  if (e.ctrlKey) {
    if (k === "c") return e.shiftKey || hasSelection ? "copy" : null;
    if (k === "v") return "paste";
    if (k === "insert" && !e.shiftKey) return "copy";
    return null;
  }
  if (e.shiftKey && k === "insert") return "paste";
  return null;
}
