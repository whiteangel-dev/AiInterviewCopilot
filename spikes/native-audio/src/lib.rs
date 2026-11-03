//! AI Interview Copilot — native audio capture (Phase 0 spike, Option B).
//!
//! Captures one audio source per session on a dedicated thread and delivers
//! 20 ms frames of 16 kHz mono PCM16 to JavaScript through a thread-safe callback.
//!
//! Sources:
//! - `microphone` (Windows): WASAPI capture endpoint.
//! - `system` (Windows): WASAPI loopback of a render endpoint (everything the PC plays).
//! - `process` (Windows): per-app loopback (e.g. only Zoom/Teams), Windows 10 2004+/11.
//! - `test-tone` (all platforms): a 440 Hz tone, for testing the JS plumbing.
#![deny(clippy::all)]

mod frames;
#[cfg(windows)]
mod wasapi_capture;

use std::f64::consts::TAU;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

pub use frames::{FRAME_SAMPLES, FrameAssembler, InputFormat, SampleFormat, TARGET_RATE};

static EPOCH: OnceLock<Instant> = OnceLock::new();

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

#[napi(object)]
pub struct CaptureOptions {
    /// "microphone" | "system" | "process" | "test-tone"
    pub source: String,
    /// Label echoed on every frame, e.g. "interviewer" or "candidate".
    pub channel: String,
    /// Endpoint id from `listDevices()`; default device when omitted.
    pub device_id: Option<String>,
    /// Target process for `process` capture.
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

pub(crate) type FrameCallback = ThreadsafeFunction<AudioFrame, (), AudioFrame, Status, false>;
pub(crate) type ErrorCallback = ThreadsafeFunction<String, (), String, Status, false>;

/// Sends frames to JavaScript; owned by the capture thread.
pub(crate) struct FrameSink {
    channel: String,
    seq: u32,
    on_frame: FrameCallback,
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
            discontinuity,
        };
        self.seq = self.seq.wrapping_add(1);
        // NonBlocking: the audio thread must never wait on the JS thread.
        self.on_frame
            .call(frame, ThreadsafeFunctionCallMode::NonBlocking);
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
    /// Stops capture and waits (≤ ~100 ms) for the capture thread to exit.
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

/// Starts capturing one source. Frames arrive on `onFrame`; a fatal capture
/// error arrives once on `onError`, after which the session has stopped.
#[napi(
    ts_args_type = "options: CaptureOptions, onFrame: (frame: AudioFrame) => void, onError: (message: string) => void"
)]
pub fn start_capture(
    options: CaptureOptions,
    on_frame: FrameCallback,
    on_error: ErrorCallback,
) -> Result<CaptureSession> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let mut sink = FrameSink {
        channel: options.channel.clone(),
        seq: 0,
        on_frame,
    };
    let thread = std::thread::Builder::new()
        .name(format!("aic-capture-{}", options.channel))
        .spawn(move || {
            let result = match options.source.as_str() {
                "test-tone" => run_test_tone(&mut sink, &thread_stop),
                #[cfg(windows)]
                "microphone" | "system" | "process" => {
                    wasapi_capture::run(&options, &mut sink, &thread_stop)
                }
                other => Err(format!(
                    "source '{other}' is not supported on {}",
                    std::env::consts::OS
                )),
            };
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
fn run_test_tone(sink: &mut FrameSink, stop: &AtomicBool) -> std::result::Result<(), String> {
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
            (start + Duration::from_millis(n * 20)).checked_duration_since(Instant::now())
        {
            std::thread::sleep(wait);
        }
    }
    Ok(())
}
