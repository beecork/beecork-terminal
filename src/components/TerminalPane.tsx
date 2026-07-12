import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getRoot, revealPath, openUrl } from "../lib/api";
import { useSettings, zoomFont, SMOOTH_SCROLL_MS, type Theme, type Surface } from "../lib/settings";
import { decodeBase64, PATH_RE, URL_RE, looksLikePath, splitFileLine, parseOsc7 } from "../lib/paths";
import { resumeCommand } from "../lib/sessions";
import { useContextMenu } from "../lib/useContextMenu";
import { copyText, readText } from "../lib/clipboard";
import * as sound from "../lib/sound";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import ZoomControl from "./ZoomControl";
import { Close } from "./icons";
import "@xterm/xterm/css/xterm.css";

type PtyEvent =
  | { event: "output"; data: string }
  | { event: "exit"; data: number };

/** DEC private modes a child killed mid-run (SIGHUP, crash) leaves stuck ON in
 *  xterm — it never got to emit its own terminal cleanup. Mouse tracking is the
 *  harmful one: with 1000/1002/1003 (+ SGR 1006/1015) still enabled, every mouse
 *  move over the pane emits an `\e[<35;x;yM` report that the next plain shell —
 *  which never disables mouse mode — simply echoes, producing the growing
 *  `35;16;4M35;20;9M…` "gibberish". Also drop focus reporting and bracketed
 *  paste, and restore a visible cursor + default attributes. Alt-screen is left
 *  separately (only when actually active) so we never wipe the dead process's
 *  final output. */
const STUCK_MODE_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l" + // mouse tracking off
  "\x1b[?1004l" + // focus reporting off
  "\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" + // mouse encodings off
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?25h" + // cursor visible
  "\x1b[0m"; // reset colors/attributes

function resetStuckModes(term: Terminal) {
  if (term.buffer.active.type === "alternate") term.write("\x1b[?1049l");
  term.write(STUCK_MODE_RESET);
}

/** Build xterm's theme from the app theme, including its built-in scrollbar. The
 *  slider is drawn from the themed `muted`/`accent` colors with alpha (8-digit
 *  hex) so it's a subtle-but-visible, draggable bar that brightens on hover/drag —
 *  on every theme, dark or light. */
