// Native sound engine. The app's chimes used to be synthesized in the webview
// with Web Audio, but WKWebView suspends — and often *zombifies* — a page's
// AudioContext when the window is backgrounded or occluded: sound silently died
// over time and only opening a fresh window brought it back. Playing natively
// removes that entire class of failure. It also plays regardless of window focus,
// which is exactly what you want for a "come look" chime while you're in another
// app.
//
// The tone specs mirror the old Web Audio design (see the former src/lib/sound.ts
// synthesis) so the sounds are unchanged; only where they're produced moved.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

const SAMPLE_RATE: u32 = 44100;

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Triangle,
}

/// One decaying tone: `sine`/`triangle` at `freq`, optionally gliding to
/// `glide_to`, starting `delay`s in, ramping up over `attack`s then decaying over
/// the rest of `dur`s, scaled by `gain`.
struct Tone {
    freq: f32,
    dur: f32,
    gain: f32,
    delay: f32,
    attack: f32,
    wave: Wave,
    glide_to: Option<f32>,
}

impl Tone {
    fn new(freq: f32, dur: f32, gain: f32, delay: f32, attack: f32, wave: Wave) -> Self {
        Tone { freq, dur, gain, delay, attack, wave, glide_to: None }
    }
    fn glide(mut self, to: f32) -> Self {
        self.glide_to = Some(to);
        self
    }
}

/// Tone recipe for a named sound. Values copied 1:1 from the old Web Audio code.
fn spec(kind: &str) -> Vec<Tone> {
    use Wave::{Sine, Triangle};
    match kind {
        // attention family
        "attention" => vec![
            Tone::new(659.25, 0.17, 0.16, 0.0, 0.003, Sine),
            Tone::new(987.77, 0.26, 0.12, 0.11, 0.003, Sine),
        ],
        "exit" => vec![
            Tone::new(392.0, 0.16, 0.12, 0.0, 0.0016, Sine),
            Tone::new(261.63, 0.28, 0.11, 0.09, 0.0016, Sine),
        ],
        // interface family
        "create" => vec![
            Tone::new(440.0, 0.07, 0.09, 0.0, 0.002, Triangle),
            Tone::new(659.25, 0.10, 0.08, 0.055, 0.002, Triangle),
        ],
        "split" => vec![
            Tone::new(523.25, 0.05, 0.08, 0.0, 0.0016, Sine),
            Tone::new(523.25, 0.06, 0.08, 0.075, 0.0016, Sine),
        ],
        "close" => vec![
            Tone::new(659.25, 0.07, 0.09, 0.0, 0.002, Sine),
            Tone::new(440.0, 0.11, 0.07, 0.05, 0.002, Sine),
        ],
        "panelOpen" => vec![Tone::new(587.33, 0.05, 0.08, 0.0, 0.001, Sine).glide(880.0)],
        "panelClose" => vec![Tone::new(587.33, 0.05, 0.08, 0.0, 0.001, Sine).glide(392.0)],
        "blip" => vec![Tone::new(520.0, 0.035, 0.05, 0.0, 0.002, Sine)],
        // typing family
        "send" => vec![
            Tone::new(587.33, 0.07, 0.08, 0.0, 0.002, Sine),
            Tone::new(880.0, 0.09, 0.06, 0.045, 0.002, Sine),
        ],
        _ => vec![],
    }
}

