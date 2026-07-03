import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type State = "idle" | "installing" | "error";

export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    // Check on launch; silently ignore (offline, no release yet, etc.).
    check()
      .then((u) => {
        if (u) setUpdate(u);
      })
      .catch(() => {});
  }, []);

  if (!update) return null;

  async function install() {
    setState("installing");
    try {
      await update!.downloadAndInstall();
      await relaunch();
    } catch {
      setState("error");
    }
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
      <button className="ub-dismiss" onClick={() => setUpdate(null)} title="Dismiss">
        ✕
      </button>
    </div>
  );
}
