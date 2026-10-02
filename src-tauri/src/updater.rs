//! Desktop-only updater. Downloads and restart authority stay outside the WebView.
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tempfile::NamedTempFile;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub enabled: bool,
    pub reason: Option<String>,
    pub phase: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<UpdateError>,
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateError {
    pub code: String,
    pub message: String,
}

impl UpdateError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn plugin(error: tauri_plugin_updater::Error, fallback: &str) -> Self {
        use tauri_plugin_updater::Error;
        let code = match &error {
            Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::SignedVersionMismatch { .. }
            | Error::MissingSignedVersion => "SIGNATURE",
            Error::Reqwest(e) if !e.is_decode() => "NETWORK",
            Error::Network(_) | Error::ReleaseNotFound => "NETWORK",
            Error::Serialization(_)
            | Error::Semver(_)
            | Error::TargetNotFound(_)
            | Error::TargetsNotFound(_) => "INVALID_MANIFEST",
            _ => fallback,
        };
        Self::new(code, error.to_string())
    }
}

#[derive(Default)]
pub struct PreparedUpdate {
    pub update: Option<Update>,
    pub package: Option<NamedTempFile>,
    pub rejected_version: Option<String>,
}

pub struct UpdateState {
    status: Mutex<UpdateStatus>,
    pub operation: tokio::sync::Mutex<PreparedUpdate>,
    pub pubkey: String,
}

pub fn decode_key(key: &str) -> Result<minisign_verify::PublicKey, UpdateError> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))?;
    let text =
        String::from_utf8(decoded).map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))?;
    minisign_verify::PublicKey::decode(&text)
        .map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))
}

pub fn verify_package(bytes: &[u8], signature: &str, key: &str) -> Result<(), UpdateError> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))?;
    let signature =
        String::from_utf8(decoded).map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))?;
    let signature = minisign_verify::Signature::decode(&signature)
        .map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))?;
    decode_key(key)?
        .verify(bytes, &signature, true)
        .map_err(|e| UpdateError::new("SIGNATURE", e.to_string()))
}

impl UpdateState {
    pub fn new(config: Option<&Value>, development: bool, e2e: bool, appimage: bool) -> Self {
        let pubkey = config
            .and_then(|c| c["pubkey"].as_str())
            .unwrap_or_default()
            .trim()
            .to_owned();
        let endpoints = config.and_then(|c| c["endpoints"].as_array());
        let empty_endpoints = endpoints.is_none_or(Vec::is_empty);
        let reason = if e2e {
            Some("test")
        } else if development {
            Some("development")
        } else if cfg!(target_os = "linux") && !appimage {
            Some("package-manager")
        } else if pubkey.is_empty() && empty_endpoints {
            Some("unconfigured")
        } else if pubkey.is_empty()
            || empty_endpoints
            || decode_key(&pubkey).is_err()
            || endpoints.is_some_and(|urls| {
                urls.iter().any(|url| {
                    url.as_str().is_none_or(|url| {
                        !url.starts_with("https://") || url.len() <= "https://".len()
                    })
                })
            })
            || config.is_some_and(|c| {
                [
                    "dangerousInsecureTransportProtocol",
                    "dangerousAcceptInvalidCerts",
                    "dangerousAcceptInvalidHostnames",
                    "allowDowngrades",
                ]
                .iter()
                .any(|flag| c[flag].as_bool() == Some(true))
            })
        {
            Some("invalid-configuration")
        } else {
            None
        };
        Self {
            status: Mutex::new(UpdateStatus {
                enabled: reason.is_none(),
                reason: reason.map(str::to_owned),
                phase: if reason.is_some() { "disabled" } else { "idle" }.into(),
                version: None,
                notes: None,
                error: None,
                downloaded: 0,
                total: None,
            }),
            operation: tokio::sync::Mutex::new(PreparedUpdate::default()),
            pubkey,
        }
    }

    pub fn snapshot(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn change(&self, edit: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
        let mut status = self.status.lock().unwrap();
        edit(&mut status);
        status.clone()
    }

    pub fn require_enabled(&self) -> Result<(), UpdateError> {
        let status = self.snapshot();
        if status.enabled {
            Ok(())
        } else {
            Err(UpdateError::new(
                "UNAVAILABLE",
                status.reason.unwrap_or_default(),
            ))
        }
    }

    pub fn fail(&self, error: UpdateError) -> UpdateError {
        tracing::warn!(target: "gitmini::updater", code = %error.code, message = %error.message, "update failed");
        self.change(|s| {
            s.phase = "error".into();
            s.error = Some(error.clone());
        });
        error
    }
}

/// Called after a successful macOS/Linux installation, immediately before restart.
pub fn cleanup<R: Runtime>(app: &AppHandle<R>) {
    if let (Some(state), Some(open)) = (
        app.try_state::<std::sync::Arc<gitmini_core::AppState>>(),
        app.try_state::<crate::ipc::OpenRepos>(),
    ) {
        let ids = open.take_all();
        tauri::async_runtime::block_on(async {
            for repo_id in ids {
                let _ = gitmini_core::repo::repo_close(
                    &state,
                    gitmini_core::repo::RepoCloseArgs { repo_id },
                )
                .await;
            }
        });
    }
    crate::logging::flush();
}

pub fn builder<R: Runtime>(app: &AppHandle<R>) -> tauri_plugin_updater::UpdaterBuilder {
    let builder = app.updater_builder().timeout(Duration::from_secs(30));
    #[cfg(windows)]
    let builder = builder
        // This hook also runs before a failed ShellExecuteW. Keep repositories and Tauri
        // resources intact so the UI can recover; Windows releases handles on process exit.
        .on_before_exit(crate::logging::flush)
        .restart_after_install(true);
    builder
}

pub fn cache_package(bytes: &[u8]) -> Result<NamedTempFile, UpdateError> {
    let mut file = NamedTempFile::new().map_err(|e| UpdateError::new("DOWNLOAD", e.to_string()))?;
    file.write_all(bytes)
        .map_err(|e| UpdateError::new("DOWNLOAD", e.to_string()))?;
    file.flush()
        .map_err(|e| UpdateError::new("DOWNLOAD", e.to_string()))?;
    Ok(file)
}

pub fn read_package(file: &mut std::fs::File) -> Result<Vec<u8>, UpdateError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| UpdateError::new("INSTALL", e.to_string()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| UpdateError::new("INSTALL", e.to_string()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests;
