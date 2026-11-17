// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// The modal's only ways out of the webview are `invoke` (diagnostics, reveal,
// sound) and the folder picker. jsdom has neither, and neither is under test:
// an `invoke` that never answers leaves every caller exactly where it started.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => new Promise(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

import SettingsModal from "./SettingsModal";
import { SettingsProvider } from "../lib/settings";

const stored = () => JSON.parse(localStorage.getItem("beecork.settings") ?? "{}");
const box = () =>
  screen.getByRole("checkbox", { name: /keep the file panel open when splitting/i }) as HTMLInputElement;
const openSettings = () =>
  render(
    <SettingsProvider>
      <SettingsModal onClose={() => {}} />
    </SettingsProvider>
  );

describe("Settings: keep the file panel open when splitting", () => {
  afterEach(() => {
    // Vitest runs without globals here, so RTL cannot register its own cleanup.
    cleanup();
    localStorage.clear();
  });

  // Folding the panel on a split is the designed behaviour, and what a
  // default-size window needs. Nobody gets the other one without asking.
  it("is off until somebody turns it on", () => {
    openSettings();
    expect(box().checked).toBe(false);
    expect(stored().splitKeepsPanel).toBe(false);
  });

  it("is remembered once it is on", () => {
    openSettings();
    fireEvent.click(box());
    expect(stored().splitKeepsPanel).toBe(true);

    cleanup();
    openSettings(); // a fresh provider, reading it back from storage
    expect(box().checked).toBe(true);
  });

  // An install that predates the setting has no such key in storage. It must
  // come up as "off", not as a checkbox React complains is uncontrolled.
  it("reads a saved profile from before the setting existed as off", () => {
    localStorage.setItem("beecork.settings", JSON.stringify({ themeId: "ocean", sound: false }));
    openSettings();
    expect(box().checked).toBe(false);
    expect(stored().themeId).toBe("ocean");
  });
});
