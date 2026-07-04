import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export interface Theme {
  id: string;
  name: string;
  editor: "dark" | "light";
  /** CSS custom properties applied to :root */
  ui: Record<string, string>;
  terminal: TerminalTheme;
}

export const THEMES: Theme[] = [
  {
    id: "mocha",
    name: "Mocha (purple)",
    editor: "dark",
    ui: {
      bg: "#1e1e2e",
      panel: "#181825",
      "panel-header": "#11111b",
      fg: "#cdd6f4",
      muted: "#9399b2",
      border: "#313244",
      hover: "#313244",
      selected: "#45475a",
      accent: "#cba6f7",
    },
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
    },
  },
  {
    id: "ocean",
    name: "Ocean (blue)",
    editor: "dark",
    ui: {
      bg: "#08182e",
      panel: "#0a2140",
      "panel-header": "#061224",
      fg: "#d6e6ff",
      muted: "#7fa8cc",
      border: "#1c3f66",
      hover: "#0f2d4d",
      selected: "#1c4a72",
      accent: "#4cc2ff",
    },
    terminal: {
      background: "#08182e",
      foreground: "#d6e6ff",
      cursor: "#4cc2ff",
      selectionBackground: "#1c4a72",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox (warm)",
    editor: "dark",
    ui: {
      bg: "#282828",
      panel: "#1d2021",
      "panel-header": "#161616",
      fg: "#ebdbb2",
      muted: "#a89984",
      border: "#3c3836",
      hover: "#32302f",
      selected: "#504945",
      accent: "#fe8019",
    },
    terminal: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#fe8019",
      selectionBackground: "#504945",
    },
  },
  {
    id: "graphite",
    name: "Graphite (grey)",
    editor: "dark",
    ui: {
      bg: "#1a1a1a",
      panel: "#141414",
      "panel-header": "#0e0e0e",
      fg: "#e4e4e4",
      muted: "#8a8a8a",
      border: "#333333",
      hover: "#262626",
      selected: "#3a3a3a",
      accent: "#c0c0c0",
    },
    terminal: {
      background: "#1a1a1a",
      foreground: "#e4e4e4",
      cursor: "#e4e4e4",
      selectionBackground: "#404040",
    },
  },
  {
    id: "light",
    name: "Light",
    editor: "light",
    ui: {
      bg: "#ffffff",
      panel: "#f3f3f3",
      "panel-header": "#eaeaea",
      fg: "#1f2328",
      muted: "#6a737d",
      border: "#d0d7de",
      hover: "#eef1f4",
      selected: "#dbe6f5",
      accent: "#0969da",
    },
    terminal: {
      background: "#ffffff",
      foreground: "#1f2328",
      cursor: "#1f2328",
      selectionBackground: "#b6dbff",
    },
  },
];

export interface Settings {
  themeId: string;
  /** terminal (xterm) font size — zoomable independently */
  terminalFontSize: number;
  /** editor (CodeMirror) font size — zoomable independently */
  editorFontSize: number;
  fontFamily: string;
}

export const MIN_FONT = 9;
export const MAX_FONT = 28;
/** Default font size for both surfaces (⌘0 reset uses this — single source of truth). */
export const DEFAULT_FONT_SIZE = 13;

const DEFAULTS: Settings = {
  themeId: "mocha",
  terminalFontSize: DEFAULT_FONT_SIZE,
  editorFontSize: DEFAULT_FONT_SIZE,
  fontFamily: 'Menlo, "SF Mono", Monaco, "Cascadia Code", monospace',
};

const STORAGE_KEY = "beecork.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate the old single `fontSize` into both surfaces.
      if (typeof parsed.fontSize === "number") {
        if (parsed.terminalFontSize == null) parsed.terminalFontSize = parsed.fontSize;
        if (parsed.editorFontSize == null) parsed.editorFontSize = parsed.fontSize;
        delete parsed.fontSize;
      }
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

export const clampFont = (n: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, n));

type Patch = Partial<Settings> | ((s: Settings) => Partial<Settings>);

interface Ctx {
  settings: Settings;
  theme: Theme;
  themes: Theme[];
  update: (patch: Patch) => void;
}

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);

  const theme = useMemo(
    () => THEMES.find((t) => t.id === settings.themeId) ?? THEMES[0],
    [settings.themeId]
  );

  // Apply UI variables + persist whenever settings change.
  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(theme.ui)) {
      root.style.setProperty(`--${k}`, v);
    }
    root.style.setProperty("--font-mono", settings.fontFamily);
    root.style.setProperty("--editor-font-size", `${settings.editorFontSize}px`);
    // Exact terminal background, so the container behind the xterm canvas blends
    // seamlessly during a resize (no seam/flash when the panel opens or closes).
    root.style.setProperty("--term-bg", theme.terminal.background);
    root.setAttribute("data-theme", theme.editor);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [theme, settings]);

  // Stable identity — it only uses the functional setState updater, so effects
  // that depend on `update` don't re-subscribe on every settings/theme change.
  const update = useCallback(
    (patch: Patch) =>
      setSettings((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) })),
    []
  );

  const value = useMemo<Ctx>(
    () => ({ settings, theme, themes: THEMES, update }),
    [settings, theme, update]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
