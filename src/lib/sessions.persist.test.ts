// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSessions, isDivider, type RailItem, type Session } from "./sessions";

// The persisted layout is the app's only durable state, and its shape changes on
// most releases (the agent fields arrived in v0.1.23). These pin the round trip:
// what gets written, what comes back, and what a bad save degrades to.
//
// `IS_MAIN_WINDOW` needs no mocking — it is computed at module load inside a
// try/catch that defaults to true off-Tauri, deliberately "so the restore path
// stays exercised" in tests.
const KEY = "beecork.sessions.v1";
const save = (state: unknown) => localStorage.setItem(KEY, JSON.stringify(state));
const load = () => JSON.parse(localStorage.getItem(KEY)!);
const sessionsOf = (items: RailItem[]) => items.filter((i): i is Session => !isDivider(i));

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("session layout restore", () => {
  it("restores the saved layout, re-seeding startCwd from the saved cwd", () => {
    save({
      sessions: [
        { id: "a", name: "Session 1", custom: "build", cwd: "/repo", partner: "b" },
        { id: "b", name: "Session 2", cwd: "/other", partner: "a" },
      ],
      activeId: "b",
      nextNum: 7,
    });
    const { result } = renderHook(() => useSessions());
    const [a, b] = sessionsOf(result.current.items);
    expect(a).toMatchObject({
      id: "a",
      custom: "build",
      cwd: "/repo",
      startCwd: "/repo",
      partner: "b",
    });
    expect(b.startCwd).toBe("/other");
    expect(result.current.activeId).toBe("b");
  });

  it("restores the agent fields as a Resume offer", () => {
    const uuid = "21c89373-22e7-4064-8ef4-543836557a64";
    save({
      sessions: [{ id: "a", name: "Session 1", agent: "claude", agentSession: uuid }],
      activeId: "a",
      nextNum: 2,
    });
    const { result } = renderHook(() => useSessions());
    expect(sessionsOf(result.current.items)[0]).toMatchObject({
      resumeAgent: "claude",
      resumeSessionId: uuid,
    });
  });

  // Guards the resume allowlist at the load-bearing boundary: bad values are
  // already sitting in users' saved layouts, and restore runs before any write.
  it("drops a saved agent it cannot resume, and its conversation id with it", () => {
    save({
      sessions: [{ id: "a", name: "Session 1", agent: "vim", agentSession: "whatever" }],
      activeId: "a",
      nextNum: 2,
    });
    const { result } = renderHook(() => useSessions());
    const s = sessionsOf(result.current.items)[0];
    expect(s.resumeAgent).toBeUndefined();
    expect(s.resumeSessionId).toBeUndefined();
  });

  it("keeps dividers, in order, alongside the sessions", () => {
    save({
      sessions: [
        { kind: "divider", id: "d1", name: "work" },
        { id: "a", name: "Session 1" },
      ],
      activeId: "a",
      nextNum: 2,
    });
    const { result } = renderHook(() => useSessions());
    expect(result.current.items.map((i) => i.id)).toEqual(["d1", "a"]);
    expect(isDivider(result.current.items[0])).toBe(true);
    expect(sessionsOf(result.current.items)).toHaveLength(1); // dividers stay out of `sessions`
  });

  it("falls back to the first session when the saved activeId is gone", () => {
    save({ sessions: [{ id: "a", name: "Session 1" }], activeId: "vanished", nextNum: 2 });
    expect(renderHook(() => useSessions()).result.current.activeId).toBe("a");
  });

  it("starts fresh on corrupt storage", () => {
    localStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useSessions());
    const s = sessionsOf(result.current.items);
    expect(s).toHaveLength(1);
    expect(result.current.activeId).toBe(s[0].id);
  });

  // A divider-only save has no session to fall back to; restoring it would crash
  // on the non-null `items.find(…) as Session`. loadSessions rejects it instead.
  it("starts fresh when the save holds dividers but no session", () => {
    save({
      sessions: [{ kind: "divider", id: "d1", name: "work" }],
      activeId: "d1",
      nextNum: 2,
    });
    expect(sessionsOf(renderHook(() => useSessions()).result.current.items)).toHaveLength(1);
  });
});

describe("session layout save → load", () => {
  it("round-trips a renamed, cd'd session with its running agent", () => {
    const first = renderHook(() => useSessions());
    const id = sessionsOf(first.result.current.items)[0].id;
    act(() => {
      first.result.current.rename(id, "build");
      first.result.current.setCwd(id, "/repo/packages/api");
      first.result.current.setRunning(id, "claude");
    });
    first.unmount();

    expect(load()).toMatchObject({ activeId: id });
    const restored = sessionsOf(renderHook(() => useSessions()).result.current.items)[0];
    expect(restored).toMatchObject({
      id,
      custom: "build",
      cwd: "/repo/packages/api",
      startCwd: "/repo/packages/api",
      resumeAgent: "claude",
    });
    expect(restored.running).toBeUndefined(); // live-only, deliberately not restored
  });

  // The other half of the allowlist: a foreground editor must never be written
  // as something resumable in the first place.
  it("never persists a non-agent foreground command as a Resume offer", () => {
    const first = renderHook(() => useSessions());
    const id = sessionsOf(first.result.current.items)[0].id;
    act(() => first.result.current.setRunning(id, "vim"));
    first.unmount();
    expect(load().sessions[0].agent).toBeUndefined();
    expect(
      sessionsOf(renderHook(() => useSessions()).result.current.items)[0].resumeAgent
    ).toBeUndefined();
  });
});
