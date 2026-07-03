import { describe, it, expect } from "vitest";
import { languageFor } from "./language";

describe("languageFor", () => {
  it("returns a language extension for known file types", () => {
    expect(languageFor("App.tsx").length).toBeGreaterThan(0);
    expect(languageFor("main.rs").length).toBeGreaterThan(0);
    expect(languageFor("data.json").length).toBeGreaterThan(0);
    expect(languageFor("style.css").length).toBeGreaterThan(0);
  });

  it("returns no extension for unknown or extension-less files", () => {
    expect(languageFor("notes.unknownext")).toEqual([]);
    expect(languageFor("Makefile")).toEqual([]);
  });
});
