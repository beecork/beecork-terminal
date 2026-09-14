import { listen } from "@tauri-apps/api/event";

type Sub = {
  cb: () => void;
  debounceMs: number;
  match?: (paths: string[]) => boolean;
  timer?: ReturnType<typeof setTimeout>;
};

// One shared `fs-changed` listener for the whole app, fanned out in JS — rather
// than a separate Tauri `listen()` per subscriber, which multiplied with every
// expanded tree node (dozens of native subscriptions to the same event). Each
// subscriber keeps its own debounce and, optionally, a path filter.
const subs = new Set<Sub>();
let started = false;

function ensureGlobalListener() {
  if (started) return;
  started = true;
  void listen<string[]>("fs-changed", (e) => {
    const paths = e.payload ?? [];
    // Empty payload = a re-root ("everything changed") → bypass path filters.
    const refreshAll = paths.length === 0;
    for (const s of subs) {
      if (!refreshAll && s.match && !s.match(paths)) continue;
      clearTimeout(s.timer);
      s.timer = setTimeout(s.cb, s.debounceMs);
    }
  });
}

/**
 * Subscribe to the Rust file watcher's `fs-changed` event, debounced so a burst
 * of edits triggers a single refresh. Pass `match` to fire only when a changed
 * path is relevant (e.g. an editor watching its own file). Returns an unsubscribe
 * function. The underlying Tauri listener is shared and lives for the app.
 */
export function onFsChanged(
  cb: () => void,
  opts?: { debounceMs?: number; match?: (paths: string[]) => boolean }
): () => void {
  const sub: Sub = { cb, debounceMs: opts?.debounceMs ?? 300, match: opts?.match };
  subs.add(sub);
  ensureGlobalListener();
  return () => {
    clearTimeout(sub.timer);
    subs.delete(sub);
  };
}

/** A request that arrived on the local control socket (see `control.rs`). */
export interface ControlRequest {
  kind: string;
  cwd?: string | null;
  run?: string | null;
}

/**
 * Listen for control-socket requests.
 *
 * Its own `listen`, not folded into the shared `fs-changed` fan-out above: that
 * one exists because dozens of tree nodes subscribed to the SAME event, which is
 * not this. Exactly one subscriber (App) handles control requests, and it needs
 * the payload rather than a bare "something changed".
 */
export function onControlRequest(cb: (req: ControlRequest) => void): () => void {
  const un = listen<ControlRequest>("control-request", (e) => {
    if (e.payload) cb(e.payload);
  });
  return () => void un.then((f) => f()).catch(() => {});
}
