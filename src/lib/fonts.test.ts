import { describe, it, expect } from "vitest";
import { withGeorgian } from "./fonts";

describe("withGeorgian", () => {
  it("puts the bundled Georgian face in front of the user's stack", () => {
    expect(withGeorgian('Menlo, "Cascadia Code", monospace')).toBe(
      '"Beecork Georgian", Menlo, "Cascadia Code", monospace',
    );
  });

  it("does not add it twice", () => {
    const once = withGeorgian("Consolas, monospace");
    expect(withGeorgian(once)).toBe(once);
  });

  it("falls back to monospace for an empty setting", () => {
    expect(withGeorgian("  ")).toBe('"Beecork Georgian", monospace');
  });
});
