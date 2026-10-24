//! Streaming counterparts of the worker's deterministic track effects.
use serde_json::Value;

const REVERB_TAPS: [(f64, f64); 6] = [
    (0.071, 0.34),
    (0.113, 0.27),
    (0.181, 0.21),
    (0.293, 0.15),
    (0.457, 0.10),
    (0.691, 0.06),
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct EffectSettings {
    pub reverb: f64,
    pub delay: f64,
    pub delay_time: f64,
    pub clarity: f64,
    pub compressor: f64,
}

impl Default for EffectSettings {
    fn default() -> Self {
        Self {
            reverb: 0.0,
            delay: 0.0,
            delay_time: 0.24,
            clarity: 0.0,
            compressor: 0.0,
        }
    }
}

impl EffectSettings {
    pub fn parse(value: Option<&Value>) -> Result<Self, String> {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Ok(Self::default());
        };
        let object = value.as_object().ok_or("Track effects must be an object")?;
        let read = |name: &str, default: f64, min: f64, max: f64| -> Result<f64, String> {
            let Some(value) = object.get(name) else {
                return Ok(default);
            };
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("Track effect {name} must be a finite number"))?;
            if !(min..=max).contains(&number) {
                return Err(format!(
                    "Track effect {name} is outside the supported range"
                ));
            }
            Ok(number)
        };
        Ok(Self {
            reverb: read("reverb", 0.0, 0.0, 1.0)?,
            delay: read("delay", 0.0, 0.0, 1.0)?,
            delay_time: read("delayTime", 0.24, 0.05, 1.2)?,
            clarity: read("clarity", 0.0, 0.0, 1.0)?,
            compressor: read("compressor", 0.0, 0.0, 1.0)?,
        })
    }

    fn last_tap(self, rate: u32) -> usize {
        let reverb = if self.reverb > 0.0 {
            (f64::from(rate) * 0.691).floor() as usize
        } else {
            0
        };
        let delay = if self.delay > 0.0 {
            (f64::from(rate) * self.delay_time * 5.0).floor() as usize
        } else {
            0
        };
        reverb.max(delay)
    }

    /// Stereo frames required by enabled delay/reverb taps, including the write position.
    /// The caller validates the rate and total project allocation before constructing processors.
    pub fn history_frames(self, rate: u32) -> usize {
        if self.reverb <= 0.0 && self.delay <= 0.0 {
            0
        } else {
            self.last_tap(rate).max(1) + 1
        }
    }

    fn bypassed(self) -> bool {
        self.reverb <= 0.0 && self.delay <= 0.0 && self.clarity <= 0.0 && self.compressor <= 0.0
    }
}

#[derive(Clone, Copy, Default)]
struct Tap {
    frames: usize,
    gain: f32,
}

pub(crate) struct TrackEffects {
    settings: EffectSettings,
    taps: [Tap; 11],
    tap_count: usize,
    history: Vec<[f32; 2]>,
    cursor: usize,
    previous_input: [f64; 2],
    previous_output: [f64; 2],
    alpha: f64,
    threshold: f32,
    ratio: f32,
    tail: u64,
}

impl TrackEffects {
    pub fn new(settings: EffectSettings, rate: u32) -> Self {
        let mut taps = [Tap::default(); 11];
        let mut count = 0;
        if settings.reverb > 0.0 {
            for (seconds, gain) in REVERB_TAPS {
                taps[count] = Tap {
                    frames: (f64::from(rate) * seconds).floor().max(1.0) as usize,
                    gain: (settings.reverb * gain) as f32,
                };
                count += 1;
            }
        }
        if settings.delay > 0.0 {
            for repeat in 1..=5 {
                taps[count] = Tap {
                    frames: (f64::from(rate) * settings.delay_time * f64::from(repeat))
                        .floor()
                        .max(1.0) as usize,
                    gain: (settings.delay * 0.46_f64.powi(repeat)) as f32,
                };
                count += 1;
            }
        }
        let alpha = if settings.clarity > 0.0 {
            let rc = 1.0 / (2.0 * std::f64::consts::PI * (20.0 + settings.clarity * 180.0));
            rc / (rc + 1.0 / f64::from(rate))
        } else {
            0.0
        };
        // Unlike the worker's finite-array filter, a streaming high-pass continues responding
        // to zero input. Allow its state to settle by 120 dB after the final delayed dry sample.
        let settling = if alpha > 0.0 {
            (1e-6_f64.ln() / alpha.ln()).ceil() as u64
        } else {
            0
        };
        Self {
            settings,
            taps,
            tap_count: count,
            history: vec![[0.0; 2]; settings.history_frames(rate)],
            cursor: 0,
            previous_input: [0.0; 2],
            previous_output: [0.0; 2],
            alpha,
            threshold: 10.0_f64.powf((-36.0 + settings.compressor * 14.0) / 20.0) as f32,
            ratio: (1.0 + settings.compressor * 7.0) as f32,
            tail: settings.last_tap(rate) as u64 + settling,
        }
    }

