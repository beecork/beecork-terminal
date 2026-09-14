// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { Session } from "./sessions";

// Every one of these ends in a Tauri `invoke`, so all three must be mocked.
const ptyStatus = vi.fn(() =>
  Promise.resolve({ cwd: null, running: null, agent_session: null })
);
const ptyStatusAll = vi.fn(() => Promise.resolve({} as Record<string, unknown>));
vi.mock("./api", () => ({
  getRoot: () => Promise.resolve("/"),
  ptyStatus: (...a: unknown[]) => ptyStatus(...(a as [])),
  ptyStatusAll: (...a: unknown[]) => ptyStatusAll(...(a as [])),
}));
const attention = vi.fn();
vi.mock("./sound", () => ({ attention: (...a: unknown[]) => attention(...(a as [])) }));
vi.mock("./notify", () => ({ notify: vi.fn() }));

import { useSessionStatus } from "./useSessionStatus";

// The constants under test, mirrored from the hook.
const QUIET_MS = 1500;
const ATTN_QUIET_MS = 6000;
const INFER_RECHIME_MS = 60_000;

const SESSIONS: Session[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
];

function setup(initial?: { activeId?: string; visibleIds?: string[] }) {
  const setCwd = vi.fn();
  const setRunning = vi.fn();
  const setAgentId = vi.fn();
  const view = renderHook(
    ({ activeId, visibleIds }: { activeId: string; visibleIds: string[] }) =>
      useSessionStatus(SESSIONS, activeId, visibleIds, setCwd, setRunning, setAgentId, "/tmp"),
    {
      initialProps: {
        activeId: initial?.activeId ?? "a",
        visibleIds: initial?.visibleIds ?? ["a"],
      },
    }
  );
  return { ...view, setCwd, setRunning, setAgentId };
}

/** Advance timers and let the mocked promises settle. */
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** A real turn of work: an output streak longer than the hook's WORK_MIN_MS
 *  (2500ms) gate, then silence. Below that gate a burst is a stray redraw. */
async function workStreak(onActivity: (id: string) => void, id: string) {
  for (let i = 0; i < 7; i++) {
    act(() => onActivity(id));
    await tick(500);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  attention.mockClear();
  ptyStatus.mockClear();
  ptyStatusAll.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("busy dot and the WORK_MIN_MS gate", () => {
  // A spinner tick or a statusline repaint is not a finished turn. Nagging on
  // those lit every quiet background agent amber at once and drowned the signal.
  it("a brief output blip never flags attention", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    act(() => result.current.onActivity("b"));
    expect(result.current.busy.has("b")).toBe(true);

    await tick(QUIET_MS + 100);
    expect(result.current.busy.has("b")).toBe(false); // busy clears…
    await tick(ATTN_QUIET_MS);
    expect(result.current.wantsYou.has("b")).toBe(false); // …but never nags
    expect(attention).not.toHaveBeenCalled();
  });

  // The streak start lives in `busySince`, written OUTSIDE the setBusy updater
  // (React requires updaters to be pure). This pins the re-arm that fix depends
  // on: once a streak ends, the next one must measure from its OWN first chunk.
  // If someone later stops deleting the key when the streak ends, a short second
  // burst would inherit the first streak's start, read as a long turn, and nag.
  it("a second short burst after an idle gap re-measures from its own start", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b"); // a real turn…
    await tick(QUIET_MS + 100); // …ends, and the idle timer clears the streak
    attention.mockClear();

    act(() => result.current.onActivity("b")); // one chunk — not a turn
    await tick(ATTN_QUIET_MS + 500);
    expect(result.current.wantsYou.has("b")).toBe(false);
    expect(attention).not.toHaveBeenCalled();
  });

  // Flagging at QUIET_MS chimed in the MIDDLE of agent turns (API latency between
  // tool rounds reads as silence); only a much longer pause means "finished".
  it("a real streak flags only after the full quiet window, and chimes once", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b");

    await tick(QUIET_MS + 100);
    expect(result.current.busy.has("b")).toBe(false);
    expect(result.current.wantsYou.has("b")).toBe(false); // not yet

    await tick(ATTN_QUIET_MS - QUIET_MS + 100);
    expect(result.current.wantsYou.has("b")).toBe(true);
    expect(attention).toHaveBeenCalledTimes(1);
  });
});

