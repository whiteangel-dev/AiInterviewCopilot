//! Platform-independent conversion of captured audio into the pipeline's
//! canonical format: 20 ms frames of 16 kHz mono 16-bit PCM.

pub const TARGET_RATE: u32 = 16_000;
/// 20 ms at 16 kHz.
pub const FRAME_SAMPLES: usize = 320;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleFormat {
    I16,
    /// 32-bit integer container (also used for left-justified 24-bit audio).
    I32,
    F32,
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

/// Down-mixes, resamples (linear interpolation) and slices audio into frames.
///
/// Linear interpolation has no anti-alias filter; it is only the fallback for
/// devices where WASAPI's own converter (AUTOCONVERTPCM) is unavailable. The
/// production pipeline should use a polyphase resampler (e.g. `rubato`).
pub struct FrameAssembler {
    input: InputFormat,
    /// Input samples advanced per output sample.
    step: f64,
    /// Position of the next output sample, relative to `prev` (0.0 = at `prev`).
    pos: f64,
    prev: f32,
    have_prev: bool,
    pending: Vec<i16>,
    carry: Vec<u8>,
}

impl FrameAssembler {
    pub fn new(input: InputFormat) -> Self {
        Self {
            input,
            step: input.sample_rate as f64 / TARGET_RATE as f64,
            pos: 0.0,
            prev: 0.0,
            have_prev: false,
            pending: Vec::with_capacity(FRAME_SAMPLES),
            carry: Vec::new(),
        }
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
        self.carry = data[whole..].to_vec();
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

    fn push_sample(&mut self, cur: f32, emit: &mut impl FnMut(&[i16])) {
        if !self.have_prev {
            self.prev = cur;
            self.have_prev = true;
            return;
        }
        while self.pos < 1.0 {
            let v = self.prev + (cur - self.prev) * self.pos as f32;
            self.pending
                .push((v.clamp(-1.0, 1.0) * 32_767.0).round() as i16);
            if self.pending.len() == FRAME_SAMPLES {
                emit(&self.pending);
                self.pending.clear();
            }
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.prev = cur;
    }
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
}
