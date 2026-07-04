import { describe, it, expect } from "vitest";
import { displayName, wantsAttention, type Session } from "./sessions";

describe("displayName", () => {
  const base: Session = { id: "1", name: "Session 1" };

  it("falls back to the base name", () => {
    expect(displayName(base)).toBe("Session 1");
  });

  it("prefers the dynamic (terminal) title over the base name", () => {
    expect(displayName({ ...base, dynamic: "~/project" })).toBe("~/project");
  });

  it("prefers a user-chosen custom name over everything", () => {
    expect(displayName({ ...base, dynamic: "~/project", custom: "build" })).toBe("build");
  });

  it("prefers a running tool over the cwd basename", () => {
    expect(displayName({ ...base, running: "claude", cwd: "/a/b" })).toBe("claude");
  });

  it("prefers the dynamic title over a running tool", () => {
    expect(displayName({ ...base, dynamic: "task", running: "claude" })).toBe("task");
  });

  it("falls back to the cwd basename when nothing better exists", () => {
    expect(displayName({ ...base, cwd: "/Users/me/project" })).toBe("project");
  });

  it("handles a trailing-slash cwd", () => {
    expect(displayName({ ...base, cwd: "/a/b/" })).toBe("b");
  });

  it("handles a root cwd", () => {
    expect(displayName({ ...base, cwd: "/" })).toBe("/");
  });
});

describe("wantsAttention", () => {
  it("fires when a background command finishes (running → idle)", () => {
    expect(wantsAttention("claude", undefined, false)).toBe(true);
  });

  it("does not fire for the active session", () => {
    expect(wantsAttention("claude", undefined, true)).toBe(false);
  });

  it("does not fire on first observation (was undefined)", () => {
    expect(wantsAttention(undefined, undefined, false)).toBe(false);
  });

  it("does not fire when a command merely starts (idle → running)", () => {
    expect(wantsAttention(undefined, "claude", false)).toBe(false);
  });

  it("does not fire while a command keeps running", () => {
    expect(wantsAttention("claude", "claude", false)).toBe(false);
  });
});
