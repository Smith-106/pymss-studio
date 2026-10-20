use std::sync::atomic::{AtomicBool, Ordering};

static TERMINAL_ATTACHED: AtomicBool = AtomicBool::new(false);

/// Connect a release GUI application to the terminal that launched it, when one exists.
///
/// Unix processes inherit stdout/stderr naturally. Windows GUI-subsystem executables do not,
/// so they have to opt in to their parent's console. `AttachConsole` does not allocate a new
/// console, which is what keeps Explorer/Finder/desktop launches free of a debug window.
pub fn attach_parent() {
    #[cfg(windows)]
    {
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        const FILE_TYPE_DISK: u32 = 1;
        const FILE_TYPE_PIPE: u32 = 3;

        #[link(name = "Kernel32")]
        extern "system" {
            fn AttachConsole(process_id: u32) -> i32;
            fn GetConsoleWindow() -> *mut core::ffi::c_void;
            fn GetStdHandle(kind: u32) -> *mut core::ffi::c_void;
            fn SetStdHandle(kind: u32, handle: *mut core::ffi::c_void) -> i32;
            fn GetFileType(handle: *mut core::ffi::c_void) -> u32;
        }

        // AttachConsole can replace inherited file/pipe handles. Keep redirected output
        // intact so CMD's `start /b /wait ... > file 2>&1` and piped launches retain logs.
        // SAFETY: These are borrowed process handles; none are closed or owned by Rust.
        let attached = unsafe {
            let redirected = [(-11_i32) as u32, (-12_i32) as u32].map(|kind| {
                let handle = GetStdHandle(kind);
                matches!(GetFileType(handle), FILE_TYPE_DISK | FILE_TYPE_PIPE)
                    .then_some((kind, handle))
            });
            let redirected_stderr = redirected[1].is_some();
            let console = AttachConsole(ATTACH_PARENT_PROCESS) != 0
                || !GetConsoleWindow().is_null();
            for (kind, handle) in redirected.into_iter().flatten() {
                SetStdHandle(kind, handle);
            }
            console || redirected_stderr
        };
        TERMINAL_ATTACHED.store(attached, Ordering::Relaxed);
    }

    // Unix desktop launches normally inherit a sink for stderr, while shell launches may inherit
    // either a terminal, a pipe, or a redirected file. Always attempt the write so redirection
    // keeps standard command-line semantics; write failures (including a closed pipe) are ignored.
    #[cfg(not(windows))]
    TERMINAL_ATTACHED.store(true, Ordering::Relaxed);
}

pub fn write(line: &str) {
    if is_attached() {
        use std::io::Write;
        let formatted = if supports_color() {
            format_with_color(line, true)
        } else {
            format_line(line)
        };
        let _ = std::io::stderr().lock().write_all(formatted.as_bytes());
    }
}

pub fn write_early(line: &str) {
    use std::io::Write;
    let formatted = if supports_color() {
        format_with_color(line, true)
    } else {
        format_line(line)
    };
    let _ = std::io::stderr().lock().write_all(formatted.as_bytes());
}

fn supports_color() -> bool {
    use std::io::IsTerminal;
    if std::env::var_os("NO_COLOR").is_some() || !std::io::stderr().is_terminal() {
        return false;
    }
    #[cfg(windows)]
    {
        #[link(name = "Kernel32")]
        extern "system" {
            fn GetStdHandle(kind: u32) -> *mut core::ffi::c_void;
            fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
            fn SetConsoleMode(handle: *mut core::ffi::c_void, mode: u32) -> i32;
        }
        let mut mode = 0;
        // SAFETY: the process owns its stderr handle; mode points to a valid u32.
        unsafe {
            let handle = GetStdHandle((-12_i32) as u32);
            GetConsoleMode(handle, &mut mode) != 0 && SetConsoleMode(handle, mode | 0x0004) != 0
        }
    }
    #[cfg(not(windows))]
    {
        std::env::var("TERM").is_ok_and(|term| term != "dumb")
    }
}

fn colored(text: &str, code: &str, enabled: bool) -> String {
    if enabled {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

fn context_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) if value.is_empty() => None,
        serde_json::Value::String(value) => Some(value.replace('\r', "\\r").replace('\n', "\\n")),
        value => Some(value.to_string()),
    }
}

