import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getHomeDir } from "../lib/api";

/**
 * First-run (or never-configured) prompt for the default startup folder. Shown by
 * App while `settings.defaultCwd` is undefined. Every path here results in a
 * defined `defaultCwd`, so it never re-appears. Deliberately not dismissable —
 * picking a folder (or "Use home folder") is the way out.
 */
export default function FirstRunModal({ onChoose }: { onChoose: (path: string) => void }) {
  const [path, setPath] = useState("");
  const [home, setHome] = useState<string | null>(null);

  useEffect(() => {
    getHomeDir()
      .then((h) => {
        setHome(h);
        setPath((p) => p || h); // prefill so "Set folder" is ready immediately
      })
      .catch(() => {});
  }, []);

  async function pick() {
    const chosen = await open({ directory: true, defaultPath: path || home || undefined });
    if (typeof chosen === "string") setPath(chosen);
  }

  const confirm = () => {
    const p = path.trim();
    if (p) onChoose(p);
  };

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Welcome to Beecork</span>
        </div>
        <div className="modal-body">
          <p className="confirm-msg">
            Choose the folder new terminals should open in, so you don't have to
            <code> cd </code> every time. You can change it later in Settings.
          </p>
          <div className="folder-row">
            <input
              className="setting-text"
              value={path}
              placeholder="/Users/you/projects"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              autoFocus
            />
            <button className="btn ghost" onClick={pick}>
              Choose folder…
            </button>
          </div>
        </div>
        <div className="modal-actions">
          {home && (
            <button className="btn ghost" onClick={() => onChoose(home)}>
              Use home folder
            </button>
          )}
          <button className="btn primary" onClick={confirm} disabled={!path.trim()}>
            Set folder
          </button>
        </div>
      </div>
    </div>
  );
}
