use crate::application::audit::AuditEvent;
use crate::application::cron::CronManager;
use crate::application::database::DatabaseManager;
use crate::application::filesystem::FilesystemManager;
use crate::application::incident::IncidentManager;
use crate::application::network::NetworkManager;
use crate::application::pm2::{Pm2Action, Pm2Manager};
use crate::application::processes::{ProcessManager, ProcessSignal};
use crate::application::remediation;
use crate::application::security::SecurityManager;
use crate::application::services::{ServiceAction, ServiceManager, WebService};
use crate::application::ssh_access::SshAccessManager;
use crate::application::sudoers::SudoersManager;
use crate::application::terminal::TerminalOptions;
use crate::error::{AppError, AppResult};
use crate::models::{
    ConfigContent, ConfigEntry, ConnectionProfile, CronBackupSummary, CronDeleteResult, CronReport,
    DbInfo, DbLoginTest, DbPasswordResult, DbUser, ExecOutput, ExecutionLog, FileDeleteResult,
    FileProperties, IncidentActionResult, IncidentScan, KeyProbe, LargeFile, LogFilter,
    NetworkReport, NodeProcess, Pm2Logs, Pm2Report, PoolStats, ProcessKillResult, ProcessLocation,
    ProfileView, SecurityAuditSummary, SecurityFixResult, SecurityReport, ServerInfo,
    ServiceActionResult, ServiceStatus, SshActionResult, SshConfig, SshKey, SudoersReport,
    TerminalInfo, TestResult, WebServiceInfo,
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

// ---------------------------------------------------------------------------
// MariaDB / MySQL
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn database_info(profile_id: String, state: State<'_, AppState>) -> AppResult<DbInfo> {
    let profile = state.profiles.get(&profile_id)?;
    DatabaseManager::info(&state.pools, &profile).await
}

#[tauri::command]
pub async fn database_users(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<DbUser>> {
    let profile = state.profiles.get(&profile_id)?;
    DatabaseManager::users(&state.pools, &profile).await
}

#[tauri::command]
pub async fn database_grants(
    profile_id: String,
    user: String,
    host: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let profile = state.profiles.get(&profile_id)?;
    DatabaseManager::grants(&state.pools, &profile, &user, &host).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn database_change_password(
    profile_id: String,
    user: String,
    host: String,
    password: String,
    test_host: Option<String>,
    test_port: Option<u16>,
    test_database: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<DbPasswordResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = DatabaseManager::change_password(
        &state.pools,
        &profile,
        &user,
        &host,
        &password,
        test_host.as_deref(),
        test_port,
        test_database.as_deref(),
    )
    .await;

    let mut event = AuditEvent::new(
        "database",
        "change-password",
        match &result {
            Ok(result) if result.ok => "success",
            _ => "error",
        },
    )
    .profile(Some(&profile_id), Some(&profile.name))
    .target(format!("{user}@{host}"));
    if let Ok(result) = &result {
        if let Some(test) = &result.test {
            event = event.metadata(serde_json::json!({
                "login_test_ok": test.ok
            }));
        }
        if !result.ok {
            event = event.error("password change failed");
        }
    } else if let Err(error) = &result {
        event = event.error(error.to_string());
    }
    state.audit.log(event);
    result
}

#[tauri::command]
pub async fn database_test_login(
    profile_id: String,
    user: String,
    host: String,
    password: String,
    port: Option<u16>,
    database: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<DbLoginTest> {
    let profile = state.profiles.get(&profile_id)?;
    let result = DatabaseManager::test_login(
        &state.pools,
        &profile,
        &user,
        &host,
        port.unwrap_or(3306),
        database.as_deref(),
        &password,
    )
    .await;
    state.audit.log(
        AuditEvent::new(
            "database",
            "test-login",
            match &result {
                Ok(test) if test.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(format!("{user}@{host}")),
    );
    result
}

#[tauri::command]
pub async fn cron_list(profile_id: String, state: State<'_, AppState>) -> AppResult<CronReport> {
    let profile = state.profiles.get(&profile_id)?;
    CronManager::list(&state.pools, &profile).await
}

// ---------------------------------------------------------------------------
// SSH access
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cron_delete_entry(
    profile_id: String,
    source: String,
    raw_line: String,
    state: State<'_, AppState>,
) -> AppResult<CronDeleteResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = CronManager::delete_entry(&state.pools, &profile, &source, &raw_line).await;
    let backup = match &result {
        Ok(deleted) => {
            if !deleted.backup.is_empty() {
                let _ = state.storage.insert_cron_backup(
                    &profile_id,
                    &profile.name,
                    &deleted.source,
                    &deleted.backup,
                    &deleted.entries,
                );
            }
            deleted.backup.clone()
        }
        Err(_) => String::new(),
    };
    state.audit.log(
        AuditEvent::new(
            "cron",
            "delete-entry",
            if result.is_ok() { "success" } else { "error" },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(source)
        .metadata(serde_json::json!({ "entry": raw_line, "backup": backup })),
    );
    result
}

#[tauri::command]
pub fn cron_list_backups(
    profile_id: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Vec<CronBackupSummary>> {
    state.storage.list_cron_backups(
        profile_id.as_deref().filter(|value| !value.is_empty()),
        limit.unwrap_or(30),
    )
}

#[tauri::command]
pub async fn cron_restore_backup(backup_id: i64, state: State<'_, AppState>) -> AppResult<String> {
    let backup = state
        .storage
        .get_cron_backup(backup_id)?
        .ok_or_else(|| crate::error::AppError::Validation("backup not found".into()))?;
    let profile = state.profiles.get(&backup.profile_id)?;
    let output =
        CronManager::restore_backup(&state.pools, &profile, &backup.source, &backup.backup_path)
            .await?;
    state.audit.log(
        AuditEvent::new("cron", "restore", "success")
            .profile(Some(&backup.profile_id), Some(&profile.name))
            .target(&backup.source)
            .metadata(serde_json::json!({ "backup": backup.backup_path })),
    );
    Ok(output)
}

#[tauri::command]
pub async fn ssh_keys(profile_id: String, state: State<'_, AppState>) -> AppResult<Vec<SshKey>> {
    let profile = state.profiles.get(&profile_id)?;
    SshAccessManager::keys(&state.pools, &profile).await
}

#[tauri::command]
pub async fn ssh_config(profile_id: String, state: State<'_, AppState>) -> AppResult<SshConfig> {
    let profile = state.profiles.get(&profile_id)?;
    SshAccessManager::config(&state.pools, &profile).await
}

#[tauri::command]
pub async fn ssh_add_key(
    profile_id: String,
    user: String,
    public_key: String,
    state: State<'_, AppState>,
) -> AppResult<SshActionResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = SshAccessManager::add_key(&state.pools, &profile, &user, &public_key).await;
    state.audit.log(
        AuditEvent::new(
            "ssh-access",
            "add-key",
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(format!("{user}@{}", profile.host)),
    );
    result
}

#[tauri::command]
pub async fn ssh_remove_key(
    profile_id: String,
    user: String,
    public_key: String,
    state: State<'_, AppState>,
) -> AppResult<SshActionResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = SshAccessManager::remove_key(&state.pools, &profile, &user, &public_key).await;
    state.audit.log(
        AuditEvent::new(
            "ssh-access",
            "remove-key",
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(format!("{user}@{}", profile.host)),
    );
    result
}

#[tauri::command]
pub async fn ssh_set_key_only(
    profile_id: String,
    enabled: bool,
    confirmed: bool,
    state: State<'_, AppState>,
) -> AppResult<SshActionResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = SshAccessManager::set_key_only(&state.pools, &profile, enabled, confirmed).await;
    state.audit.log(
        AuditEvent::new(
            "ssh-access",
            if enabled {
                "disable-password"
            } else {
                "enable-password"
            },
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(format!("{}:{}", profile.host, profile.port)),
    );
    result
}

// ---------------------------------------------------------------------------
// Security audit
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn run_security_audit(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<SecurityReport> {
    let profile = state.profiles.get(&profile_id)?;
    let mut report = SecurityManager::audit(&state.pools, &profile).await?;
    let id = state.storage.insert_security_audit(&report)?;
    report.id = Some(id);
    state.audit.log(
        AuditEvent::new("security", "audit", "success")
            .profile(Some(&profile_id), Some(&profile.name))
            .target("security-audit")
            .duration(report.duration_ms)
            .metadata(serde_json::json!({
                "score": report.score,
                "critical": report.summary.critical,
                "high": report.summary.high,
                "medium": report.summary.medium,
                "low": report.summary.low
            })),
    );
    Ok(report)
}

#[tauri::command]
pub fn list_security_audits(
    profile_id: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Vec<SecurityAuditSummary>> {
    state.storage.list_security_audits(
        profile_id.as_deref().filter(|value| !value.is_empty()),
        limit.unwrap_or(20),
    )
}

#[tauri::command]
pub fn get_security_audit(
    id: i64,
    state: State<'_, AppState>,
) -> AppResult<Option<SecurityReport>> {
    state.storage.get_security_audit(id)
}

#[tauri::command]
pub async fn apply_security_fix(
    profile_id: String,
    finding_id: String,
    state: State<'_, AppState>,
) -> AppResult<SecurityFixResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = remediation::apply(&state.pools, &profile, &finding_id).await;
    if let Ok(fix) = &result {
        for backup in &fix.cron_backups {
            if backup.backup.is_empty() {
                continue;
            }
            let _ = state.storage.insert_cron_backup(
                &profile_id,
                &profile.name,
                &backup.source,
                &backup.backup,
                &backup.entries,
            );
        }
    }
    state.audit.log(
        AuditEvent::new(
            "security",
            "fix",
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(&finding_id),
    );
    result
}

// ---------------------------------------------------------------------------
// Incident response
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn incident_scan(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<IncidentScan> {
    let profile = state.profiles.get(&profile_id)?;
    IncidentManager::scan(&state.pools, &profile).await
}

#[tauri::command]
pub async fn incident_kill_process(
    profile_id: String,
    pid: u32,
    state: State<'_, AppState>,
) -> AppResult<IncidentActionResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = IncidentManager::kill_process(&state.pools, &profile, pid).await;
    state.audit.log(
        AuditEvent::new(
            "incident",
            "kill-process",
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(format!("pid={pid}")),
    );
    result
}

#[tauri::command]
pub async fn incident_quarantine(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<IncidentActionResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = IncidentManager::quarantine(&state.pools, &profile, &path).await;
    state.audit.log(
        AuditEvent::new(
            "incident",
            "quarantine",
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(&path),
    );
    result
}

#[tauri::command]
pub async fn incident_block_ip(
    profile_id: String,
    ip: String,
    block: bool,
    state: State<'_, AppState>,
) -> AppResult<IncidentActionResult> {
    let profile = state.profiles.get(&profile_id)?;
    let result = IncidentManager::block_ip(&state.pools, &profile, &ip, block).await;
    state.audit.log(
        AuditEvent::new(
            "incident",
            if block { "block-ip" } else { "unblock-ip" },
            match &result {
                Ok(result) if result.ok => "success",
                _ => "error",
            },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(&ip),
    );
    result
}

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pm2_list(profile_id: String, state: State<'_, AppState>) -> AppResult<Pm2Report> {
    let profile = state.profiles.get(&profile_id)?;
    Pm2Manager::list(&state.pools, &profile).await
}

#[tauri::command]
pub async fn pm2_action(
    profile_id: String,
    id: u32,
    action: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let profile = state.profiles.get(&profile_id)?;
    let action = Pm2Action::parse(&action)?;
    let result = Pm2Manager::action(&state.pools, &profile, id, action).await;
    state.audit.log(
        AuditEvent::new(
            "pm2",
            format!("{action:?}").to_lowercase(),
            if result.is_ok() { "success" } else { "error" },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(format!("pm2:{id}")),
    );
    result
}

#[tauri::command]
pub async fn pm2_logs(
    profile_id: String,
    id: u32,
    lines: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Pm2Logs> {
    let profile = state.profiles.get(&profile_id)?;
    Pm2Manager::logs(&state.pools, &profile, id, lines.unwrap_or(200)).await
}

#[tauri::command]
pub async fn node_processes(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<NodeProcess>> {
    let profile = state.profiles.get(&profile_id)?;
    crate::application::processes::ProcessManager::node_processes(&state.pools, &profile).await
}

#[tauri::command]
pub async fn network_scan(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<NetworkReport> {
    let profile = state.profiles.get(&profile_id)?;
    NetworkManager::scan(&state.pools, &profile).await
}

#[tauri::command]
pub async fn sudoers_report(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<SudoersReport> {
    let profile = state.profiles.get(&profile_id)?;
    SudoersManager::report(&state.pools, &profile).await
}

#[tauri::command]
pub async fn sudoers_remove_rule(
    profile_id: String,
    source: String,
    line: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let profile = state.profiles.get(&profile_id)?;
    let result = SudoersManager::remove_rule(&state.pools, &profile, &source, &line).await;
    state.audit.log(
        AuditEvent::new(
            "security",
            "remove-sudoers-rule",
            if result.is_ok() { "success" } else { "error" },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(&source)
        .metadata(serde_json::json!({ "rule": line })),
    );
    result
}

#[tauri::command]
pub async fn system_user_lock(
    profile_id: String,
    user: String,
    locked: bool,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let profile = state.profiles.get(&profile_id)?;
    let result = SudoersManager::set_lock(&state.pools, &profile, &user, locked).await;
    state.audit.log(
        AuditEvent::new(
            "security",
            if locked { "lock-user" } else { "unlock-user" },
            if result.is_ok() { "success" } else { "error" },
        )
        .profile(Some(&profile_id), Some(&profile.name))
        .target(&user),
    );
    result
}
