// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

// xterm and the Tauri bridge are the two things a jsdom test cannot have: one
// wants a real canvas/GPU, the other a Rust backend. Both are mocked to the
// smallest surface this component actually touches, so the test is about OUR
// ordering logic and nothing else.
const terminals: { opened: number; disposed: number; refreshed: number; themeWrites: number }[] = [];

type TermPos = { x: number; y: number };
type TermLink = {
  text: string;
  range: { start: TermPos; end: TermPos };
  activate: (e: { metaKey: boolean; ctrlKey: boolean }) => void;
};
type LinkProvider = { provideLinks(y: number, cb: (links?: TermLink[]) => void): void };
let provider: LinkProvider | null = null;

// The link provider reads the BUFFER, not one string: a long path wraps and has
// to be rejoined across rows, so the fake buffer has to be able to wrap. Rows
// carry `isWrapped` the way xterm's do — the flag is on the CONTINUATION row,
// never on its head — and `translateToString` pads to `cols` and honours
// trimRight, because the rejoin depends on both.
const TEST_COLS = 80;
let bufferRows: { text: string; wrapped: boolean }[] = [];
const setLine = (text: string) => {
  bufferRows = [{ text, wrapped: false }];
};
/** Lay `text` into rows the way a pane `TEST_COLS` wide would. */
const setWrappedLine = (text: string) => {
  bufferRows = [];
  for (let i = 0; i < text.length; i += TEST_COLS) {
    bufferRows.push({ text: text.slice(i, i + TEST_COLS), wrapped: i > 0 });
  }
};

// jsdom has no ResizeObserver; the pane installs one to refit on resize.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    cols = TEST_COLS;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        type: "normal",
        get length() {
          return bufferRows.length;
        },
        getLine: (i: number) => {
          const row = bufferRows[i];
          if (!row) return undefined;
          return {
            isWrapped: row.wrapped,
            translateToString: (trimRight?: boolean, start = 0, end = TEST_COLS) => {
              const cells = row.text.padEnd(TEST_COLS, " ").slice(start, end);
              return trimRight ? cells.replace(/\s+$/, "") : cells;
            },
          };
        },
      },
    };
    parser = { registerOscHandler: () => ({ dispose: () => {} }) };
    private rec: { opened: number; disposed: number; refreshed: number; themeWrites: number };
    constructor() {
      this.rec = { opened: 0, disposed: 0, refreshed: 0, themeWrites: 0 };
      terminals.push(this.rec);
      // Writing `options.theme` is how the pane forces the WebGL renderer to
      // re-upload its atlas pages, so count the writes rather than the value.
      const rec = this.rec;
      Object.defineProperty(this.options, "theme", {
        get: () => undefined,
        set: () => {
          rec.themeWrites++;
        },
        configurable: true,
        enumerable: true,
      });
    }
    open() {
      this.rec.opened++;
    }
    dispose() {
      this.rec.disposed++;
    }
    refresh() {
      this.rec.refreshed++;
    }
    loadAddon() {}
    focus() {}
    write() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider(p: LinkProvider) {
      provider = p;
      return { dispose: () => {} };
    }
    onBell() {
      return { dispose: () => {} };
    }
    onTitleChange() {
      return { dispose: () => {} };
    }
    onData() {
      return { dispose: () => {} };
    }
    onResize() {
      return { dispose: () => {} };
    }
  }
  return { Terminal: FakeTerminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
// The WebGL addon is where the texture-atlas events come from. The mock lets a
// test fire them, which is the only way to reach the re-sync path from jsdom.
let atlasPageAdded: (() => void) | null = null;
let atlasPageRemoved: (() => void) | null = null;
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    onAddTextureAtlasCanvas(cb: () => void) {
      atlasPageAdded = cb;
    }
    onRemoveTextureAtlasCanvas(cb: () => void) {
      atlasPageRemoved = cb;
    }
    dispose() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("../lib/api", () => ({
  getRoot: () => Promise.resolve("/repo"),
  revealPath: () => Promise.resolve(),
  openUrl: () => Promise.resolve(),
}));
vi.mock("../lib/sound", () => ({ exit: () => {}, send: () => {} }));

import TerminalPane from "./TerminalPane";
import { SettingsProvider } from "../lib/settings";

const noop = () => {};
const props = {
  sessionId: "s1",
  active: false,
  onOpenPath: noop,
  onBell: noop,
  onSeen: noop,
  onTitle: noop,
  onCwd: noop,
  onStatusHint: noop,
  onActivity: noop,
  onFocusSurface: noop,
  focusSignal: 0,
  onNewSession: noop,
  onToggleSplit: noop,
  onCloseSession: noop,
  onResumeConsumed: noop,
};

const spawns = () => invoke.mock.calls.filter((c) => c[0] === "pty_spawn");

/** Let the pending requestAnimationFrame callback run. */
async function flushFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
}

const view = (visible: boolean) => (
  <SettingsProvider>
    <TerminalPane {...props} visible={visible} />
  </SettingsProvider>
);

