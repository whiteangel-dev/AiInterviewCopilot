//! AI Interview Copilot — native audio capture.
//!
//! Captures one audio source per session on a dedicated thread and delivers
//! 20 ms frames of 16 kHz mono PCM16 to JavaScript through a thread-safe callback.
//!
//! Sources:
//! - `microphone` (Windows): WASAPI capture endpoint.
//! - `system` (Windows): WASAPI loopback of a render endpoint (everything the PC plays).
//! - `process` (Windows): per-app loopback (e.g. only Zoom/Teams), Windows 10 2004+/11.
//! - `test-tone` (all platforms): a 440 Hz tone, for testing the JS plumbing.
//!
//! Device problems after a successful start never end a session: the capture
//! thread reports them on `onEvent`, keeps the frame timeline going with silent
//! frames and reopens the device. Only start-up failures go to `onError`.
#![deny(clippy::all)]

mod apps;
mod frames;
#[cfg(windows)]
mod wasapi_capture;

use std::f64::consts::TAU;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

pub use frames::{FRAME_MS, FRAME_SAMPLES, FrameAssembler, InputFormat, SampleFormat, TARGET_RATE};

static EPOCH: OnceLock<Instant> = OnceLock::new();

/// Longest gap that is filled with silent frames in one go. A longer gap (the
/// PC was asleep, say) is skipped and the next frame is flagged `discontinuity`.
const MAX_FILL_FRAMES: u64 = 500;

/// Milliseconds on the module's monotonic clock (shared by all sessions).
#[napi]
pub fn now_ms() -> f64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[napi(object)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    /// "input" (microphones) or "output" (speakers/headphones, usable for loopback).
    pub kind: String,
    pub is_default: bool,
}

/// An app that currently has an audio session, for per-app (`process`) capture.
#[napi(object)]
pub struct AudioApp {
    /// Root process of the app (pass as `processId`; capture includes its child processes).
    pub pid: u32,
    /// Executable file name, e.g. "Zoom.exe".
    pub name: String,
    /// Name to show: the session's display name, or the executable name without ".exe".
    pub display_name: String,
    /// True if any of the app's audio sessions is currently playing.
    pub active: bool,
}

#[napi(object)]
pub struct CaptureOptions {
    /// "microphone" | "system" | "process" | "test-tone"
    pub source: String,
    /// Label echoed on every frame, e.g. "interviewer" or "candidate".
    pub channel: String,
    /// Endpoint id from `listDevices()`; default device (followed when it changes) when omitted.
    pub device_id: Option<String>,
    /// Target process for `process` capture (use `pid` from `listAudioApps()`).
    pub process_id: Option<u32>,
    /// Include child processes of the target (default true; browsers and Teams use several).
    pub include_process_tree: Option<bool>,
}

#[napi(object)]
pub struct AudioFrame {
    pub channel: String,
    pub seq: u32,
    /// `nowMs()` clock time when the frame was completed.
    pub timestamp_ms: f64,
    /// 320 samples of 16-bit little-endian mono PCM at 16 kHz (20 ms).
    pub pcm: Buffer,
    /// True if the frame is synthesized silence filling a gap with no device data.
    pub filled: bool,
    /// True if the device reported a data discontinuity (glitch) in this frame.
    pub discontinuity: bool,
}

/// Something that happened to a capture session's device.
#[napi(object)]
pub struct CaptureEvent {
    /// "opened" | "device-changed" | "device-lost" | "reopened"
    pub kind: String,
    /// Human-readable description.
    pub message: String,
    /// Friendly name of the device (or app) involved.
    pub device: Option<String>,
    /// Format delivered by the device (before conversion to 16 kHz mono).
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    /// "i16" | "i32" | "f32"
    pub sample_format: Option<String>,
    /// True if Windows converts to 16 kHz mono PCM16 itself (AUTOCONVERTPCM).
    pub windows_converts: Option<bool>,
}