describe("visibility, not focus", () => {
  // The project rule: a pane you can SEE never nags — in a split both count,
  // even the one that doesn't have keyboard focus.
  it("a visible but unfocused split pane never flags", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a", "b"] });
    await workStreak(result.current.onActivity, "b");
    await tick(ATTN_QUIET_MS + 500);
    expect(result.current.wantsYou.has("b")).toBe(false);
    expect(attention).not.toHaveBeenCalled();
  });

  // Visibility is evaluated when the timer FIRES, not when it was armed.
  it("becoming visible before the timer fires cancels the nag", async () => {
    const { result, rerender } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b");
    await tick(QUIET_MS + 100);
    rerender({ activeId: "a", visibleIds: ["a", "b"] }); // user opens the split
    await tick(ATTN_QUIET_MS);
    expect(result.current.wantsYou.has("b")).toBe(false);
  });
});

describe("bell stickiness vs quiet-inferred attention", () => {
  it("a bell stays flagged through new output and clears only when seen", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    act(() => result.current.onBell("b"));
    expect(result.current.wantsYou.has("b")).toBe(true);
    expect(attention).toHaveBeenCalledTimes(1);

    act(() => result.current.onActivity("b")); // agent resumes talking
    expect(result.current.wantsYou.has("b")).toBe(true); // still sticky

    act(() => result.current.onSeen("b"));
    expect(result.current.wantsYou.has("b")).toBe(false);
  });

  it("a quiet-inferred flag self-clears when output resumes", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b");
    await tick(ATTN_QUIET_MS + 500);
    expect(result.current.wantsYou.has("b")).toBe(true);

    act(() => result.current.onActivity("b")); // it was still working after all
    expect(result.current.wantsYou.has("b")).toBe(false);
  });

  // A session that flaps (stall → flag → output resumes → stall…) must not keep
  // calling you. The dot still lights; only the repeat sound is suppressed.
  it("rate-limits the repeat chime for an inferred flag but not a bell", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b");
    await tick(ATTN_QUIET_MS + 500);
    expect(attention).toHaveBeenCalledTimes(1);

    act(() => result.current.onActivity("b")); // clears it
    await workStreak(result.current.onActivity, "b");
    await tick(ATTN_QUIET_MS + 500);
    expect(result.current.wantsYou.has("b")).toBe(true); // flagged again…
    expect(attention).toHaveBeenCalledTimes(1); // …silently

    // A bell is a precise signal and is exempt from the rate limit.
    act(() => result.current.onSeen("b"));
    act(() => result.current.onBell("b"));
    expect(attention).toHaveBeenCalledTimes(2);

    // Past the window, an inferred flag may chime again.
    act(() => result.current.onSeen("b"));
    await tick(INFER_RECHIME_MS);
    await workStreak(result.current.onActivity, "b");
    await tick(ATTN_QUIET_MS + 500);
    expect(attention).toHaveBeenCalledTimes(3);
  });
});

describe("closed sessions", () => {
  it("markClosed drops the session's bookkeeping and its flag", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    act(() => result.current.onBell("b"));
    expect(result.current.wantsYou.has("b")).toBe(true);
    act(() => result.current.markClosed("b"));
    expect(result.current.wantsYou.has("b")).toBe(false);
    expect(result.current.busy.has("b")).toBe(false);
  });
});

// ---- guards for the two fixes this file was written alongside ----------------

describe("action before sound (flagWants)", () => {
  // Sound is best-effort; the attention flag is not. A throwing chime must never
  // cost the user their dot and OS notification.
  it("still flags the session when the chime throws", () => {
    attention.mockImplementationOnce(() => {
      throw new Error("no audio device");
    });
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    act(() => result.current.onBell("b")); // must not throw out of the hook
    expect(result.current.wantsYou.has("b")).toBe(true);
    expect(attention).toHaveBeenCalledTimes(1);
  });
});

describe("out-of-order status replies", () => {
  // The commands became `#[tauri::command(async)]` in v0.1.25, so replies now
  // arrive in completion order, not call order. A slow one must not overwrite a
  // fresh one — here a stale "idle" landing after a fresh "claude is running"
  // would otherwise look like a command finished, and chime.
  it("a stale reply cannot overwrite a fresher one for the same session", async () => {
    let resolveSlow: (v: Record<string, unknown>) => void = () => {};
    const slow = new Promise<Record<string, unknown>>((r) => (resolveSlow = r));
    ptyStatusAll.mockReturnValueOnce(slow); // tick 1: hangs
    ptyStatusAll.mockReturnValueOnce(
      Promise.resolve({ b: { cwd: null, running: "claude", agent_session: null } })
    );

    const { result, setRunning } = setup({ activeId: "a", visibleIds: ["a"] });
    await tick(2000); // tick 1 issued, still pending
    await tick(2000); // tick 2 issued and applied: b is running claude
    expect(setRunning).toHaveBeenCalledWith("b", "claude");
    setRunning.mockClear();

    // Now the FIRST tick's reply finally lands, saying b is idle.
    await act(async () => {
      resolveSlow({ b: { cwd: null, running: null, agent_session: null } });
      await Promise.resolve();
    });

    expect(setRunning).not.toHaveBeenCalledWith("b", undefined);
    expect(result.current.wantsYou.has("b")).toBe(false); // no phantom "finished"
  });
});

