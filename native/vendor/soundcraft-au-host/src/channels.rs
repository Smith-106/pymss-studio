//! Main-bus mono/stereo negotiation and planar channel mapping, independent of AudioToolbox.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ChannelLayout {
    pub(crate) inputs: usize,
    pub(crate) outputs: usize,
}

/// Prefer the host's layout, then preserve its output width before folding either side.
/// Each pair is attempted once; a unit without an input bus needs only two output choices.
pub(crate) fn candidates(channels: usize, has_input: bool) -> Vec<ChannelLayout> {
    let alternate = 3 - channels;
    let mut layouts = Vec::with_capacity(4);
    for (inputs, outputs) in [
        (channels, channels),
        (alternate, channels),
        (channels, alternate),
        (alternate, alternate),
    ] {
        let layout = ChannelLayout {
            inputs: if has_input { inputs } else { 0 },
            outputs,
        };
        if !layouts.contains(&layout) {
            layouts.push(layout);
        }
    }
    layouts
}

/// Configuration attempts remain stopped control operations. The callback sets both scoped
/// stream formats and initializes the unit; no accepted pair is inferred from a setter alone.
pub(crate) fn negotiate(
    layouts: &[ChannelLayout],
    mut attempt: impl FnMut(ChannelLayout) -> Result<(), i32>,
) -> Result<ChannelLayout, i32> {
    let mut last = -50;
    for &layout in layouts {
        match attempt(layout) {
            Ok(()) => return Ok(layout),
            Err(status) => last = status,
        }
    }
    Err(last)
}

/// Copy/duplicate one planar channel, or fold a stereo pair to mono with equal gain.
/// Bounds are checked before writing so an incomplete unit buffer cannot partially map audio.
pub(crate) fn copy_channel(
    destination: &mut [f32],
    first: &[f32],
    second: Option<&[f32]>,
) -> Result<(), &'static str> {
    if first.len() < destination.len()
        || second.is_some_and(|channel| channel.len() < destination.len())
    {
        return Err("Audio Unit returned an incomplete audio block");
    }
    if let Some(second) = second {
        for ((output, left), right) in destination.iter_mut().zip(first).zip(second) {
            *output = 0.5 * left + 0.5 * right;
        }
    } else {
        destination.copy_from_slice(&first[..destination.len()]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_covers_each_pair_and_accepts_asymmetric_effects() {
        for host in [1, 2] {
            let layouts = candidates(host, true);
            assert_eq!(layouts.len(), 4);
            assert_eq!(
                layouts[0],
                ChannelLayout {
                    inputs: host,
                    outputs: host
                }
            );
            for accepted in [
                ChannelLayout {
                    inputs: 1,
                    outputs: 1,
                },
                ChannelLayout {
                    inputs: 1,
                    outputs: 2,
                },
                ChannelLayout {
                    inputs: 2,
                    outputs: 1,
                },
                ChannelLayout {
                    inputs: 2,
                    outputs: 2,
                },
            ] {
                let mut attempts = Vec::new();
                assert_eq!(
                    negotiate(&layouts, |layout| {
                        assert!(!attempts.contains(&layout));
                        attempts.push(layout);
                        if layout == accepted {
                            Ok(())
                        } else {
                            Err(-10868)
                        }
                    }),
                    Ok(accepted)
                );
                assert_eq!(attempts.last(), Some(&accepted));
            }
        }
        assert_eq!(
            candidates(2, false),
            [
                ChannelLayout {
                    inputs: 0,
                    outputs: 2
                },
                ChannelLayout {
                    inputs: 0,
                    outputs: 1
                },
            ]
        );
    }

    #[test]
    fn failed_initialization_continues_and_exact_restart_does_not_renegotiate() {
        let accepted = ChannelLayout {
            inputs: 1,
            outputs: 2,
        };
        let mut calls = 0;
        assert_eq!(
            negotiate(&candidates(2, true), |layout| {
                calls += 1;
                if layout == accepted {
                    Ok(())
                } else {
                    Err(-10875)
                }
            }),
            Ok(accepted)
        );
        assert_eq!(calls, 2);
        assert_eq!(negotiate(&[accepted], |_| Err(-10875)), Err(-10875));
    }

    #[test]
    fn asymmetric_buffers_preserve_channel_direction_and_block_boundaries() {
        let host = [vec![1.0, 3.0, 5.0, 7.0], vec![3.0, 5.0, 7.0, 9.0]];
        let mut mono_input = [0.0; 2];
        copy_channel(&mut mono_input, &host[0][1..3], Some(&host[1][1..3])).unwrap();
        assert_eq!(mono_input, [4.0, 6.0]);
        // A 1-in/2-out fake effect sends the mono input into distinct output channels.
        let unit_outputs = [
            mono_input.map(|sample| sample * 2.0),
            mono_input.map(|sample| -sample),
        ];
        let mut host_outputs = [[0.0; 2]; 2];
        copy_channel(&mut host_outputs[0], &unit_outputs[0], None).unwrap();
        copy_channel(&mut host_outputs[1], &unit_outputs[1], None).unwrap();
        assert_eq!(host_outputs, [[8.0, 12.0], [-4.0, -6.0]]);
        let mut mono_host = [0.0; 2];
        copy_channel(&mut mono_host, &unit_outputs[0], Some(&unit_outputs[1])).unwrap();
        assert_eq!(mono_host, [2.0, 3.0]);
        // A 2-in/1-out fake effect returns mono, which is duplicated on a stereo host bus.
        for output in &mut host_outputs {
            copy_channel(output, &mono_input, None).unwrap();
        }
        assert_eq!(host_outputs, [[4.0, 6.0], [4.0, 6.0]]);
        // A mono host duplicates the same source into both inputs of a stereo-input effect.
        let mono_host_input = [2.0, -3.0];
        let mut stereo_unit_inputs = [[0.0; 2]; 2];
        for channel in &mut stereo_unit_inputs {
            copy_channel(channel, &mono_host_input, None).unwrap();
        }
        assert_eq!(stereo_unit_inputs, [[2.0, -3.0], [2.0, -3.0]]);
        let mut unchanged = [11.0, 12.0];
        assert!(copy_channel(&mut unchanged, &[1.0], None).is_err());
        assert_eq!(unchanged, [11.0, 12.0]);
    }
}
