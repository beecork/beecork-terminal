import { open } from "@tauri-apps/plugin-dialog";
import {
  useSettings,
  MIN_FONT,
  MAX_FONT,
  MIN_SCROLL_SPEED,
  MAX_SCROLL_SPEED,
} from "../lib/settings";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, themes, update } = useSettings();

  async function pickFolder() {
    const chosen = await open({ directory: true, defaultPath: settings.defaultCwd });
    if (typeof chosen === "string") update({ defaultCwd: chosen });
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
        </div>
      </div>
    </div>
  );
}