describe("a status tick that could not read the foreground command", () => {
  // `running: null` has two causes with opposite meanings: the shell really is
  // idle at its prompt (= "your command finished, come look" — it chimes), or the
  // backend could not read the foreground command this tick. Acting on the second
  // is a phantom completion: amber dot + chime on a tab whose agent is still
  // sitting there, which is exactly what it looked like from the outside.
  it("never reads as a finished command, and holds the running label", async () => {
    ptyStatusAll.mockReturnValue(
      Promise.resolve({ b: { cwd: null, running: "claude", agent_session: "conv-1" } })
    );
    const { result, setRunning, setAgentId } = setup({ activeId: "a", visibleIds: ["a"] });
    await tick(2100);
    expect(setRunning).toHaveBeenCalledWith("b", "claude");
    setRunning.mockClear();
    setAgentId.mockClear();

    // Now a tick that simply couldn't tell.
    ptyStatusAll.mockReturnValue(
      Promise.resolve({
        b: { cwd: null, running: null, running_known: false, agent_session: null },
      })
    );
    await tick(2100);

    expect(result.current.wantsYou.has("b")).toBe(false);
    expect(attention).not.toHaveBeenCalled();
    expect(setRunning).not.toHaveBeenCalled(); // label held, not wiped
    expect(setAgentId).not.toHaveBeenCalled(); // resume id held too

    // A tick that CAN tell, and says idle, is the real signal — it still fires.
    ptyStatusAll.mockReturnValue(
      Promise.resolve({
        b: { cwd: null, running: null, running_known: true, agent_session: null },
      })
    );
    await tick(2100);
    expect(result.current.wantsYou.has("b")).toBe(true);
    expect(attention).toHaveBeenCalledTimes(1);
  });
});

describe("quiet timers that fire after the app was suspended", () => {
  // macOS freezes a backgrounded / asleep window's timers and releases them all
  // when you come back, so the 1.5s + 4.5s quiet timers can land hours late. The
  // silence they measured is the app being frozen, not the agent finishing —
  // inferring "needs you" from it lights a tab amber and chimes for a turn that
  // ended long ago, at a moment when nothing happened at all.
  it("does not infer 'needs you' from silence measured across a suspension", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b");

    // The app is frozen for an hour with the quiet timers armed, then resumes:
    // the wall clock jumped, the timers did not run.
    vi.setSystemTime(Date.now() + 3_600_000);
    await tick(ATTN_QUIET_MS + 1000);

    expect(result.current.wantsYou.has("b")).toBe(false);
    expect(attention).not.toHaveBeenCalled();
    expect(result.current.busy.has("b")).toBe(false); // the dot still goes out
  });

  // The suspension can also begin in the SECOND window — after the busy dot went
  // off and the attention timer was armed, but before the quiet window completed.
  // That timer needs its own guard; the one on the first cannot see this.
  it("does not infer it when the suspension begins inside the attention window", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    await workStreak(result.current.onActivity, "b");
    await tick(QUIET_MS + 100); // busy dot off, attention timer armed
    expect(result.current.wantsYou.has("b")).toBe(false);

    vi.setSystemTime(Date.now() + 3_600_000); // frozen here, resumed an hour later
    await tick(ATTN_QUIET_MS);

    expect(result.current.wantsYou.has("b")).toBe(false);
    expect(attention).not.toHaveBeenCalled();
  });

  // Only the guessed signal is dropped. A bell is the agent explicitly asking for
  // you and must survive the same resume.
  it("still flags a bell that arrives after a suspension", async () => {
    const { result } = setup({ activeId: "a", visibleIds: ["a"] });
    vi.setSystemTime(Date.now() + 3_600_000);
    act(() => result.current.onBell("b"));
    expect(result.current.wantsYou.has("b")).toBe(true);
    expect(attention).toHaveBeenCalledTimes(1);
  });
});