    pub fn settings(&self) -> EffectSettings {
        self.settings
    }
    pub fn tail_samples(&self) -> u64 {
        self.tail
    }

    pub fn reset(&mut self) {
        self.history.fill([0.0; 2]);
        self.cursor = 0;
        self.previous_input.fill(0.0);
        self.previous_output.fill(0.0);
    }

    /// Processes at most the first two channels and their shared available frame count.
    /// No allocations or I/O occur here; the ring always stores the processed dry signal.
    pub fn process(&mut self, io: &mut [Vec<f32>], frames: usize) {
        if self.settings.bypassed() || io.is_empty() || frames == 0 {
            return;
        }
        let channels = io.len().min(2);
        let frames = io
            .iter()
            .take(channels)
            .map(Vec::len)
            .fold(frames, usize::min);
        for frame in 0..frames {
            let mut dry = [0.0_f32; 2];
            for channel in 0..channels {
                let mut sample = io[channel][frame];
                if self.alpha > 0.0 {
                    let input = f64::from(sample);
                    let output = self.alpha * (input - self.previous_input[channel])
                        + self.alpha * self.previous_output[channel];
                    self.previous_input[channel] = input;
                    self.previous_output[channel] = output;
                    sample = output as f32;
                }
                if self.settings.compressor > 0.0 {
                    let magnitude = sample.abs();
                    let compressed = if magnitude > self.threshold {
                        self.threshold + (magnitude - self.threshold) / self.ratio
                    } else {
                        magnitude
                    };
                    // Match the worker's float32 gain calculation, including its small-signal floor.
                    sample *= compressed / magnitude.max(1e-6);
                }
                dry[channel] = sample;
            }
            let mut output = dry;
            if !self.history.is_empty() {
                self.history[self.cursor] = dry;
                for tap in self.taps.iter().take(self.tap_count) {
                    let index = if self.cursor >= tap.frames {
                        self.cursor - tap.frames
                    } else {
                        self.history.len() - (tap.frames - self.cursor)
                    };
                    let past = self.history[index];
                    for channel in 0..channels {
                        output[channel] += past[channel] * tap.gain;
                    }
                }
                self.cursor += 1;
                if self.cursor == self.history.len() {
                    self.cursor = 0;
                }
            }
            for channel in 0..channels {
                io[channel][frame] = output[channel];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(value: Value) -> EffectSettings {
        EffectSettings::parse(Some(&value)).unwrap()
    }
    fn stereo(samples: Vec<f32>) -> Vec<Vec<f32>> {
        vec![samples.clone(), samples]
    }
    fn assert_close(actual: &[f32], expected: &[f32]) {
        assert_eq!(actual.len(), expected.len());
        for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
            assert!(
                (actual - expected).abs() <= 1e-6,
                "sample {index}: {actual} != {expected}"
            );
        }
    }

    #[test]
    fn impulse_matches_parallel_reverb_and_delay_coefficients() {
        let settings = settings(json!({ "reverb": 0.75, "delay": 0.6, "delayTime": 0.071 }));
        let rate = 8_000;
        let mut effects = TrackEffects::new(settings, rate);
        let frames = effects.tail_samples() as usize + 2;
        let mut input = vec![0.0; frames];
        input[0] = 1.0;
        let mut io = stereo(input);
        effects.process(&mut io, frames);
        let mut expected = vec![0.0; frames];
        expected[0] = 1.0;
        // Reference coefficients/positions from worker_audio.py at 8 kHz. The coincident
        // first delay/reverb tap must add both parallel contributions without feedback.
        for (frame, gain) in [
            (568, 0.531_f32),
            (904, 0.2025),
            (1136, 0.12696),
            (1448, 0.1575),
            (1704, 0.0584016),
            (2272, 0.026864736),
            (2344, 0.1125),
            (2840, 0.01235777856),
            (3656, 0.075),
            (5528, 0.045),
        ] {
            expected[frame] = gain;
        }
        assert_eq!(io[0], expected);
        assert_eq!(io[1], expected);
        assert_eq!(effects.tail_samples(), (8_000.0_f64 * 0.691).floor() as u64);
        assert_eq!(effects.history.len(), effects.tail_samples() as usize + 1);
    }

    #[test]
    fn individual_impulses_have_the_worker_taps_and_no_feedback_echo() {
        for (settings, taps) in [
            (
                settings(json!({ "reverb": 1.0 })),
                vec![
                    (568, 0.34_f32),
                    (904, 0.27),
                    (1448, 0.21),
                    (2344, 0.15),
                    (3656, 0.1),
                    (5528, 0.06),
                ],
            ),
            (
                settings(json!({ "delay": 1.0, "delayTime": 0.05 })),
                vec![
                    (400, 0.46_f32),
                    (800, 0.2116),
                    (1200, 0.097336),
                    (1600, 0.04477456),
                    (2000, 0.0205962976),
                ],
            ),
        ] {
            let mut effects = TrackEffects::new(settings, 8_000);
            let frames = effects.tail_samples() as usize + 801;
            let mut input = vec![0.0; frames];
            input[0] = 1.0;
            let mut io = stereo(input);
            effects.process(&mut io, frames);
            let mut expected = vec![0.0; frames];
            expected[0] = 1.0;
            for (frame, gain) in taps {
                expected[frame] = gain;
            }
            assert_eq!(io[0], expected);
            assert_eq!(io[1], expected);
        }
    }

    #[test]
    fn clarity_and_compression_match_reference_samples_in_order() {
        let settings = settings(json!({ "clarity": 0.6, "compressor": 0.7 }));
        let mut effects = TrackEffects::new(settings, 48_000);
        let mut io = vec![
            vec![0.0, 0.000_000_01, 0.5, -0.4, 0.02, 0.0],
            vec![0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
        ];
        let original = io.clone();
        effects.process(&mut io, 6);
        let cutoff = 20.0 + 0.6 * 180.0;
        let alpha = 1.0 / (1.0 + 2.0 * std::f64::consts::PI * cutoff / 48_000.0);
        let threshold = 10.0_f64.powf((-36.0 + 0.7 * 14.0) / 20.0) as f32;
        let ratio = (1.0 + 0.7 * 7.0) as f32;
        for channel in 0..2 {
            let mut state = 0.0_f64;
            let mut expected = Vec::new();
            // Independent direct-form-II reference, matching scipy.signal.lfilter.
            for input in &original[channel] {
                let filtered = alpha * f64::from(*input) + state;
                state = -alpha * f64::from(*input) + alpha * filtered;
                let value = filtered as f32;
                let magnitude = value.abs();
                let compressed = if magnitude > threshold {
                    threshold + (magnitude - threshold) / ratio
                } else {
                    magnitude
                };
                expected.push(value * compressed / magnitude.max(1e-6));
            }
            assert_close(&io[channel], &expected);
        }
        assert!(effects.history.is_empty());
        assert!(effects.tail_samples() > 0);
    }

    #[test]
    fn clarity_tail_settles_after_a_step_ends_without_a_history_buffer() {
        for rate in [8_000, 48_000, 192_000] {
            let mut effects = TrackEffects::new(settings(json!({ "clarity": 0.4 })), rate);
            let rc = 1.0 / (2.0 * std::f64::consts::PI * (20.0 + 0.4 * 180.0));
            let alpha = rc / (rc + 1.0 / f64::from(rate));
            let settling = (1e-6_f64.ln() / alpha.ln()).ceil() as usize;
            assert_eq!(effects.tail_samples(), settling as u64);
            assert!(effects.history.is_empty());
            let mut step = stereo(vec![1.0; 4_096]);
            effects.process(&mut step, 4_096);
            let mut tail = stereo(vec![0.0; settling]);
            effects.process(&mut tail, settling);
            assert!(tail[0][0].abs() > 0.5);
            let final_sample = tail[0][settling - 1].abs();
            // The ended full-scale step excites the high-pass state. It must reach -120 dB,
            // while retaining its real decay rather than abruptly clearing the filter.
            assert!(final_sample <= 1.000_001e-6, "rate {rate}: {final_sample}");
            assert!(final_sample > 1e-7, "rate {rate}: response was truncated");
            assert_eq!(tail[0], tail[1]);
        }
    }

    #[test]
    fn final_sample_impulse_settles_after_the_last_parallel_tap() {
        let settings =
            settings(json!({ "reverb": 0.8, "delay": 0.6, "delayTime": 0.05, "clarity": 0.5 }));
        let rate = 8_000;
        let mut effects = TrackEffects::new(settings, rate);
        let dry_taps = TrackEffects::new(
            EffectSettings {
                clarity: 0.0,
                ..settings
            },
            rate,
        );
        let settling = (1e-6_f64.ln() / effects.alpha.ln()).ceil() as usize;
        assert_eq!(
            effects.tail_samples(),
            dry_taps.tail_samples() + settling as u64
        );
        assert_eq!(effects.history.len(), dry_taps.history.len());
        assert_eq!(effects.history.len(), settings.history_frames(rate));
        let mut source = stereo(vec![0.0; 257]);
        source[0][256] = 1.0;
        source[1][256] = -1.0;
        effects.process(&mut source, 257);
        let final_response = source[0][256].abs();
        let frames = effects.tail_samples() as usize;
        let mut tail = stereo(vec![0.0; frames]);
        effects.process(&mut tail, frames);
        assert!(tail[0][dry_taps.tail_samples() as usize - 1].abs() > 0.001);
        assert!(tail[0][frames - 1].abs() <= final_response * 1e-6);
        assert!(tail[0][frames - 1] != 0.0);
        for (left, right) in tail[0].iter().zip(&tail[1]) {
            assert_eq!(*left, -*right);
        }
    }

    #[test]
    fn block_splitting_preserves_stereo_history_and_iir_state() {
        let settings = settings(
            json!({ "reverb": 0.4, "delay": 0.7, "delayTime": 0.053, "clarity": 0.9, "compressor": 0.5 }),
        );
        let samples = (0..18_001)
            .map(|index| ((index as f32 * 0.13).sin() + (index as f32 * 0.27).cos()) * 0.25)
            .collect::<Vec<_>>();
        let right = samples.iter().rev().copied().collect::<Vec<_>>();
        let original = vec![samples, right];
        let mut whole = original.clone();
        let mut continuous = TrackEffects::new(settings, 8_000);
        continuous.process(&mut whole, 18_001);
        let mut split = TrackEffects::new(settings, 8_000);
        let mut collected = vec![Vec::new(), Vec::new()];
        let mut start = 0;
        let mut block = 0;
        while start < 18_001 {
            let frames = [1, 17, 256, 701, 3][block % 5].min(18_001 - start);
            let mut io = original
                .iter()
                .map(|channel| channel[start..start + frames].to_vec())
                .collect::<Vec<_>>();
            split.process(&mut io, frames);
            for channel in 0..2 {
                collected[channel].extend_from_slice(&io[channel]);
            }
            start += frames;
            block += 1;
        }
        assert_eq!(whole, collected);
    }

    #[test]
    fn reset_discards_both_the_effect_tail_and_filter_history() {
        let settings = settings(json!({ "reverb": 1.0, "delay": 1.0, "clarity": 1.0 }));
        let mut effects = TrackEffects::new(settings, 8_000);
        let mut impulse = stereo(vec![1.0]);
        effects.process(&mut impulse, 1);
        effects.reset();
        let mut silence = stereo(vec![0.0; effects.history.len() + 10]);
        let frames = silence[0].len();
        effects.process(&mut silence, frames);
        assert!(silence.iter().flatten().all(|value| *value == 0.0));
        assert_eq!(effects.settings(), settings);
    }

    #[test]
    fn bypass_preserves_every_sample_bit_and_allocates_no_history() {
        let mut effects = TrackEffects::new(EffectSettings::default(), 192_000);
        let values = vec![
            f32::from_bits(0x7fc0_0042),
            -0.0,
            0.0,
            0.25,
            f32::MIN_POSITIVE,
            f32::INFINITY,
        ];
        let mut io = stereo(values.clone());
        effects.process(&mut io, 99);
        for channel in io {
            assert_eq!(
                channel
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                values
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>()
            );
        }
        assert!(effects.history.is_empty());
        assert_eq!(EffectSettings::default().history_frames(192_000), 0);
        assert_eq!(effects.tail_samples(), 0);
    }

    #[test]
    fn settings_defaults_bounds_and_invalid_inputs_are_explicit() {
        assert_eq!(
            EffectSettings::parse(None).unwrap(),
            EffectSettings::default()
        );
        assert_eq!(
            EffectSettings::parse(Some(&Value::Null)).unwrap(),
            EffectSettings::default()
        );
        assert_eq!(
            settings(json!({ "futureEffect": { "preset": 4 } })),
            EffectSettings::default()
        );
        for value in [
            json!([]),
            json!("effects"),
            json!(true),
            json!(1),
            json!({ "reverb": null }),
            json!({ "delay": "0.5" }),
            json!({ "clarity": true }),
            json!({ "compressor": -0.1 }),
            json!({ "reverb": 1.1 }),
            json!({ "delayTime": 0.049 }),
            json!({ "delayTime": 1.201 }),
        ] {
            assert!(EffectSettings::parse(Some(&value)).is_err(), "{value}");
        }
        assert!(serde_json::from_str::<Value>("{\"delay\":NaN}").is_err());
        let upper = settings(
            json!({ "reverb": 1, "delay": 1, "clarity": 1, "compressor": 1, "delayTime": 1.2 }),
        );
        assert_eq!(upper.history_frames(192_000), 1_152_001);
        let reverb_only = settings(json!({ "reverb": 0.1, "delayTime": 1.2 }));
        assert_eq!(reverb_only.history_frames(8_000), 5_529);
        let delay_only = settings(json!({ "delay": 0.1, "delayTime": 0.05 }));
        assert_eq!(delay_only.history_frames(8_000), 2_001);
    }
}
