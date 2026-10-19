use crate::error::{AppError, AppResult};
#[cfg(target_os = "macos")]
mod authorized;
mod startup;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

const BUNDLE_NAME: &str = "Pymss Studio.app";
#[cfg(target_os = "macos")]
const BUNDLE_ID: &str = "studio.pymss.desktop";
#[cfg(target_os = "macos")]
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024 - 1;
const MAX_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 200_000;

fn failure(message: impl Into<String>) -> AppError {
    AppError::Worker(message.into())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn previous_bundle(target: &Path) -> PathBuf {
    let identity = sha256_hex(target.as_os_str().as_encoded_bytes());
    target
        .parent()
        .unwrap()
        .join(format!(".pymss-studio-previous-{identity}.app"))
}

struct VerifiedStream<'a> {
    verifier: minisign_verify::StreamVerifier<'a>,
    digest: Sha256,
}

impl<'a> VerifiedStream<'a> {
    fn new(
        key: &'a minisign_verify::PublicKey,
        signature: &'a minisign_verify::Signature,
    ) -> AppResult<Self> {
        let verifier = key.verify_stream(signature).map_err(|error| {
            failure(format!("Unable to verify the macOS update stream: {error}"))
        })?;
        Ok(Self {
            verifier,
            digest: Sha256::new(),
        })
    }

    fn update(&mut self, chunk: &[u8]) {
        self.verifier.update(chunk);
        self.digest.update(chunk);
    }

    fn finish(mut self) -> AppResult<String> {
        self.verifier
            .finalize()
            .map_err(|error| failure(format!("Update signature verification failed: {error}")))?;
        Ok(format!("{:x}", self.digest.finalize()))
    }
}

fn bundle_from_executable(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

fn location_problem(bundle: &Path, read_only: bool) -> Option<&'static str> {
    if read_only
        || bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
    {
        Some("Install Pymss Studio in Applications, then reopen it before updating. The current application is running from a read-only or translocated location.")
    } else {
        None
    }
}

fn runtime_contract(manifest: &serde_json::Value) -> Option<serde_json::Value> {
    let common = manifest
        .get("common")?
        .as_object()?
        .iter()
        .filter(|(name, _)| !matches!(name.as_str(), "pymss" | "pymss-core"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    Some(serde_json::json!({
        "python": manifest.get("python")?.as_str()?,
        "baseGeneration": manifest.get("baseGeneration")?.as_u64()?,
        "common": common,
        "backends": {
            "cpu": manifest.get("backends")?.get("cpu")?,
            "mlx": manifest.get("backends")?.get("mlx")?,
        },
    }))
}

fn validate_entry(path: &Path, link: Option<&Path>) -> AppResult<()> {
    let parts: Vec<_> = path.components().collect();
    if parts.first().map(|part| part.as_os_str()) != Some(BUNDLE_NAME.as_ref())
        || parts
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(failure(
            "The macOS update contains an invalid application path",
        ));
    }
    if let Some(link) = link {
        if parts.len() < 2 {
            return Err(failure("The application root cannot be a symbolic link"));
        }
        let mut depth = parts.len().saturating_sub(1);
        for part in link.components() {
            match part {
                Component::Normal(_) => depth += 1,
                Component::CurDir => (),
                Component::ParentDir if depth > 1 => depth -= 1,
                _ => {
                    return Err(failure(
                        "The macOS update contains a link outside the application",
                    ))
                }
            }
        }
    }
    Ok(())
}

fn extract_bundle(archive: &Path, destination: &Path) -> AppResult<PathBuf> {
    use flate2::read::GzDecoder;
    use std::collections::HashSet;
    let mut archive = tar::Archive::new(GzDecoder::new(fs::File::open(archive)?));
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for (index, entry) in archive.entries()?.enumerate() {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        validate_entry(&path, entry.link_name()?.as_deref())?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            return Err(failure(
                "The macOS update contains an unsupported archive entry",
            ));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| failure("Update size overflow"))?;
        if index >= MAX_ARCHIVE_ENTRIES || total > MAX_EXTRACTED_BYTES || !paths.insert(path) {
            return Err(failure(
                "The macOS update exceeds extraction limits or contains duplicate paths",
            ));
        }
        if !entry.unpack_in(destination)? {
            return Err(failure("The macOS update contains an unsafe archive path"));
        }
    }
    let bundle = destination.join(BUNDLE_NAME);
    if !bundle.join("Contents/Info.plist").is_file() || !bundle.join("Contents/MacOS").is_dir() {
        return Err(failure(
            "The macOS update does not contain a complete application",
        ));
    }
    Ok(bundle)
}

