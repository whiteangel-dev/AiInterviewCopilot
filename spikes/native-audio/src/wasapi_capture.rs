//! Windows capture through WASAPI (shared mode, event driven).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use wasapi::{
    AudioClient, Device, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
    initialize_mta,
};

use crate::frames::{FRAME_SAMPLES, FrameAssembler, InputFormat, SampleFormat, TARGET_RATE};
use crate::{AudioDevice, CaptureOptions, FrameSink};

type Res<T> = std::result::Result<T, String>;

fn ctx<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> String {
    move |err| format!("{what}: {err}")
}

/// 20 ms device buffer, in 100 ns units.
const BUFFER_HNS: i64 = 200_000;
/// With no device data for this long, the gap is filled with silent frames
/// (loopback delivers nothing while nothing is playing).
const GAP_FILL_AFTER_MS: u128 = 100;

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

fn find_device(direction: Direction, id: Option<&str>) -> Res<Device> {
    let enumerator = DeviceEnumerator::new().map_err(ctx("device enumerator"))?;
    let Some(id) = id else {
        return enumerator
            .get_default_device(&direction)
            .map_err(ctx("default device"));
    };
    let collection = enumerator
        .get_device_collection(&direction)
        .map_err(ctx("device collection"))?;
    for device in &collection {
        let device = device.map_err(ctx("device"))?;
        if device.get_id().map_err(ctx("device id"))? == id {
            return Ok(device);
        }
    }
    Err(format!("device not found: {id}"))
}

fn new_client(opts: &CaptureOptions) -> Res<AudioClient> {
    match opts.source.as_str() {
        "microphone" => find_device(Direction::Capture, opts.device_id.as_deref())?
            .get_iaudioclient()
            .map_err(ctx("audio client")),
        // Loopback = a render (output) device opened in the capture direction.
        "system" => find_device(Direction::Render, opts.device_id.as_deref())?
            .get_iaudioclient()
            .map_err(ctx("audio client")),
        "process" => {
            let pid = opts.process_id.ok_or("process capture needs processId")?;
            AudioClient::new_application_loopback_client(
                pid,
                opts.include_process_tree.unwrap_or(true),
            )
            .map_err(ctx("process loopback client"))
        }
        other => Err(format!("unknown source '{other}'")),
    }
}

/// Opens and initialises a client. Prefers letting Windows convert to 16 kHz mono
/// PCM16 (AUTOCONVERTPCM); falls back to the device format and converts in Rust.
fn open_client(opts: &CaptureOptions) -> Res<(AudioClient, InputFormat, bool)> {
    let desired = WaveFormat::new(16, 16, &SampleType::Int, TARGET_RATE as usize, 1, None);
    let mut client = new_client(opts)?;
    let auto = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_HNS,
    };
    if client
        .initialize_client(&desired, &Direction::Capture, &auto)
        .is_ok()
    {
        return Ok((
            client,
            InputFormat {
                sample_rate: TARGET_RATE,
                channels: 1,
                format: SampleFormat::I16,
            },
            true,
        ));
    }

    // A failed Initialize can leave the client unusable, so start from a fresh one.
    let mut client = new_client(opts)?;
    let format = if opts.source == "process" {
        // Per-app loopback clients cannot report a mix format.
        WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None)
    } else {
        client.get_mixformat().map_err(ctx("mix format"))?
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
    Ok((client, input, false))
}

pub fn run(opts: &CaptureOptions, sink: &mut FrameSink, stop: &AtomicBool) -> Res<()> {
    initialize_mta().ok().map_err(ctx("COM init"))?;
    let (client, input, _windows_converts) = open_client(opts)?;
    let event = client.set_get_eventhandle().map_err(ctx("event handle"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(ctx("capture client"))?;
    let mut assembler = FrameAssembler::new(input);
    let mut bytes = VecDeque::<u8>::with_capacity(64 * 1024);

    client.start_stream().map_err(ctx("start stream"))?;
    let started = Instant::now();
    let mut last_data = Instant::now();
    let mut emitted: u64 = 0;

    while !stop.load(Ordering::SeqCst) {
        let signalled = event.wait_for_event(100).is_ok();
        let mut discontinuity = false;
        if signalled {
            while capture
                .get_next_packet_size()
                .map_err(ctx("packet size"))?
                .unwrap_or(0)
                > 0
            {
                let before = bytes.len();
                let info = capture
                    .read_from_device_to_deque(&mut bytes)
                    .map_err(ctx("read"))?;
                discontinuity |= info.flags.data_discontinuity;
                if info.flags.silent {
                    // The buffer content is undefined when flagged silent: zero it.
                    bytes.range_mut(before..).for_each(|b| *b = 0);
                }
            }
            if !bytes.is_empty() {
                let (a, b) = bytes.as_slices();
                let mut on_frame = |f: &[i16]| {
                    sink.emit(f, false, discontinuity);
                    emitted += 1;
                };
                assembler.push_bytes(a, &mut on_frame);
                assembler.push_bytes(b, &mut on_frame);
                bytes.clear();
                last_data = Instant::now();
            }
        }
        if last_data.elapsed().as_millis() >= GAP_FILL_AFTER_MS {
            let due = (started.elapsed().as_millis() / 20) as u64;
            while emitted + 1 < due {
                sink.emit(&[0; FRAME_SAMPLES], true, false);
                emitted += 1;
            }
        }
    }
    client.stop_stream().map_err(ctx("stop stream"))?;
    Ok(())
}
