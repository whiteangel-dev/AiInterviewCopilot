//! Platform-independent conversion of captured audio into the pipeline's
//! canonical format: 20 ms frames of 16 kHz mono 16-bit PCM.

use std::f64::consts::PI;

pub const TARGET_RATE: u32 = 16_000;
/// 20 ms at 16 kHz.
pub const FRAME_SAMPLES: usize = 320;
/// Length of one frame in milliseconds.
pub const FRAME_MS: u64 = 20;

/// Anti-alias low-pass used before downsampling: cutoff (-6 dB point), width of
/// the transition band and stop-band attenuation. Everything above ~8.05 kHz
/// (the new Nyquist frequency is 8 kHz) is attenuated by about 50 dB, while
/// speech up to ~6.4 kHz passes unchanged.
const AA_CUTOFF_HZ: f64 = 7_250.0;
const AA_TRANSITION_HZ: f64 = 1_600.0;
const AA_ATTENUATION_DB: f64 = 50.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleFormat {
    I16,
    /// 32-bit integer container (also used for left-justified 24-bit audio).
    I32,
    F32,
}

impl SampleFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            SampleFormat::I16 => "i16",
            SampleFormat::I32 => "i32",
            SampleFormat::F32 => "f32",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub format: SampleFormat,
}

impl InputFormat {
    pub fn bytes_per_sample(&self) -> usize {
        match self.format {
            SampleFormat::I16 => 2,
            SampleFormat::I32 | SampleFormat::F32 => 4,
        }
    }

    pub fn bytes_per_frame(&self) -> usize {
        self.bytes_per_sample() * self.channels.max(1) as usize
    }
}

/// Down-mixes, resamples and slices audio into frames.
///
/// Resampling is linear interpolation. When the input rate is above 16 kHz the
/// mono signal first goes through a windowed-sinc (Kaiser) low-pass FIR so that
/// content above 8 kHz does not fold back into the speech band. The filter is
/// evaluated only at the input samples the interpolator actually uses, so the
/// cost scales with the output rate rather than the input rate. It delays the
/// signal by (taps - 1) / 2 input samples (under 1 ms at 44.1/48 kHz).
///
/// Input at 16 kHz or below is not filtered, and 16 kHz mono PCM16 passes
/// through bit-exact (delayed by the one sample that primes the interpolator).
pub struct FrameAssembler {
    input: InputFormat,
    /// Input samples advanced per output sample.
    step: f64,
    /// Position of the next output sample, relative to the previous input sample.
    pos: f64,
    /// Anti-alias filter, present when the input rate is above the target rate.
    filter: Option<LowPass>,
    /// Interpolator value of the previous input sample, when already known.
    prev: Option<f32>,
    primed: bool,
    pending: Vec<i16>,
    carry: Vec<u8>,
}

impl FrameAssembler {
    pub fn new(input: InputFormat) -> Self {
        let rate = input.sample_rate.max(1);
        Self {
            input,
            step: rate as f64 / TARGET_RATE as f64,
            pos: 0.0,
            filter: (rate > TARGET_RATE).then(|| LowPass::new(rate as f64)),
            prev: None,
            primed: false,
            pending: Vec::with_capacity(FRAME_SAMPLES),
            carry: Vec::new(),
        }
    }

    pub fn input(&self) -> InputFormat {
        self.input
    }

    /// Feeds raw interleaved little-endian bytes in the input format.
    /// Calls `emit` once per completed 320-sample frame.
    pub fn push_bytes(&mut self, bytes: &[u8], mut emit: impl FnMut(&[i16])) {
        let bpf = self.input.bytes_per_frame();
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(bytes);
        let whole = data.len() / bpf * bpf;
        for frame in data[..whole].chunks_exact(bpf) {
            let mono = self.mono_sample(frame);
            self.push_sample(mono, &mut emit);
        }
        data.drain(..whole);
        self.carry = data;
    }

    /// Emits the partly assembled frame, if any, padded with silence. Used when
    /// the device stops delivering, so the audio is not held back indefinitely.
    pub fn flush(&mut self, mut emit: impl FnMut(&[i16])) {
        if !self.pending.is_empty() {
            self.pending.resize(FRAME_SAMPLES, 0);
            emit(&self.pending);
            self.pending.clear();
        }
    }

