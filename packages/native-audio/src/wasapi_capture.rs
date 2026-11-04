//! Windows capture through WASAPI (shared mode, event driven), with recovery
//! from default-device changes and lost (unplugged) devices, and enumeration of
//! apps that play audio.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use wasapi::{
    AudioCaptureClient, AudioClient, Device, DeviceEnumerator, Direction, Handle, SampleType,
    StreamMode, WaveFormat, initialize_mta,
};
use windows::Win32::Foundation::{CloseHandle, S_OK};
use windows::Win32::Media::Audio::{
    AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoTaskMemFree};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::core::{Interface, PWSTR};

use crate::apps::{self, ProcessInfo, ProcessTable, Session};
use crate::frames::{FRAME_MS, FrameAssembler, InputFormat, SampleFormat, TARGET_RATE};
use crate::{AudioApp, AudioDevice, CaptureEvent, CaptureOptions, EventSink, FrameSink};

type Res<T> = std::result::Result<T, String>;

fn ctx<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> String {
    move |err| format!("{what}: {err}")
}

/// 20 ms device buffer, in 100 ns units.
const BUFFER_HNS: i64 = 200_000;
/// Longest wait for the device event (one frame). Bounds how quickly `stop()`
/// and a broken device are noticed, and paces gap filling while loopback is silent.
const WAIT_MS: u32 = FRAME_MS as u32;
/// With no device data for this long, the gap is filled with silent frames
/// (loopback delivers nothing while nothing is playing).
const GAP_FILL_AFTER: Duration = Duration::from_millis(100);
/// How often the default device is checked when following it.
const DEFAULT_POLL: Duration = Duration::from_secs(1);
/// How often a lost device is reopened.
const REOPEN_EVERY: Duration = Duration::from_secs(1);
/// A microphone delivers data continuously, even in silence; this long without
/// any means the stream is stuck, so it is treated as lost.
const MIC_STALL: Duration = Duration::from_secs(3);

