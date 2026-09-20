import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getRoot, revealPath, openUrl, type PtyEvent } from "../lib/api";
import { useSettings, zoomFont, SMOOTH_SCROLL_MS, type Theme, type Surface } from "../lib/settings";
import {
  decodeBase64,
  isAbsolute,
  joinPath,
  PATH_RE,
  URL_RE,
  looksLikePath,
  splitFileLine,
  parseOsc7,
} from "../lib/paths";
import { resumeCommand } from "../lib/sessions";
import { useContextMenu } from "../lib/useContextMenu";
import { copyText, readText } from "../lib/clipboard";
import * as sound from "../lib/sound";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import ZoomControl from "./ZoomControl";
import { Close } from "./icons";
import "@xterm/xterm/css/xterm.css";

/** WebView2 (Windows) reports "Windows NT" in its UA; WKWebView/WebKitGTK don't. */
const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

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

/** How long after a pane reappears to repaint it a second time. Long enough to
 *  be a different compositing pass than the first, short enough that a pane that
 *  did lose its picture is never blank for a noticeable beat. */
const REDRAW_SETTLE_MS = 250;

/** Force xterm to redraw the whole viewport.
 *
 *  xterm draws only when something asks it to, and coming back on screen is not
 *  one of those things. Its RenderService parks the renderer on an
 *  IntersectionObserver while the pane is `display:none`, and on resume repaints
 *  only if a refresh was REQUESTED while it was away (`_needsFullRefresh`). A
 *  pane that sat idle in the background — no output, no resize — therefore gets
 *  zero draw calls when it reappears; xterm is trusting its canvas to still hold
 *  the frame it last drew. `fit()` does not cover this: with the geometry
 *  unchanged it returns without touching the renderer.
 *
 *  That trust is misplaced in a webview. This is the same hazard already called
 *  out for pane reordering in App's `terminalOrder` — a WebGL canvas here loses
 *  what it was showing when its layer is torn down, and nothing tells us it
 *  happened, so it stays blank until the next draw. `display:none` for a long
 *  stretch is exactly such a teardown.
 *
 *  The focused pane is usually saved by accident: `term.focus()` on the pane you
 *  switch to fires xterm's focus handler, which requests a redraw. A pane that
 *  comes back WITHOUT focus gets nothing — the unfocused half of a split, or a
 *  session swapped into it from the pane header. Repainting costs one frame. */
function redrawViewport(term: Terminal | null) {
  if (!term) return;
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    /* a terminal being torn down is not worth a crash */
  }
}

/** Force the WebGL renderer to re-upload every texture-atlas page.
 *
 *  xterm's GlyphRenderer decides whether a texture unit still matches its atlas
 *  page by comparing `page.version` — a PER-PAGE counter — against the version it
 *  recorded for that texture SLOT. Sound only while a page keeps its slot, and it
 *  doesn't: once the atlas reaches `maxAtlasPages` (`MAX_TEXTURE_IMAGE_UNITS`, 16
 *  on WebKit) xterm merges four pages into one and SPLICES them out, so every
 *  page above them shifts down a slot. Slot i now holds a different page, and its
 *  counter is being compared against the counter of the page that used to live
 *  there — two unrelated numbers. Equal by chance means the upload is skipped and
 *  the pane keeps drawing the old page's picture with the new page's
 *  coordinates: letters rendered as fragments of OTHER letters, in those letters'
 *  colours. Rare glyphs go first (bold/italic/coloured runs live on the late
 *  pages; plain body text sits on page 0 and looks fine), and it is permanent —
 *  the same character is wrong everywhere it appears on screen.
 *
 *  Nothing self-heals it. `GlyphRenderer.setAtlas()` is what resets every slot to
 *  version -1 and forces a full re-upload, and the only thing that reaches it is
 *  `WebglRenderer._refreshCharAtlas()` — resize, DPR change, theme change, and
 *  nothing else. That is exactly why resizing the window repairs it, and why it
 *  comes back: the next merge is another chance to collide.
 *
 *  So take the cheapest of those three triggers. Re-assigning `options.theme`
 *  with the SAME colours runs the identical path a resize does — reacquire the
 *  atlas, reset the slots, clear the model, repaint the viewport — without
 *  touching geometry or the buffer. It must be a fresh object: xterm's option
 *  setter compares by identity and ignores a write of the same reference.
 *
 *  Fixed upstream in @xterm/addon-webgl 0.20.0 by making the counter globally
 *  monotonic (`AtlasPage.nextVersion`); drop this when that ships stable. */
