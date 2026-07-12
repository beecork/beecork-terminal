import { describe, it, expect, beforeEach, vi } from "vitest";

// Sound is now a thin policy layer over a native Rust command: it gates + throttles
// and then calls invoke("play_sound", …). So the meaningful tests are "does the
// right event ask Rust to play, with the right kind/volume, and does gating +
// throttling hold" — not audio synthesis (that lives + is tested in sound.rs).

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import * as sound from "./sound";

// The module throttles per-kind on performance.now(); pin it so each test starts
// well past any prior throttle window but stays constant *within* a test (so two
// back-to-back calls collapse, which is exactly the throttle behaviour we assert).
let now = 0;
beforeEach(() => {
  invokeMock.mockClear();
  now += 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  sound.setSoundConfig({ enabled: true, volume: 0.5, uiSounds: true, keyClicks: true });
});

describe("sound policy layer", () => {
  it("asks the native engine to play, with kind + volume", () => {
    sound.attention();
    expect(invokeMock).toHaveBeenCalledWith("play_sound", { kind: "attention", volume: 0.5 });
  });

  it("plays nothing when the master toggle is off", () => {
    sound.setSoundConfig({ enabled: false, volume: 0.5, uiSounds: true, keyClicks: true });
    sound.attention();
    sound.create();
    sound.send();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("gates interface sounds on uiSounds, but not the attention chime", () => {
    sound.setSoundConfig({ enabled: true, volume: 0.5, uiSounds: false, keyClicks: true });
    sound.create();
    sound.blip();
    expect(invokeMock).not.toHaveBeenCalled();
    sound.attention(); // meaningful ones ride the master toggle, not uiSounds
    expect(invokeMock).toHaveBeenCalledWith("play_sound", { kind: "attention", volume: 0.5 });
  });

  it("gates the Enter tone on keyClicks", () => {
    sound.setSoundConfig({ enabled: true, volume: 0.5, uiSounds: true, keyClicks: false });
    sound.send();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("throttles a burst of the same sound to one play", () => {
    sound.blip();
    sound.blip();
    sound.blip();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("preview plays even when sound is disabled, at the given volume", () => {
    sound.setSoundConfig({ enabled: false, volume: 0.5, uiSounds: true, keyClicks: true });
    sound.preview(0.3);
    expect(invokeMock).toHaveBeenCalledWith("play_sound", { kind: "attention", volume: 0.3 });
  });

  it("withVisual runs its callback (immediately, no audio-latency delay)", () => {
    const fn = vi.fn();
    sound.withVisual(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
