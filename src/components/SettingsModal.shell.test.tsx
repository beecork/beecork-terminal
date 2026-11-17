// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

// What Rust says about this machine's shells; each test sets it. Every other
// `invoke` (diagnostics, sound) never answers, which leaves its caller idle.
let machine: { windows: boolean; pwsh: boolean; cmd: boolean; default_name: string } | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    cmd === "shell_info" && machine ? Promise.resolve(machine) : new Promise(() => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

import SettingsModal from "./SettingsModal";
import { SettingsProvider } from "../lib/settings";

const WITH_PWSH = { windows: true, pwsh: true, cmd: false, default_name: "PowerShell 7" };
const WITHOUT_PWSH = { windows: true, pwsh: false, cmd: false, default_name: "Windows PowerShell" };
const ONLY_CMD = { windows: true, pwsh: false, cmd: true, default_name: "Command Prompt" };

async function openSettings(on: typeof machine) {
  machine = on;
  render(
    <SettingsProvider>
      <SettingsModal onClose={() => {}} />
    </SettingsProvider>
  );
  // Rust's answer arrives a tick later; let it land and be drawn. Waiting for the
  // heading to appear would not do — one of these tests is that it does NOT.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const choose = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
/** Every element in the window's body: a line that comes or goes changes the count. */
const elements = () => document.querySelectorAll(".modal-body *").length;
const hint = () => screen.queryByRole("button", { name: /get powershell 7/i })?.closest(".setting-row") ?? null;

describe("Settings: the shell choice", () => {
  afterEach(() => {
    // Vitest runs without globals here, so RTL cannot register its own cleanup.
    cleanup();
    localStorage.clear();
  });

  it("is offered on Windows only", async () => {
    await openSettings({ windows: false, pwsh: false, cmd: false, default_name: "zsh" });
    expect(screen.queryByText("Shell")).toBeNull();
    cleanup();

    await openSettings(WITH_PWSH);
    expect(screen.queryByText("Shell")).not.toBeNull();
    expect(screen.getByRole("button", { name: "PowerShell" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Command Prompt" }).getAttribute("aria-pressed")).toBe("false");
  });

  // A status line under the buttons ("Using PowerShell 7.") used to be there for
  // one choice and gone for the other, so every click resized the whole window.
  // Whatever the section shows, it shows for both.
  it("shows the same things whichever shell is chosen", async () => {
    for (const on of [WITH_PWSH, WITHOUT_PWSH]) {
      await openSettings(on);
      const before = elements();
      choose("Command Prompt");
      expect(elements(), `${on.default_name}: after Command Prompt`).toBe(before);
      choose("PowerShell");
      expect(elements(), `${on.default_name}: back on PowerShell`).toBe(before);
      expect(screen.queryByText(/^Using /)).toBeNull();
      cleanup();
      localStorage.clear();
    }
  });

  it("says nothing more when PowerShell 7 is what runs", async () => {
    await openSettings(WITH_PWSH);
    expect(hint()).toBeNull();
  });

  // The one case with something to say: the PowerShell on this machine is the old
  // one. It names what really runs and stays put for both choices — dimmed for
  // Command Prompt, the way the Sound rows dim, rather than removed.
  it("names the PowerShell in use and offers PowerShell 7 when that is missing", async () => {
    await openSettings(WITHOUT_PWSH);
    expect(hint()?.textContent).toContain("Windows PowerShell");
    expect(hint()?.classList.contains("setting-disabled")).toBe(false);

    choose("Command Prompt");
    expect(hint()).not.toBeNull();
    expect(hint()?.classList.contains("setting-disabled")).toBe(true);
  });

  // Both PowerShells failed to start and the sessions fell through to cmd. "The
  // older one that comes with Windows" would then be said of Command Prompt.
  it("says so when no PowerShell would start", async () => {
    await openSettings(ONLY_CMD);
    expect(hint()?.textContent).toContain("PowerShell would not start here");
    expect(hint()?.textContent).not.toContain("older one");
  });
});
