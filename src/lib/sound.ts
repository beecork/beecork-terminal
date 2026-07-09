// Sound design for the app — a small, tasteful audio layer.
//
// Everything is *synthesized* with the Web Audio API rather than loaded from
// files: there's nothing to bundle, nothing to allow through the CSP, and every
// tone (pitch, length, timbre, volume) is tunable in one place. The sounds form
// a small vocabulary so each kind of action has its own voice:
//   • rising    → something appears / arrives   (new session, panel opens, send)
//   • falling   → something dismisses / leaves   (close, panel collapses, exit)
//   • a chime   → an agent wants you             (done, question, bell)
//   • a blip    → a light in-session interaction (switch session, open a file)
//
// Playback is gated by user settings (pushed in via `setSoundConfig`, so callers
// never need the settings context), and every sound self-throttles so a burst of
// events can't machine-gun. Kept deliberately soft — a gentle presence.

export interface SoundConfig {
  /** master on/off for all sound */
  enabled: boolean;
  /** 0..1 master volume */
  volume: number;
  /** interface sounds: sessions, splits, panels, switching */
  uiSounds: boolean;
  /** a soft tone when you press Enter to send a line */
  keyClicks: boolean;
}

let config: SoundConfig = { enabled: true, volume: 0.5, uiSounds: true, keyClicks: true };

/** Push the current user settings in — call whenever the sound settings change. */
export function setSoundConfig(next: SoundConfig) {
  config = next;
}

// One shared AudioContext. `latencyHint: "interactive"` asks the platform for the
// smallest output buffer (lowest latency). We create it eagerly and keep it warm
// (see `warm()`), because a suspended context's async `resume()` adds audible lag
// to the first sound after any idle gap — the main source of "the sound feels late".
let ctx: AudioContext | null = null;
function ensureCtx(): AudioContext | null {
  try {
    const w = window as unknown as {
      webkitAudioContext?: typeof AudioContext;
      __beecorkAudio?: AudioContext;
    };
    // Reuse a context stashed on `window`. A hot-reload re-evaluates this module
    // (resetting `ctx` to null) and would otherwise mint a fresh *suspended*
    // context on every save — whose async resume() adds lag to the next sound.
    // Keeping the already-running one on window makes latency stable across edits.
    if (w.__beecorkAudio) {
      ctx = w.__beecorkAudio;
      return ctx;
    }
    const Ctor = window.AudioContext || w.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) {
      ctx = new Ctor({ latencyHint: "interactive" });
      w.__beecorkAudio = ctx;
    }
    return ctx;
  } catch {
    return null;
  }
}
function audio(): AudioContext | null {
  const a = ensureCtx();
  if (a && a.state === "suspended") void a.resume();
  return a;
}

/** Create + resume the context ahead of the first sound so it's never cold. Safe
 *  to call on every user interaction (a no-op once running). */
export function warm() {
  const a = ensureCtx();
  if (a && a.state !== "running") void a.resume();
}

/** Run a visual change *after* the audio output latency, so a sound dispatched
 *  now becomes audible at the same moment the visual lands — closing the small
 *  "visual leads the sound" gap. Falls through instantly when no UI sound will
 *  play (master or interface sounds off) — there'd be nothing to sync to. */
export function withVisual(fn: () => void) {
  if (!config.enabled || !config.uiSounds) {
    fn();
    return;
  }
  // Clamp to a small perceptual budget: a 13–40ms lead aligns the blip with the
  // visual, but a device's real outputLatency (Bluetooth ≈ 150–300ms) beyond that
  // is pure input lag, so cap it — responsiveness wins over perfect sync.
  const ms = Math.min(audioInfo().outputMs, 40);
  if (ms <= 1) {
    fn();
    return;
  }
  setTimeout(fn, ms);
}

/** Live audio-engine diagnostics — the *real* latency figures, for surfacing in
 *  the UI so we work from measurements, not estimates. `total` is the platform's
 *  own estimate of schedule→speaker delay (base processing + output buffer). */
export function audioInfo(): {
  state: string;
  baseMs: number;
  outputMs: number;
  totalMs: number;
} {
  const a = ctx;
  if (!a) return { state: "not started", baseMs: 0, outputMs: 0, totalMs: 0 };
  const base = a.baseLatency ?? 0;
  const output = (a as unknown as { outputLatency?: number }).outputLatency ?? 0;
  return {
    state: a.state,
    baseMs: Math.round(base * 1000),
    outputMs: Math.round(output * 1000),
    totalMs: Math.round((base + output) * 1000),
  };
}

// Per-kind throttle so rapid events collapse to a single sound.
const lastAt: Record<string, number> = {};
function throttled(key: string, ms: number): boolean {
  const now = performance.now();
  if (lastAt[key] && now - lastAt[key] < ms) return true;
  lastAt[key] = now;
  return false;
}

/** A single decaying tone (sine "bell" by default), optionally gliding in pitch.
 *  Gains are pre-master. */
