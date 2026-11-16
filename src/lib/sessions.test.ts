import { describe, it, expect } from "vitest";
import {
  displayName,
  nameFromTitle,
  wantsAttention,
  resumeCommand,
  isResumableAgent,
  isDivider,
  isMark,
  MARKS,
  moveBefore,
  toggleMarkIn,
  type RailItem,
  type Session,
  splitLayout,
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

// Every title below is a real capture from ConPTY on Windows 11, not a guess at
// a format — the doubled space after the command's first word included.
describe("nameFromTitle", () => {
  const CMD = "C:\\WINDOWS\\system32\\cmd.exe";

  it("counts a console's placeholder — the path of its shell — as no title", () => {
    for (const placeholder of [
      CMD,
      "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\pwsh.exe",
    ]) {
      expect(nameFromTitle(placeholder)).toBe("");
    }
    // Not captured, but the same thing by construction: a shell on a share, a
    // path spelled with forward slashes, one with ` - ` in a folder name.
    expect(nameFromTitle("\\\\server\\tools\\nu.exe")).toBe("");
    expect(nameFromTitle("c:/tools/nu.exe")).toBe("");
    expect(nameFromTitle("C:\\My - Tools\\cmd.exe")).toBe("");
  });

  // The point of the whole function: with the placeholder gone, `displayName`
  // reaches the folder — on Windows it never did.
  it("so a session at its prompt is named after its folder", () => {
    const s: Session = { id: "1", name: "Session 1", cwd: "C:\\Users\\me\\project" };
    expect(displayName({ ...s, dynamic: CMD })).toBe(CMD);
    expect(displayName({ ...s, dynamic: nameFromTitle(CMD) || undefined })).toBe("project");
  });

  it("keeps the command cmd appends to its placeholder while one runs", () => {
    expect(nameFromTitle(`${CMD} - ping  -n 3 localhost`)).toBe("ping  -n 3 localhost");
    // The path ends at the FIRST `.exe` a command can follow, so a command that
    // names an executable of its own survives whole.
    expect(nameFromTitle(`${CMD} - C:\\tools\\build.exe - fast`)).toBe("C:\\tools\\build.exe - fast");
  });

  it("lets through every title somebody chose", () => {
    for (const chosen of [
      "My Work", // cmd's `title My Work`…
      "My Work - ping  -n 2 localhost", // …and what cmd makes of it while a command runs
      "✳ Claude Code",
      "~/project",
      "MINGW64:/c/Users/me",
      "C:\\Users\\me\\project", // a folder, not a program
      "cmd.exe", // a bare name is not a path
      "C:\\notes.exe.txt - Notepad", // `.exe` in the middle of a name ends nothing
    ]) {
      expect(nameFromTitle(chosen)).toBe(chosen);
    }
  });

  // Windows puts this prefix on an elevated console's title itself. Dropping
  // the placeholder here would drop the only sign on the tab that it is elevated.
  it("leaves an elevated console's title alone", () => {
    const elevated = `Administrator: ${CMD}`;
    expect(nameFromTitle(elevated)).toBe(elevated);
  });

  // A title is terminal output — hostile input — and xterm lets one run to
  // megabytes. Without the `s` flag this one is rescanned from every `.exe` in
  // it: seconds here, and minutes at the size a program can really send.
  it("is not slowed down by a title built to backtrack", () => {
    const hostile = "C:\\" + ".exe - x".repeat(20_000) + "\u2028y";
    const started = performance.now();
    nameFromTitle(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
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
  it("knows how to resume Claude Code and Codex (latest conversation)", () => {
    expect(resumeCommand("claude")).toBe("claude --continue");
    expect(resumeCommand("codex")).toBe("codex resume");
  });

  // The pill's command is typed into the shell WITH a trailing Enter, and `agent`
  // is just the foreground process basename — so anything not on the allowlist
  // gets no pill at all rather than a command that doesn't exist. `aider
  // --continue` was never a real flag; the old fallback was already broken.
  it("offers nothing for an agent we don't know how to resume", () => {
    expect(resumeCommand("aider")).toBeNull();
    expect(resumeCommand("vim")).toBeNull();
    expect(resumeCommand("vim", "21c89373-22e7-4064-8ef4-543836557a64")).toBeNull();
    expect(isResumableAgent("claude")).toBe(true);
    expect(isResumableAgent("codex")).toBe(true);
    expect(isResumableAgent("vim")).toBe(false);
    expect(isResumableAgent(undefined)).toBe(false);
  });

  it("resumes a SPECIFIC conversation when given its id (per-tab resume)", () => {
    const id = "21c89373-22e7-4064-8ef4-543836557a64";
    expect(resumeCommand("claude", id)).toBe(`claude --resume ${id}`);
    expect(resumeCommand("codex", id)).toBe(`codex resume ${id}`);
  });
});

describe("splitLayout", () => {
  const S = (id: string, partner?: string): Session => ({ id, name: id, partner });

  it("is not split when the focused session has no partner", () => {
    const sessions = [S("a"), S("b")];
    expect(splitLayout(sessions, "a")).toEqual({
      leftId: "a",
      rightId: null,
      visibleIds: ["a"],
    });
  });

  it("orders panes by rail position, not by which one is focused", () => {
    const sessions = [S("a", "b"), S("b", "a")];
    // Focus either side — "a" comes first in the rail, so it stays on the left.
    expect(splitLayout(sessions, "a")).toEqual({
      leftId: "a",
      rightId: "b",
      visibleIds: ["a", "b"],
    });
    expect(splitLayout(sessions, "b")).toEqual({
      leftId: "a",
      rightId: "b",
      visibleIds: ["a", "b"],
    });
  });

  it("ignores a partner that has since closed", () => {
    const sessions = [S("a", "gone")];
    expect(splitLayout(sessions, "a")).toEqual({
      leftId: "a",
      rightId: null,
      visibleIds: ["a"],
    });
  });

  it("ignores a session paired with itself", () => {
    const sessions = [S("a", "a")];
    expect(splitLayout(sessions, "a").rightId).toBeNull();
  });

  it("treats an unknown focused id as unsplit", () => {
    expect(splitLayout([S("a")], "nope")).toEqual({
      leftId: "nope",
      rightId: null,
      visibleIds: ["nope"],
    });
  });
});

// The user's own colour marks. Their MEANING is the user's; these pin the two
// properties the app owns — that toggling is symmetric, and that a value from
// storage is never trusted.
describe("session marks", () => {
  it("toggles a mark on and back off", () => {
    expect(toggleMarkIn(undefined, "red")).toEqual(["red"]);
    expect(toggleMarkIn(["red"], "red")).toBeUndefined();
  });

  it("holds several at once, because the meanings are independent", () => {
    // "waiting for deploy" AND "want to close this" is a real combination.
    let m = toggleMarkIn(undefined, "red");
    m = toggleMarkIn(m, "teal");
    m = toggleMarkIn(m, "green");
    expect(m).toEqual(["red", "teal", "green"]);
    // Removing the middle one leaves the others untouched.
    expect(toggleMarkIn(m, "teal")).toEqual(["red", "green"]);
  });

  it("returns undefined rather than an empty array when the last mark goes", () => {
    // Absent, not empty: `JSON.stringify` drops the key entirely, so an unmarked
    // session costs nothing in storage and reads as never-marked on restore.
    expect(toggleMarkIn(["green"], "green")).toBeUndefined();
  });

  // Storage is untrusted input, exactly like `resumeAgent`. Guarding only the
  // WRITE would still surface a bad value on the next launch, because restore
  // runs first — the same trap a previous release already paid for.
  it("rejects anything that is not a known mark", () => {
    for (const m of MARKS) expect(isMark(m)).toBe(true);
    for (const bad of ["amber", "blue", "", "RED", 1, null, undefined, {}]) {
      expect(isMark(bad)).toBe(false);
    }
  });

  // Amber and blue are the status dot's — a mark in either would be misread as
  // the attention signal, which is the one thing a marking system must not do.
  it("never uses a colour the status dot already speaks", () => {
    expect(MARKS).not.toContain("amber");
    expect(MARKS).not.toContain("blue");
    expect(MARKS).not.toContain("yellow");
  });
});