    /// Feeds mono samples in the range [-1, 1] at the input sample rate.
    pub fn push_mono(&mut self, samples: &[f32], mut emit: impl FnMut(&[i16])) {
        for &s in samples {
            self.push_sample(s, &mut emit);
        }
    }

    fn mono_sample(&self, frame: &[u8]) -> f32 {
        let bps = self.input.bytes_per_sample();
        let channels = self.input.channels.max(1) as usize;
        let mut acc = 0.0f32;
        for c in 0..channels {
            let b = &frame[c * bps..(c + 1) * bps];
            acc += match self.input.format {
                SampleFormat::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
                SampleFormat::I32 => {
                    i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0
                }
                SampleFormat::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            };
        }
        acc / channels as f32
    }

    fn push_sample(&mut self, x: f32, emit: &mut impl FnMut(&[i16])) {
        if let Some(filter) = self.filter.as_mut() {
            filter.push(x);
        }
        let first = !self.primed;
        self.primed = true;
        if first || self.pos >= 1.0 {
            // No output sample falls between the previous sample and this one.
            if !first {
                self.pos -= 1.0;
            }
            // Unfiltered values are free to keep; filtered ones are computed on demand.
            self.prev = self.filter.is_none().then_some(x);
            return;
        }
        let cur = self.filter.as_ref().map_or(x, |f| f.output(0));
        let prev = match (self.prev, self.filter.as_ref()) {
            (Some(p), _) => p,
            (None, Some(f)) => f.output(1),
            (None, None) => cur,
        };
        while self.pos < 1.0 {
            let v = prev + (cur - prev) * self.pos as f32;
            // Scaling by 32768 keeps i16 input bit-exact; +1.0 clamps to 32767.
            self.pending
                .push((v * 32_768.0).round().clamp(-32_768.0, 32_767.0) as i16);
            if self.pending.len() == FRAME_SAMPLES {
                emit(&self.pending);
                self.pending.clear();
            }
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.prev = Some(cur);
    }
}

/// Linear-phase low-pass FIR over a short history of input samples.
struct LowPass {
    taps: Vec<f32>,
    /// The last `len` input samples, stored twice so that every window is one
    /// contiguous slice.
    history: Vec<f32>,
    len: usize,
    /// Slot of the next sample to write.
    head: usize,
    primed: bool,
}

impl LowPass {
    fn new(sample_rate: f64) -> Self {
        let taps = kaiser_lowpass(
            sample_rate,
            AA_CUTOFF_HZ,
            AA_TRANSITION_HZ,
            AA_ATTENUATION_DB,
        );
        let len = taps.len() + 1;
        Self {
            taps,
            history: vec![0.0; 2 * len],
            len,
            head: 0,
            primed: false,
        }
    }

    fn push(&mut self, x: f32) {
        if !self.primed {
            // Start as if the first sample had always been there: no start-up ramp.
            self.history.fill(x);
            self.primed = true;
        }
        self.history[self.head] = x;
        self.history[self.head + self.len] = x;
        self.head = (self.head + 1) % self.len;
    }