pub fn list_devices() -> Res<Vec<AudioDevice>> {
    initialize_mta().ok().map_err(ctx("COM init"))?;
    let enumerator = DeviceEnumerator::new().map_err(ctx("device enumerator"))?;
    let mut out = Vec::new();
    for (direction, kind) in [(Direction::Capture, "input"), (Direction::Render, "output")] {
        let default_id = enumerator
            .get_default_device(&direction)
            .and_then(|d| d.get_id())
            .ok();
        let collection = enumerator
            .get_device_collection(&direction)
            .map_err(ctx("device collection"))?;
        for device in &collection {
            let device = device.map_err(ctx("device"))?;
            let id = device.get_id().map_err(ctx("device id"))?;
            out.push(AudioDevice {
                is_default: default_id.as_deref() == Some(id.as_str()),
                name: device
                    .get_friendlyname()
                    .unwrap_or_else(|_| "(unknown)".into()),
                kind: kind.into(),
                id,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Apps with audio sessions
// ---------------------------------------------------------------------------

pub fn list_audio_apps() -> Res<Vec<AudioApp>> {
    initialize_mta().ok().map_err(ctx("COM init"))?;
    let enumerator = DeviceEnumerator::new().map_err(ctx("device enumerator"))?;
    let collection = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(ctx("device collection"))?;
    let mut sessions = Vec::new();
    // A device can vanish while we enumerate; skip it rather than fail the list.
    for device in (&collection).into_iter().flatten() {
        let _ = collect_sessions(&device, &mut sessions);
    }
    let table = process_table()?;
    Ok(apps::group_sessions(&sessions, &table, std::process::id()))
}

fn collect_sessions(device: &Device, out: &mut Vec<Session>) -> windows::core::Result<()> {
    // SAFETY: plain COM calls on interfaces created on this (MTA) thread.
    unsafe {
        let manager: IAudioSessionManager2 = device.as_immdevice().Activate(CLSCTX_ALL, None)?;
        let sessions = manager.GetSessionEnumerator()?;
        for i in 0..sessions.GetCount()? {
            let Ok(control) = sessions.GetSession(i) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            if control2.IsSystemSoundsSession() == S_OK {
                continue;
            }
            let Ok(pid) = control2.GetProcessId() else {
                continue;
            };
            out.push(Session {
                pid,
                display_name: control.GetDisplayName().map(take_pwstr).unwrap_or_default(),
                active: control
                    .GetState()
                    .is_ok_and(|s| s == AudioSessionStateActive),
            });
        }
    }
    Ok(())
}

/// Copies and frees a COM-allocated string.
fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: `p` is a valid NUL-terminated string allocated with CoTaskMemAlloc,
    // owned by us and not used after this call.
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// Snapshot of running processes: pid → parent pid and executable name.
fn process_table() -> Res<ProcessTable> {
    // SAFETY: the snapshot handle is closed below; `entry` has dwSize set as required.
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(ctx("process snapshot"))?;
        let mut table = ProcessTable::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            table.insert(
                entry.th32ProcessID,
                ProcessInfo {
                    parent: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&name[..len]),
                },
            );
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        Ok(table)
    }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/// What a session captures, parsed once from the options.
enum Source {
    Microphone { device_id: Option<String> },
    System { device_id: Option<String> },
    Process { pid: u32, include_tree: bool },
}

impl Source {
    fn parse(opts: &CaptureOptions) -> Res<Self> {
        let device_id = opts.device_id.clone().filter(|id| !id.is_empty());
        match opts.source.as_str() {
            "microphone" => Ok(Source::Microphone { device_id }),
            "system" => Ok(Source::System { device_id }),
            "process" => match opts.process_id {
                Some(pid) if pid != 0 => Ok(Source::Process {
                    pid,
                    include_tree: opts.include_process_tree.unwrap_or(true),
                }),
                _ => Err("process capture needs a processId".into()),
            },
            other => Err(format!("unknown source '{other}'")),
        }
    }

    /// Endpoint direction, for device sources.
    fn direction(&self) -> Option<Direction> {
        match self {
            Source::Microphone { .. } => Some(Direction::Capture),
            Source::System { .. } => Some(Direction::Render),
            Source::Process { .. } => None,
        }
    }

    fn device_id(&self) -> Option<&str> {
        match self {
            Source::Microphone { device_id } | Source::System { device_id } => device_id.as_deref(),
            Source::Process { .. } => None,
        }
    }

    /// True if the session follows the default device as it changes.
    fn follows_default(&self) -> bool {
        self.direction().is_some() && self.device_id().is_none()
    }

    fn label(&self) -> &'static str {
        match self {
            Source::Microphone { .. } => "microphone",
            Source::System { .. } => "output device",
            Source::Process { .. } => "app",
        }
    }
}

/// Where audio clients come from.
enum Target {
    Endpoint(Device),
    Process { pid: u32, include_tree: bool },
}

impl Target {
    fn new_client(&self) -> Res<AudioClient> {
        match self {
            Target::Endpoint(device) => device.get_iaudioclient().map_err(ctx("audio client")),
            Target::Process { pid, include_tree } => {
                AudioClient::new_application_loopback_client(*pid, *include_tree)
                    .map_err(ctx("process loopback client"))
            }
        }
    }
}

/// Finds the device (or process) to capture now: the given device, or the
/// current default. Returns the target, its endpoint id and a friendly name.
fn resolve(source: &Source) -> Res<(Target, Option<String>, String)> {
    if let Source::Process { pid, include_tree } = *source {
        let exe = process_table()
            .ok()
            .and_then(|t| t.get(&pid).map(|p| p.exe.clone()));
        let name = match exe {
            Some(exe) => format!("{exe} (pid {pid})"),
            None => format!("process {pid}"),
        };
        return Ok((Target::Process { pid, include_tree }, None, name));
    }
    let direction = source.direction().ok_or("not a device source")?;
    let enumerator = DeviceEnumerator::new().map_err(ctx("device enumerator"))?;
    let device = match source.device_id() {
        Some(id) => {
            let device = enumerator
                .get_device(id)
                .map_err(|e| format!("device {id}: {e}"))?;
            if device.get_direction() != direction {
                return Err(format!("device {id} is not an {} device", source.label()));
            }
            device
        }
        None => enumerator
            .get_default_device(&direction)
            .map_err(ctx("default device"))?,
    };
    let id = device.get_id().map_err(ctx("device id"))?;
    let name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "(unknown device)".into());
    Ok((Target::Endpoint(device), Some(id), name))
}

/// Endpoint id of the current default device for `direction`.
fn default_endpoint_id(direction: Direction) -> Res<String> {
    DeviceEnumerator::new()
        .and_then(|e| e.get_default_device(&direction))
        .and_then(|d| d.get_id())
        .map_err(ctx("default device"))
}

/// Initialises a client. Prefers letting Windows convert to 16 kHz mono PCM16
/// (AUTOCONVERTPCM); falls back to the device format and converts in Rust.
fn init_client(target: &Target) -> Res<(AudioClient, InputFormat, bool)> {
    let desired = WaveFormat::new(16, 16, &SampleType::Int, TARGET_RATE as usize, 1, None);
    let mut client = target.new_client()?;
    let auto = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_HNS,
    };
    if client
        .initialize_client(&desired, &Direction::Capture, &auto)
        .is_ok()
    {
        let input = InputFormat {
            sample_rate: TARGET_RATE,
            channels: 1,
            format: SampleFormat::I16,
        };
        return Ok((client, input, true));
    }

    // A failed Initialize can leave the client unusable, so start from a fresh one.
    let mut client = target.new_client()?;
    let format = match target {
        // Per-app loopback clients cannot report a mix format.
        Target::Process { .. } => WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None),
        Target::Endpoint(_) => client.get_mixformat().map_err(ctx("mix format"))?,
    };
    let manual = StreamMode::EventsShared {
        autoconvert: false,
        buffer_duration_hns: BUFFER_HNS,
    };
    client
        .initialize_client(&format, &Direction::Capture, &manual)
        .map_err(ctx("initialize client"))?;
    let sample = match (
        format.get_subformat().map_err(ctx("sample format"))?,
        format.get_bitspersample(),
    ) {
        (SampleType::Float, 32) => SampleFormat::F32,
        (SampleType::Int, 16) => SampleFormat::I16,
        (SampleType::Int, 32) => SampleFormat::I32,
        (t, bits) => return Err(format!("unsupported device format {t} {bits}-bit")),
    };
    let input = InputFormat {
        sample_rate: format.get_samplespersec(),
        channels: format.get_nchannels(),
        format: sample,
    };
    if input.sample_rate == 0 || input.channels == 0 {
        return Err(format!(
            "unusable device format: {} Hz, {} channels",
            input.sample_rate, input.channels
        ));
    }
    Ok((client, input, false))
}

