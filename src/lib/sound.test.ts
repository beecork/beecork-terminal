import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as sound from "./sound";

// A minimal Web Audio mock so the (browser-only) engine runs under Node. Every
// sound is one or more oscillator tones, so "did a sound play?" reduces to "how
// many oscillators were scheduled?" — that's what `oscCount` tracks.
class MockParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class MockNode {
  frequency = new MockParam();
  gain = new MockParam();
  type = "";
  connect(n: unknown) {
    return n;
  }
  start() {}
  stop() {}
}
class MockCtx {
  static instances: MockCtx[] = [];
  currentTime = 0;
  sampleRate = 48000;
  state = "running";
  destination = {};
  oscCount = 0;
  constructor() {
    MockCtx.instances.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    this.oscCount++;
    return new MockNode();
  }
  createGain() {
    return new MockNode();
  }
}

let mockNow = 0;

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = { AudioContext: MockCtx };
  (globalThis as unknown as { performance: unknown }).performance = { now: () => mockNow };
});

/** Oscillators scheduled so far by the single (cached) context. */
function osc() {
  return MockCtx.instances[0]?.oscCount ?? 0;
}

// Advance well past every throttle window so each test's sounds fire independently.
beforeEach(() => {
  mockNow += 10_000;
});

const ALL_ON = { enabled: true, volume: 0.5, uiSounds: true, keyClicks: true };

describe("sound gating", () => {
  it("attention chime is silent when sound is disabled", () => {
    sound.setSoundConfig({ ...ALL_ON, enabled: false });
    const before = osc();
    sound.attention();
    expect(osc()).toBe(before);
  });

  it("attention and exit each play two tones when enabled", () => {
    sound.setSoundConfig(ALL_ON);
    let before = osc();
    sound.attention();
    expect(osc()).toBe(before + 2);

    mockNow += 10_000;
    before = osc();
    sound.exit();
    expect(osc()).toBe(before + 2);
  });

  it("interface sounds are distinct actions, each under the uiSounds toggle", () => {
    // Off: none of the interface family makes a sound.
    sound.setSoundConfig({ ...ALL_ON, uiSounds: false });
    let before = osc();
    sound.create();
    sound.split();
    sound.closeSession();
    sound.panelOpen();
    sound.panelClose();
    sound.blip();
    expect(osc()).toBe(before);

    // On: each fires (create/split/close are two-note; panels/blip are one).
    sound.setSoundConfig(ALL_ON);
    for (const [fn, tones] of [
      [sound.create, 2],
      [sound.split, 2],
      [sound.closeSession, 2],
      [sound.panelOpen, 1],
      [sound.panelClose, 1],
      [sound.blip, 1],
    ] as const) {
      mockNow += 10_000;
      before = osc();
      fn();
      expect(osc()).toBe(before + tones);
    }
  });

  it("send tone respects the keyClicks sub-toggle", () => {
    sound.setSoundConfig({ ...ALL_ON, keyClicks: false });
    let before = osc();
    sound.send();
    expect(osc()).toBe(before); // off

    mockNow += 10_000;
    sound.setSoundConfig({ ...ALL_ON, keyClicks: true });
    before = osc();
    sound.send();
    expect(osc()).toBe(before + 2); // on
  });

  it("the master toggle overrides every sub-toggle", () => {
    sound.setSoundConfig({ enabled: false, volume: 0.5, uiSounds: true, keyClicks: true });
    const before = osc();
    sound.create();
    sound.split();
    sound.panelOpen();
    sound.blip();
    sound.send();
    expect(osc()).toBe(before);
  });

  it("collapses a rapid burst into a single chime (throttle)", () => {
    sound.setSoundConfig(ALL_ON);
    const before = osc();
    sound.attention(); // fires
    sound.attention(); // same instant → throttled
    sound.attention(); // throttled
    expect(osc()).toBe(before + 2); // one chime, not three
  });

  it("preview plays even when sound is disabled", () => {
    sound.setSoundConfig({ enabled: false, volume: 0.5, uiSounds: false, keyClicks: false });
    const before = osc();
    sound.preview(0.7);
    expect(osc()).toBe(before + 2);
  });
});

describe("withVisual", () => {
  beforeEach(() => {
    mockNow += 10_000; // clear throttles between tests
  });

  it("runs the visual immediately when sound is disabled", () => {
    sound.setSoundConfig({ ...ALL_ON, enabled: false });
    let ran = false;
    sound.withVisual(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("runs the visual immediately when interface sounds are off (nothing to sync to)", () => {
    sound.setSoundConfig({ ...ALL_ON, uiSounds: false });
    let ran = false;
    sound.withVisual(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("defers the visual by the output latency when a UI sound will play", () => {
    sound.setSoundConfig(ALL_ON);
    sound.blip(); // ensure the shared context exists (real timers)
    (MockCtx.instances[0] as unknown as { outputLatency: number }).outputLatency = 0.02; // 20ms
    vi.useFakeTimers();
    let ran = false;
    sound.withVisual(() => {
      ran = true;
    });
    expect(ran).toBe(false); // held back
    vi.advanceTimersByTime(25);
    expect(ran).toBe(true);
    vi.useRealTimers();
  });

  it("clamps the defer to 40ms on high-latency (Bluetooth) devices", () => {
    sound.setSoundConfig(ALL_ON);
    sound.blip();
    (MockCtx.instances[0] as unknown as { outputLatency: number }).outputLatency = 0.3; // 300ms
    vi.useFakeTimers();
    let ran = false;
    sound.withVisual(() => {
      ran = true;
    });
    vi.advanceTimersByTime(40); // clamp is 40ms, not 300
    expect(ran).toBe(true);
    vi.useRealTimers();
  });
});
