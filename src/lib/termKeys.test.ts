import { describe, it, expect } from "vitest";
import { clipboardKeyAction } from "./termKeys";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("clipboardKeyAction on Windows", () => {
  it("Ctrl+C copies when text is selected", () => {
    expect(clipboardKeyAction(key("c", { ctrlKey: true }), true, true)).toBe("copy");
  });

  it("Ctrl+C without a selection still goes to the shell as an interrupt", () => {
    expect(clipboardKeyAction(key("c", { ctrlKey: true }), false, true)).toBeNull();
  });

  it("Ctrl+Shift+C always copies (key arrives upper-case with Shift)", () => {
    expect(clipboardKeyAction(key("C", { ctrlKey: true, shiftKey: true }), false, true)).toBe("copy");
  });

  it("Ctrl+V and Ctrl+Shift+V paste", () => {
    expect(clipboardKeyAction(key("v", { ctrlKey: true }), false, true)).toBe("paste");
    expect(clipboardKeyAction(key("V", { ctrlKey: true, shiftKey: true }), false, true)).toBe("paste");
  });

  it("Ctrl+Insert copies and Shift+Insert pastes", () => {
    expect(clipboardKeyAction(key("Insert", { ctrlKey: true }), true, true)).toBe("copy");
    expect(clipboardKeyAction(key("Insert", { shiftKey: true }), false, true)).toBe("paste");
  });

  it("leaves other Ctrl chords and AltGr combos alone", () => {
    expect(clipboardKeyAction(key("d", { ctrlKey: true }), true, true)).toBeNull();
    // AltGr reports as Ctrl+Alt on Windows keyboards.
    expect(clipboardKeyAction(key("v", { ctrlKey: true, altKey: true }), false, true)).toBeNull();
  });
});

describe("clipboardKeyAction elsewhere", () => {
  it("does nothing off Windows — ⌘C/⌘V are native there and Ctrl+C is ^C", () => {
    expect(clipboardKeyAction(key("c", { ctrlKey: true }), true, false)).toBeNull();
    expect(clipboardKeyAction(key("v", { ctrlKey: true }), false, false)).toBeNull();
  });
});
