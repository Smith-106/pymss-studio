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
        let mut child = Command::new(env!("CARGO_BIN_EXE_pymss-audio-host"))
            .arg("--audio-host")
            .env("PYMSS_VST_FIXTURE_BEHAVIOR", "dynamic-tail,startup-delay")
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
