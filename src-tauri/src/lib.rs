mod application;
mod error;
mod infrastructure;
mod models;
mod presentation;
mod ssh;
mod state;

use crate::infrastructure::crypto::SecretBox;
use crate::infrastructure::storage::Storage;
use crate::state::AppState;
use std::sync::Arc;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("twoshell=info,russh=warn,tauri=warn")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let secrets = Arc::new(SecretBox::load_or_create(&data_dir.join("master.key"))?);
            let storage = Arc::new(Storage::open(
                &data_dir.join("nexshell.db"),
                Some(&data_dir.join("nexshell.json")),
            )?);
            let state = AppState::new(storage, secrets);

            tracing::info!(
                target: "twoshell",
                "state ready at {}",
                data_dir.display()
            );
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            presentation::tauri::commands::list_profiles,
            presentation::tauri::commands::save_profile,
            presentation::tauri::commands::delete_profile,
            presentation::tauri::commands::probe_ssh_key,
            presentation::tauri::commands::test_profile,
            presentation::tauri::commands::connect_profile,
            presentation::tauri::commands::disconnect_profile,
            presentation::tauri::commands::detect_server,
            presentation::tauri::commands::pool_stats,
            presentation::tauri::commands::remote_exec,
            presentation::tauri::commands::terminal_open,
            presentation::tauri::commands::terminal_write,
            presentation::tauri::commands::terminal_resize,
            presentation::tauri::commands::terminal_close,
            presentation::tauri::commands::terminal_list,
            presentation::tauri::commands::terminal_open_process,
            presentation::tauri::commands::terminal_open_directory,
            presentation::tauri::commands::disk_large_files,
            presentation::tauri::commands::file_properties,
            presentation::tauri::commands::file_delete,
            presentation::tauri::commands::fs_list,
            presentation::tauri::commands::fs_editor,
            presentation::tauri::commands::forensics_sessions,
            presentation::tauri::commands::forensics_artifacts,
            presentation::tauri::commands::forensics_search,
            presentation::tauri::commands::forensics_secrets,
            presentation::tauri::commands::forensics_auth,
            presentation::tauri::commands::alerts_start,
            presentation::tauri::commands::alerts_stop,
            presentation::tauri::commands::alerts_status,
            presentation::tauri::commands::local_ip,
            presentation::tauri::commands::fs_create,
            presentation::tauri::commands::fs_rename,
            presentation::tauri::commands::fs_delete,
            presentation::tauri::commands::process_locate,
            presentation::tauri::commands::process_kill,
            presentation::tauri::commands::process_details,
            presentation::tauri::commands::monitor_start,
            presentation::tauri::commands::monitor_stop,
            presentation::tauri::commands::monitor_snapshot,
            presentation::tauri::commands::service_detect,
            presentation::tauri::commands::service_status,
            presentation::tauri::commands::service_action,
            presentation::tauri::commands::service_config_list,
            presentation::tauri::commands::service_config_read,
            presentation::tauri::commands::service_config_write,
            presentation::tauri::commands::service_logs,
            presentation::tauri::commands::list_execution_logs,
            presentation::tauri::commands::clear_execution_logs,
            presentation::tauri::commands::audit_db_path,
            presentation::tauri::commands::database_info,
            presentation::tauri::commands::database_users,
            presentation::tauri::commands::database_grants,
            presentation::tauri::commands::database_change_password,
            presentation::tauri::commands::database_test_login,
            presentation::tauri::commands::cron_list,
            presentation::tauri::commands::cron_delete_entry,
            presentation::tauri::commands::cron_list_backups,
            presentation::tauri::commands::cron_restore_backup,
            presentation::tauri::commands::incident_scan,
            presentation::tauri::commands::incident_kill_process,
            presentation::tauri::commands::incident_quarantine,
            presentation::tauri::commands::incident_block_ip,
            presentation::tauri::commands::pm2_list,
            presentation::tauri::commands::pm2_action,
            presentation::tauri::commands::pm2_logs,
            presentation::tauri::commands::node_processes,
            presentation::tauri::commands::network_scan,
            presentation::tauri::commands::network_inspect,
            presentation::tauri::commands::sudoers_report,
            presentation::tauri::commands::sudoers_remove_rule,
            presentation::tauri::commands::system_user_lock,
            presentation::tauri::commands::account_origin,
            presentation::tauri::commands::ssh_keys,
            presentation::tauri::commands::ssh_config,
            presentation::tauri::commands::ssh_add_key,
            presentation::tauri::commands::ssh_remove_key,
            presentation::tauri::commands::ssh_set_key_only,
            presentation::tauri::commands::run_security_audit,
            presentation::tauri::commands::list_security_audits,
            presentation::tauri::commands::get_security_audit,
            presentation::tauri::commands::apply_security_fix,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 2Shell");
}
