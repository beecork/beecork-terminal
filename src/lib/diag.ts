// The webview's half of the crash & error log (`src-tauri/src/diag.rs`).
//
// An installed copy has no devtools and no console, so an error the UI doesn't
// catch is simply gone — the user sees a dead button or a blank panel and can
// only tell us "it broke". Everything here writes to the local log file the
// backend keeps; nothing leaves the machine.
import { invoke } from "@tauri-apps/api/core";

export interface DiagInfo {
  version: string;
  os: string;
  arch: string;
  /** null when the backend could not create a log directory */
  log_path: string | null;
}

/** Version, platform and log location — what Settings shows under Diagnostics. */
export const diagInfo = () => invoke<DiagInfo>("diag_info");

/** Append one entry to the log. Fire-and-forget by contract: this is called from
 *  error paths (a global error handler, `componentDidCatch`), so it must never
 *  throw or reject back into them — outside Tauri (tests, a plain browser) the
 *  invoke itself throws, and that is swallowed too. */
export function logEvent(kind: string, message: string): void {
  try {
    // `message` is TYPED string, but every caller is an error path where the
    // value can be anything — `describeError` used to return the VALUE
    // `undefined` while declaring `string` (see below). A non-string is dropped
    // in serialization, the Rust command then fails to deserialize, the promise
    // rejects, and `.catch` swallows it: the entry vanishes silently, which is
    // the one thing this file must never do. One coercion closes that for good.
    const body = typeof message === "string" ? message : String(message);
    void invoke<void>("log_event", { kind, message: body }).catch(() => {});
  } catch {
    /* not inside Tauri — nowhere to write */
  }
}

/** Render an error-ish value with its stack when it has one. */
export function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`;
  }
  if (typeof reason === "string") return reason;
  try {
    // `JSON.stringify` is DECLARED `string` but returns the value `undefined`
    // for `undefined`, a function, or a lone symbol — TypeScript cannot catch
    // it, and the `try/catch` only covers the throwing cases (circular, BigInt).
    // `Promise.reject()` with no argument and `throw undefined` both land here,
    // and used to be recorded nowhere at all.
    const json = JSON.stringify(reason);
    if (typeof json === "string") return json;
  } catch {
    /* circular, BigInt, a throwing toJSON — fall through */
  }
  return String(reason);
}

/** Record that the UI actually reached the screen.
 *
 *  `[ready]` in the log means Tauri created the window and webview — NOT that
 *  anything was drawn. A Fedora 44 user's white window logged `[ready]` and then
 *  the WebKit web process aborted in its own EGL init, so the log looked like a
 *  clean start while the user stared at nothing (see CLAUDE.md "Linux"). The
 *  whole point of the log is to tell those apart, so the frontend says when it
 *  has painted: `[ready]` with NO `[painted]` after it is the white-window
 *  signature, and it is one grep for anyone reading a user's file.
 *
 *  Two frames, not one: the first fires before the browser has composited the
 *  work React queued, the second only after a real paint has gone out. If the
 *  web process dies, or the renderer never composites, neither fires and nothing
 *  is logged — which is exactly the signal we want. Reports the viewport too, so
 *  a window that came up 0×0 is visible in the log as well. */
export function logPainted(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      // Two extra fields, both chosen because they FALSIFY a `[painted]` that
      // did not mean what it says — not because they were free to add.
      //   root=0 children  → React never mounted, so a frame was composited over
      //                      an empty page; self-evidently not a real paint.
      //   visibility=hidden → the window was occluded or minimised at launch.
      //                      rAF callbacks queue rather than drop, so this line
      //                      can arrive minutes after `[ready]`; without the
      //                      field that gap reads as a second anomaly.
      const root = document.getElementById("root");
      const kids = root ? root.childElementCount : -1;
      logEvent(
        "painted",
        `UI painted at ${window.innerWidth}×${window.innerHeight}` +
          ` root=${kids} children visibility=${document.visibilityState}`
      );
    })
  );
}

/** Route the two failures a webview has no other outlet for into the log: an
 *  uncaught exception and an unhandled promise rejection. Neither reaches
 *  `ErrorBoundary` (which sees only render/lifecycle throws), and an event
 *  handler or a forgotten `.catch` on an invoke is exactly where a "the button
 *  does nothing" bug lives. Install once, before the first render. */
export function installGlobalErrorLog(): void {
  window.addEventListener("error", (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    const stack = e.error instanceof Error ? `\n${e.error.stack ?? ""}` : "";
    logEvent("js-error", `${e.message}${where}${stack}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logEvent("js-rejection", describeError(e.reason));
  });
}
