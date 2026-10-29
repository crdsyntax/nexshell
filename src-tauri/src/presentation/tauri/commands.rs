use crate::application::audit::AuditEvent;
use crate::application::filesystem::FilesystemManager;
use crate::application::processes::{ProcessManager, ProcessSignal};
use crate::application::services::{ServiceAction, ServiceManager, WebService};
use crate::application::terminal::TerminalOptions;
use crate::error::{AppError, AppResult};
use crate::models::{
    ConfigContent, ConfigEntry, ConnectionProfile, ExecOutput, ExecutionLog, FileDeleteResult,
    FileProperties, KeyProbe, LargeFile, LogFilter, PoolStats, ProcessKillResult, ProcessLocation,
    ProfileView, ServerInfo, ServiceActionResult, ServiceStatus, TerminalInfo, TestResult,
    WebServiceInfo,
};
use crate::state::AppState;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Vec<ProfileView> {
    state.profiles.list()
}

#[tauri::command]
pub async fn save_profile(
    profile: ConnectionProfile,
    state: State<'_, AppState>,
) -> AppResult<ProfileView> {
    let view = state.profiles.save(profile)?;
    // Credentials or pool settings may have changed: stop collectors, then
    // force fresh transports on the next operation.
    state.metrics.stop(&view.id).await;
    state.pools.invalidate(&view.id).await;
    state.audit.log(
        AuditEvent::new("profile", "save", "success")
            .profile(Some(&view.id), Some(&view.name))
            .target(format!("{}@{}:{}", view.username, view.host, view.port)),
    );
    Ok(view)
}

#[tauri::command]
pub async fn delete_profile(id: String, state: State<'_, AppState>) -> AppResult<()> {
    let existing = state.profiles.get(&id).ok();
    let name = existing.as_ref().map(|profile| profile.name.clone());
    let target = existing
        .as_ref()
        .map(|profile| format!("{}@{}:{}", profile.username, profile.host, profile.port));
    state.terminals.close_profile(&id).await;
    state.metrics.stop(&id).await;
    state.pools.invalidate(&id).await;
    state.profiles.delete(&id)?;
    let mut event =
        AuditEvent::new("profile", "delete", "success").profile(Some(&id), name.as_deref());
    if let Some(target) = target {
        event = event.target(target);
    }
    state.audit.log(event);
    Ok(())
}

#[tauri::command]
pub fn probe_ssh_key(path: String) -> AppResult<KeyProbe> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("key path is required".into()));
    }
    Ok(crate::ssh::probe_private_key(trimmed))
}

#[tauri::command]
pub async fn test_profile(
    profile: ConnectionProfile,
    state: State<'_, AppState>,
) -> AppResult<TestResult> {
    let started = Instant::now();
    let target = format!("{}@{}:{}", profile.username, profile.host, profile.port);
    let profile_id = (!profile.id.is_empty()).then(|| profile.id.clone());
    let profile_name = (!profile.name.is_empty()).then(|| profile.name.clone());
    let result = state.profiles.test(profile).await;

    let mut event = AuditEvent::new(
        "connection",
        "test",
        if result.ok { "success" } else { "error" },
    )
    .profile(profile_id.as_deref(), profile_name.as_deref())
    .target(target)
    .duration(started.elapsed().as_millis() as u64);
    if let Some(error) = &result.error {
        event = event.error(error);
    }
    if let Some(server) = &result.server {
        event = event.metadata(serde_json::json!({
            "hostname": server.hostname,
            "os": server.os_name,
            "kernel": server.kernel,
            "latency_ms": result.latency_ms
        }));
    }
    state.audit.log(event);
    Ok(result)
}

#[tauri::command]
pub async fn connect_profile(id: String, state: State<'_, AppState>) -> AppResult<PoolStats> {
    state.pools.check(&id).await?;
    state.pools.stats(&id).await
}

