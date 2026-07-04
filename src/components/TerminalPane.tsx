import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getRoot } from "../lib/api";
import { useSettings, zoomFont, type Surface } from "../lib/settings";
import { decodeBase64, PATH_RE, looksLikePath, splitFileLine, parseOsc7 } from "../lib/paths";
import { resumeCommand } from "../lib/sessions";
import ZoomControl from "./ZoomControl";
import { Close } from "./icons";
import "@xterm/xterm/css/xterm.css";

type PtyEvent =
  | { event: "output"; data: string }
  | { event: "exit"; data: number };

interface Props {
  sessionId: string;
  /** on screen right now (single view = the active session; split = either pane) */
  visible: boolean;
  /** the focused pane — gets keyboard focus, status hints, and ⌘F search */
  active: boolean;
  /** directory the shell should start in (new sessions inherit the active cwd) */
  startCwd?: string;
  onOpenPath: (path: string, line?: number) => void;
  /** terminal bell rang */
  onBell: (id: string) => void;
  onSeen: (id: string) => void;
  onTitle: (id: string, title: string) => void;
  /** shell pushed its cwd via OSC 7 (instant) */
  onCwd: (id: string, path: string) => void;
  /** output settled — re-check cwd + running command */
  onStatusHint: (id: string) => void;
  /** the shell produced output — drives the busy dot (works for TUI agents) */
  onActivity: (id: string) => void;
  onFocusSurface: (s: Surface) => void;
  /** if set, show a close-session ✕ in the terminal (single view only) */
  onRequestClose?: () => void;
  /** on a restored session, the agent to offer resuming (e.g. "claude") */
  resumeAgent?: string;
  /** called when the resume offer is used or dismissed (they started typing) */
  onResumeConsumed: (id: string) => void;
}