impl CaptureEvent {
    pub(crate) fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
            device: None,
            sample_rate: None,
            channels: None,
            sample_format: None,
            windows_converts: None,
        }
    }

    pub(crate) fn device(mut self, name: &str) -> Self {
        self.device = Some(name.to_string());
        self
    }

    pub(crate) fn format(mut self, input: InputFormat, windows_converts: bool) -> Self {
        self.sample_rate = Some(input.sample_rate);
        self.channels = Some(u32::from(input.channels));
        self.sample_format = Some(input.format.as_str().to_string());
        self.windows_converts = Some(windows_converts);
        self
    }
}

pub(crate) type FrameCallback = ThreadsafeFunction<AudioFrame, (), AudioFrame, Status, false>;
pub(crate) type ErrorCallback = ThreadsafeFunction<String, (), String, Status, false>;
pub(crate) type EventCallback = ThreadsafeFunction<CaptureEvent, (), CaptureEvent, Status, false>;

/// Sends frames to JavaScript and keeps them on a 20 ms timeline; owned by the capture thread.
pub(crate) struct FrameSink {
    channel: String,
    seq: u32,
    on_frame: FrameCallback,
    /// Start of the timeline (set when the first device stream starts).
    clock: Option<Instant>,
    /// Timeline slots used so far: frames emitted plus frames skipped.
    slots: u64,
    /// A gap was skipped; the next frame is flagged as a discontinuity.
    skipped: bool,
}

impl FrameSink {
    pub(crate) fn emit(&mut self, pcm: &[i16], filled: bool, discontinuity: bool) {
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let frame = AudioFrame {
            channel: self.channel.clone(),
            seq: self.seq,
            timestamp_ms: now_ms(),
            pcm: bytes.into(),
            filled,
            discontinuity: discontinuity || std::mem::take(&mut self.skipped),
        };
        self.seq = self.seq.wrapping_add(1);
        self.slots += 1;
        // NonBlocking: the audio thread must never wait on the JS thread.
        self.on_frame
            .call(frame, ThreadsafeFunctionCallMode::NonBlocking);
    }

    /// Starts the timeline (no-op if already started).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn start_clock(&mut self) {
        self.clock.get_or_insert_with(Instant::now);
    }

    /// Emits silent `filled` frames until the frame count catches up with the
    /// wall clock, leaving one frame of slack for device latency.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn fill_gap(&mut self) {
        let Some(clock) = self.clock else {
            return;
        };
        let due = (clock.elapsed().as_millis() / u128::from(FRAME_MS)) as u64;
        let target = due.saturating_sub(1);
        if target.saturating_sub(self.slots) > MAX_FILL_FRAMES {
            self.slots = target;
            self.skipped = true;
            return;
        }
        while self.slots < target {
            self.emit(&[0; FRAME_SAMPLES], true, false);
        }
    }
}

/// Sends device events to JavaScript, if the caller asked for them.
pub(crate) struct EventSink(Option<EventCallback>);