function tone(
  a: AudioContext,
  opts: {
    freq: number;
    dur: number;
    gain: number;
    delay?: number;
    attack?: number;
    type?: OscillatorType;
    glideTo?: number;
  }
) {
  const t0 = a.currentTime + (opts.delay ?? 0);
  const attack = opts.attack ?? 0.0016;
  const peak = Math.max(0.0001, opts.gain * config.volume);

  const osc = a.createOscillator();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t0 + opts.dur);

  const g = a.createGain();
  // Linear attack from true zero → the onset lands *immediately* (an exponential
  // ramp from ~0 crawls at the bottom and makes the sound feel a few ms late).
  // Then an exponential decay for a natural tail.
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);

  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.02);
}

// Gate helpers keep the family/throttle logic out of each sound.
function ui(name: string, ms: number): AudioContext | null {
  if (!config.enabled || !config.uiSounds) return null;
  if (throttled(name, ms)) return null;
  return audio();
}
function base(name: string, ms: number): AudioContext | null {
  if (!config.enabled) return null;
  if (throttled(name, ms)) return null;
  return audio();
}

// ---- attention family (rides the master toggle — these are the meaningful ones) ----

/** The gentle rising two-note chime (E5 → B5). Shared by attention() and the
 *  settings preview so the preview is always identical to the real chime. */
function attentionChime(a: AudioContext) {
  tone(a, { freq: 659.25, dur: 0.17, gain: 0.16, attack: 0.003 });
  tone(a, { freq: 987.77, dur: 0.26, gain: 0.12, delay: 0.11, attack: 0.003 });
}

/** An agent wants you — it finished, asked a question, or rang the bell. */
export function attention() {
  const a = base("attention", 400);
  if (!a) return;
  attentionChime(a);
}

/** A shell process exited or crashed — a soft descending "power down" (G4 → C4). */
export function exit() {
  const a = base("exit", 400);
  if (!a) return;
  tone(a, { freq: 392.0, dur: 0.16, gain: 0.12 });
  tone(a, { freq: 261.63, dur: 0.28, gain: 0.11, delay: 0.09 });
}

// ---- interface family (under the uiSounds sub-toggle) ----

/** New session — a bright ascending "appear" (A4 → E5). */
export function create() {
  const a = ui("create", 40);
  if (!a) return;
  tone(a, { freq: 440.0, dur: 0.07, gain: 0.09, attack: 0.002, type: "triangle" });
  tone(a, { freq: 659.25, dur: 0.1, gain: 0.08, delay: 0.055, attack: 0.002, type: "triangle" });
}

/** Split — two equal pips, a "divide in two" (C5, C5). */
export function split() {
  const a = ui("split", 40);
  if (!a) return;
  tone(a, { freq: 523.25, dur: 0.05, gain: 0.08 });
  tone(a, { freq: 523.25, dur: 0.06, gain: 0.08, delay: 0.075 });
}

/** Close a session — a soft descending "dismiss" (E5 → A4). */
export function closeSession() {
  const a = ui("close", 40);
  if (!a) return;
  tone(a, { freq: 659.25, dur: 0.07, gain: 0.09, attack: 0.002 });
  tone(a, { freq: 440.0, dur: 0.11, gain: 0.07, delay: 0.05, attack: 0.002 });
}

/** A panel/drawer opens (file panel, session rail) — a short upward pip. Kept
 *  brief with a hard onset so it lands *with* the click, not after it. */
export function panelOpen() {
  const a = ui("panelOpen", 60);
  if (!a) return;
  tone(a, { freq: 587.33, glideTo: 880, dur: 0.05, gain: 0.08, attack: 0.001 });
}

/** A panel/drawer closes/collapses — a short downward pip. */
export function panelClose() {
  const a = ui("panelClose", 60);
  if (!a) return;
  tone(a, { freq: 587.33, glideTo: 392, dur: 0.05, gain: 0.08, attack: 0.001 });
}

/** A light in-session interaction — switching sessions, opening a file. A tiny neutral blip. */
export function blip() {
  const a = ui("blip", 70);
  if (!a) return;
  tone(a, { freq: 520, dur: 0.035, gain: 0.05, attack: 0.002 });
}

// ---- typing family (under the keyClicks sub-toggle) ----

/** Sending a line (Enter) — a soft, pleasant rising "sent" (D5 → A5). */
export function send() {
  if (!config.enabled || !config.keyClicks) return;
  if (throttled("send", 45)) return;
  const a = audio();
  if (!a) return;
  tone(a, { freq: 587.33, dur: 0.07, gain: 0.08, attack: 0.002 });
  tone(a, { freq: 880.0, dur: 0.09, gain: 0.06, delay: 0.045, attack: 0.002 });
}

/** Play the attention chime at a given volume, bypassing the on/off gate — for
 *  live feedback while the user is adjusting the sound settings. */
export function preview(volume: number) {
  if (throttled("preview", 130)) return;
  const a = audio();
  if (!a) return;
  const saved = config.volume;
  config.volume = volume;
  attentionChime(a);
  config.volume = saved;
}
