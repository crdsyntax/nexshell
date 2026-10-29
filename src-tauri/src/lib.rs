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
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let secrets = Arc::new(SecretBox::load_or_create(&data_dir.join("master.key"))?);
            // Migrates the previous JSON store into SQLite on first start.
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
            presentation::tauri::commands::process_locate,
            presentation::tauri::commands::process_kill,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running 2Shell");
}