describe("TerminalPane lazy build", () => {
  beforeEach(() => {
    invoke.mockClear();
    terminals.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

  // The whole point of the lazy gate: every session renders a TerminalPane so
  // its shell keeps running, but an unopened one must cost nothing — no xterm,
  // no WebGL context, no pty.
  it("builds nothing and spawns nothing while the pane has never been visible", async () => {
    render(view(false));
    await flushFrame();
    expect(terminals).toHaveLength(0);
    expect(spawns()).toHaveLength(0);
  });

  it("builds the terminal and spawns exactly one shell once it becomes visible", async () => {
    const { rerender } = render(view(false));
    await flushFrame();
    expect(spawns()).toHaveLength(0);

    await act(async () => {
      rerender(view(true));
    });
    await flushFrame();

    expect(terminals.filter((t) => t.opened > 0)).toHaveLength(1);
    expect(spawns()).toHaveLength(1);
  });

  // Regression guard: hiding a pane must NOT kill its shell — that is the
  // feature (background sessions keep running), and showing it again must not
  // start a second one.
  it("keeps the one shell across hide/show cycles", async () => {
    const { rerender } = render(view(true));
    await flushFrame();
    expect(spawns()).toHaveLength(1);

    await act(async () => rerender(view(false)));
    await flushFrame();
    await act(async () => rerender(view(true)));
    await flushFrame();

    expect(spawns()).toHaveLength(1);
    expect(invoke.mock.calls.filter((c) => c[0] === "pty_kill")).toHaveLength(0);
  });

  it("spawns in the same pass a pane starts out visible", async () => {
    render(view(true));
    await flushFrame();
    expect(spawns()).toHaveLength(1);
  });

  // Coming back on screen must force a repaint. xterm parks its renderer while
  // the pane is display:none and, on resume, redraws only if a refresh was
  // requested while it was away — an idle background pane gets none, and the
  // canvas is not guaranteed to have kept its picture across the hide. Without
  // this the pane comes back blank until something else happens to draw.
  // `fit()` does not stand in for it: unchanged geometry means it does nothing.
  it("repaints the viewport when a hidden pane comes back on screen", async () => {
    const { rerender } = render(view(true));
    await flushFrame();
    const term = terminals[0];
    const atFirstShow = term.refreshed;

    await act(async () => rerender(view(false)));
    await flushFrame();
    expect(term.refreshed).toBe(atFirstShow); // hidden: nothing to draw

    await act(async () => rerender(view(true)));
    await flushFrame();
    const atShow = term.refreshed;
    expect(atShow).toBeGreaterThan(atFirstShow);

    // …and again once the webview has settled: the first repaint shares a frame
    // with the layer being rebuilt and can be wiped by it, which is what leaves
    // the pane showing only the rows redrawn afterwards.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(term.refreshed).toBeGreaterThan(atShow);
  });

  // The window, not the pane, can be what was hidden (minimised, buried, display
  // asleep) — same lost canvas, but no prop changes, so the show path never runs.
  it("repaints an on-screen pane when the window itself wakes up", async () => {
    render(view(true));
    await flushFrame();
    const term = terminals[0];
    const before = term.refreshed;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushFrame();

    expect(term.refreshed).toBeGreaterThan(before);
  });
});

// A page merge renumbers xterm's texture slots, and its GlyphRenderer keys
// "does this slot still hold what I uploaded?" off a PER-PAGE counter — so a
// page that lands in a slot whose recorded counter happens to match is never
// re-uploaded, and every glyph on it draws from the previous page's picture.
// That is the garbled-letters-in-other-letters'-colours report, and the reason
// resizing the window (the only thing that otherwise resets the slots) fixes it.
describe("WebGL texture atlas re-sync", () => {
  beforeEach(() => {
    invoke.mockClear();
    terminals.length = 0;
    atlasPageAdded = null;
    atlasPageRemoved = null;
  });
  afterEach(() => vi.clearAllMocks());

  /** Run the pending re-sync timer. */
  async function flushResync() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("costs nothing while the atlas has only ever grown", async () => {
    render(view(true));
    await flushFrame();
    const term = terminals[0];
    const before = term.themeWrites;

    // Pages 2..N of a fresh atlas: each one is the first ever to occupy its
    // slot, which is still at version -1 and therefore always uploads. Nothing
    // to repair, so nothing should happen.
    await act(async () => atlasPageAdded?.());
    await act(async () => atlasPageAdded?.());
    await flushResync();

    expect(term.themeWrites).toBe(before);
  });

  it("re-syncs once for a merge, not once per page it removed", async () => {
    render(view(true));
    await flushFrame();
    const term = terminals[0];
    const before = term.themeWrites;

    // What a merge actually emits: four pages spliced out, one merged page in.
    await act(async () => {
      atlasPageRemoved?.();
      atlasPageRemoved?.();
      atlasPageRemoved?.();
      atlasPageRemoved?.();
      atlasPageAdded?.();
    });
    await flushResync();

    expect(term.themeWrites).toBe(before + 1);
  });

  it("keeps re-syncing on later adds, which can now land in a reused slot", async () => {
    render(view(true));
    await flushFrame();
    const term = terminals[0];

    await act(async () => atlasPageRemoved?.());
    await flushResync();
    const afterMerge = term.themeWrites;

    // Same event as the first test, but the array has holes in it now.
    await act(async () => atlasPageAdded?.());
    await flushResync();

    expect(term.themeWrites).toBe(afterMerge + 1);
  });

  // The events fire from inside xterm's own model update, mid-frame. Re-entering
  // the renderer there clears the vertex array it is halfway through filling.
  it("defers the re-sync out of the frame the event fires in", async () => {
    render(view(true));
    await flushFrame();
    const term = terminals[0];

    await act(async () => atlasPageRemoved?.());
    const during = term.themeWrites;
    await flushResync();

    expect(term.themeWrites).toBe(during + 1);
  });
});

describe("clicked-path resolution", () => {
  beforeEach(() => {
    invoke.mockClear();
    terminals.length = 0;
    provider = null;
    bufferRows = [];
  });

  const pane = (onOpenPath: () => void, currentCwd?: string) => (
    <SettingsProvider>
      <TerminalPane
        {...props}
        visible
        onOpenPath={onOpenPath}
        startCwd="/repo"
        currentCwd={currentCwd}
      />
    </SettingsProvider>
  );

  function linksOn(row: number) {
    let links: TermLink[] = [];
    provider!.provideLinks(row, (l) => {
      links = l ?? [];
    });
    return links;
  }

  function clickFirstLink(row = 1) {
    linksOn(row)[0].activate({ metaKey: false, ctrlKey: false });
  }

  // A default zsh/bash never emits OSC 7, so the poll-derived cwd is the only
  // thing that follows `cd` — resolving against startCwd opens the wrong file.
  // This also pins the REF: read `currentCwd` as a plain prop inside openToken
  // and it freezes at the mount render, so this test goes red.
  it("resolves a relative path against the session's CURRENT cwd, not its start cwd", async () => {
    const onOpenPath = vi.fn();
    const { rerender } = render(pane(onOpenPath, "/repo"));
    await flushFrame();
    await act(async () => rerender(pane(onOpenPath, "/repo/packages/api")));

    setLine("src/App.tsx:12");
    clickFirstLink();
    expect(onOpenPath).toHaveBeenCalledWith("/repo/packages/api/src/App.tsx", 12);
  });

  it("falls back to startCwd before the first status poll lands", async () => {
    const onOpenPath = vi.fn();
    render(pane(onOpenPath, undefined));
    await flushFrame();
    setLine("src/App.tsx:12");
    clickFirstLink();
    expect(onOpenPath).toHaveBeenCalledWith("/repo/src/App.tsx", 12);
  });

  // An absolute path must be opened as written. Drop its leading separator and
  // it reads as relative, and the line above re-roots it under the session cwd.
  it("opens an absolute path as-is, not re-rooted at the cwd", async () => {
    const onOpenPath = vi.fn();
    render(pane(onOpenPath, "/repo"));
    await flushFrame();
    setLine("edited /Users/me/other/src/App.tsx:12");
    clickFirstLink();
    expect(onOpenPath).toHaveBeenCalledWith("/Users/me/other/src/App.tsx", 12);
  });

  // The reported bug: a screenshot path too long for the pane. Per ROW the head
  // has no extension (no link at all) and the tail links as a relative path, so
  // the click opened `<cwd>/hrome-…/shot.jpg` — "No preview available".
  const WRAPPED =
    "shut (/var/folders/v0/98f2gj3j4y54_m34wntqpd8c0000gn/T/claude-chrome-screenshots-lUHh5e/screenshot-1789918353418-3.jpg)";
  const WRAPPED_PATH = WRAPPED.slice("shut (".length, -1);

  it("rejoins a path that WRAPPED across rows, from either row", async () => {
    const onOpenPath = vi.fn();
    render(pane(onOpenPath, "/repo"));
    await flushFrame();
    setWrappedLine(WRAPPED);
    expect(bufferRows.length).toBeGreaterThan(1); // the wrap is the point

    clickFirstLink(bufferRows.length); // hovering the tail row, as the user did
    expect(onOpenPath).toHaveBeenCalledWith(WRAPPED_PATH, undefined);

    onOpenPath.mockClear();
    clickFirstLink(1); // and the head row gives the same link
    expect(onOpenPath).toHaveBeenCalledWith(WRAPPED_PATH, undefined);
  });

  // xterm hit-tests and underlines a link by its RANGE, so a rejoined token
  // whose range stayed on one row would highlight (and be clickable on) only
  // the row it was asked about.
  it("gives the rejoined link a range that spans the wrap", async () => {
    const onOpenPath = vi.fn();
    render(pane(onOpenPath, "/repo"));
    await flushFrame();
    setWrappedLine(WRAPPED);

    const [link] = linksOn(1);
    expect(link.text).toBe(WRAPPED_PATH);
    // 1-based, inclusive: starts after "shut (" on row 1, ends before the ")".
    expect(link.range.start).toEqual({ x: "shut (".length + 1, y: 1 });
    expect(link.range.end).toEqual({
      x: ((WRAPPED.length - 1 - 1) % TEST_COLS) + 1,
      y: bufferRows.length,
    });
  });
});
