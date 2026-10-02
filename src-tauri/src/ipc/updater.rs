use tauri::{AppHandle, Runtime, State, ipc::Channel};

use super::Core;
use crate::updater::{self, UpdateError, UpdateState, UpdateStatus};

fn busy() -> UpdateError {
    UpdateError::new("BUSY", "An update is already underway.")
}

#[tauri::command]
pub async fn app_update_status(state: State<'_, UpdateState>) -> Result<UpdateStatus, UpdateError> {
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, UpdateError> {
    state.require_enabled()?;
    let mut prepared = state.operation.try_lock().map_err(|_| busy())?;
    if prepared.package.is_some() {
        return Ok(state.change(|s| {
            s.phase = "ready".into();
            s.error = None;
        }));
    }
    state.change(|s| {
        s.phase = "checking".into();
        s.error = None;
    });
    let result = async {
        let update = updater::builder(&app)
            .build()
            .map_err(|e| UpdateError::plugin(e, "CHECK"))?
            .check()
            .await
            .map_err(|e| UpdateError::plugin(e, "CHECK"))?;
        if let Some(update) = &update {
            if update.download_url.scheme() != "https" {
                return Err(UpdateError::new(
                    "INVALID_MANIFEST",
                    "The download must use HTTPS.",
                ));
            }
            if prepared.rejected_version.as_deref() == Some(update.version.as_str()) {
                return Err(UpdateError::new(
                    "SIGNATURE",
                    "This version has already failed the signature check.",
                ));
            }
        }
        let status = state.change(|s| {
            s.phase = if update.is_some() {
                "available"
            } else {
                "up-to-date"
            }
            .into();
            s.version = update.as_ref().map(|u| u.version.clone());
            s.notes = update.as_ref().and_then(|u| u.body.clone());
            s.downloaded = 0;
            s.total = None;
        });
        prepared.update = update;
        Ok(status)
    }
    .await;
    result.map_err(|e| state.fail(e))
}

#[tauri::command]
pub async fn app_update_download(
    state: State<'_, UpdateState>,
    on_progress: Channel<UpdateStatus>,
) -> Result<UpdateStatus, UpdateError> {
    state.require_enabled()?;
    let mut prepared = state.operation.try_lock().map_err(|_| busy())?;
    if prepared.package.is_some() {
        return Ok(state.snapshot());
    }
    let mut update = prepared
        .update
        .clone()
        .ok_or_else(|| UpdateError::new("UNAVAILABLE", "Check the updates first."))?;
    update.timeout = Some(std::time::Duration::from_secs(600));
    state.change(|s| {
        s.phase = "downloading".into();
        s.error = None;
        s.downloaded = 0;
    });
    let mut last_progress = std::time::Instant::now();
    let result = update
        .download(
            |size, total| {
                let status = state.change(|s| {
                    s.downloaded += size as u64;
                    s.total = total;
                });
                if last_progress.elapsed() >= std::time::Duration::from_millis(100) {
                    let _ = on_progress.send(status);
                    last_progress = std::time::Instant::now();
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            let file = tauri::async_runtime::spawn_blocking(move || updater::cache_package(&bytes))
                .await
                .map_err(|e| state.fail(UpdateError::new("DOWNLOAD", e.to_string())))?
                .map_err(|e| state.fail(e))?;
            prepared.package = Some(file);
            Ok(state.change(|s| {
                s.phase = "ready".into();
            }))
        }
        Err(error) => {
            let error = UpdateError::plugin(error, "DOWNLOAD");
            if error.code == "SIGNATURE" {
                prepared.rejected_version = Some(update.version.clone());
            }
            Err(state.fail(error))
        }
    }
}

#[tauri::command]
pub async fn app_update_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdateState>,
    core: Core<'_>,
) -> Result<(), UpdateError> {
    state.require_enabled()?;
    let mut prepared = state.operation.try_lock().map_err(|_| busy())?;
    let update = prepared
        .update
        .clone()
        .ok_or_else(|| UpdateError::new("UNAVAILABLE", "No updates selected."))?;
    let file = prepared
        .package
        .as_ref()
        .ok_or_else(|| UpdateError::new("UNAVAILABLE", "The update is not downloaded."))?;
    let mut file = file
        .reopen()
        .map_err(|e| state.fail(UpdateError::new("INSTALL", e.to_string())))?;
    let _guard = core
        .prepare_app_update()
        .map_err(|e| UpdateError::new("BUSY", e.message))?;
    gitmini_core::settings::recent_list_flushed(&core).await;
    state.change(|s| {
        s.phase = "installing".into();
        s.error = None;
    });
    let key = state.pubkey.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bytes = updater::read_package(&mut file)?;
        updater::verify_package(&bytes, &update.signature, &key)?;
        update
            .install(bytes)
            .map_err(|e| UpdateError::plugin(e, "INSTALL"))
    })
    .await
    .map_err(|e| state.fail(UpdateError::new("INSTALL", e.to_string())))?;
    if let Err(error) = result {
        if error.code == "SIGNATURE" {
            prepared.rejected_version = prepared.update.as_ref().map(|u| u.version.clone());
            prepared.package = None;
        }
        return Err(state.fail(error));
    }
    // Windows' installer exits the app itself. On other platforms the new binary needs a relaunch.
    #[cfg(not(windows))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            updater::cleanup(&app);
            app.restart();
        })
        .await
        .map_err(|e| state.fail(UpdateError::new("INSTALL", e.to_string())))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = app;
        Ok(())
    }
}
