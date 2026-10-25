//! Exercise export timing through the real helper and a separately loaded native fixture.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

fn fixture_bundle(root: &Path) -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor/soundcraft-vst3-host/tests/fixture/Cargo.toml");
    let target = Path::new(env!("CARGO_TARGET_TMPDIR")).join("audio-host-tail-fixture-target");
    let status = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(["build", "--quiet", "--manifest-path"])
        .arg(manifest)
        .arg("--target-dir")
        .arg(&target)
        .env_remove("RUSTFLAGS")
        .status()
        .unwrap();
    assert!(status.success(), "fixture build failed");
    let (library, folder, executable) = if cfg!(windows) {
        ("vst3_fixture.dll", "x86_64-win", "Fixture.vst3")
    } else if cfg!(target_os = "macos") {
        ("libvst3_fixture.dylib", "MacOS", "Fixture")
    } else {
        (
            "libvst3_fixture.so",
            if cfg!(target_arch = "aarch64") {
                "aarch64-linux"
            } else {
                "x86_64-linux"
            },
            "Fixture.so",
        )
    };
    let bundle = root.join("Fixture.vst3");
    let directory = bundle.join("Contents").join(folder);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::copy(
        target.join("debug").join(library),
        directory.join(executable),
    )
    .unwrap();
    bundle
}

struct Host {
    child: Child,
    input: ChildStdin,
    responses: Receiver<Value>,
    sequence: u64,
}

impl Host {
    fn start() -> Self {
        Self::with_behavior("dynamic-tail,startup-delay")
    }

