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
  isAbsolute,
  isDirectChild,
  PATH_RE,
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
  // Regression: this used to return the WHOLE path on Windows, so the title bar
  // and every session name showed "C:\Users\me\proj" instead of "proj".
  it("returns the last segment of a Windows path", () => {
    expect(basename("C:\\Users\\me\\proj")).toBe("proj");
    expect(basename("C:\\a\\b\\")).toBe("b");
    expect(basename("C:\\")).toBe("C:");
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
  // Regression: this returned "" on Windows, so "New file…" / "Rename…" built
  // "/name" and wrote to the drive root instead of the containing folder.
  it("returns the parent of a Windows path", () => {
    expect(dirname("C:\\Users\\me\\main.rs")).toBe("C:\\Users\\me");
    expect(dirname("C:\\a")).toBe("C:\\");
  });
});

describe("joinPath", () => {
  it("joins with a single separator", () => {
    expect(joinPath("/a/b", "c.txt")).toBe("/a/b/c.txt");
  });
  it("collapses redundant separators", () => {
    expect(joinPath("/a/b/", "/c.txt")).toBe("/a/b/c.txt");
  });
  it("keeps a Windows path a Windows path", () => {
    expect(joinPath("C:\\a\\b", "c.txt")).toBe("C:\\a\\b\\c.txt");
    expect(joinPath("C:\\", "c.txt")).toBe("C:\\c.txt");
  });
  it("round-trips dirname → joinPath on Windows (the new-file path)", () => {
    expect(joinPath(dirname("C:\\p\\src\\main.rs"), "new.rs")).toBe("C:\\p\\src\\new.rs");
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
  it("strips a Windows root prefix", () => {
    expect(relativePath("C:\\r\\a\\b", "C:\\r")).toBe("a\\b");
    expect(relativePath("C:\\r", "C:\\r")).toBe("r");
  });
  // A sibling whose name merely *starts with* the root name is not inside it.
  it("does not treat a name-prefix sibling as inside the root", () => {
    expect(relativePath("/repoX/a", "/repo")).toBe("/repoX/a");
    expect(relativePath("C:\\repoX\\a", "C:\\repo")).toBe("C:\\repoX\\a");
  });
});

describe("isAbsolute", () => {
  it("accepts POSIX, Windows drive, and UNC paths", () => {
    expect(isAbsolute("/a/b")).toBe(true);
    expect(isAbsolute("C:\\a")).toBe(true);
    expect(isAbsolute("C:/a")).toBe(true);
    expect(isAbsolute("\\\\server\\share")).toBe(true);
  });
  it("rejects relative paths", () => {
    expect(isAbsolute("src/App.tsx")).toBe(false);
    expect(isAbsolute("src\\App.tsx")).toBe(false);
    expect(isAbsolute("./a")).toBe(false);
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

describe("PATH_RE", () => {
  const find = (text: string): string[] => {
    PATH_RE.lastIndex = 0;
    return text.match(PATH_RE) ?? [];
  };
  it("finds POSIX paths with an optional :line:col", () => {
    expect(find("see src/App.tsx:42 for details")).toEqual(["src/App.tsx:42"]);
    expect(find("edited lib/paths.ts")).toEqual(["lib/paths.ts"]);
  });
  it("finds Windows paths, drive and all", () => {
    expect(find("wrote C:\\Users\\me\\proj\\src\\main.rs")).toEqual([
      "C:\\Users\\me\\proj\\src\\main.rs",
    ]);
    expect(find("at src\\main.rs:12:5")).toEqual(["src\\main.rs:12:5"]);
  });
  it("keeps the drive colon out of the :line suffix", () => {
    expect(splitFileLine("C:\\a\\b.ts:12")).toEqual({ file: "C:\\a\\b.ts", line: 12 });
    expect(splitFileLine("C:\\a\\b.ts")).toEqual({ file: "C:\\a\\b.ts" });
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
  // Regression: on Windows this used to return the changed FILE's own path and
  // no directories at all, so no folder in the tree ever coloured.
  it("adds every ancestor up to root on Windows", () => {
    const s = changedAncestors(["C:\\repo\\a\\b\\x.ts"], "C:\\repo");
    expect([...s].sort()).toEqual(["C:\\repo", "C:\\repo\\a", "C:\\repo\\a\\b"]);
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

describe("isDirectChild", () => {
  it("is true only for an entry directly inside the directory", () => {
    expect(isDirectChild("/repo/a.ts", "/repo")).toBe(true);
    expect(isDirectChild("/repo/sub/a.ts", "/repo")).toBe(false);
    expect(isDirectChild("/repo/sub/a.ts", "/repo/sub")).toBe(true);
  });
  it("tolerates a trailing separator on the directory", () => {
    expect(isDirectChild("/repo/a.ts", "/repo/")).toBe(true);
  });
  it("works at the filesystem root", () => {
    expect(isDirectChild("/a", "/")).toBe(true);
    expect(isDirectChild("/a/b", "/")).toBe(false);
  });
  it("works on Windows paths", () => {
    expect(isDirectChild("C:\\repo\\a.ts", "C:\\repo")).toBe(true);
    expect(isDirectChild("C:\\repo\\sub\\a.ts", "C:\\repo")).toBe(false);
  });
  it("is false for an empty directory", () => {
    expect(isDirectChild("/repo/a.ts", "")).toBe(false);
  });
});