export default function TerminalPane({
  sessionId,
  visible,
  active,
  startCwd,
  onOpenPath,
  onBell,
  onSeen,
  onTitle,
  onCwd,
  onStatusHint,
  onActivity,
  onFocusSurface,
  onRequestClose,
  resumeAgent,
  onResumeConsumed,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const rootRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const resumeRef = useRef(resumeAgent);
  resumeRef.current = resumeAgent;
  // Revive a pane whose shell exited: restartRef re-spawns, exitedRef gates input.
  const restartRef = useRef<(() => void) | null>(null);
  const exitedRef = useRef(false);
  // Last cwd this shell reported (via OSC 7) — so a revived shell restarts where
  // the session actually is, not back in its mount-time startCwd.
  const lastCwdRef = useRef<string | null>(null);

  const { theme, settings, update } = useSettings();
  const lookRef = useRef({ theme, settings });
  lookRef.current = { theme, settings };

  // Callbacks captured in refs so the mount effect always sees current ones.
  const cbRef = useRef({ onOpenPath, onBell, onSeen, onTitle, onCwd, onStatusHint, onActivity, onResumeConsumed });
  cbRef.current = { onOpenPath, onBell, onSeen, onTitle, onCwd, onStatusHint, onActivity, onResumeConsumed };

  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getRoot().then((r) => (rootRef.current = r)).catch(() => {});
  }, []);

  function openToken(token: string) {
    const { file, line } = splitFileLine(token);
    let abs = file;
    if (!file.startsWith("/")) {
      const root = rootRef.current;
      if (root) abs = root.replace(/\/$/, "") + "/" + file.replace(/^\.\//, "");
    }
    cbRef.current.onOpenPath(abs, line);
  }

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let cwdHintTimer: ReturnType<typeof setTimeout> | undefined;

    const { theme, settings } = lookRef.current;
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.terminalFontSize,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: theme.terminal.background,
        foreground: theme.terminal.foreground,
        cursor: theme.terminal.cursor,
        selectionBackground: theme.terminal.selectionBackground,
      },
    });
    termRef.current = term;

    // Let the app own ⌘+/⌘-/⌘0 (zoom) — don't forward them to the shell.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && ["+", "=", "-", "_", "0"].includes(e.key)) {
        return false;
      }
      return true;
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(search);

    term.open(hostRef.current);
    try {
      term.loadAddon(new WebglAddon());
    } catch (e) {
      console.warn("WebGL renderer unavailable, using default", e);
    }
    try {
      fit.fit();
    } catch {
      /* hidden on mount */
    }

    // Clickable file:line paths.
    const linkProvider = term.registerLinkProvider({
      provideLinks(y, callback) {
        const bufLine = term.buffer.active.getLine(y - 1);
        if (!bufLine) {
          callback(undefined);
          return;
        }
        const text = bufLine.translateToString(true);
        const links = [];
        PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PATH_RE.exec(text)) !== null) {
          const token = m[0];
          if (!looksLikePath(token)) continue;
          const startX = m.index + 1;
          const endX = m.index + token.length;
          links.push({
            text: token,
            range: { start: { x: startX, y }, end: { x: endX, y } },
            activate: () => openToken(token),
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    // (Re)launch the shell for this pane. A fresh Channel each time, because the
    // previous reader thread ends when its child exits. onData/onResize below are
    // keyed by sessionId, so they keep working across a restart with no re-wiring.
    const spawn = () => {
      exitedRef.current = false;
      const channel = new Channel<PtyEvent>();
      channel.onmessage = (msg) => {
        if (disposed) return;
        if (msg.event === "output") {
          term.write(decodeBase64(msg.data));
          // Output = this session is actively working (drives the busy dot even
          // for TUI agents, which the OS foreground check can't see into).
          cbRef.current.onActivity(sessionId);
          // When output settles (a prompt likely returned), re-check status.
          if (activeRef.current) {
            clearTimeout(cwdHintTimer);
            cwdHintTimer = setTimeout(() => cbRef.current.onStatusHint(sessionId), 150);
          }
        } else if (msg.event === "exit") {
          exitedRef.current = true;
          term.write(
            "\r\n\x1b[90m[process exited — press any key to start a new shell]\x1b[0m\r\n"
          );
        }
      };
      invoke("pty_spawn", {
        id: sessionId,
        // Restart where the session actually is; fall back to the mount cwd, then root.
        cwd: lastCwdRef.current ?? startCwd ?? null,
        onEvent: channel,
        shell: null,
        cols: term.cols,
        rows: term.rows,
      }).catch((e) => {
        // A failed spawn (bad cwd, fd exhaustion, …) must not leave a silent dead
        // pane: mark it exited so a keypress retries, and say what happened.
        console.error("pty_spawn failed", e);
        exitedRef.current = true;
        // The usual cause is a gone directory — clear it so the retry falls back
        // to startCwd / root instead of failing on the same dead cwd forever.
        lastCwdRef.current = null;
        term.write(`\r\n\x1b[31m[failed to start shell: ${e} — press any key to retry]\x1b[0m\r\n`);
      });
    };
    restartRef.current = spawn;

    const bellSub = term.onBell(() => cbRef.current.onBell(sessionId));

    const titleSub = term.onTitleChange((t) => {
      // Terminal output controls this via OSC escapes — strip control chars
      // and cap the length before it reaches the session/window title.
      const clean = t.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
      cbRef.current.onTitle(sessionId, clean);
    });

    // OSC 7: shells with integration push their cwd instantly.
    const osc7 = term.parser.registerOscHandler(7, (data) => {
      const p = parseOsc7(data);
      if (p) {
        lastCwdRef.current = p;
        cbRef.current.onCwd(sessionId, p);
      }
      return true;
    });

    spawn();

    const dataSub = term.onData((data) => {
      // A dead pane is not a dead end — any key relaunches its shell.
      if (exitedRef.current) {
        restartRef.current?.();
        return;
      }
      // Typing your own command dismisses the restored-session Resume offer.
      if (resumeRef.current) cbRef.current.onResumeConsumed(sessionId);
      invoke("pty_write", { id: sessionId, data }).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) =>
      invoke("pty_resize", { id: sessionId, cols, rows }).catch(() => {})
    );

    // Coalesce size changes to one fit per frame — smooths continuous resizes
    // (dragging the panel divider) instead of thrashing the terminal each tick.
    let roRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* container not ready / hidden */
        }
      });
    });
    ro.observe(hostRef.current);

    return () => {
      disposed = true;
      clearTimeout(cwdHintTimer);
      cancelAnimationFrame(roRaf);
      ro.disconnect();
      linkProvider.dispose();
      bellSub.dispose();
      titleSub.dispose();
      osc7.dispose();
      dataSub.dispose();
      resizeSub.dispose();
      invoke("pty_kill", { id: sessionId }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [sessionId]);

  // On becoming visible (either split pane), refit and clear "wants you" — you
  // can see it now. (A width change while already visible is handled by the
  // ResizeObserver.)
  useEffect(() => {
    if (!visible) return;
    cbRef.current.onSeen(sessionId);
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, sessionId]);

  // Only the focused pane grabs the keyboard.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    const raf = requestAnimationFrame(() => term.focus());
    return () => cancelAnimationFrame(raf);
  }, [active, sessionId]);

  // ⌘F opens search in the active terminal.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Live-apply theme / font changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = {
      background: theme.terminal.background,
      foreground: theme.terminal.foreground,
      cursor: theme.terminal.cursor,
      selectionBackground: theme.terminal.selectionBackground,
    };
    term.options.fontSize = settings.terminalFontSize;
    term.options.fontFamily = settings.fontFamily;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [theme, settings.terminalFontSize, settings.fontFamily]);

  function runSearch(term: string, dir: "next" | "prev") {
    if (!term) return;
    if (dir === "next") searchRef.current?.findNext(term);
    else searchRef.current?.findPrevious(term);
  }

  return (
    <div className="terminal-wrap" onFocusCapture={() => onFocusSurface("terminal")}>
      <div className="terminal-host" ref={hostRef} />
      {onRequestClose && (
        <button className="term-close" title="Close session" onClick={onRequestClose}>
          <Close size={14} />
        </button>
      )}
      {resumeAgent && visible && (
        <button
          className="term-resume"
          title={`Run "${resumeCommand(resumeAgent)}" to pick this agent back up`}
          onClick={() => {
            invoke("pty_write", { id: sessionId, data: resumeCommand(resumeAgent) + "\r" }).catch(() => {});
            onResumeConsumed(sessionId);
            termRef.current?.focus();
          }}
        >
          ⟳ Resume {resumeAgent}
        </button>
      )}
      {active && (
        <ZoomControl
          className="term-zoom"
          size={settings.terminalFontSize}
          onDec={() => zoomFont(update, "terminal", -1)}
          onInc={() => zoomFont(update, "terminal", 1)}
        />
      )}
      {showSearch && active && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            value={searchTerm}
            placeholder="Find…"
            onChange={(e) => {
              setSearchTerm(e.target.value);
              runSearch(e.target.value, "next");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(searchTerm, e.shiftKey ? "prev" : "next");
              else if (e.key === "Escape") {
                setShowSearch(false);
                termRef.current?.focus();
              }
            }}
          />
          <button onClick={() => runSearch(searchTerm, "prev")} title="Previous">
            ↑
          </button>
          <button onClick={() => runSearch(searchTerm, "next")} title="Next">
            ↓
          </button>
          <button
            onClick={() => {
              setShowSearch(false);
              termRef.current?.focus();
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
