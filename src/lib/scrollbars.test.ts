// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { CLASSIC_SCROLLBARS, markScrollbarKind, scrollbarsTakeRoom, watchScrollbarKind } from "./scrollbars";

// jsdom lays nothing out, so every element measures 0 by 0 — which is exactly an
// overlay scrollbar. A classic one is stood in for by giving the probe (the one
// element with `overflow: scroll`) an outer width its inner width falls short of.
function scrollbarWidth(px: number) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.style.overflow === "scroll" ? 100 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.style.overflow === "scroll" ? 100 - px : 0;
  });
}

describe("scrollbar kind", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute(CLASSIC_SCROLLBARS);
  });

  it("tells a scrollbar that takes room from one that floats over the content", () => {
    expect(scrollbarsTakeRoom()).toBe(false);
    scrollbarWidth(15);
    expect(scrollbarsTakeRoom()).toBe(true);
  });

  it("leaves nothing behind in the document", () => {
    const before = document.body.innerHTML;
    scrollbarWidth(15);
    scrollbarsTakeRoom();
    expect(document.body.innerHTML).toBe(before);
  });

  // The attribute is the whole interface to the stylesheet: present means "theme
  // the classic bars", absent means "touch nothing" — and it has to come OFF
  // again, or a Mac whose mouse was unplugged keeps bars it no longer needs.
  it("says so on the root, in both directions", () => {
    scrollbarWidth(15);
    markScrollbarKind();
    expect(document.documentElement.hasAttribute(CLASSIC_SCROLLBARS)).toBe(true);
    scrollbarWidth(0);
    markScrollbarKind();
    expect(document.documentElement.hasAttribute(CLASSIC_SCROLLBARS)).toBe(false);
  });

  it("asks again when the window comes back into focus", () => {
    watchScrollbarKind();
    expect(document.documentElement.hasAttribute(CLASSIC_SCROLLBARS)).toBe(false);
    scrollbarWidth(15); // a mouse was plugged in while the app was in the background
    window.dispatchEvent(new Event("focus"));
    expect(document.documentElement.hasAttribute(CLASSIC_SCROLLBARS)).toBe(true);
  });

  // It runs before the first render. A document it cannot measure must cost the
  // scrollbar's looks, never the window.
  it("does not throw when it cannot measure", () => {
    vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("no DOM for you");
    });
    expect(() => markScrollbarKind()).not.toThrow();
    expect(document.documentElement.hasAttribute(CLASSIC_SCROLLBARS)).toBe(false);
  });
});
