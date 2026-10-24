//! Headless processing-mode contracts, each in an isolated plugin process.
use soundcraft_dsp::Plugin;

mod common;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--child") {
        let mode = std::env::args().nth(2).expect("child processing mode");
        check(&mode);
        soundcraft_vst3_host::shutdown();
        return;
    }
    for mode in ["", "mode-quality", "reject-offline", "reject-rollback"] {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--child")
            .arg(mode)
            .env("PYMSS_VST_FIXTURE_BEHAVIOR", mode)
            .status()
            .unwrap();
        assert!(result.success(), "processing mode scenario failed: {mode}");
    }
}

fn check(mode: &str) {
    let id = soundcraft_vst3_host::scan_paths(&[common::fixture_dir().to_path_buf()])
        .into_iter()
        .find(|plugin| plugin.name == "Fixture Gain")
        .unwrap()
        .id;
    let mut plugin = soundcraft_vst3_host::instantiate_plugin(&id).unwrap();
    assert!(!plugin.is_offline());
    if mode.starts_with("reject-") {
        plugin.try_prepare(48_000.0, 64, 2).unwrap();
        assert!(plugin.set_param("7", 1.5));
        let error = plugin.set_offline(true).unwrap_err();
        assert!(!plugin.is_offline());
        let mut io = vec![vec![0.25; 64]; 2];
        if mode == "reject-rollback" {
            assert!(error.contains("unable to restore processing mode"));
            assert!(plugin.try_process(&mut io, 64).is_err());
            assert!(plugin.try_process(&mut io, 64).is_err());
        } else {
            plugin.try_process(&mut io, 64).unwrap();
            assert!(
                io.iter()
                    .flatten()
                    .all(|value| (*value - 0.375).abs() < 1e-6)
            );
        }
        return;
    }

    // Staging the initial mode must not prepare/process on a different thread.
    plugin.set_offline(true).unwrap();
    plugin.try_prepare(48_000.0, 64, 2).unwrap();
    assert!(plugin.is_offline());
    if mode == "mode-quality" {
        assert_eq!(plugin.latency(), 11);
        assert_eq!(plugin.tail_samples(), 64);
    }
    assert!(plugin.set_param("7", 1.5));
    plugin.flush_pending().unwrap();
    let state = plugin.save_state().unwrap();
    assert!(plugin.set_param("7", 1.25));
    for offline in [false, true, false] {
        plugin.set_offline(offline).unwrap();
        assert_eq!(plugin.is_offline(), offline);
        assert_eq!(plugin.param("7"), Some(1.25));
        // Mode setup must retain the queued processor value and controller state.
        plugin.flush_pending().unwrap();
        let mut io = vec![vec![0.25; 64]; 2];
        plugin.try_process(&mut io, 64).unwrap();
        let expected = if offline && mode == "mode-quality" {
            0.625
        } else {
            0.3125
        };
        assert!(
            io.iter()
                .flatten()
                .all(|value| (*value - expected).abs() < 1e-6)
        );
        if mode == "mode-quality" {
            assert_eq!(plugin.latency(), if offline { 11 } else { 3 });
            assert_eq!(plugin.tail_samples(), if offline { 64 } else { 0 });
        }
    }
    assert!(plugin.load_state(&state));
    assert_eq!(plugin.param("7"), Some(1.5));
}