/// A running WASAPI capture stream feeding a frame assembler.
struct Stream {
    client: AudioClient,
    capture: AudioCaptureClient,
    event: Handle,
    assembler: FrameAssembler,
    input: InputFormat,
    windows_converts: bool,
    /// Endpoint id (None for per-app capture).
    endpoint_id: Option<String>,
    name: String,
    scratch: Vec<u8>,
    /// The device flagged a discontinuity that no frame has carried yet.
    discontinuity: bool,
}

impl Stream {
    fn open(source: &Source) -> Res<Stream> {
        let (target, endpoint_id, name) = resolve(source)?;
        let (client, input, windows_converts) = init_client(&target)?;
        let event = client.set_get_eventhandle().map_err(ctx("event handle"))?;
        let capture = client
            .get_audiocaptureclient()
            .map_err(ctx("capture client"))?;
        client.start_stream().map_err(ctx("start stream"))?;
        Ok(Stream {
            client,
            capture,
            event,
            assembler: FrameAssembler::new(input),
            input,
            windows_converts,
            endpoint_id,
            name,
            scratch: Vec::with_capacity(16 * 1024),
            discontinuity: false,
        })
    }

    fn event(&self, kind: &str, message: String) -> CaptureEvent {
        CaptureEvent::new(kind, message)
            .device(&self.name)
            .format(self.input, self.windows_converts)
    }

    /// The "opened" event, with the format details.
    fn opened(&self, source: &Source) -> CaptureEvent {
        let message = format!(
            "Capturing {} \"{}\" ({} Hz, {} ch, {}{})",
            source.label(),
            self.name,
            self.input.sample_rate,
            self.input.channels,
            self.input.format.as_str(),
            if self.windows_converts {
                ", converted to 16 kHz mono by Windows"
            } else {
                ""
            }
        );
        self.event("opened", message)
    }

    /// Emits a partly assembled frame, padded with silence, so audio captured
    /// before a pause or a device switch is not held back or lost.
    fn flush(&mut self, sink: &mut FrameSink) {
        let mut discontinuity = self.discontinuity;
        self.assembler
            .flush(|f| sink.emit(f, false, std::mem::take(&mut discontinuity)));
        self.discontinuity = discontinuity;
    }

    /// Waits (≤ `WAIT_MS`) for the device, then moves everything it has captured
    /// into the sink. Returns whether any audio arrived; an error means the
    /// stream is broken (e.g. AUDCLNT_E_DEVICE_INVALIDATED after an unplug).
    fn pump(&mut self, sink: &mut FrameSink) -> Res<bool> {
        // A timeout is normal (loopback is silent while nothing plays). The
        // packet size is queried either way so a dead device is noticed.
        let _ = self.event.wait_for_event(WAIT_MS);
        let bpf = self.input.bytes_per_frame();
        let mut got = false;
        loop {
            let frames = self
                .capture
                .get_next_packet_size()
                .map_err(ctx("packet size"))?
                .unwrap_or(0) as usize;
            if frames == 0 {
                break;
            }
            self.scratch.resize(frames * bpf, 0);
            let (read, info) = self
                .capture
                .read_from_device(&mut self.scratch)
                .map_err(ctx("read"))?;
            let len = (read as usize * bpf).min(self.scratch.len());
            if len == 0 {
                break;
            }
            let data = &mut self.scratch[..len];
            if info.flags.silent {
                // The buffer content is undefined when flagged silent: zero it.
                data.fill(0);
            }
            let mut discontinuity = self.discontinuity || info.flags.data_discontinuity;
            self.assembler.push_bytes(data, |f| {
                sink.emit(f, false, std::mem::take(&mut discontinuity));
            });
            self.discontinuity = discontinuity;
            got = true;
        }
        Ok(got)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self.client.stop_stream();
    }
}