impl EventSink {
    pub(crate) fn emit(&self, event: CaptureEvent) {
        if let Some(on_event) = &self.0 {
            // NonBlocking: the audio thread must never wait on the JS thread.
            on_event.call(event, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

/// Lists audio endpoints. Empty on platforms without native capture yet.
#[napi]
pub fn list_devices() -> Result<Vec<AudioDevice>> {
    #[cfg(windows)]
    {
        // COM is initialised on a short-lived worker thread so the JS thread's
        // COM apartment (which Electron may have set to STA) is never touched.
        std::thread::spawn(wasapi_capture::list_devices)
            .join()
            .map_err(|_| Error::from_reason("device enumeration thread panicked"))?
            .map_err(Error::from_reason)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// Lists apps with audio sessions on any active output device, for per-app
/// capture. Empty on platforms other than Windows.
#[napi]
pub fn list_audio_apps() -> Result<Vec<AudioApp>> {
    #[cfg(windows)]
    {
        // Same reason as `list_devices`: keep COM off the JS thread.
        std::thread::spawn(wasapi_capture::list_audio_apps)
            .join()
            .map_err(|_| Error::from_reason("audio app enumeration thread panicked"))?
            .map_err(Error::from_reason)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// Capture sources available on this platform.
#[napi]
pub fn supported_sources() -> Vec<String> {
    let mut out = vec!["test-tone".to_string()];
    if cfg!(windows) {
        out.extend(["microphone", "system", "process"].map(String::from));
    }
    out
}

#[napi]
pub struct CaptureSession {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl CaptureSession {
    /// Stops capture and waits for the capture thread to exit (normally ≤ ~100 ms;
    /// longer if a device is being reopened at that moment).
    #[napi]
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }

    #[napi(getter)]
    pub fn running(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts capturing one source. Frames arrive on `onFrame`; device events
/// (opened, device-changed, device-lost, reopened) on the optional `onEvent`.
/// A fatal start-up error arrives once on `onError`, after which the session
/// has stopped. Errors after a successful start are not fatal: the session
/// fills the gap with silent frames and reopens the device.
#[napi(
    ts_args_type = "options: CaptureOptions, onFrame: (frame: AudioFrame) => void, onError: (message: string) => void, onEvent?: (event: CaptureEvent) => void"
)]
pub fn start_capture(
    options: CaptureOptions,
    on_frame: FrameCallback,
    on_error: ErrorCallback,
    on_event: Option<EventCallback>,
) -> Result<CaptureSession> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let mut sink = FrameSink {
        channel: options.channel.clone(),
        seq: 0,
        on_frame,
        clock: None,
        slots: 0,
        skipped: false,
    };
    let events = EventSink(on_event);
    let thread = std::thread::Builder::new()
        .name(format!("aic-capture-{}", options.channel))
        .spawn(move || {
            let result =
                std::panic::catch_unwind(AssertUnwindSafe(|| match options.source.as_str() {
                    "test-tone" => run_test_tone(&mut sink, &events, &thread_stop),
                    #[cfg(windows)]
                    "microphone" | "system" | "process" => {
                        wasapi_capture::run(&options, &mut sink, &events, &thread_stop)
                    }
                    other => Err(format!(
                        "source '{other}' is not supported on {}",
                        std::env::consts::OS
                    )),
                }))
                .unwrap_or_else(|panic| {
                    let what = panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown panic".into());
                    Err(format!("capture thread panicked: {what}"))
                });
            if let Err(message) = result {
                on_error.call(message, ThreadsafeFunctionCallMode::NonBlocking);
            }
        })
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(CaptureSession {
        stop,
        thread: Some(thread),
    })
}

/// 440 Hz tone at -12 dBFS in real time, paced against an absolute schedule.
fn run_test_tone(
    sink: &mut FrameSink,
    events: &EventSink,
    stop: &AtomicBool,
) -> std::result::Result<(), String> {
    let format = InputFormat {
        sample_rate: TARGET_RATE,
        channels: 1,
        format: SampleFormat::I16,
    };
    events.emit(
        CaptureEvent::new("opened", "Capturing the 440 Hz test tone")
            .device("Test tone")
            .format(format, false),
    );
    let start = Instant::now();
    let step = TAU * 440.0 / TARGET_RATE as f64;
    let mut phase = 0.0f64;
    let mut buf = [0i16; FRAME_SAMPLES];
    let mut n: u64 = 0;
    while !stop.load(Ordering::SeqCst) {
        for s in buf.iter_mut() {
            *s = (phase.sin() * 0.25 * 32_767.0) as i16;
            phase = (phase + step) % TAU;
        }
        sink.emit(&buf, false, false);
        n += 1;
        if let Some(wait) =
            (start + Duration::from_millis(n * FRAME_MS)).checked_duration_since(Instant::now())
        {
            std::thread::sleep(wait);
        }
    }
    Ok(())
}
