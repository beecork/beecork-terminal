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
    void invoke<void>("log_event", { kind, message }).catch(() => {});
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
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
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