fn format_with_color(line: &str, color: bool) -> String {
    let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
        return format_legacy_line(line);
    };
    if record
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return format_legacy_line(line);
    }
    let value = |key: &str| {
        record
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    let level = value("level").to_ascii_uppercase();
    let level = if level.is_empty() { "RAW" } else { &level };
    let level_color = match level {
        "ERROR" | "FATAL" => "1;31",
        "WARN" => "1;33",
        "INFO" => "32",
        _ => "90",
    };
    let (source, source_color) = match value("source") {
        "studio" => ("Studio", "94"),
        "worker" => ("Worker", "96"),
        "pymss" => ("pymss", "95"),
        _ => ("External", "93"),
    };
    let clock =
        terminal_clock(value("timestamp")).unwrap_or_else(|| value("timestamp").to_string());
    let message = value("message");
    let message = if message.is_empty() {
        value("event")
    } else {
        message
    };
    let mut scope = Vec::new();
    let mut displayed_keys = Vec::new();
    for key in ["taskId", "requestId", "nodeId", "jobId"] {
        if !value(key).is_empty() {
            scope.push(format!("{key}={}", value(key)));
            displayed_keys.push(key);
        }
    }
    let context = record.get("context").and_then(serde_json::Value::as_object);
    if let Some(context) = context {
        for key in ["command", "model", "backend", "version", "status"] {
            if let Some(text) = context.get(key).and_then(context_text) {
                scope.push(format!("{key}={text}"));
                displayed_keys.push(key);
            }
        }
    }
    let mut formatted = format!(
        "{} {} {} {}",
        colored(&clock, "90", color),
        colored(&format!("{level:<5}"), level_color, color),
        colored(&format!("[{source}]"), source_color, color),
        message
    );
    if !scope.is_empty() {
        formatted.push_str(&colored(&format!("  {}", scope.join(" ")), "90", color));
    }
    formatted.push('\n');
    if !value("logger").is_empty() && value("logger") != value("source") {
        formatted.push_str(&colored(&format!("    logger={}\n", value("logger")), "90", color));
    }
    if let Some(location) = record.get("location").and_then(context_text) {
        formatted.push_str(&colored(&format!("    location={location}\n"), "90", color));
    }
    if let Some(context) = context {
        for (key, value) in context {
            // Keep useful diagnostics even when a producer adds new context fields. Only
            // omit transport bookkeeping and values already present on the compact line.
            if displayed_keys.contains(&key.as_str()) || matches!(key.as_str(), "processId" | "thread") {
                continue;
            }
            if let Some(text) = context_text(value) {
                formatted.push_str(&colored(&format!("    {key}={text}\n"), "90", color));
            }
        }
    }
    if !value("detail").is_empty() {
        for detail in value("detail").lines() {
            formatted.push_str(&colored(
                &format!("    {detail}\n"),
                if level == "ERROR" || level == "FATAL" {
                    "31"
                } else {
                    "90"
                },
                color,
            ));
        }
    }
    formatted
}

/// Keep the terminal readable without changing the machine-oriented log files.
/// Rust writes epoch timestamps while Python writes ISO timestamps; both become a compact
/// local clock value in the terminal, leaving the event payload untouched.
pub fn format_line(line: &str) -> String {
    format_with_color(line, false)
}

fn format_legacy_line(line: &str) -> String {
    let Some((timestamp, rest)) = line.split_once(' ') else {
        return line.to_string();
    };
    let Some(clock) = terminal_clock(timestamp) else {
        return line.to_string();
    };
    format!("{clock} {rest}")
}

fn terminal_clock(timestamp: &str) -> Option<String> {
    use chrono::{DateTime, Local, TimeZone};

    if timestamp.contains('T') {
        let parsed = DateTime::parse_from_rfc3339(timestamp).ok()?;
        return Some(
            parsed
                .with_timezone(&Local)
                .format("%H:%M:%S%.3f")
                .to_string(),
        );
    }
    let (seconds, millis) = timestamp.trim_end_matches('Z').split_once('.')?;
    let seconds = seconds.parse::<i64>().ok()?;
    let millis = millis.get(..3).unwrap_or(millis).parse::<i64>().ok()?;
    let timestamp_millis = seconds.checked_mul(1000)?.checked_add(millis)?;
    Local
        .timestamp_millis_opt(timestamp_millis)
        .single()
        .map(|value| value.format("%H:%M:%S%.3f").to_string())
}

