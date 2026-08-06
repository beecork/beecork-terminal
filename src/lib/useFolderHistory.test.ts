import { describe, it, expect } from "vitest";
import { recordVisit, canGoBack, canGoForward, EMPTY_HISTORY } from "./useFolderHistory";

const visit = (paths: string[]) => paths.reduce(recordVisit, EMPTY_HISTORY);

describe("recordVisit", () => {
  it("pushes each new folder and points at it", () => {
    const h = visit(["/a", "/a/b", "/a/b/c"]);
    expect(h).toEqual({ stack: ["/a", "/a/b", "/a/b/c"], index: 2 });
  });

  // A tab switch re-reports the incoming session's own cwd; that must not add a
  // duplicate step (which would make Back a no-op that looks broken).
  it("returns the SAME history when you're already there", () => {
    const h = visit(["/a", "/a/b"]);
    expect(recordVisit(h, "/a/b")).toBe(h);
  });

  it("truncates the forward tail on a genuine move, like a browser", () => {
    const h = { stack: ["/a", "/b", "/c"], index: 0 }; // went back twice
    expect(recordVisit(h, "/x")).toEqual({ stack: ["/a", "/x"], index: 1 });
  });

  it("re-visiting an earlier folder from a back position is not a no-op", () => {
    const h = { stack: ["/a", "/b"], index: 0 };
    expect(recordVisit(h, "/b")).toEqual({ stack: ["/a", "/b"], index: 1 });
  });
});

describe("canGoBack / canGoForward", () => {
  it("are both false on an empty trail", () => {
    expect(canGoBack(EMPTY_HISTORY)).toBe(false);
    expect(canGoForward(EMPTY_HISTORY)).toBe(false);
  });
  it("are both false with a single entry", () => {
    const h = visit(["/a"]);
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });
  it("allow back, but not forward, at the end of the trail", () => {
    const h = visit(["/a", "/b"]);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
  });
  it("allow forward, but not back, at the start of the trail", () => {
    const h = { stack: ["/a", "/b"], index: 0 };
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(true);
  });
});