    fn with_behavior(behavior: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
            .arg("--audio-host")
            .env(
                "PYMSS_VST_FIXTURE_BEHAVIOR",
                format!("strict-timing,{behavior}"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(response) = serde_json::from_str(&line) else {
                    break;
                };
                if tx.send(response).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            responses,
            sequence: 0,
        }
    }

    fn response(&mut self, mut request: Value) -> Value {
        self.sequence += 1;
        request["id"] = self.sequence.into();
        serde_json::to_writer(&mut self.input, &request).unwrap();
        self.input.write_all(b"\n").unwrap();
        self.input.flush().unwrap();
        let response = self
            .responses
            .recv_timeout(Duration::from_secs(30))
            .unwrap();
        assert_eq!(response["id"], self.sequence);
        response
    }

    fn request(&mut self, request: Value) -> Value {
        let response = self.response(request);
        assert_eq!(response["ok"], true, "{response}");
        response["result"].clone()
    }

    fn render(&mut self, path: &Path) -> Value {
        let response = self.request(json!({"op":"render", "path":path}));
        let audio = hound::WavReader::open(path).unwrap();
        assert_eq!(audio.spec().channels, 2);
        assert_eq!(audio.spec().bits_per_sample, 32);
        assert_eq!(
            audio.spec().sample_rate,
            response["sampleRate"].as_u64().unwrap() as u32
        );
        let duration = response["duration"].as_f64().unwrap();
        assert!(
            (f64::from(audio.duration()) / f64::from(audio.spec().sample_rate) - duration).abs()
                < 1e-9
        );
        response
    }

    fn finish(&mut self) {
        self.request(json!({"op":"shutdown"}));
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(Instant::now() < deadline, "audio host shutdown timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn monitor_protocol_validates_masks_and_preserves_them_only_across_updates() {
    let mut host = Host::with_behavior("");
    let mut project = json!({"id":"monitor", "name":"Audio", "sources":[],
        "tracks":[{"id":"voice","clips":[],"muted":false},{"id":"backing","clips":[],"muted":false}]});
    let loaded = host.request(
        json!({"op":"load","project":project,"ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}),
    );
    assert_eq!(loaded["suppressedTrackIds"], json!([]));
    host.request(json!({"op":"monitor","suppressedTrackIds":["voice","backing"]}));
    for value in [
        Value::Null,
        json!("voice"),
        json!(["voice", 1]),
        json!(["missing"]),
        json!(["voice", "voice"]),
        json!(vec!["voice"; 257]),
    ] {
        let rejected = host.response(json!({"op":"monitor","suppressedTrackIds":value}));
        assert_eq!(rejected["ok"], false, "{rejected}");
        let status = host.request(json!({"op":"status"}));
        assert_eq!(status["suppressedTrackIds"], json!(["voice", "backing"]));
        assert!(status["error"].is_null());
    }
    project["tracks"][0]["volume"] = 0.4.into();
    let mixed = host.request(
        json!({"op":"update","project":project,"ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}),
    );
    assert_eq!(mixed["sessionId"], loaded["sessionId"]);
    assert_eq!(mixed["suppressedTrackIds"], json!(["voice", "backing"]));
    project["tracks"][1]["id"] = "extra".into();
    let rebuilt = host.request(
        json!({"op":"update","project":project,"ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}),
    );
    assert_ne!(rebuilt["sessionId"], loaded["sessionId"]);
    assert_eq!(rebuilt["suppressedTrackIds"], json!(["voice"]));
    assert_eq!(
        host.request(json!({"op":"monitor","suppressedTrackIds":[]}))["suppressedTrackIds"],
        json!([])
    );
    host.request(json!({"op":"monitor","suppressedTrackIds":["voice"]}));
    let fresh = host.request(
        json!({"op":"load","project":project,"ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}),
    );
    assert_eq!(fresh["suppressedTrackIds"], json!([]));
    host.finish();
}

#[test]
fn offline_protocol_validates_modes_and_preserves_them_across_updates() {
    let mut host = Host::with_behavior("");
    let mut project = json!({"id":"offline-mode","name":"Audio","sources":[],"tracks":[]});
    let executable = env!("CARGO_BIN_EXE_pymss-audio-host");
    let loaded =
        host.request(json!({"op":"load","project":project,"ffmpeg":executable,"offline":true}));
    assert_eq!(loaded["offline"], true);
    assert_eq!(host.response(json!({"op":"play"}))["ok"], false);
    for value in [Value::Null, json!(1), json!("true"), json!([])] {
        let rejected = host
            .response(json!({"op":"update","project":project,"ffmpeg":executable,"offline":value}));
        assert_eq!(rejected["ok"], false);
        assert_eq!(
            host.request(json!({"op":"status"}))["sessionId"],
            loaded["sessionId"]
        );
    }
    project["masterVolume"] = 0.5.into();
    let inherited = host.request(json!({"op":"update","project":project,"ffmpeg":executable}));
    assert_eq!(inherited["offline"], true);
    assert_eq!(inherited["sessionId"], loaded["sessionId"]);
    project["tracks"] = json!([{"id":"track","clips":[]}]);
    let rebuilt = host.request(json!({"op":"update","project":project,"ffmpeg":executable}));
    assert_eq!(rebuilt["offline"], true);
    assert_ne!(rebuilt["sessionId"], loaded["sessionId"]);
    let preview =
        host.request(json!({"op":"update","project":project,"ffmpeg":executable,"offline":false}));
    assert_eq!(preview["offline"], false);
    assert_ne!(preview["sessionId"], rebuilt["sessionId"]);
    let fresh = host.request(json!({"op":"load","project":project,"ffmpeg":executable}));
    assert_eq!(fresh["offline"], false);
    host.finish();
}

#[test]
fn offline_export_uses_configured_mode_without_replacing_preview() {
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(scan.status.success());
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let project = json!({"id":"offline-export","name":"Audio","sources":[],
        "tracks":[{"id":"voice","clips":[]}],
        "pluginChain":[{"id":"effect","format":"vst3","pluginId":descriptor["id"],
        "name":"Gain","path":bundle,"bypassed":false}]});
    for offline in [false, true] {
        let mut host = Host::with_behavior("mode-quality,delay");
        let loaded = host.request(json!({"op":"load","project":project,
            "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host"),"offline":offline}));
        assert_eq!(loaded["offline"], offline);
        host.request(json!({"op":"param","slotId":"effect","paramId":"7","value":1.5}));
        host.request(json!({"op":"monitor","suppressedTrackIds":["voice"]}));
        let before = host.request(json!({"op":"snapshot"}));
        let output = directory.path().join(format!("mode-{offline}.wav"));
        host.render(&output);
        assert_eq!(
            hound::WavReader::open(&output).unwrap().duration(),
            64,
            "Only an offline-configured fixture reports the 64-frame tail"
        );
        // A subsequent output conflict must release the export session as well.
        assert_eq!(
            host.response(json!({"op":"render","path":output}))["ok"],
            false
        );
        let status = host.request(json!({"op":"status"}));
        assert_eq!(status["sessionId"], loaded["sessionId"]);
        assert_eq!(status["offline"], offline);
        assert_eq!(status["suppressedTrackIds"], json!(["voice"]));
        assert!(status["error"].is_null());
        let after = host.request(json!({"op":"snapshot"}));
        assert_eq!(after["states"], before["states"]);
        let values = host.request(json!({"op":"parameters","slotId":"effect"}));
        assert_eq!(values["values"]["7"], 1.5);
        host.finish();
    }
    // Rejected offline configuration must leave the preview and captured state usable.
    let mut host = Host::with_behavior("reject-offline");
    let loaded = host.request(json!({"op":"load","project":project,
        "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
    host.request(json!({"op":"param","slotId":"effect","paramId":"7","value":1.25}));
    let before = host.request(json!({"op":"snapshot"}));
    let rejected_path = directory.path().join("rejected.wav");
    assert_eq!(
        host.response(json!({"op":"render","path":rejected_path}))["ok"],
        false
    );
    assert!(!rejected_path.exists());
    let status = host.request(json!({"op":"status"}));
    assert_eq!(status["sessionId"], loaded["sessionId"]);
    assert_eq!(status["offline"], false);
    assert!(status["error"].is_null());
    assert_eq!(
        host.request(json!({"op":"snapshot"}))["states"],
        before["states"]
    );
    host.finish();
}

#[test]
fn failed_timing_reactivation_cleans_exports_and_keeps_preview_instances() {
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(scan.status.success());
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let project = json!({"id":"failed-timing","name":"Audio","sources":[],"tracks":[],
        "pluginChain":[{"id":"effect","format":"vst3","pluginId":descriptor["id"],
        "name":"Gain","path":bundle,"bypassed":false}]});
    for (behavior, reason) in [
        ("startup-delay,reject-reactivate", "reactivate"),
        ("startup-delay,reject-stop", "stop"),
    ] {
        for offline in [false, true] {
            let mut host = Host::with_behavior(behavior);
            let loaded = host.request(json!({"op":"load","project":project,"offline":offline,
                "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
            host.request(json!({"op":"param","slotId":"effect","paramId":"7","value":1.5}));
            let before = host.request(json!({"op":"snapshot"}));
            let output = directory.path().join(format!("{reason}-{offline}.wav"));
            let response = host.response(json!({"op":"render","path":output}));
            assert_eq!(response["ok"], false, "{response}");
            assert!(
                response["error"].as_str().unwrap().contains(reason),
                "{response}"
            );
            assert!(!output.exists());
            let status = host.request(json!({"op":"status"}));
            assert_eq!(status["sessionId"], loaded["sessionId"]);
            assert_eq!(status["offline"], offline);
            if !offline {
                assert!(status["error"].is_null());
                assert_eq!(
                    host.request(json!({"op":"snapshot"}))["states"],
                    before["states"]
                );
                assert_eq!(
                    host.request(json!({"op":"parameters","slotId":"effect"}))["values"]["7"],
                    1.5
                );
            } else {
                assert_eq!(
                    host.response(json!({"op":"render","path":output}))["ok"],
                    false
                );
                assert!(!output.exists());
            }
            host.finish();
        }
    }
}

#[test]
fn offline_exports_ignore_monitor_and_restore_preview_mask_after_success_and_error() {
    let ffmpeg = std::env::var_os("PYMSS_TEST_FFMPEG")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|path| {
                        path.join(if cfg!(windows) {
                            "ffmpeg.exe"
                        } else {
                            "ffmpeg"
                        })
                    })
                    .find(|path| path.is_file())
            })
        });
    let Some(ffmpeg) = ffmpeg else {
        eprintln!("FFmpeg is unavailable; set PYMSS_TEST_FFMPEG for monitor export coverage");
        return;
    };
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let source = directory.path().join("input.wav");
    let mut writer = hound::WavWriter::create(
        &source,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .unwrap();
    for _ in 0..48000 {
        writer.write_sample(0.8_f32).unwrap();
        writer.write_sample(-0.4_f32).unwrap();
    }
    writer.finalize().unwrap();
    let mut host = Host::with_behavior("");
    let project = json!({"id":"monitor-export","name":"Audio",
        "sources":[{"id":"source","path":source,"duration":1.0,"channels":2,"sampleRate":48000}],
        "tracks":[{"id":"voice","sourceId":"source","muted":false,"volume":0.5},
            {"id":"backing","sourceId":"source","muted":false,"volume":0.25}]});
    host.request(json!({"op":"load","project":project,"ffmpeg":ffmpeg.canonicalize().unwrap()}));
    let baseline = directory.path().join("full.wav");
    host.render(&baseline);
    let mask = json!(["voice"]);
    assert_eq!(
        host.request(json!({"op":"monitor","suppressedTrackIds":mask}))["suppressedTrackIds"],
        mask
    );
    let rejected = host.response(json!({"op":"render","path":baseline}));
    assert_eq!(rejected["ok"], false);
    assert_eq!(
        host.request(json!({"op":"status"}))["suppressedTrackIds"],
        mask
    );
    let exported = directory.path().join("while-recording.wav");
    host.render(&exported);
    assert_eq!(
        std::fs::read(&baseline).unwrap(),
        std::fs::read(exported).unwrap()
    );
    assert_eq!(
        host.request(json!({"op":"status"}))["suppressedTrackIds"],
        mask
    );
    host.request(json!({"op":"monitor","suppressedTrackIds":[]}));
    let restored = directory.path().join("restored.wav");
    host.render(&restored);
    assert_eq!(
        std::fs::read(baseline).unwrap(),
        std::fs::read(restored).unwrap()
    );
    host.finish();
}

#[test]
fn exports_refresh_startup_and_parameter_only_tails_and_preserve_the_cap() {
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(
        scan.status.success(),
        "{}",
        String::from_utf8_lossy(&scan.stderr)
    );
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let mut host = Host::start();
    host.request(
        json!({"op":"load", "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host"),
        "project":{"id":"tail", "name":"Audio", "sources":[], "tracks":[],
        "pluginChain":[{"id":"effect", "format":"vst3", "pluginId":descriptor["id"],
        "name":"Fixture Gain", "path":bundle, "bypassed":false}]}}),
    );

    // The fixture initially reports no tail until its first positive process call.
    // Startup probing must capture its 128-frame tail before the first export ends.
    let first_path = directory.path().join("initial.wav");
    let first = host.render(&first_path);
    assert_eq!(hound::WavReader::open(first_path).unwrap().duration(), 128);
    assert_eq!(first["tailLimited"], false);

    // Changing only the tail parameter does not trigger a latency restart notification.
    host.request(json!({"op":"param", "slotId":"effect", "paramId":"7", "value":1.0}));
    let next_path = directory.path().join("longer.wav");
    let next = host.render(&next_path);
    assert_eq!(hound::WavReader::open(next_path).unwrap().duration(), 256);
    assert_eq!(next["tailLimited"], false);

    host.request(json!({"op":"param", "slotId":"effect", "paramId":"7", "value":2.0}));
    let capped_path = directory.path().join("capped.wav");
    let capped = host.render(&capped_path);
    assert_eq!(capped["tailLimited"], true);
    assert_eq!(capped["duration"], 30.0);
    assert_eq!(
        hound::WavReader::open(capped_path).unwrap().duration(),
        capped["sampleRate"].as_u64().unwrap() as u32 * 30
    );
    host.finish();
}

#[test]
fn bypass_updates_keep_live_instances_and_parameters_without_reloading_the_graph() {
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(scan.status.success());
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let mut project = json!({"id":"bypass", "name":"Audio", "sources":[], "tracks":[],
        "pluginChain":[{"id":"effect", "format":"vst3", "pluginId":descriptor["id"],
        "name":"Fixture Gain", "path":bundle, "bypassed":false}]});
    let mut host = Host::start();
    let loaded = host.request(json!({"op":"load", "project":project,
        "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
    host.request(json!({"op":"param", "slotId":"effect", "paramId":"7", "value":1.6}));
    let original = host.request(json!({"op":"snapshot"}));

    for bypassed in [true, false, true, false] {
        project["pluginChain"][0]["bypassed"] = bypassed.into();
        let updated = host.request(json!({"op":"update", "project":project,
            "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
        assert_eq!(
            updated["sessionId"], loaded["sessionId"],
            "A bypass update must retain the live graph and its native controllers"
        );
        let params = host.request(json!({"op":"parameters", "slotId":"effect"}));
        assert!((params["values"]["7"].as_f64().unwrap() - 1.6).abs() < 1e-6);
        let captured = host.request(json!({"op":"snapshot"}));
        assert_eq!(captured["states"]["effect"], original["states"]["effect"]);
    }
    host.finish();
}

#[test]
fn enabling_an_unavailable_bypassed_slot_still_loads_and_fails_explicitly() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = Host::start();
    let mut project = json!({"id":"missing", "name":"Audio", "sources":[], "tracks":[],
        "pluginChain":[{"id":"missing", "format":"vst3", "pluginId":"vst3:00000000000000000000000000000001",
        "name":"Effect", "path":directory.path().join("Missing.vst3"), "bypassed":true}]});
    let loaded = host.request(json!({"op":"load", "project":project,
        "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
    assert_eq!(loaded["unavailablePlugins"].as_array().unwrap().len(), 1);
    project["pluginChain"][0]["bypassed"] = false.into();
    let enabled = host.response(json!({"op":"update", "project":project,
        "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
    assert_eq!(
        enabled["ok"], false,
        "An unavailable slot cannot silently remain bypassed"
    );
    assert!(enabled["error"].as_str().unwrap().contains("missing"));
    let surviving = host.request(json!({"op":"status"}));
    assert_eq!(surviving["sessionId"], loaded["sessionId"]);
    assert_eq!(
        surviving["unavailablePlugins"],
        loaded["unavailablePlugins"]
    );
    host.finish();
}

#[test]
fn startup_timing_changes_settle_each_insert_and_getter_notifications_remain_bounded() {
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(scan.status.success());
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let slot = |id| {
        json!({"id":id,"format":"vst3","pluginId":descriptor["id"],
        "name":"Gain","path":bundle,"bypassed":false})
    };
    let project = json!({"id":"startup-chain","name":"Audio","sources":[],"tracks":[],
        "pluginChain":[slot("first"), slot("second")]});
    for (index, behavior) in [
        "startup-delay,dynamic-tail",
        "startup-delay,dynamic-tail,getter-notification",
        "unstable-delay",
    ]
    .into_iter()
    .enumerate()
    {
        let mut host = Host::with_behavior(behavior);
        host.request(json!({"op":"load","project":project,"offline":true,
            "ffmpeg":env!("CARGO_BIN_EXE_pymss-audio-host")}));
        let output = directory.path().join(format!("startup-{index}.wav"));
        if behavior == "unstable-delay" {
            let response = host.response(json!({"op":"render","path":output}));
            assert_eq!(response["ok"], false, "{response}");
            assert!(!output.exists());
        } else {
            host.render(&output);
            assert_eq!(hound::WavReader::open(&output).unwrap().duration(), 256);
        }
        host.finish();
    }
}

#[test]
fn reactivation_applies_parameter_latency_before_track_and_master_export_pdc() {
    let ffmpeg = std::env::var_os("PYMSS_TEST_FFMPEG")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|path| {
                        path.join(if cfg!(windows) {
                            "ffmpeg.exe"
                        } else {
                            "ffmpeg"
                        })
                    })
                    .find(|path| path.is_file())
            })
        });
    let Some(ffmpeg) = ffmpeg else {
        eprintln!("FFmpeg is unavailable; set PYMSS_TEST_FFMPEG for timing reactivation coverage");
        return;
    };
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let source = directory.path().join("impulses.wav");
    let mut writer = hound::WavWriter::create(
        &source,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .unwrap();
    for frame in 0..48000 {
        let value = if [0, 255, 256, 47999].contains(&frame) {
            0.4_f32
        } else {
            0.0
        };
        writer.write_sample(value).unwrap();
        writer.write_sample(-value * 0.5).unwrap();
    }
    writer.finalize().unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(scan.status.success());
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let slot = |id| {
        json!({"id":id,"format":"vst3","pluginId":descriptor["id"],
        "name":"Gain","path":bundle,"bypassed":true})
    };
    let mut project = json!({"id":"reactivation","name":"Audio","masterVolume":0.5,
        "sources":[{"id":"source","path":source,"duration":1.0,"sampleRate":48000,"channels":2}],
        "tracks":[{"id":"track","sourceId":"source","pluginChain":[slot("track-fx")]}],
        "pluginChain":[slot("master-fx")]});
    let mut host = Host::with_behavior("delay,deferred-latency");
    let ffmpeg = ffmpeg.canonicalize().unwrap();
    let loaded = host.request(json!({"op":"load","project":project,"ffmpeg":ffmpeg}));
    host.request(json!({"op":"param","slotId":"track-fx","paramId":"7","value":1.25}));
    host.request(json!({"op":"param","slotId":"master-fx","paramId":"7","value":1.5}));
    let before = host.request(json!({"op":"snapshot"}));
    let baseline = directory.path().join("bypassed.wav");
    host.render(&baseline);
    project["tracks"][0]["pluginChain"][0]["bypassed"] = false.into();
    project["pluginChain"][0]["bypassed"] = false.into();
    let updated = host.request(json!({"op":"update","project":project,"ffmpeg":ffmpeg}));
    assert_eq!(updated["sessionId"], loaded["sessionId"]);
    let output = directory.path().join("wet.wav");
    host.render(&output);
    let read = |path| {
        hound::WavReader::open(path)
            .unwrap()
            .samples::<f32>()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
    };
    let dry = read(baseline);
    let wet = read(output);
    assert_eq!(dry.len(), wet.len());
    assert!(dry.iter().any(|value| value.abs() > 0.01));
    for (index, (&dry, &wet)) in dry.iter().zip(&wet).enumerate() {
        assert!(
            (wet - dry * 1.25 * 1.5).abs() < 1e-6,
            "Track/master export alignment differs at sample {index}: {dry} -> {wet}"
        );
    }
    let status = host.request(json!({"op":"status"}));
    assert_eq!(status["sessionId"], loaded["sessionId"]);
    assert_eq!(status["offline"], false);
    assert!(status["error"].is_null());
    assert_eq!(
        host.request(json!({"op":"snapshot"}))["states"],
        before["states"]
    );
    host.finish();
}

#[test]
fn legacy_effect_fields_are_ignored_and_export_updates_preserve_the_session() {
    let ffmpeg = std::env::var_os("PYMSS_TEST_FFMPEG")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|path| {
                        path.join(if cfg!(windows) {
                            "ffmpeg.exe"
                        } else {
                            "ffmpeg"
                        })
                    })
                    .find(|path| path.is_file())
            })
        });
    let Some(ffmpeg) = ffmpeg else {
        eprintln!(
            "FFmpeg is unavailable; set PYMSS_TEST_FFMPEG to enable native plugin export coverage"
        );
        return;
    };
    let ffmpeg = ffmpeg.canonicalize().unwrap();
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let source = directory.path().join("input.wav");
    let mut writer = hound::WavWriter::create(
        &source,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .unwrap();
    for _ in 0..48000 {
        writer.write_sample(0.8_f32).unwrap();
        writer.write_sample(-0.4_f32).unwrap();
    }
    writer.finalize().unwrap();
    let bundle = fixture_bundle(directory.path());
    let scan = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
        .arg("--plugin-scan")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(scan.status.success());
    let catalog: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let descriptor = catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|plugin| plugin["isInstrument"] == false)
        .unwrap();
    let slot = |id| json!({"id":id,"format":"vst3","pluginId":descriptor["id"],"name":"Gain","path":bundle,"bypassed":false});
    let mut project = json!({"id":"legacy-effects","name":"Audio","masterVolume":0.5,
        "sources":[{"id":"source","path":source,"duration":1.0,"channels":2,"sampleRate":48000}],
        "tracks":[{"id":"track","sourceId":"source","effects":{"compressor":1.0},"pluginChain":[slot("track-fx")]}],
        "pluginChain":[slot("master-fx")]});
    let mut host = Host::with_behavior("mode-quality,delay");
    let loaded = host.request(json!({"op":"load","project":project,"ffmpeg":ffmpeg}));
    let baseline = directory.path().join("baseline.wav");
    host.render(&baseline);
    let samples: Vec<_> = hound::WavReader::open(&baseline)
        .unwrap()
        .samples::<f32>()
        .map(Result::unwrap)
        .collect();
    for (channel, input) in [0.8_f32, -0.4_f32].into_iter().enumerate() {
        assert!(
            (f64::from(samples[200 + channel]) - f64::from(input) * 0.5).abs() < 1e-6,
            "Removed built-in effects must not alter the plugin path"
        );
    }

    project["tracks"][0]["effects"] =
        json!({"reverb":0.25,"delay":0.6,"delayTime":0.05,"clarity":0.35,"compressor":0.6});
    let updated = host.request(json!({"op":"update","project":project,"ffmpeg":ffmpeg}));
    assert_eq!(updated["sessionId"], loaded["sessionId"]);
    let rendered = directory.path().join("updated.wav");
    host.render(&rendered);
    assert_eq!(
        std::fs::read(&baseline).unwrap(),
        std::fs::read(rendered).unwrap(),
        "Legacy effect settings must be ignored by updates"
    );
    host.finish();
}
