import { describe, it, expect } from "vitest";
import {
  basename,
  dirname,
  joinPath,
  relativePath,
  looksLikePath,
  splitFileLine,
  parseOsc7,
  changedAncestors,
  mediaKind,
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

describe("dirname", () => {
  it("returns the parent directory", () => {
    expect(dirname("/a/b/c")).toBe("/a/b");
  });
  it("tolerates a trailing slash", () => {
    expect(dirname("/a/b/")).toBe("/a");
  });
  it("returns '/' for a top-level entry", () => {
    expect(dirname("/a")).toBe("/");
  });
  it("returns '' for a bare name", () => {
    expect(dirname("a")).toBe("");
  });
});

describe("joinPath", () => {
  it("joins with a single separator", () => {
    expect(joinPath("/a/b", "c.txt")).toBe("/a/b/c.txt");
  });
  it("collapses redundant separators", () => {
    expect(joinPath("/a/b/", "/c.txt")).toBe("/a/b/c.txt");
  });
});

describe("relativePath", () => {
  it("strips the root prefix", () => {
    expect(relativePath("/r/a/b", "/r")).toBe("a/b");
  });
  it("tolerates a trailing slash on root", () => {
    expect(relativePath("/r/a", "/r/")).toBe("a");
  });
  it("returns the basename when the path is the root itself", () => {
    expect(relativePath("/r", "/r")).toBe("r");
  });
  it("returns the full path when outside the root", () => {
    expect(relativePath("/other/x", "/r")).toBe("/other/x");
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

describe("mediaKind", () => {
  it("classifies images, video, and audio by extension", () => {
    expect(mediaKind("a.png")).toBe("image");
    expect(mediaKind("clip.mp4")).toBe("video");
    expect(mediaKind("song.flac")).toBe("audio");
  });
  it("is case-insensitive on the extension", () => {
    expect(mediaKind("PHOTO.JPG")).toBe("image");
    expect(mediaKind("Clip.MP4")).toBe("video");
  });
  it("returns null for text/code and unknown extensions", () => {
    expect(mediaKind("notes.txt")).toBeNull();
    expect(mediaKind("main.ts")).toBeNull();
    expect(mediaKind("data.bin")).toBeNull();
  });
  it("treats svg as editable text, not an image", () => {
    expect(mediaKind("icon.svg")).toBeNull();
  });
  it("returns null for extensionless paths and dotfiles", () => {
    expect(mediaKind("README")).toBeNull();
    expect(mediaKind("/repo/.env")).toBeNull();
  });
});
