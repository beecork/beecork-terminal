import { listen } from "@tauri-apps/api/event";

/**
 * Subscribe to the Rust file watcher's `fs-changed` event, debounced so a burst
 * of edits triggers a single refresh. Returns an unsubscribe function.
 */
export function onFsChanged(cb: () => void, debounceMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unlisten = listen("fs-changed", () => {
    clearTimeout(timer);
    timer = setTimeout(cb, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    void unlisten.then((u) => u());
  };
}
