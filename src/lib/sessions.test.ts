import { describe, it, expect } from "vitest";
import { displayName, type Session } from "./sessions";

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
});
