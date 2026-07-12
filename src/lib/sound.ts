// Sound — a small, tasteful audio layer.
//
// The chimes are synthesized and played NATIVELY by the Rust backend (see
// src-tauri/src/sound.rs), not by the webview. WKWebView suspends — and often
// zombifies — a page's Web Audio context when the window is backgrounded or
// occluded: sound silently died over time and only opening a fresh window brought
// it back. Native playback has none of that, and it sounds through the OS mixer
// regardless of window focus — exactly what you want for a "come look" chime while
// you're in another app.
//
// This module is now just the policy layer: it holds the user's settings, gates
// each sound, self-throttles bursts, and asks Rust to play a named sound. The
// sound *design* (the tones) lives in sound.rs.

import { invoke } from "@tauri-apps/api/core";

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

/** The named sounds the Rust engine knows how to synthesize. */
type Kind =
  | "attention"
  | "exit"
  | "create"
  | "split"
  | "close"
  | "panelOpen"
  | "panelClose"
  | "blip"
  | "send";

/** Ask the native engine to play a sound. Fire-and-forget and best-effort — a
 *  failed invoke (e.g. no audio device) must never disturb the UI. */
function play(kind: Kind, volume: number) {
  invoke("play_sound", { kind, volume }).catch(() => {});
}

// Per-kind throttle so rapid events collapse to a single sound.
const lastAt: Record<string, number> = {};
function throttled(key: string, ms: number): boolean {
  const now = performance.now();
  if (lastAt[key] && now - lastAt[key] < ms) return true;
  lastAt[key] = now;
  return false;
}

/** Run a visual change together with its sound. Native audio latency is low and
 *  not measurable from JS (unlike the old Web Audio path, which pre-delayed the
 *  visual by the output latency), so this now just runs the change immediately —
 *  kept as a wrapper so call sites don't change. */
export function withVisual(fn: () => void) {
  fn();
}

// ---- attention family (rides the master toggle — the meaningful ones) ----

/** An agent wants you — it finished, asked a question, or rang the bell. */
export function attention() {
  if (!config.enabled || throttled("attention", 400)) return;
  play("attention", config.volume);
}

/** A shell process exited or crashed — a soft descending "power down". */
export function exit() {
  if (!config.enabled || throttled("exit", 400)) return;
  play("exit", config.volume);
}

// ---- interface family (under the uiSounds sub-toggle) ----

function ui(kind: Kind, ms: number) {
  if (!config.enabled || !config.uiSounds || throttled(kind, ms)) return;
  play(kind, config.volume);
}

/** New session — a bright ascending "appear". */
export function create() {
  ui("create", 40);
}
/** Split — two equal pips, a "divide in two". */
export function split() {
  ui("split", 40);
}
/** Close a session — a soft descending "dismiss". */
export function closeSession() {
  ui("close", 40);
}
/** A panel/drawer opens — a short upward pip. */
export function panelOpen() {
  ui("panelOpen", 60);
}
/** A panel/drawer closes/collapses — a short downward pip. */
export function panelClose() {
  ui("panelClose", 60);
}
/** A light in-session interaction — switching sessions, opening a file. */
export function blip() {
  ui("blip", 70);
}

// ---- typing family (under the keyClicks sub-toggle) ----

/** Sending a line (Enter) — a soft, pleasant rising "sent". */
export function send() {
  if (!config.enabled || !config.keyClicks || throttled("send", 45)) return;
  play("send", config.volume);
}

/** Play the attention chime at a given volume, bypassing the on/off gate — for
 *  live feedback while adjusting the sound settings, and the Settings "Test"
 *  button. */
export function preview(volume: number) {
  if (throttled("preview", 130)) return;
  play("attention", volume);
}
