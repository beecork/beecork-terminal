import { describe, it, expect } from "vitest";
import {
  basename,
  dirname,
  joinPath,
  relativePath,
  breadcrumbs,
  parentDir,
  looksLikePath,
  splitFileLine,
  parseOsc7,
  changedAncestors,
  mediaKind,
  URL_RE,
  isLocalUrl,
} from "./paths";

describe("breadcrumbs", () => {
  it("splits a POSIX path, root first", () => {
    expect(breadcrumbs("/Users/me/project")).toEqual([
      { name: "/", path: "/" },
      { name: "Users", path: "/Users" },
      { name: "me", path: "/Users/me" },
      { name: "project", path: "/Users/me/project" },
    ]);
  });
  it("splits a Windows path with backslashes, drive first", () => {
    expect(breadcrumbs("C:\\Users\\me\\project")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "me", path: "C:\\Users\\me" },
      { name: "project", path: "C:\\Users\\me\\project" },
    ]);
  });
  it("tolerates a trailing separator", () => {
    const posix = breadcrumbs("/a/b/");
    expect(posix[posix.length - 1]).toEqual({ name: "b", path: "/a/b" });
    const win = breadcrumbs("C:\\a\\");
    expect(win[win.length - 1]).toEqual({ name: "a", path: "C:\\a" });
  });
  it("handles the roots themselves", () => {
    expect(breadcrumbs("/")).toEqual([{ name: "/", path: "/" }]);
    expect(breadcrumbs("C:\\")).toEqual([{ name: "C:", path: "C:\\" }]);
  });
  it("returns nothing for an empty path", () => {
    expect(breadcrumbs("")).toEqual([]);
  });
});

describe("parentDir", () => {
  it("goes up one level, POSIX", () => {
    expect(parentDir("/Users/me/project")).toBe("/Users/me");
    expect(parentDir("/Users")).toBe("/");
  });
  it("goes up one level, Windows", () => {
    expect(parentDir("C:\\Users\\me")).toBe("C:\\Users");
    expect(parentDir("C:\\Users")).toBe("C:\\");
  });
  it("stays put at a root (so callers can detect 'can't go up')", () => {
    expect(parentDir("/")).toBe("/");
    expect(parentDir("C:\\")).toBe("C:\\");
  });
});

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

describe("URL_RE", () => {
  const find = (text: string): string[] => {
    URL_RE.lastIndex = 0;
    return text.match(URL_RE) ?? [];
  };
  it("extracts http(s) URLs, including localhost with a port and path", () => {
    expect(find("  ➜  Local:   http://localhost:3000/")).toEqual(["http://localhost:3000/"]);
    expect(find("ready on https://127.0.0.1:5173/app")).toEqual(["https://127.0.0.1:5173/app"]);
  });
  it("drops trailing sentence punctuation", () => {
    expect(find("see http://localhost:3000.")).toEqual(["http://localhost:3000"]);
    expect(find("(open https://example.com/x)")).toEqual(["https://example.com/x"]);
  });
  it("finds multiple URLs on one line", () => {
    expect(find("a http://a.com b https://b.com/y c")).toEqual(["http://a.com", "https://b.com/y"]);
  });
  it("ignores bare paths and non-http schemes", () => {
    expect(find("src/App.tsx and file:///etc/hosts")).toEqual([]);
  });
});

describe("isLocalUrl", () => {
  it("is true for loopback hosts", () => {
    expect(isLocalUrl("http://localhost:3000/")).toBe(true);
    expect(isLocalUrl("https://127.0.0.1:5173")).toBe(true);
    expect(isLocalUrl("http://0.0.0.0:8080/x")).toBe(true);
  });
  it("is false for external hosts", () => {
    expect(isLocalUrl("https://example.com")).toBe(false);
    expect(isLocalUrl("http://localhost.evil.com")).toBe(false);
  });
});