/// Sleeps for `duration` in short steps, returning early once `stop` is set.
fn pause(stop: &AtomicBool, duration: Duration) {
    let until = Instant::now() + duration;
    while !stop.load(Ordering::SeqCst) {
        let Some(left) = until.checked_duration_since(Instant::now()) else {
            return;
        };
        std::thread::sleep(left.min(Duration::from_millis(10)));
    }
}

/// Runs a capture session until `stop` is set. Returns an error only if the
/// session cannot start; later device problems are reported as events.
pub fn run(
    opts: &CaptureOptions,
    sink: &mut FrameSink,
    events: &EventSink,
    stop: &AtomicBool,
) -> Res<()> {
    let source = Source::parse(opts)?;
    initialize_mta().ok().map_err(ctx("COM init"))?;
    let first = Stream::open(&source)?;
    events.emit(first.opened(&source));
    sink.start_clock();

    let mut stream = Some(first);
    let mut last_data = Instant::now();
    let mut next_poll = Instant::now() + DEFAULT_POLL;
    let mut next_retry = Instant::now();
    let mut lost_at = Instant::now();
    let mut lost_name = String::new();

    while !stop.load(Ordering::SeqCst) {
        // 1) Read from the device, or wait one frame while there is none.
        let outcome = match stream.as_mut() {
            Some(s) => Some(s.pump(sink)),
            None => {
                pause(stop, Duration::from_millis(FRAME_MS));
                None
            }
        };
        let failure = match outcome {
            Some(Ok(true)) => {
                last_data = Instant::now();
                None
            }
            Some(Ok(false))
                if matches!(source, Source::Microphone { .. })
                    && last_data.elapsed() >= MIC_STALL =>
            {
                Some(format!("no audio for {} s", MIC_STALL.as_secs()))
            }
            Some(Err(e)) => Some(e),
            _ => None,
        };
        if let Some(reason) = failure
            && let Some(mut old) = stream.take()
        {
            old.flush(sink);
            events.emit(
                CaptureEvent::new(
                    "device-lost",
                    format!(
                        "Lost {} \"{}\" ({reason}); retrying every {} s",
                        source.label(),
                        old.name,
                        REOPEN_EVERY.as_secs()
                    ),
                )
                .device(&old.name),
            );
            lost_at = Instant::now();
            lost_name = old.name.clone();
            drop(old);
            next_retry = Instant::now() + REOPEN_EVERY;
        }

        // 2) Follow the default device.
        if source.follows_default() && Instant::now() >= next_poll {
            if let (Some(current), Some(direction)) = (stream.as_ref(), source.direction())
                && let Ok(id) = default_endpoint_id(direction)
                && current.endpoint_id.as_deref() != Some(id.as_str())
            {
                // Open the new device first so a failure keeps the old one running;
                // the next poll tries again.
                if let Ok(new) = Stream::open(&source)
                    && let Some(mut old) = stream.replace(new)
                {
                    old.flush(sink);
                    let old_name = std::mem::take(&mut old.name);
                    drop(old); // stops the old client
                    sink.fill_gap();
                    if let Some(s) = stream.as_ref() {
                        events.emit(s.event(
                            "device-changed",
                            format!(
                                "Default {} changed from \"{old_name}\" to \"{}\"",
                                source.label(),
                                s.name
                            ),
                        ));
                        events.emit(s.opened(&source));
                    }
                    last_data = Instant::now();
                }
            }
            next_poll = Instant::now() + DEFAULT_POLL;
        }

        // 3) Reopen a lost device.
        if stream.is_none() && Instant::now() >= next_retry && !stop.load(Ordering::SeqCst) {
            if let Ok(new) = Stream::open(&source) {
                sink.fill_gap();
                events.emit(new.event(
                    "reopened",
                    format!(
                        "Capture resumed on {} \"{}\" after {:.1} s (lost \"{lost_name}\")",
                        source.label(),
                        new.name,
                        lost_at.elapsed().as_secs_f64()
                    ),
                ));
                events.emit(new.opened(&source));
                stream = Some(new);
                last_data = Instant::now();
            }
            next_retry = Instant::now() + REOPEN_EVERY;
        }

        // 4) Keep the timeline continuous while no audio arrives.
        if stream.is_none() || last_data.elapsed() >= GAP_FILL_AFTER {
            if let Some(s) = stream.as_mut() {
                s.flush(sink);
            }
            sink.fill_gap();
        }
    }
    drop(stream);
    Ok(())
}