function resyncAtlasTextures(term: Terminal | null, theme: Theme) {
  if (!term) return;
  try {
    term.options.theme = xtermTheme(theme);
  } catch {
    /* a terminal being torn down is not worth a crash */
  }
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
  /** where the session IS right now, from the status poll (`session.cwd`). The
   *  poll reads the shell process's own cwd, so this is the only source that
   *  follows `cd` for a default zsh/bash — those never emit OSC 7. */
  currentCwd?: string;
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
  /** that agent's specific conversation id, so Resume reopens this tab's own chat */
  resumeSessionId?: string;
  /** called when the resume offer is used or dismissed (they started typing) */
  onResumeConsumed: (id: string) => void;
}

export default function TerminalPane({
  sessionId,
  visible,
  active,
  startCwd,
  currentCwd,
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
  resumeSessionId,
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
  // Last cwd this shell reported via OSC 7 — instant, but only shells with
  // explicit integration emit it. A default macOS zsh does NOT: /etc/zshrc only
  // sources /etc/zshrc_$TERM_PROGRAM, and we present as TERM_PROGRAM=Beecork, so
  // Apple's update_terminal_cwd never runs. For most users this stays null.
  const lastCwdRef = useRef<string | null>(null);
  // …which is why the poll-derived cwd matters. Held in a ref because both
  // readers live in closures built ONCE in the mount effect (the link provider's
  // `activate`, and `spawn`) — reading the prop there would pin it to whatever
  // the value was on the pane's first render, making the whole thing inert.
  const currentCwdRef = useRef(currentCwd);
  currentCwdRef.current = currentCwd;
  // A directory a spawn already failed on — almost always one deleted out from
  // under the session. Both cwd sources can still point at it (OSC 7's last push,
  // and the polled cwd, which cannot refresh while the shell is dead), so
  // remember it and skip it on the retry rather than failing on it forever.
  const badCwdRef = useRef<string | null>(null);

  const { theme, settings, update } = useSettings();
  const lookRef = useRef({ theme, settings });
  lookRef.current = { theme, settings };

  // Callbacks captured in refs so the mount effect always sees current ones.
  const cbRef = useRef({ onOpenPath, onBell, onSeen, onTitle, onCwd, onStatusHint, onActivity, onResumeConsumed });
  cbRef.current = { onOpenPath, onBell, onSeen, onTitle, onCwd, onStatusHint, onActivity, onResumeConsumed };

  // Has this pane ever been on screen? Gates building the xterm at all.
  //
  // Every session renders a TerminalPane (they must, so their shells keep
  // running), but a pane you have never opened has nothing to draw: building it
  // eagerly meant one Terminal + one WebGL context per session, and a webview
  // only grants a handful of GL contexts before it starts dropping them. Once
  // built it is never torn down, mirroring the lazy shell spawn below.
  //
  // Latched during render rather than in an effect: React re-runs this component
  // immediately with the new value, before committing or touching the DOM, so
  // the terminal is built in the SAME pass the pane first becomes visible. An
  // effect would commit an empty pane first and build on a second render.
  const [rendered, setRendered] = useState(visible);
  if (visible && !rendered) setRendered(true);
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
    // A relative token resolves against THIS SESSION's working directory — the
    // folder the output actually came from — not the app process's cwd. A
    // Finder-launched .app has cwd `/`, so basing this on `get_root()` silently
    // turned "src/App.tsx" into "/src/App.tsx". It only ever failed in the
    // installed app, because `tauri dev` runs the binary from the project root.
    //
    // Freshest first: the shell's own OSC 7 push, then the cwd the status poll
    // read from the shell process. OSC 7 is NOT the primary source — a default
    // zsh/bash never emits it — so for most users the polled cwd is the one that
    // actually tracks `cd`, and startCwd is only the seed until the first poll.
    const base =
      lastCwdRef.current ?? currentCwdRef.current ?? startCwd ?? rootRef.current;
    const abs = isAbsolute(file)
      ? file
      : base
        ? joinPath(base, file.replace(/^\.[\\/]/, ""))
        : file;
    // ⌘/Ctrl-click reveals in Finder; a plain click opens it in the editor.
    if (reveal) void revealPath(abs).catch(() => {});
    else cbRef.current.onOpenPath(abs, line);
  }

  useEffect(() => {
    if (!rendered) return;
    if (!hostRef.current || !mountRef.current) return;
    let disposed = false;
    let cwdHintTimer: ReturnType<typeof setTimeout> | undefined;
    let atlasResync: ReturnType<typeof setTimeout> | undefined;

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
    // Skip the WebGL renderer on Windows entirely — use xterm's built-in DOM
    // renderer there. WebView2's GPU-backed WebGL ghosts cells on in-place
    // redraws (a typed char stays "stuck" in an agent's input box after it's
    // cleared, worst inside Claude Code's ConPTY classic renderer), and it's the
    // same fragile path that recycles its GPU process (webglcontextlost, v0.1.20).
    // The DOM renderer is correct and plenty fast for a terminal. macOS/Linux
    // keep WebGL, where WebKit/WebKitGTK render it cleanly.
    if (!IS_WINDOWS) {
      try {
        const webgl = new WebglAddon();
        // Belt-and-suspenders on the platforms that DO use WebGL: if the GPU
        // context is ever lost, drop the addon so xterm falls back to DOM
        // rather than drawing into a dead context (a blank/frozen terminal).
        webgl.onContextLoss(() => webgl.dispose());

        // Re-sync the atlas textures whenever xterm reshapes its page array —
        // see resyncAtlasTextures for what goes wrong if we don't.
        //
        // Only a REMOVE can make a texture slot ambiguous, and only merging
        // removes: until the first one the array has only ever grown, so page i
        // is the first page ever to occupy slot i and that slot is still at
        // version -1, which always uploads. After a merge the array has holes
        // that later pages fall into, so from then on an ADD can land in a slot
        // some other page was uploaded from, and both events need the re-sync.
        // Hence `merged` — before it, this costs nothing at all.
        //
        // Deferred, because both events fire from INSIDE xterm's model update,
        // mid-frame; re-entering the renderer there would clear the vertex array
        // it is halfway through filling. The timer also collapses a merge's five
        // events (four removes, one add) into a single re-sync.
        let merged = false;
        const resync = () => {
          if (disposed || atlasResync) return;
          atlasResync = setTimeout(() => {
            atlasResync = undefined;
            if (disposed) return;
            resyncAtlasTextures(termRef.current, lookRef.current.theme);
          }, 0);
        };
        webgl.onAddTextureAtlasCanvas(() => {
          if (merged) resync();
        });
        webgl.onRemoveTextureAtlasCanvas(() => {
          merged = true;
          resync();
        });

        term.loadAddon(webgl);
      } catch (e) {
        console.warn("WebGL renderer unavailable, using default", e);
      }
    }
    try {
      fit.fit();
    } catch {
      /* hidden on mount */
    }

    // Clickable links in output: http(s) URLs (→ browser) and file:line paths
    // (click → editor, ⌘/Ctrl-click → reveal in Finder).
    //
    // Matching runs over the whole LOGICAL line, never the row under the mouse.
    // xterm hands the provider one buffer ROW at a time, and a long path wraps —
    // `…/T/claude-c` + `hrome-screenshots-lUHh5e/shot.jpg`. Per row, the head has
    // no extension so PATH_RE ignores it, and the tail matches as a RELATIVE
    // path, which `openToken` then resolves against the session cwd: the click
    // opens a file that does not exist ("No preview available") instead of the
    // one on screen. Rejoin the wrapped rows first; an xterm link range may span
    // rows (`_linkAtPosition` compares flat buffer offsets), so hover, underline
    // and click all follow the path across the wrap.
    const logicalLine = (row: number) => {
      const buf = term.buffer.active;
      // A continuation row points back at its head; walk up to it.
      let first = row;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      const starts: number[] = [];
      let text = "";
      for (let i = first; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (!line) break;
        const last = !buf.getLine(i + 1)?.isWrapped;
        starts.push(text.length);
        // A continuation row must contribute its FULL width — no right-trim, and
        // `cols` explicitly, because a line's cell array can stay wider than the
        // pane after a resize. Trim either one and every offset past the join
        // shifts, which lands the link's range on the wrong cells.
        text += line.translateToString(last, 0, term.cols);
        if (last) break;
      }
      return { first, starts, text };
    };

    /** 1-based { x, y } link coordinates for a 0-based offset into that text. */
    const at = (line: { first: number; starts: number[] }, offset: number) => {
      let k = line.starts.length - 1;
      while (k > 0 && line.starts[k] > offset) k--;
      return { x: offset - line.starts[k] + 1, y: line.first + k + 1 };
    };

    const linkProvider = term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = logicalLine(y - 1);
        const text = line.text;
        if (!text) {
          callback(undefined);
          return;
        }
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
            // `end - 1` is the token's LAST cell; the range end is inclusive.
            range: { start: at(line, start), end: at(line, end - 1) },
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
            range: { start: at(line, start), end: at(line, end - 1) },
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
          // Last in the handler, and wrapped: this runs inside a Tauri
          // Channel.onmessage, where an escaping throw stops the channel
          // advancing its message index (@tauri-apps/api core.js) — harmless for
          // this final "exit" message, fatal anywhere earlier. sound.ts cannot
          // throw today; keep both halves so a regression reaches neither the
          // banner nor the channel.
          try {
            sound.exit();
          } catch {
            /* never let audio eat the exit banner */
          }
        }
      };
      // Restart where the session actually IS: the shell's own OSC 7 push, else
      // the polled cwd, else the mount cwd, the configured default folder, and
      // finally the Rust home fallback (null). A directory a previous spawn
      // already failed on is skipped — without that, adding the polled cwd would
      // brick the pane, because it cannot refresh while the shell is dead.
      const cwd =
        [
          lastCwdRef.current,
          currentCwdRef.current,
          startCwd,
          lookRef.current.settings.defaultCwd,
        ].find((c): c is string => !!c && c !== badCwdRef.current) ?? null;
      invoke("pty_spawn", {
        id: sessionId,
        cwd,
        onEvent: channel,
        shell: null,
        cols: term.cols,
        rows: term.rows,
      })
        .then(() => {
          badCwdRef.current = null; // this directory works — stop skipping it
        })
        .catch((e) => {
          // A failed spawn (bad cwd, fd exhaustion, …) must not leave a silent
          // dead pane: mark it exited so a keypress retries, and say what happened.
          console.error("pty_spawn failed", e);
          exitedRef.current = true;
          // The usual cause is a gone directory. Remember it — and clear the OSC 7
          // value, which may point at the same place — so the retry picks the next
          // candidate instead of failing identically forever.
          badCwdRef.current = cwd;
          lastCwdRef.current = null;
          term.write(
            `\r\n\x1b[31m[failed to start shell: ${e} — press any key to retry]\x1b[0m\r\n`
          );
        });
    };
    restartRef.current = spawn;

    // The bell is the agent's explicit "I'm done / I have a question" — chime for
    // it even when you're watching this session (the off-screen attention path in
    // App also fires, but the shared throttle collapses the two into one chime).
    // Run the attention pipeline FIRST — the bell can't be retried, so a throwing
    // sound call must never drop the wantsYou flag + OS notification. xterm 6
    // catches listener throws itself, so this ordering is the only thing that
    // protects the pipeline; the wrap below just keeps the four sound sites
    // uniform.
    const bellSub = term.onBell(() => {
      cbRef.current.onBell(sessionId);
      try {
        sound.attention();
      } catch {
        /* never let audio cost the bell */
      }
    });

    const titleSub = term.onTitleChange((t) => {
      // Terminal output controls this via OSC escapes — strip control chars
      // and cap the length before it reaches the session/window title. The
      // control characters in this class are the point, not an accident.
      // eslint-disable-next-line no-control-regex
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
      clearTimeout(atlasResync);
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
  }, [sessionId, rendered]);

  // Becoming visible clears "wants you" — you can see it now. Kept separate from
  // the fit/spawn below so acknowledging attention never waits on the terminal
  // having been built.
  useEffect(() => {
    if (!visible) return;
    cbRef.current.onSeen(sessionId);
  }, [visible, sessionId]);

  // On becoming visible (either split pane), refit and repaint. (A width change
  // while already visible is handled by the ResizeObserver.)
  useEffect(() => {
    if (!visible || !rendered) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      // Never trust the canvas to have kept its picture while it was hidden —
      // see redrawViewport. Safe to call before the IntersectionObserver has
      // reported the pane visible again: xterm queues the request and flushes it
      // on resume.
      redrawViewport(termRef.current);
      // First time this pane is shown, start its shell — now that it's laid out
      // and fitted, so the pty opens at the real size. Deferring the spawn to
      // here (rather than on mount) means restored background sessions don't all
      // cold-start simultaneously and a hidden pane never starts mis-sized —
      // both of which let a shell-startup query race the prompt and leak the
      // terminal's reply into the command line. Later show/hide cycles keep the
      // already-running shell (spawnedRef gates this to once).
      // Latch only on a call that actually happened. Consuming the gate while
      // `restartRef` is still null (the mount effect bailed at its ref check)
      // would brick the pane forever: nothing resets `spawnedRef`, the mount
      // effect's deps never change again, and the press-any-key retry needs an
      // `exitedRef` that only a FAILED spawn sets — so a spawn that never ran
      // leaves no way back. Leaving the gate unlatched costs nothing on every
      // path that works, and lets the next visibility pass retry on the one that
      // does not.
      if (!spawnedRef.current && restartRef.current) {
        spawnedRef.current = true;
        restartRef.current();
      }
    });
    // And once more, a moment later. The repaint above goes out on the frame the
    // pane reappears, which is also the frame the webview may still be rebuilding
    // its compositing layer on — a draw that lands mid-rebuild is wiped, and
    // because nothing asks xterm to draw again, the pane keeps whatever it had:
    // background, plus only the rows something happened to repaint afterwards (a
    // TUI's status line, the blinking cursor row). That is the reported symptom.
    // A second frame costs nothing and cannot land in the same window.
    const settle = setTimeout(() => redrawViewport(termRef.current), REDRAW_SETTLE_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [visible, sessionId, rendered]);

  // The same repaint for the case where the PANE never changed but the WINDOW
  // did — minimised, buried behind another app, or the display slept. The
  // webview marks the page hidden and can drop the canvas layer then too, but no
  // prop changes, so the effect above never runs. Only on-screen panes bother.
  useEffect(() => {
    if (!visible || !rendered) return;
    function onWake() {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => redrawViewport(termRef.current));
    }
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [visible, rendered]);

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

  // null for an agent we don't know how to resume — no pill at all, rather than
  // offering a command that doesn't exist. See resumeCommand's allowlist.
  const resumeCmd = resumeAgent ? resumeCommand(resumeAgent, resumeSessionId) : null;

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
      {resumeCmd && visible && (
        <button
          className="term-resume"
          title={`Run "${resumeCmd}" to pick this agent back up`}
          onClick={() => {
            invoke("pty_write", { id: sessionId, data: resumeCmd + "\r" }).catch(() => {});
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
