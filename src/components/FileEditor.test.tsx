// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// CodeMirror needs a real layout engine; swap it for a controlled <textarea>
// exposing the same value/onChange contract this component uses.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="cm" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const readFile = vi.fn(() => Promise.resolve({ content: "on disk", mtime: 1 }));
const gitFileOriginal = vi.fn(() => Promise.resolve(""));
vi.mock("../lib/api", () => ({
  readFile: (...a: unknown[]) => readFile(...(a as [])),
  writeFile: () => Promise.resolve(2),
  gitFileOriginal: (...a: unknown[]) => gitFileOriginal(...(a as [])),
  isDiskConflict: (m: string) => /changed on disk/i.test(m),
}));
vi.mock("../lib/events", () => ({ onFsChanged: () => () => {} }));

import FileEditor from "./FileEditor";
import { SettingsProvider } from "../lib/settings";

const view = (root: string) => (
  <SettingsProvider>
    <FileEditor path="/repo/a.ts" root={root} onFocusSurface={() => {}} />
  </SettingsProvider>
);

describe("FileEditor across a terminal cd", () => {
  beforeEach(() => {
    // Vitest runs without globals here, so RTL cannot auto-register its cleanup —
    // without this the previous test's DOM is still mounted and screen queries
    // find its nodes.
    cleanup();
    readFile.mockClear();
    gitFileOriginal.mockClear();
  });

  // The terminal's cwd only selects which REPO the diff baseline comes from —
  // the file's path is absolute. Re-reading the file on a `cd` (which is what
  // used to happen, via load's `root` dependency) ran with initial:true, skipped
  // the dirty guard, and silently replaced unsaved edits with the disk version.
  it("keeps unsaved edits and only refreshes the diff baseline", async () => {
    const { rerender } = render(view("/repo"));
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "my unsaved edit" } });

    await act(async () => {
      rerender(view("/repo/src"));
    });

    expect((screen.getByTestId("cm") as HTMLTextAreaElement).value).toBe("my unsaved edit");
    expect(readFile).toHaveBeenCalledTimes(1); // the cd must not re-read the file
    expect(gitFileOriginal).toHaveBeenLastCalledWith("/repo/a.ts", "/repo/src");
    // Still dirty, so Save is still offered.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("loads the file once on mount and marks it clean", async () => {
    render(view("/repo"));
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    expect(cm.value).toBe("on disk");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