function xtermTheme(theme: Theme): ITheme {
  return {
    background: theme.terminal.background,
    foreground: theme.terminal.foreground,
    cursor: theme.terminal.cursor,
    selectionBackground: theme.terminal.selectionBackground,
    scrollbarSliderBackground: theme.ui.muted + "59", // ~35%
    scrollbarSliderHoverBackground: theme.ui.muted + "b3", // ~70%
    scrollbarSliderActiveBackground: theme.ui.accent + "cc", // ~80%
  };
}

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
  /** bump this to pull keyboard focus back to the active terminal (e.g. a modal closed) */
  focusSignal: number;
  /** right-click menu: start a new session (inherits cwd) */
  onNewSession: () => void;
  /** right-click menu: split / unsplit this session */
  onToggleSplit: () => void;
  /** right-click menu: close this session */
  onCloseSession: () => void;
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
  focusSignal,
  onNewSession,
  onToggleSplit,
  onCloseSession,
  onRequestClose,
  resumeAgent,
  onResumeConsumed,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // xterm mounts into this inner element. Its inset from the host edges (see the
  // .terminal-mount CSS) is the terminal's text padding; the host behind it paints
  // the matching background edge-to-edge, so the padding shows no seam. FitAddon
  // measures this box (padding-free) and reserves the right gutter for xterm's own
  // scrollbar, which renders there.
  const mountRef = useRef<HTMLDivElement>(null);
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
  // Gate the one-time initial spawn. A pane starts its shell only when it first
  // becomes visible (and after it's fitted), not eagerly on mount — so restored
  // sessions don't all cold-start at once, and a hidden (display:none) pane never
  // starts its shell at the wrong 80×24 size. See the `visible` effect below.
  const spawnedRef = useRef(false);
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

  // Right-click menu for the terminal. Selection state is captured at open time.
  const { menu: ctxMenu, openMenu: openCtx, closeMenu: closeCtx } = useContextMenu<{
    hasSelection: boolean;
  }>();

  function onTermContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    openCtx(e, { hasSelection: !!termRef.current?.hasSelection() });
  }

  function termMenu(hasSelection: boolean): MenuEntry[] {
    const term = termRef.current;
    return [
      {
        label: "Copy",
        hint: "⌘C",
        disabled: !hasSelection,
        onSelect: () => {
          const sel = term?.getSelection() ?? "";
          if (sel) copyText(sel);
          term?.focus();
        },
      },
      {
        label: "Paste",
        hint: "⌘V",
        onSelect: () => {
          readText().then((t) => {
            if (t) term?.paste(t);
            term?.focus();
          });
        },
      },
      {
        label: "Select all",
        onSelect: () => {
          term?.selectAll();
          term?.focus();
        },
      },
      {
        label: "Clear",
        onSelect: () => {
          term?.clear();
          term?.focus();
        },
      },
      "separator",
      {
        label: "Find…",
        hint: "⌘F",
        onSelect: () => {
          setShowSearch(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        },
      },
      { label: "Split", hint: "⌘D", onSelect: onToggleSplit },
      { label: "New session", hint: "⌘T", onSelect: onNewSession },
      "separator",
      { label: "Close session", danger: true, onSelect: onCloseSession },
    ];
  }

  useEffect(() => {
    getRoot().then((r) => (rootRef.current = r)).catch(() => {});
  }, []);

  function openToken(token: string, reveal = false) {
    const { file, line } = splitFileLine(token);
    let abs = file;
    if (!file.startsWith("/")) {
      const root = rootRef.current;
      if (root) abs = root.replace(/\/$/, "") + "/" + file.replace(/^\.\//, "");
    }
    // ⌘/Ctrl-click reveals in Finder; a plain click opens it in the editor.
    if (reveal) void revealPath(abs).catch(() => {});
    else cbRef.current.onOpenPath(abs, line);
  }

  useEffect(() => {
    if (!hostRef.current || !mountRef.current) return;
    let disposed = false;
    let cwdHintTimer: ReturnType<typeof setTimeout> | undefined;

    const { theme, settings } = lookRef.current;
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.terminalFontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      scrollSensitivity: settings.scrollSpeed,
      fastScrollSensitivity: settings.scrollSpeed * 4,
      smoothScrollDuration: settings.smoothScroll ? SMOOTH_SCROLL_MS : 0,
      theme: xtermTheme(theme),
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

    term.open(mountRef.current);
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

    // Clickable links in output: http(s) URLs (→ browser) and file:line paths
    // (click → editor, ⌘/Ctrl-click → reveal in Finder).
    const linkProvider = term.registerLinkProvider({
      provideLinks(y, callback) {
        const bufLine = term.buffer.active.getLine(y - 1);
        if (!bufLine) {
          callback(undefined);
          return;
        }
        const text = bufLine.translateToString(true);
        const links = [];
        const urlRanges: Array<[number, number]> = [];
        let m: RegExpExecArray | null;

        // URLs first — open in the system browser. (localhost will route to the
        // in-app preview once that pane exists; system browser for now.)
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(text)) !== null) {
          const token = m[0];
          const start = m.index;
          const end = m.index + token.length;
          urlRanges.push([start, end]);
          links.push({
            text: token,
            range: { start: { x: start + 1, y }, end: { x: end, y } },
            activate: () => void openUrl(token).catch(() => {}),
          });
        }

        // File paths — but skip any that sit inside a URL we already linked.
        PATH_RE.lastIndex = 0;
        while ((m = PATH_RE.exec(text)) !== null) {
          const token = m[0];
          if (!looksLikePath(token)) continue;
          const start = m.index;
          const end = m.index + token.length;
          if (urlRanges.some(([s, e]) => start < e && end > s)) continue;
          links.push({
            text: token,
            range: { start: { x: start + 1, y }, end: { x: end, y } },
            activate: (e: MouseEvent) => openToken(token, e.metaKey || e.ctrlKey),
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
          // Clear any DEC private modes the dying child left stuck on (mouse
          // tracking especially) BEFORE the banner and the next shell inherit
          // the pane — otherwise mouse moves echo as `\e[<35;…M` gibberish.
          resetStuckModes(term);
          term.write(
            "\r\n\x1b[90m[process exited — press any key to start a new shell]\x1b[0m\r\n"
          );
          sound.exit(); // after the banner — a throwing sound must not eat it
        }
      };
      invoke("pty_spawn", {
        id: sessionId,
        // Restart where the session actually is; fall back to the mount cwd, then
        // the configured default folder, then the Rust home fallback (null).
        cwd: lastCwdRef.current ?? startCwd ?? lookRef.current.settings.defaultCwd ?? null,
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

    // The bell is the agent's explicit "I'm done / I have a question" — chime for
    // it even when you're watching this session (the off-screen attention path in
    // App also fires, but the shared throttle collapses the two into one chime).
    // Run the attention pipeline FIRST — the bell can't be retried, so a throwing
    // sound call must never drop the wantsYou flag + OS notification.
    const bellSub = term.onBell(() => {
      cbRef.current.onBell(sessionId);
      sound.attention();
    });

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

    // The shell is spawned lazily on first-visible (see the `visible` effect
    // below), not here — so input/resize handlers are wired up first and the pty
    // opens at the correct, already-fitted size instead of a hidden pane racing a
    // cold start at the wrong dimensions.
    const dataSub = term.onData((data) => {
      // A dead pane is not a dead end — any key relaunches its shell.
      if (exitedRef.current) {
        restartRef.current?.();
        return;
      }
      // Typing your own command dismisses the restored-session Resume offer.
      if (resumeRef.current) cbRef.current.onResumeConsumed(sessionId);
      // Send to the shell FIRST — terminal input must never be blocked by anything
      // below it (a throwing sound call once swallowed Enter). Sound is best-effort.
      invoke("pty_write", { id: sessionId, data }).catch(() => {});
      // A soft "sent" tone on Enter (self-gates on the keyClicks setting).
      if (data === "\r") {
        try {
          sound.send();
        } catch {
          /* never let audio break input */
        }
      }
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
          fitRef.current?.fit();
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
      // First time this pane is shown, start its shell — now that it's laid out
      // and fitted, so the pty opens at the real size. Deferring the spawn to
      // here (rather than on mount) means restored background sessions don't all
      // cold-start simultaneously and a hidden pane never starts mis-sized —
      // both of which let a shell-startup query race the prompt and leak the
      // terminal's reply into the command line. Later show/hide cycles keep the
      // already-running shell (spawnedRef gates this to once).
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        restartRef.current?.();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, sessionId]);

  // Only the focused pane grabs the keyboard. `focusSignal` bumps when an overlay
  // (settings, confirm, file panel) closes, so the terminal refocuses without a click.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    const raf = requestAnimationFrame(() => term.focus());
    return () => cancelAnimationFrame(raf);
  }, [active, sessionId, focusSignal]);

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
    term.options.theme = xtermTheme(theme);
    term.options.fontSize = settings.terminalFontSize;
    term.options.fontFamily = settings.fontFamily;
    // Scroll tuning applies live (no remount).
    term.options.scrollSensitivity = settings.scrollSpeed;
    term.options.fastScrollSensitivity = settings.scrollSpeed * 4;
    term.options.smoothScrollDuration = settings.smoothScroll ? SMOOTH_SCROLL_MS : 0;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [
    theme,
    settings.terminalFontSize,
    settings.fontFamily,
    settings.scrollSpeed,
    settings.smoothScroll,
  ]);

  function runSearch(term: string, dir: "next" | "prev") {
    if (!term) return;
    if (dir === "next") searchRef.current?.findNext(term);
    else searchRef.current?.findPrevious(term);
  }

  return (
    <div
      className="terminal-wrap"
      onFocusCapture={() => onFocusSurface("terminal")}
      onContextMenu={onTermContextMenu}
    >
      <div className="terminal-host" ref={hostRef}>
        <div className="terminal-mount" ref={mountRef} />
      </div>
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
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={termMenu(ctxMenu.payload.hasSelection)}
          onClose={closeCtx}
        />
      )}
    </div>
  );
}