// Keep the old bundle outside temporary directories: failed restoration must never let
// a TempDir destructor delete the user's only remaining application.
fn replace_bundle_with(
    target: &Path,
    staged: &Path,
    backup: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> AppResult<()> {
    rename(target, backup)?;
    if let Err(error) = rename(staged, target) {
        return match rename(backup, target) {
            Ok(()) => Err(error.into()),
            Err(restore) => Err(failure(format!(
                "Application replacement failed: {error}. Restoration failed: {restore}. The previous application is preserved at {}",
                backup.display()
            ))),
        };
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use crate::update_sources::{UpdateProvider, UpdateSource};
    use crate::{python::worker, storage, update_manager, update_sources};
    use std::ffi::CString;
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::Update;

    static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);
    const EVENT: &str = "pymss://managed-update-event";

    struct UpdateGuard;
    impl Drop for UpdateGuard {
        fn drop(&mut self) {
            UPDATE_RUNNING.store(false, Ordering::Release);
        }
    }

    pub fn current_bundle() -> AppResult<PathBuf> {
        let bundle = bundle_from_executable(&std::env::current_exe()?).ok_or_else(|| {
            failure("The application must run from an installed macOS app bundle")
        })?;
        Ok(bundle.canonicalize()?)
    }

    fn volume_info(path: &Path) -> AppResult<libc::statfs> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| failure("Invalid application path"))?;
        let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: the C string and output buffer remain valid for the synchronous call.
        if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: statfs initialized the structure on success.
        Ok(unsafe { info.assume_init() })
    }

    pub fn check_location(bundle: &Path) -> AppResult<()> {
        let read_only = volume_info(bundle)?.f_flags & libc::MNT_RDONLY as u32 != 0;
        if let Some(message) = location_problem(bundle, read_only) {
            return Err(failure(message));
        }
        Ok(())
    }

    fn bundled_contract(resources: &Path) -> AppResult<serde_json::Value> {
        let manifest = storage::resource_roots(resources)
            .into_iter()
            .map(|root| root.join("python/runtime-manifest.json"))
            .find(|path| path.is_file())
            .ok_or_else(|| failure("The installed runtime manifest is missing"))?;
        let manifest = serde_json::from_slice(&fs::read(manifest)?)?;
        runtime_contract(&manifest)
            .ok_or_else(|| failure("The installed runtime contract is invalid"))
    }

    pub fn check_runtime_contract(app: &AppHandle, metadata: &serde_json::Value) -> AppResult<()> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| failure(e.to_string()))?;
        let installed = bundled_contract(&resources)?;
        if metadata.get("pymss_runtime_contract") != Some(&installed) {
            return Err(failure("This release changes the Python runtime or native dependencies. Install it from the release page and verify the selected runtime environment before running tasks."));
        }
        Ok(())
    }

    fn require_space(path: &Path, required: u64) -> AppResult<()> {
        let info = volume_info(path)?;
        let available = info.f_bavail.saturating_mul(info.f_bsize as u64);
        if available < required.saturating_add(256 * 1024 * 1024) {
            return Err(failure(
                "There is not enough free disk space to download and install this update",
            ));
        }
        Ok(())
    }

    fn plist(bundle: &Path, key: &str) -> AppResult<String> {
        let result = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", &format!("Print :{key}")])
            .arg(bundle.join("Contents/Info.plist"))
            .output()?;
        if !result.status.success() {
            return Err(failure(
                "The application bundle has invalid version or identity metadata",
            ));
        }
        Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
    }

    fn validate_bundle(bundle: &Path, version: Option<&str>) -> AppResult<()> {
        if fs::symlink_metadata(bundle)?.file_type().is_symlink()
            || plist(bundle, "CFBundleIdentifier")? != BUNDLE_ID
            || version.is_some_and(|version| {
                !plist(bundle, "CFBundleShortVersionString").is_ok_and(|found| found == version)
            })
        {
            return Err(failure(
                "The application identity or version does not match the selected update",
            ));
        }
        let executable = plist(bundle, "CFBundleExecutable")?;
        if Path::new(&executable).components().count() != 1
            || !matches!(
                Path::new(&executable).components().next(),
                Some(Component::Normal(_))
            )
            || !bundle.join("Contents/MacOS").join(&executable).is_file()
        {
            return Err(failure("The updated application executable is missing"));
        }
        if !Command::new("/usr/bin/lipo")
            .arg(bundle.join("Contents/MacOS").join(executable))
            .args(["-verify_arch", "arm64"])
            .status()?
            .success()
        {
            return Err(failure(
                "The application does not contain an Apple Silicon executable",
            ));
        }
        let output = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .output()?;
        if !output.status.success() {
            return Err(failure(format!(
                "The macOS application code signature is invalid: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(())
    }

    fn unpacked_size(update: &Update) -> AppResult<u64> {
        update
            .raw_json
            .get("pymss_unpacked_size")
            .and_then(|v| v.as_u64())
            .filter(|size| *size > 0 && *size <= MAX_EXTRACTED_BYTES)
            .ok_or_else(|| failure("The macOS update manifest is missing a valid unpacked size"))
    }

    async fn download(
        app: &AppHandle,
        update: &Update,
        url: url::Url,
        path: &Path,
    ) -> AppResult<String> {
        let signature =
            update_manager::decode_release_signature(&update.signature, &update.version)?;
        let public_key = update_manager::update_public_key()?;
        let mut verifier = VerifiedStream::new(&public_key, &signature)?;
        if url.scheme() != "https" {
            return Err(failure("macOS update downloads require HTTPS"));
        }
        let (direct, proxy) = update_manager::updater_proxy(app)?;
        let client = update_manager::configure_update_client(
            update_sources::http_client_builder(),
            direct,
            proxy,
        )
        .user_agent("Pymss-Studio-Updater")
        .build()
        .map_err(|e| failure(e.without_url().to_string()))?;
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| failure(e.without_url().to_string()))?
            .error_for_status()
            .map_err(|e| failure(e.without_url().to_string()))?;
        if response.url().scheme() != "https" {
            return Err(failure(
                "macOS update downloads cannot redirect to an insecure connection",
            ));
        }
        let total = response.content_length();
        if total.is_some_and(|size| size == 0 || size > MAX_ARCHIVE_BYTES) {
            return Err(failure(
                "The macOS update archive exceeds the supported size limit",
            ));
        }
        require_space(
            path.parent().unwrap(),
            total
                .unwrap_or(MAX_ARCHIVE_BYTES)
                .saturating_add(unpacked_size(update)?),
        )?;
        let mut file = fs::File::create(path)?;
        let started = Instant::now();
        let mut last_event = Instant::now();
        let mut received = 0_u64;
        let _ = app.emit(
            EVENT,
            serde_json::json!({"event":"Started","data":{"contentLength":total}}),
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| failure(e.without_url().to_string()))?
        {
            received = received.saturating_add(chunk.len() as u64);
            if received > MAX_ARCHIVE_BYTES {
                return Err(failure(
                    "The macOS update archive exceeds the supported size limit",
                ));
            }
            // Both authenticators consume the same network chunks in process memory.
            // A writable cache file is never the authority for the privileged digest.
            verifier.update(&chunk);
            file.write_all(&chunk)?;
            if last_event.elapsed() >= Duration::from_millis(200) {
                let _ = app.emit(EVENT, serde_json::json!({"event":"Progress","data":{
                    "downloadedBytes":received,"contentLength":total,
                    "speedBytesPerSecond":received as f64 / started.elapsed().as_secs_f64().max(0.001)
                }}));
                last_event = Instant::now();
            }
        }
        file.sync_all()?;
        drop(file);
        if received == 0 || total.is_some_and(|total| received != total) {
            return Err(failure("The macOS update download is incomplete"));
        }
        let digest = verifier.finish()?;
        let _ = app.emit(EVENT, serde_json::json!({"event":"Finished"}));
        Ok(digest)
    }

    fn atomic_exchange(target: &Path, staged: &Path) -> std::io::Result<()> {
        let target = CString::new(target.as_os_str().as_bytes())?;
        let staged = CString::new(staged.as_os_str().as_bytes())?;
        // SAFETY: both C strings live until renamex_np returns. RENAME_SWAP exchanges
        // directories in one operation, preserving a valid target throughout on APFS.
        if unsafe { libc::renamex_np(target.as_ptr(), staged.as_ptr(), libc::RENAME_SWAP) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn install_writable(
        target: &Path,
        source: &Path,
        version: &str,
        size: u64,
    ) -> AppResult<PathBuf> {
        let parent = target.parent().unwrap();
        require_space(parent, size)?;
        let stage = tempfile::Builder::new()
            .prefix(".pymss-studio-update-")
            .tempdir_in(parent)?;
        let staged = stage.path().join(BUNDLE_NAME);
        let status = Command::new("/usr/bin/ditto")
            .arg(source)
            .arg(&staged)
            .status()?;
        if !status.success() {
            return Err(failure("Unable to stage the updated application"));
        }
        validate_bundle(&staged, Some(version))?;
        let backup = previous_bundle(target);
        match fs::symlink_metadata(&backup) {
            Ok(metadata) => {
                validate_bundle(&backup, None)?;
                // A user-writable parent does not imply that a root-owned app's
                // contents can be cleaned up without authorization.
                // SAFETY: geteuid takes no arguments and has no preconditions.
                let user_id = unsafe { libc::geteuid() };
                if metadata.uid() != user_id {
                    return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,
                        "Administrator authorization is required to replace the previous application backup").into());
                }
                // Retire the older backup by renaming it. Deleting it in place could
                // leave a half-deleted backup if permissions change during cleanup.
                fs::rename(&backup, stage.path().join("obsolete.app"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        match atomic_exchange(target, &staged) {
            Ok(()) => {
                if let Err(error) = fs::rename(&staged, &backup) {
                    // After a successful exchange the staged directory contains the old app.
                    // Preserve it if it cannot be moved to the normal backup location.
                    let kept = stage.keep();
                    eprintln!(
                        "Previous macOS application retained at {}: {error}",
                        kept.display()
                    );
                    return Ok(kept.join(BUNDLE_NAME));
                }
                Ok(backup)
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Err(error.into()),
            Err(_) => {
                replace_bundle_with(target, &staged, &backup, |from, to| fs::rename(from, to))?;
                Ok(backup)
            }
        }
    }

    fn restore_previous(target: &Path, backup: &Path, version: &str) -> AppResult<()> {
        validate_bundle(backup, Some(version))?;
        match atomic_exchange(target, backup) {
            Ok(()) => {
                validate_bundle(target, Some(version))?;
                if let Err(error) = fs::remove_dir_all(backup) {
                    eprintln!("Unable to remove the failed macOS update: {error}");
                }
            }
            Err(_) => {
                let failed = tempfile::Builder::new()
                    .prefix(".pymss-studio-failed-")
                    .tempdir_in(target.parent().unwrap())?;
                replace_bundle_with(
                    target,
                    backup,
                    &failed.path().join(BUNDLE_NAME),
                    |from, to| fs::rename(from, to),
                )?;
                validate_bundle(target, Some(version))?;
            }
        }
        Ok(())
    }

    pub fn confirm_startup(app: &AppHandle) -> AppResult<()> {
        static CONFIRMED: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
        let mut confirmed = CONFIRMED
            .lock()
            .map_err(|_| failure("Startup confirmation lock poisoned"))?;
        if *confirmed {
            return Ok(());
        }
        let Some(token) = startup::argument_token(std::env::args().skip(1))? else {
            return Ok(());
        };
        let directory = storage::temp_dir(app)?.join(&token);
        let metadata = fs::symlink_metadata(&directory)?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(failure(
                "The application startup transaction directory is invalid",
            ));
        }
        let request = startup::read_request(&directory)?;
        let target = current_bundle()?;
        if request.target != target
            || request.version != env!("CARGO_PKG_VERSION")
            || plist(&target, "CFBundleShortVersionString")? != request.version
        {
            return Err(failure(
                "The application startup request does not match the running version",
            ));
        }
        if request.privileged {
            authorized::report_ready(&token)?;
        }
        startup::acknowledge(&directory, &request, std::process::id())?;
        *confirmed = true;
        Ok(())
    }

    fn start_replacement(
        target: &Path,
        request: &startup::Request,
        log_path: &Path,
    ) -> AppResult<std::process::Child> {
        let executable = plist(target, "CFBundleExecutable")?;
        if Path::new(&executable).components().count() != 1
            || !matches!(
                Path::new(&executable).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(failure("Invalid updated application executable"));
        }
        let log = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(log_path)?;
        let mut command = Command::new(target.join("Contents/MacOS").join(executable));
        command
            .args(["--pymss-update-startup", &request.token])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log);
        crate::single_instance::configure_update_child(&mut command).map_err(failure)?;
        Ok(command.spawn()?)
    }

    pub async fn start(
        app: &AppHandle,
        update: &Update,
        provider: UpdateProvider,
        source: UpdateSource,
    ) -> AppResult<()> {
        UPDATE_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| failure("Another application update is already in progress"))?;
        let _update_guard = UpdateGuard;
        // Fail before a large download when a separation or runtime operation is active.
        // Reserve the worker gate again below immediately before replacing the bundle.
        drop(worker::acquire_application_update()?);
        if app.webview_windows().keys().any(|label| label != "main") {
            return Err(failure("Save your changes and close additional editor windows before installing an application update"));
        }
        let target = current_bundle()?;
        check_location(&target)?;
        check_runtime_contract(app, &update.raw_json)?;
        let size = unpacked_size(update)?;
        let root = storage::temp_dir(app)?;
        fs::create_dir_all(&root)?;
        let staging = tempfile::Builder::new()
            .prefix("macos-update-")
            .tempdir_in(&root)?;
        let archive = staging.path().join("update.app.tar.gz");
        let candidates = update_manager::download_candidates(
            &update.version,
            &update.download_url,
            provider,
            source,
        )?;
        let candidates = update_manager::order_download_candidates(app, candidates).await?;
        let mut last_error = None;
        let mut archive_digest = None;
        for (index, (provider, url)) in candidates.into_iter().enumerate() {
            let _ = app.emit(EVENT, serde_json::json!({"event":"SourceSelected","data":{"source":provider,"fallback":index>0}}));
            match download(app, update, url, &archive).await {
                Ok(digest) => {
                    archive_digest = Some(digest);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        let archive_digest = archive_digest.ok_or_else(|| {
            last_error.unwrap_or_else(|| failure("No update download source is available"))
        })?;
        let app = app.clone();
        let version = update.version.clone();
        tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
            let _workers = worker::acquire_application_update()?;
            if app.webview_windows().keys().any(|label| label != "main") {
                return Err(failure("Close additional editor windows before installing the application update"));
            }
            let state = app.state::<crate::state::AppState>();
            if !state.native_tasks.lock().map_err(|_| failure("Task registry lock poisoned"))?.is_empty()
                || !state.migrations.lock().map_err(|_| failure("Migration registry lock poisoned"))?.is_empty()
            { return Err(failure("Wait for running tasks and model migrations to finish before updating")); }
            check_location(&target)?;
            validate_bundle(&target, None)?;
            let extracted = staging.path().join("extracted");
            fs::create_dir(&extracted)?;
            let bundle = extract_bundle(&archive, &extracted)?;
            validate_bundle(&bundle, Some(&version))?;
            // The channel JSON is unsigned. Recheck the contract inside the verified
            // archive so edited channel metadata cannot bypass runtime compatibility.
            if bundled_contract(&bundle.join("Contents/Resources"))?
                != bundled_contract(&target.join("Contents/Resources"))?
            {
                return Err(failure("The signed update changes the installed runtime contract and requires manual installation"));
            }
            require_space(target.parent().unwrap(), size)?;
            let startup_directory = tempfile::Builder::new().prefix("macos-update-startup-").tempdir_in(&root)?;
            let mut request = startup::Request {
                token: startup_directory.path().file_name().unwrap().to_str().unwrap().into(),
                target: target.clone(), version: version.clone(), privileged: false,
            };
            let old_version = plist(&target, "CFBundleShortVersionString")?;
            let log_directory = storage::logs_dir(&app)?;
            fs::create_dir_all(&log_directory)?;
            let log_path = log_directory.join("macos-update.log");
            let mut authorization = None;
            let backup = match install_writable(&target, &bundle, &version, size) {
                Ok(backup) => backup,
                Err(AppError::Io(ref error)) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    request.privileged = true;
                    authorization = Some(authorized::Session::begin(
                        &target, &archive, &archive_digest, &version, &request.token, &log_path)?);
                    previous_bundle(&target)
                }
                Err(error) => return Err(error),
            };
            let mut child = None;
            let started = (|| -> AppResult<()> {
                startup::save_request(startup_directory.path(), &request)?;
                child = Some(start_replacement(&target, &request, &log_path)?);
                startup::wait_for_acknowledgement(child.as_mut().unwrap(), startup_directory.path(), &request, Duration::from_secs(30))
            })();
            if let Err(error) = started {
                if let Some(child) = child.as_mut() { startup::stop_child(child)?; }
                let restored = if let Some(session) = authorization.as_mut() { session.complete(false) }
                    else { restore_previous(&target, &backup, &old_version) };
                crate::session_log::append(&app, "ERROR", "update.restart", vec![("version", version.clone()), ("reason", error.to_string())]);
                restored.map_err(|recovery| failure(format!("Application startup failed: {error}. Previous-version recovery failed: {recovery}")))?;
                return Err(failure(format!("Application startup failed: {error}. The previous version has been restored. See {} for details.", log_path.display())));
            }
            if let Some(session) = authorization.as_mut() {
                if let Err(error) = session.complete(true) {
                    startup::stop_child(child.as_mut().unwrap())?;
                    return Err(error);
                }
            }
            crate::session_log::append(&app, "INFO", "update.restart", vec![("version", version)]);
            if let Err(error) = staging.close() { eprintln!("Unable to clean the macOS update download directory: {error}"); }
            if let Err(error) = startup_directory.close() { eprintln!("Unable to clean the macOS update startup directory: {error}"); }
            app.exit(0);
            Ok(())
        }).await.map_err(|e| failure(e.to_string()))?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn signed_bundle(parent: &Path, name: &str, version: &str) -> PathBuf {
            signed_bundle_with_arch(parent, name, version, "arm64")
        }

        fn signed_bundle_with_arch(
            parent: &Path,
            name: &str,
            version: &str,
            architecture: &str,
        ) -> PathBuf {
            let bundle = parent.join(name);
            fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
            let mut compiler = Command::new("/usr/bin/clang")
                .args(["-arch", architecture, "-x", "c", "-", "-o"])
                .arg(bundle.join("Contents/MacOS/pymss-studio"))
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            compiler
                .stdin
                .take()
                .unwrap()
                .write_all(b"int main(void) { return 0; }\n")
                .unwrap();
            assert!(compiler.wait().unwrap().success());
            fs::write(
                bundle.join("Contents/Info.plist"),
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>pymss-studio</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
<key>CFBundleVersion</key><string>{version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>"#
                ),
            )
            .unwrap();
            fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
            fs::write(bundle.join("Contents/Resources/version"), version).unwrap();
            assert!(Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&bundle)
                .status()
                .unwrap()
                .success());
            bundle
        }

        #[test]
        fn rejects_signed_bundles_without_arm64() {
            let root = tempfile::tempdir().unwrap();
            let bundle = signed_bundle_with_arch(root.path(), "Intel.app", "1.0.0", "x86_64");
            let error = validate_bundle(&bundle, Some("1.0.0")).unwrap_err();
            assert!(error.to_string().contains("Apple Silicon executable"));
        }

        #[test]
        fn replaces_signed_bundles_and_keeps_one_previous_version() {
            let root = tempfile::tempdir().unwrap();
            let target = signed_bundle(root.path(), "Installed.app", "1.0.0");
            let source = signed_bundle(root.path(), "New.app", "1.1.0");
            install_writable(&target, &source, "1.1.0", 1024).unwrap();
            assert_eq!(
                plist(&target, "CFBundleShortVersionString").unwrap(),
                "1.1.0"
            );
            assert_eq!(
                plist(&previous_bundle(&target), "CFBundleShortVersionString").unwrap(),
                "1.0.0"
            );
            let next = signed_bundle(root.path(), "Next.app", "1.2.0");
            install_writable(&target, &next, "1.2.0", 1024).unwrap();
            assert_eq!(
                plist(&previous_bundle(&target), "CFBundleShortVersionString").unwrap(),
                "1.1.0"
            );
            validate_bundle(&target, Some("1.2.0")).unwrap();
        }

        #[test]
        fn failed_startup_restores_the_old_signed_bundle_and_isolates_other_backups() {
            let root = tempfile::tempdir().unwrap();
            let target = signed_bundle(root.path(), "Installed.app", "1.0.0");
            let beta = signed_bundle(root.path(), "Beta.app", "2.0.0");
            let source = signed_bundle(root.path(), "New.app", "1.1.0");
            let next_beta = signed_bundle(root.path(), "New Beta.app", "2.1.0");
            let backup = install_writable(&target, &source, "1.1.0", 1024).unwrap();
            install_writable(&beta, &next_beta, "2.1.0", 1024).unwrap();
            restore_previous(&target, &backup, "1.0.0").unwrap();
            validate_bundle(&target, Some("1.0.0")).unwrap();
            validate_bundle(&beta, Some("2.1.0")).unwrap();
            validate_bundle(&previous_bundle(&beta), Some("2.0.0")).unwrap();
        }

        fn archive_bundle(root: &Path, source: &Path) -> PathBuf {
            let path = root.join("update.app.tar.gz");
            let gzip = flate2::write::GzEncoder::new(
                fs::File::create(&path).unwrap(),
                flate2::Compression::fast(),
            );
            let mut archive = tar::Builder::new(gzip);
            archive.append_dir_all(BUNDLE_NAME, source).unwrap();
            archive.into_inner().unwrap().finish().unwrap();
            path
        }

        fn run_authorization_script(
            target: &Path,
            archive: &Path,
            digest: &str,
            commit: Option<bool>,
        ) {
            let transaction = tempfile::Builder::new()
                .prefix("macos-update-startup-")
                .tempdir()
                .unwrap();
            let token = transaction.path().file_name().unwrap().to_str().unwrap();
            let control =
                Path::new("/private/tmp").join(format!("pymss-studio-authorized-{token}"));
            let command = authorized::command(target, archive, digest, "1.1.0", token);
            let script = format!("do shell script {}", applescript_quote(&command));
            // Exercise the same script and shell quoting as production, as the CI user.
            let mut child = Command::new("/usr/bin/osascript")
                .args(["-e", &script])
                .spawn()
                .unwrap();
            let started = Instant::now();
            let mut requested = false;
            let expected = match commit {
                Some(true) => "committed",
                Some(false) => "rolledback",
                None => "failed",
            };
            let observed = loop {
                let status = fs::read_to_string(control.join("status")).unwrap_or_default();
                if status == "installed" && !requested {
                    let value = if commit == Some(true) {
                        "commit"
                    } else {
                        "rollback"
                    };
                    fs::write(control.join("outcome"), format!("{value:<64}")).unwrap();
                    requested = true;
                }
                if matches!(status.as_str(), "committed" | "rolledback" | "failed") {
                    fs::write(control.join("outcome"), format!("{:<64}", "observed")).unwrap();
                    break status;
                }
                if started.elapsed() > Duration::from_secs(20)
                    || child.try_wait().unwrap().is_some()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("Installer ended before {expected}, status: {status}");
                }
                std::thread::sleep(Duration::from_millis(25));
            };
            let status = child.wait().unwrap();
            assert_eq!(observed, expected);
            assert_eq!(status.success(), commit.is_some());
            assert!(!control.exists());
        }

        #[test]
        fn authorization_uses_the_archive_snapshot_and_handles_quoted_paths() {
            let root = tempfile::Builder::new()
                .prefix("pymss it's a \"quoted\" $(false) `false` path-")
                .tempdir()
                .unwrap();
            let target = signed_bundle(root.path(), "Installed.app", "1.0.0");
            let source = signed_bundle(root.path(), "New.app", "1.1.0");
            let archive = archive_bundle(root.path(), &source);
            let digest = sha256_hex(&fs::read(&archive).unwrap());
            // A same-user process can change and ad-hoc re-sign the extracted copy.
            fs::write(source.join("Contents/Resources/version"), "tampered").unwrap();
            assert!(Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&source)
                .status()
                .unwrap()
                .success());
            run_authorization_script(&target, &archive, &digest, Some(true));
            validate_bundle(&target, Some("1.1.0")).unwrap();
            assert_eq!(
                fs::read_to_string(target.join("Contents/Resources/version")).unwrap(),
                "1.1.0"
            );
            validate_bundle(&previous_bundle(&target), Some("1.0.0")).unwrap();
        }

        #[test]
        fn authorization_rejects_changed_archives_and_can_restore_without_another_prompt() {
            let root = tempfile::tempdir().unwrap();
            let target = signed_bundle(root.path(), "Installed.app", "1.0.0");
            let source = signed_bundle(root.path(), "New.app", "1.1.0");
            let archive = archive_bundle(root.path(), &source);
            run_authorization_script(&target, &archive, &sha256_hex(b"different archive"), None);
            validate_bundle(&target, Some("1.0.0")).unwrap();
            assert!(!previous_bundle(&target).exists());
            run_authorization_script(
                &target,
                &archive,
                &sha256_hex(&fs::read(&archive).unwrap()),
                Some(false),
            );
            validate_bundle(&target, Some("1.0.0")).unwrap();
        }
    }
}

#[cfg(target_os = "macos")]
pub use platform::{
    check_location, check_runtime_contract, confirm_startup, current_bundle, start,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previous_versions_are_scoped_to_the_full_installation_path() {
        let first = Path::new("/Applications/Pymss Studio.app");
        let beta = Path::new("/Applications/Pymss Studio Beta.app");
        let user = Path::new("/Users/me/Applications/Pymss Studio.app");
        assert_eq!(previous_bundle(first), previous_bundle(first));
        assert_ne!(previous_bundle(first), previous_bundle(beta));
        assert_ne!(previous_bundle(first), previous_bundle(user));
        assert_eq!(previous_bundle(first).parent(), first.parent());
    }

    #[test]
    fn trusted_digest_is_bound_to_the_same_bytes_as_the_signature() {
        let key = minisign_verify::PublicKey::from_base64(
            "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
        )
        .unwrap();
        let signature = minisign_verify::Signature::decode(concat!(
            "untrusted comment: signature from minisign secret key\n",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n",
            "trusted comment: timestamp:1556193335\tfile:test\n",
            "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n",
        )).unwrap();
        let mut stream = VerifiedStream::new(&key, &signature).unwrap();
        stream.update(b"te");
        stream.update(b"st");
        assert_eq!(stream.finish().unwrap(), sha256_hex(b"test"));
        let mut tampered = VerifiedStream::new(&key, &signature).unwrap();
        tampered.update(b"tesT");
        assert!(tampered.finish().is_err());
    }

    #[test]
    fn recognizes_only_real_bundle_executable_layouts() {
        assert_eq!(
            bundle_from_executable(Path::new(
                "/Applications/Renamed.app/Contents/MacOS/pymss-studio"
            )),
            Some(PathBuf::from("/Applications/Renamed.app"))
        );
        assert!(bundle_from_executable(Path::new("/tmp/pymss-studio")).is_none());
        assert!(bundle_from_executable(Path::new("/tmp/Fake.app/bin/pymss-studio")).is_none());
        assert!(location_problem(Path::new("/Applications/Pymss Studio.app"), false).is_none());
        assert!(
            location_problem(Path::new("/Volumes/Pymss Studio/Pymss Studio.app"), true).is_some()
        );
        assert!(location_problem(
            Path::new("/private/var/AppTranslocation/id/d/Pymss Studio.app"),
            false
        )
        .is_some());
    }

    #[test]
    fn rejects_archive_traversal_and_links_outside_the_bundle() {
        for path in [
            "../outside",
            "Other.app/Contents/file",
            "Pymss Studio.app/../outside",
            "/Pymss Studio.app/file",
        ] {
            assert!(validate_entry(Path::new(path), None).is_err(), "{path}");
        }
        let path = Path::new("Pymss Studio.app/Contents/Resources/bin/python");
        assert!(validate_entry(path, Some(Path::new("../lib/python3"))).is_ok());
        assert!(validate_entry(path, Some(Path::new("../../../../outside"))).is_err());
        assert!(validate_entry(path, Some(Path::new("/usr/bin/python3"))).is_err());
    }

    #[test]
    fn failed_replacement_restores_the_previous_application() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("app");
        let staged = root.path().join("staged");
        let backup = root.path().join("previous");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("version"), "old").unwrap();
        let result =
            replace_bundle_with(&target, &staged, &backup, |from, to| fs::rename(from, to));
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(target.join("version")).unwrap(), "old");
        assert!(!backup.exists());
    }

    #[test]
    fn failed_restoration_keeps_a_persistent_backup() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("app");
        let staged = root.path().join("staged");
        let backup = root.path().join("previous");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("version"), "old").unwrap();
        let mut moves = 0;
        let result = replace_bundle_with(&target, &staged, &backup, |from, to| {
            moves += 1;
            if moves > 1 {
                return Err(std::io::Error::other("move failed"));
            }
            fs::rename(from, to)
        });
        assert!(result.unwrap_err().to_string().contains("preserved"));
        assert_eq!(fs::read_to_string(backup.join("version")).unwrap(), "old");
    }

    #[test]
    fn command_arguments_are_quoted_for_both_shells() {
        assert_eq!(shell_quote("Bob's app"), "'Bob'\\''s app'");
        assert_eq!(applescript_quote("a\\b\"c"), "\"a\\\\b\\\"c\"");
    }

    #[test]
    fn runtime_contract_detects_abi_changes_and_allows_core_package_updates() {
        let mut manifest = serde_json::json!({
            "python":"3.12", "baseGeneration":1,
            "common":{"pymss":"pymss==2.1.8","pymss-core":"pymss-core==0.1.11","numpy":"numpy>=1.26,<3"},
            "backends":{"cpu":{"torch":"2.7.1"},"mlx":{"torch":"2.7.1","extras":["mlx"]}}
        });
        let original = runtime_contract(&manifest).unwrap();
        manifest["common"]["pymss"] = "pymss==2.2.0".into();
        assert_eq!(runtime_contract(&manifest).unwrap(), original);
        manifest["python"] = "3.13".into();
        assert_ne!(runtime_contract(&manifest).unwrap(), original);
        assert!(runtime_contract(&serde_json::json!({})).is_none());
    }

    fn write_archive(root: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = root.join("update.tar.gz");
        let gzip = flate2::write::GzEncoder::new(
            fs::File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut archive = tar::Builder::new(gzip);
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append_data(&mut header, name, *data).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        path
    }

    #[test]
    fn extracts_a_complete_bundle_and_rejects_duplicate_or_missing_entries() {
        let root = tempfile::tempdir().unwrap();
        let entries: &[(&str, &[u8])] = &[
            ("Pymss Studio.app/Contents/Info.plist", b"plist"),
            (
                "Pymss Studio.app/Contents/MacOS/pymss-studio",
                b"executable",
            ),
        ];
        let archive = write_archive(root.path(), entries);
        let destination = root.path().join("valid");
        fs::create_dir(&destination).unwrap();
        let bundle = extract_bundle(&archive, &destination).unwrap();
        assert_eq!(
            fs::read(bundle.join("Contents/MacOS/pymss-studio")).unwrap(),
            b"executable"
        );

        let archive = write_archive(root.path(), &[entries[0], entries[0]]);
        let duplicate = root.path().join("duplicate");
        fs::create_dir(&duplicate).unwrap();
        assert!(extract_bundle(&archive, &duplicate)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));

        let archive = write_archive(root.path(), &entries[..1]);
        let missing = root.path().join("missing");
        fs::create_dir(&missing).unwrap();
        assert!(extract_bundle(&archive, &missing).is_err());
    }

    #[test]
    fn extraction_rejects_oversized_entries_before_writing_them() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("oversized.tar.gz");
        let mut header = tar::Header::new_gnu();
        header.set_path("Pymss Studio.app/Contents/large").unwrap();
        header.set_size(MAX_EXTRACTED_BYTES + 1);
        header.set_mode(0o644);
        header.set_cksum();
        let mut gzip = flate2::write::GzEncoder::new(
            fs::File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        gzip.write_all(header.as_bytes()).unwrap();
        gzip.write_all(&[0; 1024]).unwrap();
        gzip.finish().unwrap();
        assert!(extract_bundle(&path, root.path())
            .unwrap_err()
            .to_string()
            .contains("extraction limits"));
        assert!(!root.path().join("Pymss Studio.app/Contents/large").exists());
    }
}
