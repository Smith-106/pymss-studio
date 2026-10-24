//! Bounded package scans, persistent exclusions and cache updates on the blocking worker.
use super::*;
use std::collections::HashSet;

pub(super) struct Context<'a> {
    pub run: Option<&'a ScanRun>,
    pub storage: &'a Mutex<()>,
}

#[cfg(test)]
pub(super) fn scan_bundles(
    root: &Path,
    bundles: Vec<PathBuf>,
    failures: Vec<ScanFailure>,
    force: bool,
    mut probe: impl FnMut(&Path) -> Result<Vec<Value>, ScanProbeError>,
) -> Result<ScanReport, String> {
    scan(
        root,
        bundles,
        failures,
        force,
        Context {
            run: None,
            storage: &Mutex::new(()),
        },
        |path, _| probe(path),
    )
}

pub(super) fn scan(
    root: &Path,
    bundles: Vec<PathBuf>,
    failures: Vec<ScanFailure>,
    force: bool,
    context: Context<'_>,
    mut probe: impl FnMut(&Path, Option<ScanTicket>) -> Result<Vec<Value>, ScanProbeError>,
) -> Result<ScanReport, String> {
    if bundles.len() > 4096 {
        return Err("The plugin scan exceeded the bundle limit".into());
    }
    let run = context.run;
    let cache_path = root.join("plugin-cache.json");
    let guard = context
        .storage
        .lock()
        .map_err(|_| "Plugin scan storage lock failed")?;
    let mut blocked: HashMap<_, _> = blacklist::load(root)?
        .into_iter()
        .map(|entry| (blacklist::path_key(&entry.path), entry))
        .collect();
    let old_cache: Value = fs::File::open(&cache_path)
        .ok()
        .and_then(|file| serde_json::from_reader(file.take(MAX_CACHE_BYTES)).ok())
        .unwrap_or(Value::Null);
    drop(guard);
    let old_entries = (old_cache.get("version").and_then(Value::as_u64)
        == Some(u64::from(SCAN_CACHE_VERSION)))
    .then(|| old_cache.get("entries").and_then(Value::as_array))
    .flatten();
    let mut entries = Vec::new();
    let mut visited = HashSet::new();
    let mut report = ScanReport {
        failures,
        ..ScanReport::default()
    };
    if let Some(run) = run {
        run.set_total(bundles.len());
    }
    for bundle in bundles {
        if run.is_some_and(|run| run.decision(None) == ScanDecision::Cancel) {
            report.cancelled = true;
            break;
        }
        let virtual_target = is_virtual_scan_target(&bundle);
        // The original spelling can match an exclusion without touching the package filesystem.
        let bundle = if virtual_target
            || blocked.contains_key(&blacklist::path_key(&bundle.to_string_lossy()))
        {
            bundle
        } else {
            bundle.canonicalize().unwrap_or(bundle)
        };
        let path = bundle.to_string_lossy().to_string();
        let key = blacklist::path_key(&path);
        visited.insert(key.clone());
        let ticket = run.map(|run| run.begin_item(&path));
        if let Some(entry) = blocked.get(&key) {
            if run
                .zip(ticket)
                .is_some_and(|(run, ticket)| run.complete_item(ticket) == ScanDecision::Cancel)
            {
                report.cancelled = true;
                break;
            }
            report.blacklisted.push(entry.clone());
            continue;
        }
        if let Some(reason) = unsupported_scan_reason(&bundle) {
            report.failures.push(ScanFailure {
                path,
                message: reason.into(),
            });
            if let Some((run, ticket)) = run.zip(ticket) {
                run.complete_item(ticket);
            }
            continue;
        }
        let mut fingerprint = None;
        let mut used_cache = false;
        let result = (|| -> Result<Vec<Value>, ScanProbeError> {
            fingerprint = Some(if virtual_target {
                String::new()
            } else {
                bundle_fingerprint(&bundle)?
            });
            if !force && !virtual_target && !run.is_some_and(|run| run.is_invalidated(&path)) {
                if let Some(entry) = old_entries.and_then(|entries| {
                    entries.iter().find(|entry| {
                        entry["path"] == path
                            && entry["fingerprint"].as_str() == fingerprint.as_deref()
                    })
                }) {
                    if let Some(error) = entry["error"].as_str() {
                        used_cache = true;
                        return Err(ScanProbeError::Failure(error.to_owned()));
                    }
                    if let Some(found) = entry["plugins"]
                        .as_array()
                        .filter(|found| !found.is_empty() && found.iter().all(Value::is_object))
                    {
                        let mut found = found.clone();
                        for descriptor in &mut found {
                            normalize_descriptor(descriptor, &path, false)?;
                        }
                        used_cache = true;
                        return Ok(found);
                    }
                }
            }
            if let Some((run, ticket)) = run.zip(ticket) {
                match run.decision(Some(ticket)) {
                    ScanDecision::Skip => {
                        return Err(ScanProbeError::Skipped(BlacklistReason::Manual))
                    }
                    ScanDecision::Cancel => return Err(ScanProbeError::Cancelled),
                    ScanDecision::Continue => {}
                }
                if ticket.started.elapsed() >= SCAN_TIMEOUT {
                    return Err(ScanProbeError::Skipped(BlacklistReason::Timeout));
                }
            }
            report.scanned += 1;
            let mut found = probe(&bundle, ticket)?;
            if found.is_empty() && !virtual_target {
                return Err(ScanProbeError::Failure(
                    "No compatible effects were found in this plugin".into(),
                ));
            }
            if found.iter().any(|descriptor| !descriptor.is_object()) {
                return Err(ScanProbeError::Failure(
                    "The plugin scanner returned an invalid result".into(),
                ));
            }
            for descriptor in &mut found {
                normalize_descriptor(descriptor, &path, virtual_target)?;
            }
            Ok(found)
        })();
        // Commit under the control lock: late skip cannot remove a later package or accept stale success.
        let result = match run
            .zip(ticket)
            .map(|(run, ticket)| run.complete_item(ticket))
        {
            Some(ScanDecision::Skip) => Err(ScanProbeError::Skipped(BlacklistReason::Manual)),
            Some(ScanDecision::Cancel) => Err(ScanProbeError::Cancelled),
            _ => result,
        };
        match result {
            Ok(found) => {
                report.cached += usize::from(used_cache);
                if !virtual_target {
                    entries.push(
                        json!({"path":path,"fingerprint":fingerprint,"plugins":found,"error":null}),
                    );
                }
                report.plugins.extend(found);
            }
            Err(ScanProbeError::Skipped(reason)) => {
                let _guard = context
                    .storage
                    .lock()
                    .map_err(|_| "Plugin scan storage lock failed")?;
                // Manual skip has one persistence owner (the control command). It may already
                // have been restored while the worker was stopping; never re-add it here.
                let entry = match reason {
                    BlacklistReason::Manual => blacklist::load(root)?
                        .into_iter()
                        .find(|entry| blacklist::path_matches(&entry.path, &path)),
                    BlacklistReason::Timeout => {
                        Some(blacklist::add(root, &path, BlacklistReason::Timeout)?)
                    }
                };
                if let Some(entry) = entry {
                    blocked.insert(key, entry.clone());
                    report.blacklisted.push(entry);
                }
            }
            Err(ScanProbeError::Cancelled) => {
                // Legacy callers retain the previous cache on cancellation.
                if run.is_none() {
                    return Err("Plugin scanning was cancelled".into());
                }
                report.cancelled = true;
                break;
            }
            Err(ScanProbeError::Failure(message)) => {
                report.cached += usize::from(used_cache);
                crate::session_log::early(
                    "WARN",
                    "audio.plugin_scan",
                    &format!("Plugin scan failed for {}: {message}", bundle.display()),
                );
                if !virtual_target {
                    entries.push(
                        json!({"path":path,"fingerprint":fingerprint,"plugins":[],"error":message}),
                    );
                }
                report.failures.push(ScanFailure { path, message });
            }
        }
    }
    let _guard = context
        .storage
        .lock()
        .map_err(|_| "Plugin scan storage lock failed")?;
    let invalidations = run.map(ScanRun::invalidations).unwrap_or_default();
    let latest_blocked: HashSet<_> = blacklist::load(root)?
        .into_iter()
        .map(|entry| blacklist::path_key(&entry.path))
        .collect();
    report.blacklisted.retain(|entry| {
        let key = blacklist::path_key(&entry.path);
        latest_blocked.contains(&key) && !invalidations.contains(&key)
    });
    if report.cancelled {
        if let Some(previous) = old_entries {
            entries.extend(
                previous
                    .iter()
                    .filter(|entry| {
                        entry["path"]
                            .as_str()
                            .is_some_and(|path| !visited.contains(&blacklist::path_key(path)))
                    })
                    .cloned(),
            );
        }
    }
    // Removing an exclusion while a scan runs must not resurrect its old cached failure at commit.
    entries.retain(|entry| {
        entry["path"].as_str().is_some_and(|path| {
            let key = blacklist::path_key(path);
            !latest_blocked.contains(&key) && !invalidations.contains(&key)
        })
    });
    let cache = json!({"version":SCAN_CACHE_VERSION,"entries":entries});
    if serde_json::to_vec(&cache)
        .map_err(|error| error.to_string())?
        .len() as u64
        > MAX_CACHE_BYTES
    {
        return Err("The plugin scan cache exceeded the size limit".into());
    }
    crate::storage::write_json_file(&cache_path, &cache).map_err(|error| error.to_string())?;
    Ok(report)
}