/// Render a sound's tones to a mono f32 PCM buffer at SAMPLE_RATE, scaled by the
/// master `volume` (0..1). Pure — unit-tested. Each tone: a linear attack from
/// zero, then an exponential decay (matching the old Web Audio envelope), summed
/// into the buffer at its delay offset, with an optional exponential pitch glide.
fn render(tones: &[Tone], volume: f32) -> Vec<f32> {
    let sr = SAMPLE_RATE as f32;
    let vol = volume.clamp(0.0, 1.0);
    let span = tones
        .iter()
        .map(|t| t.delay + t.dur)
        .fold(0.0f32, f32::max);
    if span <= 0.0 {
        return Vec::new();
    }
    let n = ((span + 0.02) * sr) as usize; // +20ms tail so the decay isn't clipped
    let mut buf = vec![0.0f32; n.max(1)];
    let two_pi = std::f32::consts::PI * 2.0;

    for t in tones {
        let peak = (t.gain * vol).max(0.0001);
        let start = (t.delay * sr) as usize;
        let dur_samples = ((t.dur * sr) as usize).max(1);
        let attack_samples = ((t.attack * sr) as usize).max(1);
        let mut phase = 0.0f32;
        for i in 0..dur_samples {
            let idx = start + i;
            if idx >= buf.len() {
                break;
            }
            let tt = i as f32 / sr; // seconds since this tone began
            // Instantaneous frequency (exponential glide when requested).
            let f = match t.glide_to {
                Some(g) if t.dur > 0.0 => t.freq * (g / t.freq).powf(tt / t.dur),
                _ => t.freq,
            };
            phase += two_pi * f / sr;
            let osc = match t.wave {
                Wave::Sine => phase.sin(),
                // asin(sin(x)) is a triangle wave in [-π/2, π/2]; scale to [-1,1].
                Wave::Triangle => phase.sin().asin() * (2.0 / std::f32::consts::PI),
            };
            let env = if i < attack_samples {
                peak * (i as f32 / attack_samples as f32)
            } else {
                let frac = (i - attack_samples) as f32 / (dur_samples - attack_samples).max(1) as f32;
                peak * (0.0001f32 / peak).powf(frac)
            };
            buf[idx] += osc * env;
        }
    }
    for s in buf.iter_mut() {
        *s = s.clamp(-1.0, 1.0);
    }
    buf
}

struct SoundCmd {
    kind: String,
    volume: f32,
}

/// Managed state: a handle to the dedicated audio thread. Playing never touches
/// the UI/IPC thread — `play_sound` just enqueues.
pub struct SoundState {
    tx: Sender<SoundCmd>,
}

impl SoundState {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<SoundCmd>();
        thread::Builder::new()
            .name("beecork-audio".into())
            .spawn(move || audio_loop(rx))
            .ok();
        SoundState { tx }
    }
}

impl Default for SoundState {
    fn default() -> Self {
        Self::new()
    }
}

/// The audio thread. Opens a FRESH output stream per sound so it always targets
/// the current default device — the native counterpart of "a new window fixed
/// it": unplugging headphones or switching outputs can't leave us wedged on a
/// dead device, because we never hold a long-lived stream. Sounds are short and
/// throttled upstream, so serial playback is imperceptible.
fn audio_loop(rx: Receiver<SoundCmd>) {
    use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
    while let Ok(cmd) = rx.recv() {
        let samples = render(&spec(&cmd.kind), cmd.volume);
        if samples.is_empty() {
            continue;
        }
        // Recreate the device stream each time; on any error just drop the sound
        // (no audio device, device busy) rather than propagate — sound is never
        // allowed to break anything.
        if let Ok((_stream, handle)) = OutputStream::try_default() {
            if let Ok(sink) = Sink::try_new(&handle) {
                sink.append(SamplesBuffer::new(1, SAMPLE_RATE, samples));
                sink.sleep_until_end(); // keeps _stream alive until the sound ends
            }
        }
    }
}

/// Play a named sound at the given master volume. Fire-and-forget: enqueues to the
/// audio thread and returns immediately, so a chime can never stall the caller.
#[tauri::command]
pub fn play_sound(state: tauri::State<SoundState>, kind: String, volume: f32) {
    let _ = state.tx.send(SoundCmd { kind, volume });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_known_sounds_to_bounded_samples() {
        for kind in [
            "attention", "exit", "create", "split", "close", "panelOpen", "panelClose", "blip",
            "send",
        ] {
            let buf = render(&spec(kind), 0.5);
            assert!(!buf.is_empty(), "{kind} produced no samples");
            assert!(
                buf.iter().all(|s| s.is_finite() && (-1.0..=1.0).contains(s)),
                "{kind} produced out-of-range samples"
            );
            // At least some energy — it's not silence.
            assert!(buf.iter().any(|s| s.abs() > 0.001), "{kind} is silent");
        }
    }

    #[test]
    fn unknown_sound_is_empty_not_a_panic() {
        assert!(render(&spec("nope"), 0.5).is_empty());
    }

    #[test]
    fn volume_scales_amplitude() {
        let quiet = render(&spec("attention"), 0.1);
        let loud = render(&spec("attention"), 0.9);
        let peak = |b: &[f32]| b.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak(&loud) > peak(&quiet));
    }

    // Actually plays a chime through the default device — proves the native path
    // reaches CoreAudio/the OS mixer. Ignored by default (headless CI has no
    // device); run locally with: cargo test -- --ignored plays_through_device
    #[test]
    #[ignore]
    fn plays_through_device() {
        let st = SoundState::new();
        st.tx
            .send(SoundCmd { kind: "attention".into(), volume: 0.6 })
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
    }
}
