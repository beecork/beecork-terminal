import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type State = "idle" | "installing" | "error";

// Re-check for updates this often while the app stays open (in addition to the
// check on launch), so a long-running window notices a new release without a
// restart. Tune here.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<State>("idle");
  // Persist across the polling closure: the version the user dismissed (so we
  // don't re-nag for it), and whether an install is in flight (so a poll can't
  // clobber the banner mid-install).
  const dismissedRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (cancelled || busyRef.current) return;
      try {
        const u = await check();
        if (cancelled || busyRef.current) return;
        // Show an update only if the user hasn't already dismissed that version.
        setUpdate(u && u.version !== dismissedRef.current ? u : null);
      } catch {
        // Offline, no release yet, endpoint unreachable — ignore silently.
      }
    }
    poll(); // on launch
    const id = setInterval(poll, CHECK_INTERVAL_MS); // then periodically
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!update) return null;

  async function install() {
    setState("installing");
    busyRef.current = true;
    try {
      await update!.downloadAndInstall();
      await relaunch();
    } catch {
      setState("error");
      busyRef.current = false;
    }
  }

  function dismiss() {
    // Remember the dismissed version so the periodic re-check won't resurface it
    // (a newer version later still shows).
    dismissedRef.current = update?.version ?? null;
    setUpdate(null);
  }

  return (
    <div className="update-banner">
      <span className="ub-text">
        {state === "error"
          ? "Update failed — try again later."
          : `Beecork Terminal ${update.version} is available.`}
      </span>
      {state !== "error" && (
        <button className="ub-install" onClick={install} disabled={state === "installing"}>
          {state === "installing" ? "Installing…" : "Install & Restart"}
        </button>
      )}
      <button className="ub-dismiss" onClick={dismiss} title="Dismiss">
        ✕
      </button>
    </div>
  );
}