    /// Filter output at the newest sample (`back` = 0) or the one before it (`back` = 1).
    fn output(&self, back: usize) -> f32 {
        let end = self.head + self.len - back;
        let window = &self.history[end - self.taps.len()..end];
        window.iter().zip(&self.taps).map(|(x, h)| x * h).sum()
    }
}

/// Designs a windowed-sinc low-pass with a Kaiser window (odd length, unity DC gain).
fn kaiser_lowpass(fs: f64, cutoff_hz: f64, transition_hz: f64, attenuation_db: f64) -> Vec<f32> {
    let a = attenuation_db;
    let beta = if a > 50.0 {
        0.1102 * (a - 8.7)
    } else if a >= 21.0 {
        0.5842 * (a - 21.0).powf(0.4) + 0.07886 * (a - 21.0)
    } else {
        0.0
    };
    let dw = 2.0 * PI * transition_hz / fs;
    let mut n = ((a - 8.0) / (2.285 * dw)).ceil().max(1.0) as usize + 1;
    if n.is_multiple_of(2) {
        n += 1;
    }
    let m = (n - 1) as f64 / 2.0;
    let fc = cutoff_hz / fs;
    let i0_beta = bessel_i0(beta);
    let taps: Vec<f64> = (0..n)
        .map(|i| {
            let t = i as f64 - m;
            let sinc = if t == 0.0 {
                2.0 * fc
            } else {
                (2.0 * PI * fc * t).sin() / (PI * t)
            };
            let r = if m > 0.0 { t / m } else { 0.0 };
            sinc * bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0_beta
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    taps.iter().map(|t| (t / sum) as f32).collect()
}

/// Modified Bessel function of the first kind, order 0 (power series).
fn bessel_i0(x: f64) -> f64 {
    let q = x * x / 4.0;
    let mut sum = 1.0;
    let mut term = 1.0;
    for k in 1..100 {
        term *= q / (k * k) as f64;
        sum += term;
        if term < sum * 1e-14 {
            break;
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(asm: &mut FrameAssembler, bytes: &[u8]) -> Vec<Vec<i16>> {
        let mut out = Vec::new();
        asm.push_bytes(bytes, |f| out.push(f.to_vec()));
        out
    }

    fn i16_bytes(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn f32_bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    /// Gain in dB of a 0.5-amplitude sine at `freq` through the assembler.
    fn sine_gain_db(rate: u32, freq: f64) -> f64 {
        let input = InputFormat {
            sample_rate: rate,
            channels: 1,
            format: SampleFormat::F32,
        };
        let samples: Vec<f32> = (0..rate)
            .map(|i| (0.5 * (2.0 * PI * freq * i as f64 / rate as f64).sin()) as f32)
            .collect();
        let mut asm = FrameAssembler::new(input);
        let out: Vec<i16> = collect(&mut asm, &f32_bytes(&samples))
            .concat()
            .into_iter()
            .skip(FRAME_SAMPLES) // skip the first 20 ms
            .collect();
        let rms = (out.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / out.len() as f64).sqrt();
        let reference = 0.5 * 32_768.0 / 2f64.sqrt();
        20.0 * (rms / reference).log10()
    }

    #[test]
    fn passthrough_16k_mono_i16() {
        let input = InputFormat {
            sample_rate: 16_000,
            channels: 1,
            format: SampleFormat::I16,
        };
        let mut asm = FrameAssembler::new(input);
        let samples: Vec<i16> = (0..1000).map(|i| (i * 10) as i16).collect();
        let frames = collect(&mut asm, &i16_bytes(&samples));
        // The first sample primes the interpolator, so output lags by one sample.
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0][0], 0);
        assert_eq!(frames[0][1], 10);
        assert_eq!(frames[2][319], (959 * 10) as i16);
    }

    #[test]
    fn passthrough_is_bit_exact_at_full_scale() {
        let input = InputFormat {
            sample_rate: 16_000,
            channels: 1,
            format: SampleFormat::I16,
        };
        let samples: Vec<i16> = (0..641)
            .map(|i| match i % 5 {
                0 => i16::MAX,
                1 => i16::MIN,
                2 => -1,
                3 => 16_385,
                _ => (i * 97) as i16,
            })
            .collect();
        let mut asm = FrameAssembler::new(input);
        let out = collect(&mut asm, &i16_bytes(&samples)).concat();
        assert_eq!(out, samples[..640]);
    }

    #[test]
    fn downmix_and_resample_48k_stereo_f32() {
        let input = InputFormat {
            sample_rate: 48_000,
            channels: 2,
            format: SampleFormat::F32,
        };
        let mut asm = FrameAssembler::new(input);
        // 100 ms of L = 0.25, R = 0.75 → mono 0.5
        let bytes: Vec<u8> = (0..4800)
            .flat_map(|_| [0.25f32.to_le_bytes(), 0.75f32.to_le_bytes()].concat())
            .collect();
        let frames = collect(&mut asm, &bytes);
        assert_eq!(frames.len(), 5); // 1600 output samples
        assert!(frames.iter().flatten().all(|&s| (s - 16_384).abs() <= 1));
    }

    #[test]
    fn flush_pads_a_partial_frame_with_silence() {
        let input = InputFormat {
            sample_rate: 16_000,
            channels: 1,
            format: SampleFormat::I16,
        };
        let mut asm = FrameAssembler::new(input);
        assert!(collect(&mut asm, &i16_bytes(&[100; 101])).is_empty());
        let mut out = Vec::new();
        asm.flush(|f| out.push(f.to_vec()));
        asm.flush(|f| out.push(f.to_vec())); // nothing left
        assert_eq!(out.len(), 1);
        assert!(out[0][..100].iter().all(|&s| s == 100));
        assert!(out[0][100..].iter().all(|&s| s == 0));
    }

    #[test]
    fn upsample_8k_doubles_sample_count() {
        let input = InputFormat {
            sample_rate: 8_000,
            channels: 1,
            format: SampleFormat::I16,
        };
        let mut asm = FrameAssembler::new(input);
        let frames = collect(&mut asm, &i16_bytes(&vec![1000; 801]));
        assert_eq!(frames.len(), 5); // 800 input intervals → 1600 output samples
    }

    #[test]
    fn chunk_boundaries_do_not_change_output() {
        let input = InputFormat {
            sample_rate: 44_100,
            channels: 2,
            format: SampleFormat::I16,
        };
        let samples: Vec<i16> = (0..44_100 * 2)
            .map(|i| ((i as f32 * 0.01).sin() * 20_000.0) as i16)
            .collect();
        let bytes = i16_bytes(&samples);

        let mut whole = FrameAssembler::new(input);
        let expected = collect(&mut whole, &bytes);

        let mut pieces = FrameAssembler::new(input);
        let mut got = Vec::new();
        for chunk in bytes.chunks(997) {
            got.extend(collect(&mut pieces, chunk)); // odd size splits sample frames
        }
        assert_eq!(expected, got);
        assert_eq!(expected.len(), 50); // 1 s of stereo 44.1 kHz → 16000 samples → 50 frames
    }

    #[test]
    fn chunk_boundaries_do_not_change_output_48k_f32() {
        let input = InputFormat {
            sample_rate: 48_000,
            channels: 2,
            format: SampleFormat::F32,
        };
        let samples: Vec<f32> = (0..48_000 * 2)
            .map(|i| ((i as f32 * 0.37).sin() * 0.8) * if i % 7 == 0 { -1.0 } else { 1.0 })
            .collect();
        let bytes = f32_bytes(&samples);

        let mut whole = FrameAssembler::new(input);
        let expected = collect(&mut whole, &bytes);

        let mut pieces = FrameAssembler::new(input);
        let mut got = Vec::new();
        for (i, chunk) in bytes.chunks(1_237).enumerate() {
            let mut out = Vec::new();
            // Mix byte and sample-aligned chunk sizes.
            if i % 3 == 0 {
                for part in chunk.chunks(5) {
                    pieces.push_bytes(part, |f| out.push(f.to_vec()));
                }
            } else {
                pieces.push_bytes(chunk, |f| out.push(f.to_vec()));
            }
            got.extend(out);
        }
        assert_eq!(expected, got);
        assert_eq!(expected.len(), 50);
    }

    #[test]
    fn anti_alias_48k() {
        let pass = sine_gain_db(48_000, 1_000.0);
        let stop = sine_gain_db(48_000, 10_000.0);
        eprintln!("48 kHz: 1 kHz {pass:.2} dB, 10 kHz {stop:.2} dB");
        assert!(pass.abs() <= 1.0, "1 kHz gain {pass:.2} dB");
        assert!(stop <= -30.0, "10 kHz gain {stop:.2} dB");
    }

    #[test]
    fn anti_alias_44k1() {
        let pass = sine_gain_db(44_100, 1_000.0);
        let stop = sine_gain_db(44_100, 10_000.0);
        eprintln!("44.1 kHz: 1 kHz {pass:.2} dB, 10 kHz {stop:.2} dB");
        assert!(pass.abs() <= 1.0, "1 kHz gain {pass:.2} dB");
        assert!(stop <= -30.0, "10 kHz gain {stop:.2} dB");
    }

    #[test]
    fn filter_design_is_symmetric_with_unity_dc_gain() {
        for rate in [22_050.0, 44_100.0, 48_000.0, 96_000.0] {
            let taps = kaiser_lowpass(rate, AA_CUTOFF_HZ, AA_TRANSITION_HZ, AA_ATTENUATION_DB);
            assert_eq!(taps.len() % 2, 1);
            let sum: f32 = taps.iter().sum();
            assert!((sum - 1.0).abs() < 1e-5);
            let n = taps.len();
            assert!((0..n / 2).all(|i| (taps[i] - taps[n - 1 - i]).abs() < 1e-7));
        }
    }
}
