import { describe, it, expect } from "vitest";
import {
  displayName,
  wantsAttention,
  resumeCommand,
  isDivider,
  moveBefore,
  type RailItem,
  type Session,
} from "./sessions";

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

describe("isDivider", () => {
  it("distinguishes dividers from sessions", () => {
    const items: RailItem[] = [
      { id: "s1", name: "Session 1" },
      { kind: "divider", id: "d1", name: "project A" },
    ];
    expect(isDivider(items[0])).toBe(false);
    expect(isDivider(items[1])).toBe(true);
  });
});

describe("moveBefore", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ids = (l: { id: string }[]) => l.map((x) => x.id).join("");

  it("moves an item before another", () => {
    expect(ids(moveBefore(list, "c", "a"))).toBe("cab");
  });

  it("moves an item to the end (beforeId null)", () => {
    expect(ids(moveBefore(list, "a", null))).toBe("bca");
  });

  it("moves an item down past a later item", () => {
    expect(ids(moveBefore(list, "a", "c"))).toBe("bac");
  });

  it("returns the SAME array when already in place", () => {
    expect(moveBefore(list, "a", "b")).toBe(list);
    expect(moveBefore(list, "c", null)).toBe(list);
    expect(moveBefore(list, "b", "b")).toBe(list);
  });

  it("returns the SAME array for unknown ids", () => {
    expect(moveBefore(list, "nope", "a")).toBe(list);
    expect(moveBefore(list, "a", "nope")).toBe(list);
  });
});

describe("resumeCommand", () => {
  it("knows how to resume Claude Code and Codex", () => {
    expect(resumeCommand("claude")).toBe("claude --continue");
    expect(resumeCommand("codex")).toBe("codex resume");
  });

  it("falls back to <agent> --continue for anything else", () => {
    expect(resumeCommand("aider")).toBe("aider --continue");
  });
});