pub fn is_attached() -> bool {
    TERMINAL_ATTACHED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_output_has_one_level_and_source_and_preserves_exception_lines() {
        let record = serde_json::json!({"schemaVersion":1,"timestamp":"2026-10-19T12:00:00Z","source":"pymss","level":"error","message":"Allocation failed","taskId":"task-1","detail":"Traceback:\n  model.forward()"}).to_string();
        let plain = format_line(&record);
        assert_eq!(plain.matches("ERROR").count(), 1);
        assert!(plain.contains("[pymss] Allocation failed"));
        assert!(plain.contains("    Traceback:\n      model.forward()"));
        assert!(!plain.contains("\x1b["));
        let color = format_with_color(&record, true);
        assert!(color.contains("\x1b[1;31mERROR"));
        assert!(color.contains("\x1b[95m[pymss]"));
    }

    #[test]
    fn stderr_without_a_level_is_not_presented_as_warning() {
        let record = serde_json::json!({"schemaVersion":1,"source":"third_party","level":null,"message":"Loading decoder"}).to_string();
        let plain = format_line(&record);
        assert!(plain.contains("RAW"));
        assert!(!plain.contains("WARN"));
    }

    #[test]
    fn redirected_output_preserves_diagnostic_context_without_repeated_scope() {
        let record = serde_json::json!({
            "schemaVersion": 1, "timestamp": "2026-10-19T12:00:00Z",
            "source": "studio", "level": "debug", "message": "worker.command", "logger": "studio.worker",
            "location": {"file": "worker.rs", "line": 72, "function": "probe"},
            "taskId": "task-a", "requestId": "request-a", "nodeId": "node-a", "jobId": "job-a",
            "context": {
                "command": "env_info", "taskId": "task-a", "requestId": "request-a",
                "nodeId": "node-a", "jobId": "job-a", "backend": "cpu",
                "python": "D:/runtime/python.exe", "worker": "D:/app/python/worker.py",
                "payloadFile": "D:/Temp/payload.json", "path": "D:/Pymss Studio/app.exe",
                "dataRoot": "D:/Pymss Studio/data", "logsDir": "D:/Pymss Studio/logs",
                "torchError": "DLL load failed: missing dependency",
                "cudaAvailableError": "Driver unavailable", "torchAvailable": false,
                "deviceCount": 0, "futureDiagnostic": {"enabled": true, "devices": [1, 2]},
                "processId": 123, "thread": "MainThread", "empty": "", "missing": null
            }
        });
        let input = record.to_string();
        let plain = format_line(&input);
        for (key, value) in record["context"].as_object().unwrap() {
            if matches!(key.as_str(), "processId" | "thread" | "empty" | "missing") {
                continue;
            }
            let text = context_text(value).unwrap();
            assert!(plain.contains(&format!("{key}={text}")), "missing {key}: {plain}");
            assert_eq!(plain.matches(&format!("{key}=")).count(), 1, "repeated {key}");
        }
        assert_eq!(plain.matches("DEBUG").count(), 1);
        assert_eq!(plain.matches("[Studio]").count(), 1);
        let clock = terminal_clock("2026-10-19T12:00:00Z").unwrap();
        assert_eq!(plain.matches(&clock).count(), 1);
        assert!(!plain.contains('\u{1b}'));
        assert!(plain.contains("    logger=studio.worker\n"));
        assert!(plain.contains(&format!("    location={}\n", record["location"])));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&input).unwrap(), record);
        let color = format_with_color(&input, true);
        assert!(color.contains("\x1b[94m[Studio]"));
        assert!(color.contains("\x1b[90m    torchError=DLL load failed: missing dependency"));
    }

    #[test]
    fn context_values_keep_multiline_diagnostics_on_indented_lines() {
        let input = serde_json::json!({
            "schemaVersion": 1, "source": "worker", "level": "info", "message": "Probe complete",
            "context": {"probeError": "first line\nsecond line\rthird line", "status": false}
        }).to_string();
        let plain = format_line(&input);
        assert!(plain.contains("status=false"));
        assert!(plain.contains("\n    probeError=first line\\nsecond line\\rthird line\n"));
    }
}
