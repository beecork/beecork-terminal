import { describe, it, expect } from "vitest";
import {
  basename,
  looksLikePath,
  splitFileLine,
  parseOsc7,
  changedAncestors,
} from "./paths";

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("/Users/me/project")).toBe("project");
  });
  it("tolerates a trailing slash", () => {
    expect(basename("/a/b/")).toBe("b");
  });
  it("returns '/' for root", () => {
    expect(basename("/")).toBe("/");
  });
});

describe("looksLikePath", () => {
  it("accepts a path with a slash", () => {
    expect(looksLikePath("src/App.tsx")).toBe(true);
  });
  it("accepts a bare code filename by extension", () => {
    expect(looksLikePath("main.rs")).toBe(true);
  });
  it("accepts a file with a :line suffix", () => {
    expect(looksLikePath("main.rs:42")).toBe(true);
  });
  it("rejects a plain word with no path/extension", () => {
    expect(looksLikePath("hello")).toBe(false);
  });
});

describe("splitFileLine", () => {
  it("splits file:line", () => {
    expect(splitFileLine("src/App.tsx:42")).toEqual({ file: "src/App.tsx", line: 42 });
  });
  it("splits file:line:col (col ignored)", () => {
    expect(splitFileLine("a.ts:12:5")).toEqual({ file: "a.ts", line: 12 });
  });
  it("returns just the file when there's no position", () => {
    expect(splitFileLine("a.ts")).toEqual({ file: "a.ts" });
  });
});

describe("parseOsc7", () => {
  it("parses a file:// url to an absolute path", () => {
    expect(parseOsc7("file://host/Users/me/proj")).toBe("/Users/me/proj");
  });
  it("percent-decodes", () => {
    expect(parseOsc7("file://host/a%20b/c")).toBe("/a b/c");
  });
  it("returns null for a non-file payload", () => {
    expect(parseOsc7("https://example.com")).toBeNull();
  });
});

describe("changedAncestors", () => {
  it("adds every ancestor up to root", () => {
    const s = changedAncestors(["/repo/a/b/x.ts"], "/repo");
    expect([...s].sort()).toEqual(["/repo", "/repo/a", "/repo/a/b"]);
  });
  it("unions ancestors across files without dupes", () => {
    const s = changedAncestors(["/repo/a/x.ts", "/repo/a/y.ts", "/repo/b/z.ts"], "/repo");
    expect([...s].sort()).toEqual(["/repo", "/repo/a", "/repo/b"]);
  });
  it("returns empty for an empty root", () => {
    expect(changedAncestors(["/repo/a/x.ts"], "").size).toBe(0);
  });
});
