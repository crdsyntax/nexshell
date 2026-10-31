use crate::application::pool::PoolManager;
use crate::error::AppResult;
use crate::models::{AlertEvent, ConnectionProfile};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

const DEFAULT_INTERVAL_SECS: u64 = 60;

#[derive(Default)]
pub struct AlertsService {
    watchers: RwLock<HashMap<String, Watcher>>,
}

struct Watcher {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

impl AlertsService {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(
        self: &Arc<Self>,
        profile: &ConnectionProfile,
        pools: &PoolManager,
        app: AppHandle,
        interval_secs: Option<u64>,
    ) -> AppResult<()> {
        self.stop(&profile.id).await;
        let interval = Duration::from_secs(
            interval_secs
                .unwrap_or(DEFAULT_INTERVAL_SECS)
                .clamp(30, 900),
        );
        let pool = pools.pool(&profile.id).await?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let profile_id = profile.id.clone();
        let profile_name = profile.name.clone();

        let handle = tokio::spawn(async move {
            let mut seen_sessions: HashSet<String> = HashSet::new();
            let mut seen_procs: HashSet<String> = HashSet::new();

            if let Ok(list) = ssh_sessions(&pool).await {
                for (key, _) in list {
                    seen_sessions.insert(key);
                }
            }
            if let Ok(list) = autostart_processes(&pool, interval.as_secs() * 2).await {
                for (key, _) in list {
                    seen_procs.insert(key);
                }
            }

            loop {
                tokio::time::sleep(interval).await;
                if stop_flag.load(Ordering::SeqCst) {
                    return;
                }

                if let Ok(list) = ssh_sessions(&pool).await {
                    for (key, label) in list {
                        if seen_sessions.insert(key) {
                            notify(&app, &profile_name, "ssh", "Nuevo acceso SSH", &label);
                        }
                    }
                }

                if let Ok(list) = autostart_processes(&pool, interval.as_secs() * 2).await {
                    for (key, label) in list {
                        if seen_procs.insert(key) {
                            notify(
                                &app,
                                &profile_name,
                                "process",
                                "Proceso iniciado automáticamente",
                                &label,
                            );
                        }
                    }
                }
            }
        });

        self.watchers
            .write()
            .await
            .insert(profile_id, Watcher { stop, handle });
        Ok(())
    }

    pub async fn stop(&self, profile_id: &str) {
        if let Some(watcher) = self.watchers.write().await.remove(profile_id) {
            watcher.stop.store(true, Ordering::SeqCst);
            watcher.handle.abort();
        }
    }

    pub async fn running(&self) -> Vec<String> {
        self.watchers.read().await.keys().cloned().collect()
    }
}

fn notify(app: &AppHandle, profile: &str, kind: &str, title: &str, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title(format!("2Shell · {profile}"))
        .body(format!("{title}: {body}"))
        .show();
    let _ = app.emit(
        "alert:new",
        AlertEvent {
            profile: profile.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            timestamp: chrono::Utc::now().timestamp(),
        },
    );
}

async fn ssh_sessions(
    pool: &Arc<crate::application::pool::ConnectionPool>,
) -> AppResult<Vec<(String, String)>> {
    let script = "LC_ALL=C last -aF -n 40 2>/dev/null";
    let output = pool
        .acquire()
        .await?
        .connection()
        .exec(script, Duration::from_secs(15))
        .await?;
    let mut sessions = Vec::new();
    for line in output.stdout.lines() {
        if line.trim().is_empty() || line.starts_with("wtmp") || line.starts_with("btmp") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let user = fields[0];
        if user == "reboot" {
            continue;
        }
        let tty = fields[1];
        let start = fields[2..7].join(" ");
        let host = fields
            .last()
            .copied()
            .filter(|value| {
                !value.starts_with('(') && !matches!(*value, "in" | "logged" | "running")
            })
            .unwrap_or("local");
        let key = format!("{user}|{tty}|{host}|{start}");
        sessions.push((key, format!("{user}@{host} ({tty}) · {start}")));
    }
    Ok(sessions)
}

async fn autostart_processes(
    pool: &Arc<crate::application::pool::ConnectionPool>,
    window_secs: u64,
) -> AppResult<Vec<(String, String)>> {
    let window = window_secs.max(60);
    let script = format!(
        "LC_ALL=C ps -eo pid=,ppid=,etimes=,comm=,args= --no-headers 2>/dev/null | awk -v w={window} '$2 == 1 && $3 <= w'"
    );
    let output = pool
        .acquire()
        .await?
        .connection()
        .exec(&script, Duration::from_secs(15))
        .await?;
    let mut procs = Vec::new();
    for line in output.stdout.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid) = parts.next() else { continue };
        let _ppid = parts.next();
        let _elapsed = parts.next();
        let Some(comm) = parts.next() else { continue };
        if comm.starts_with('[') || comm.contains("kthread") {
            continue;
        }
        let args = parts.collect::<Vec<_>>().join(" ");
        let label = if args.is_empty() {
            format!("{comm} (pid {pid})")
        } else {
            format!("{comm} (pid {pid}) · {}", truncate(&args, 120))
        };
        procs.push((pid.to_string(), label));
    }
    Ok(procs)
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_commands() {
        let value = "a".repeat(200);
        let cut = truncate(&value, 20);
        assert!(cut.ends_with('…'));
        assert!(cut.len() <= 24);
    }
}