#[tauri::command]
pub async fn disconnect_profile(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.terminals.close_profile(&id).await;
    state.metrics.stop(&id).await;
    state.pools.invalidate(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn detect_server(id: String, state: State<'_, AppState>) -> AppResult<ServerInfo> {
    let started = Instant::now();
    let profile = state.profiles.get(&id)?;
    let target = format!("{}@{}:{}", profile.username, profile.host, profile.port);
    let result = async {
        let pool = state.pools.pool(&id).await?;
        let lease = pool.acquire().await?;
        state.profiles.detect_server(lease.connection()).await
    }
    .await;

    let mut event = AuditEvent::new(
        "detect",
        "detect",
        if result.is_ok() { "success" } else { "error" },
    )
    .profile(Some(&id), Some(&profile.name))
    .target(target)
    .duration(started.elapsed().as_millis() as u64);
    if let Err(error) = &result {
        event = event.error(error.to_string());
    }
    state.audit.log(event);
    result
}

#[tauri::command]
pub async fn pool_stats(id: String, state: State<'_, AppState>) -> AppResult<PoolStats> {
    state.pools.stats(&id).await
}

#[tauri::command]
pub async fn remote_exec(
    id: String,
    command: String,
    state: State<'_, AppState>,
) -> AppResult<ExecOutput> {
    if command.trim().is_empty() {
        return Err(AppError::Validation("command is required".into()));
    }
    if command.len() > 64 * 1024 {
        return Err(AppError::Validation("command is too large".into()));
    }
    state
        .pools
        .execute_command(&id, &command, Duration::from_secs(60))
        .await
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn terminal_open(
    profile_id: String,
    cols: Option<u32>,
    rows: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<TerminalInfo> {
    let profile = state.profiles.get(&profile_id)?;
    let pool = state.pools.pool(&profile_id).await?;
    state
        .terminals
        .open(
            pool,
            &profile,
            TerminalOptions {
                cols: cols.unwrap_or(120),
                rows: rows.unwrap_or(32),
                ..Default::default()
            },
            app,
        )
        .await
}

#[tauri::command]
pub async fn terminal_open_process(
    profile_id: String,
    pid: u32,
    cols: Option<u32>,
    rows: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<TerminalInfo> {
    let location = ProcessManager::locate(&state.pools, &profile_id, pid).await?;
    if !location.accessible {
        return Err(AppError::Validation(format!(
            "process {pid} runs in {}, but the SSH user cannot access that directory",
            location.directory
        )));
    }
    let profile = state.profiles.get(&profile_id)?;
    let pool = state.pools.pool(&profile_id).await?;
    let name = std::path::Path::new(&location.directory)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&location.directory)
        .to_string();
    let title = format!("pid {pid} · {name}");
    state
        .terminals
        .open(
            pool,
            &profile,
            TerminalOptions {
                cols: cols.unwrap_or(120),
                rows: rows.unwrap_or(32),
                initial_directory: Some(location.directory),
                title: Some(title),
            },
            app,
        )
        .await
}

#[tauri::command]
pub async fn terminal_open_directory(
    profile_id: String,
    directory: String,
    cols: Option<u32>,
    rows: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<TerminalInfo> {
    let profile = state.profiles.get(&profile_id)?;
    FilesystemManager::ensure_directory(&state.pools, &profile, &directory).await?;
    let pool = state.pools.pool(&profile_id).await?;
    let name = std::path::Path::new(&directory)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("/")
        .to_string();
    state
        .terminals
        .open(
            pool,
            &profile,
            TerminalOptions {
                cols: cols.unwrap_or(120),
                rows: rows.unwrap_or(32),
                initial_directory: Some(directory),
                title: Some(format!("dir · {name}")),
            },
            app,
        )
        .await
}

#[tauri::command]
pub async fn disk_large_files(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<LargeFile>> {
    let profile = state.profiles.get(&profile_id)?;
    FilesystemManager::large_files(&state.pools, &profile).await
}

#[tauri::command]
pub async fn file_properties(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<FileProperties> {
    let profile = state.profiles.get(&profile_id)?;
    FilesystemManager::properties(&state.pools, &profile, &path).await
}

#[tauri::command]
pub async fn file_delete(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<FileDeleteResult> {
    let profile = state.profiles.get(&profile_id)?;
    FilesystemManager::delete(&state.pools, &profile, &path).await
}

#[tauri::command]
pub async fn process_locate(
    profile_id: String,
    pid: u32,
    state: State<'_, AppState>,
) -> AppResult<ProcessLocation> {
    ProcessManager::locate(&state.pools, &profile_id, pid).await
}

#[tauri::command]
pub async fn process_kill(
    profile_id: String,
    pid: u32,
    signal: String,
    state: State<'_, AppState>,
) -> AppResult<ProcessKillResult> {
    let profile = state.profiles.get(&profile_id)?;
    let signal = ProcessSignal::parse(&signal)?;
    ProcessManager::kill(&state.pools, &profile, pid, signal).await
}

#[tauri::command]
pub async fn terminal_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.terminals.write(&session_id, data).await
}

#[tauri::command]
pub async fn terminal_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.terminals.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_close(session_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.terminals.close(&session_id).await
}

#[tauri::command]
pub async fn terminal_list(state: State<'_, AppState>) -> AppResult<Vec<TerminalInfo>> {
    Ok(state.terminals.list().await)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn monitor_start(
    profile_id: String,
    interval_ms: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let pool = state.pools.pool(&profile_id).await?;
    state
        .metrics
        .start(&profile_id, pool, app, interval_ms.unwrap_or(2_000))
        .await
}

#[tauri::command]
pub async fn monitor_stop(profile_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.metrics.stop(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn monitor_snapshot(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<Option<crate::models::MetricsSnapshot>> {
    Ok(state.metrics.snapshot(&profile_id).await)
}

// ---------------------------------------------------------------------------
// Web services
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn service_detect(
    id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<WebServiceInfo>> {
    let profile = state.profiles.get(&id)?;
    ServiceManager::detect(&state.pools, &profile).await
}

#[tauri::command]
pub async fn service_status(
    id: String,
    service: String,
    state: State<'_, AppState>,
) -> AppResult<ServiceStatus> {
    let profile = state.profiles.get(&id)?;
    let service = WebService::parse(&service)?;
    ServiceManager::status(&state.pools, &profile, service).await
}

#[tauri::command]
pub async fn service_action(
    id: String,
    service: String,
    action: String,
    state: State<'_, AppState>,
) -> AppResult<ServiceActionResult> {
    let profile = state.profiles.get(&id)?;
    let service = WebService::parse(&service)?;
    let action = ServiceAction::parse(&action)?;
    ServiceManager::act(&state.pools, &profile, service, action).await
}

#[tauri::command]
pub async fn service_config_list(
    id: String,
    service: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<ConfigEntry>> {
    let profile = state.profiles.get(&id)?;
    let service = WebService::parse(&service)?;
    ServiceManager::config_list(&state.pools, &profile, service).await
}

#[tauri::command]
pub async fn service_config_read(
    id: String,
    service: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<ConfigContent> {
    let profile = state.profiles.get(&id)?;
    let service = WebService::parse(&service)?;
    ServiceManager::config_read(&state.pools, &profile, service, &path).await
}

#[tauri::command]
pub async fn service_config_write(
    id: String,
    service: String,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> AppResult<ServiceActionResult> {
    let profile = state.profiles.get(&id)?;
    let service = WebService::parse(&service)?;
    ServiceManager::config_write(&state.pools, &profile, service, &path, &content).await
}

#[tauri::command]
pub async fn service_logs(
    id: String,
    service: String,
    lines: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let profile = state.profiles.get(&id)?;
    let service = WebService::parse(&service)?;
    ServiceManager::logs(&state.pools, &profile, service, lines.unwrap_or(200)).await
}

// ---------------------------------------------------------------------------
// Execution log
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_execution_logs(
    profile_id: Option<String>,
    category: Option<String>,
    status: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Vec<ExecutionLog>> {
    state.audit.list(&LogFilter {
        profile_id: profile_id.filter(|value| !value.is_empty()),
        category: category.filter(|value| !value.is_empty()),
        status: status.filter(|value| !value.is_empty()),
        search: search.filter(|value| !value.trim().is_empty()),
        limit: limit.unwrap_or(250),
        offset: offset.unwrap_or(0),
    })
}

#[tauri::command]
pub fn clear_execution_logs(
    profile_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    state
        .audit
        .clear(profile_id.as_deref().filter(|value| !value.is_empty()))
}

#[tauri::command]
pub fn audit_db_path(state: State<'_, AppState>) -> String {
    state.audit.db_path()
}
