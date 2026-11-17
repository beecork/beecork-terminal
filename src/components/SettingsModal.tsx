import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealPath, openUrl, shellInfo, type ShellInfo } from "../lib/api";
import { diagInfo, type DiagInfo } from "../lib/diag";
import {
  useSettings,
  MIN_FONT,
  MAX_FONT,
  MIN_SCROLL_SPEED,
  MAX_SCROLL_SPEED,
} from "../lib/settings";
import * as sound from "../lib/sound";

/** Microsoft's install page for PowerShell 7 on Windows. */
const PWSH_INSTALL_URL =
  "https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, themes, update } = useSettings();
  const [diag, setDiag] = useState<DiagInfo | null>(null);
  // Asked of Rust rather than guessed from the user agent: only Rust knows what
  // is installed. Null until it answers (or off-Tauri), which hides the section.
  const [shell, setShell] = useState<ShellInfo | null>(null);
  useEffect(() => {
    diagInfo().then(setDiag).catch(() => {});
    shellInfo().then(setShell).catch(() => {});
  }, []);

  async function pickFolder() {
    // An empty or unparseable defaultPath (a cleared field, a path typed on
    // another OS) must not stop the picker opening — fall back to none.
    const start = settings.defaultCwd?.trim() || undefined;
    try {
      const chosen = await open({ directory: true, defaultPath: start });
      if (typeof chosen === "string") update({ defaultCwd: chosen });
    } catch {
      try {
        const chosen = await open({ directory: true });
        if (typeof chosen === "string") update({ defaultCwd: chosen });
      } catch {
        /* no picker available — the text field still works */
      }
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Settings</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <label className="setting-row">
            <span className="setting-label">Default folder — where new terminals open</span>
            <div className="folder-row">
              <input
                type="text"
                className="setting-text"
                value={settings.defaultCwd ?? ""}
                placeholder="/Users/you/projects"
                onChange={(e) => update({ defaultCwd: e.target.value })}
              />
              <button className="btn ghost" onClick={pickFolder}>
                Choose folder…
              </button>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">Theme</span>
            <div className="theme-grid">
              {themes.map((t) => (
                <button
                  key={t.id}
                  className={`theme-swatch${settings.themeId === t.id ? " active" : ""}`}
                  onClick={() => update({ themeId: t.id })}
                  title={t.name}
                >
                  <span
                    className="swatch-preview"
                    style={{
                      background: t.terminal.background,
                      color: t.terminal.foreground,
                      borderColor: t.ui.border,
                    }}
                  >
                    Aa
                  </span>
                  <span className="swatch-name">{t.name}</span>
                </button>
              ))}
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">
              Terminal font size — {settings.terminalFontSize}px
            </span>
            <input
              type="range"
              min={MIN_FONT}
              max={MAX_FONT}
              value={settings.terminalFontSize}
              onChange={(e) => update({ terminalFontSize: Number(e.target.value) })}
            />
          </label>

          <label className="setting-row">
            <span className="setting-label">
              Editor font size — {settings.editorFontSize}px
            </span>
            <input
              type="range"
              min={MIN_FONT}
              max={MAX_FONT}
              value={settings.editorFontSize}
              onChange={(e) => update({ editorFontSize: Number(e.target.value) })}
            />
          </label>

          <label className="setting-row">
            <span className="setting-label">Font family</span>
            <input
              type="text"
              className="setting-text"
              value={settings.fontFamily}
              onChange={(e) => update({ fontFamily: e.target.value })}
            />
          </label>

          <label className="setting-row">
            <span className="setting-label">Scroll speed — {settings.scrollSpeed}×</span>
            <input
              type="range"
              min={MIN_SCROLL_SPEED}
              max={MAX_SCROLL_SPEED}
              value={settings.scrollSpeed}
              onChange={(e) => update({ scrollSpeed: Number(e.target.value) })}
            />
          </label>

          <label className="setting-row setting-row-inline">
            <span className="setting-label">Smooth scrolling</span>
            <input
              type="checkbox"
              className="setting-check"
              checked={settings.smoothScroll}
              onChange={(e) => update({ smoothScroll: e.target.checked })}
            />
          </label>

          {shell?.windows && (
            <>
              <div className="setting-section">Shell</div>

              <div className="setting-row">
                <span className="setting-label">
                  What new terminals open with — choose one. Terminals already open keep
                  theirs.
                </span>
                <div className="folder-row">
                  <button
                    className={`btn ${settings.windowsShell === "powershell" ? "primary" : "ghost"}`}
                    aria-pressed={settings.windowsShell === "powershell"}
                    onClick={() => update({ windowsShell: "powershell" })}
                  >
                    PowerShell
                  </button>
                  <button
                    className={`btn ${settings.windowsShell === "cmd" ? "primary" : "ghost"}`}
                    aria-pressed={settings.windowsShell === "cmd"}
                    onClick={() => update({ windowsShell: "cmd" })}
                  >
                    Command Prompt
                  </button>
                </div>
              </div>

              {/* Shown when PowerShell 7 is not what runs — and then for BOTH choices,
                  dimmed for Command Prompt the way the Sound rows dim. Nothing in
                  this section may come and go with the choice itself: a line that
                  did ("Using PowerShell 7.") made the whole window change height on
                  every click of the two buttons. */}
              {!shell.pwsh && (
                <div
                  className={`setting-row setting-row-inline${
                    settings.windowsShell === "powershell" ? "" : " setting-disabled"
                  }`}
                >
                  <span className="setting-label">
                    PowerShell here is {shell.default_name}, the older one that comes with
                    Windows. PowerShell 7 is the current version: once it is installed,
                    Beecork uses it automatically (restart Beecork after installing).
                  </span>
                  <button
                    className="btn ghost"
                    title="Open Microsoft's PowerShell 7 install page"
                    onClick={() => void openUrl(PWSH_INSTALL_URL).catch(() => {})}
                  >
                    Get PowerShell 7…
                  </button>
                </div>
              )}
            </>
          )}

          <div className="setting-section">Sound</div>

          <label className="setting-row setting-row-inline">
            <span className="setting-label">
              Sounds — a soft chime when an agent needs you, and gentle UI clicks
            </span>
            <input
              type="checkbox"
              className="setting-check"
              checked={settings.sound}
              onChange={(e) => {
                update({ sound: e.target.checked });
                if (e.target.checked) sound.preview(settings.soundVolume);
              }}
            />
          </label>

          <label className={`setting-row${settings.sound ? "" : " setting-disabled"}`}>
            <span className="setting-label">
              Sound volume — {Math.round(settings.soundVolume * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={100}
              disabled={!settings.sound}
              value={Math.round(settings.soundVolume * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                update({ soundVolume: v });
                sound.preview(v);
              }}
            />
          </label>

          <label className={`setting-row setting-row-inline${settings.sound ? "" : " setting-disabled"}`}>
            <span className="setting-label">Interface sounds — sessions, splits, panels, switching</span>
            <input
              type="checkbox"
              className="setting-check"
              disabled={!settings.sound}
              checked={settings.uiSounds}
              onChange={(e) => update({ uiSounds: e.target.checked })}
            />
          </label>

          <label className={`setting-row setting-row-inline${settings.sound ? "" : " setting-disabled"}`}>
            <span className="setting-label">Soft tone when sending a line (Enter)</span>
            <input
              type="checkbox"
              className="setting-check"
              disabled={!settings.sound}
              checked={settings.keyClicks}
              onChange={(e) => update({ keyClicks: e.target.checked })}
            />
          </label>

          <div className="setting-row setting-row-inline">
            <span className="setting-label">Play a test chime through the native audio engine</span>
            <button
              className="btn ghost"
              title="Play the chime"
              onClick={() => sound.preview(settings.soundVolume)}
            >
              Test sound
            </button>
          </div>

          <div className="setting-section">Split view</div>

          <label className="setting-row setting-row-inline">
            <span className="setting-label">
              Keep the file panel open when splitting — otherwise it folds, to give both
              terminals the room
            </span>
            <input
              type="checkbox"
              className="setting-check"
              checked={settings.splitKeepsPanel}
              onChange={(e) => update({ splitKeepsPanel: e.target.checked })}
            />
          </label>

          <div className="setting-section">Diagnostics</div>

          <div className="setting-row">
            <span className="setting-label">
              {diag
                ? `Beecork Terminal ${diag.version} · ${diag.os} ${diag.arch}`
                : "Beecork Terminal"}
            </span>
            <span className="setting-label">
              Crashes and errors are written to this local file — nothing is sent
              anywhere. If something goes wrong, send us the file.
            </span>
            <div className="folder-row">
              <input
                type="text"
                className="setting-text"
                readOnly
                value={diag?.log_path ?? "(no log file — the log folder could not be created)"}
                onFocus={(e) => e.target.select()}
              />
              <button
                className="btn ghost"
                disabled={!diag?.log_path}
                title="Reveal the log file in the file manager"
                onClick={() => {
                  if (diag?.log_path) void revealPath(diag.log_path).catch(() => {});
                }}
              >
                Show log file
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
