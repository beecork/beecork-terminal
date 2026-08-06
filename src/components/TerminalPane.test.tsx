// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

// xterm and the Tauri bridge are the two things a jsdom test cannot have: one
// wants a real canvas/GPU, the other a Rust backend. Both are mocked to the
// smallest surface this component actually touches, so the test is about OUR
// ordering logic and nothing else.
const terminals: { opened: number; disposed: number }[] = [];

// jsdom has no ResizeObserver; the pane installs one to refit on resize.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { type: "normal", getLine: () => null } };
    parser = { registerOscHandler: () => ({ dispose: () => {} }) };
    private rec: { opened: number; disposed: number };
    constructor() {
      this.rec = { opened: 0, disposed: 0 };
      terminals.push(this.rec);
    }
    open() {
      this.rec.opened++;
    }
    dispose() {
      this.rec.disposed++;
    }
    loadAddon() {}
    focus() {}
    write() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {
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
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
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
});
