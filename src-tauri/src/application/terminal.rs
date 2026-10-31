use crate::application::audit::{AuditEvent, AuditService};
use crate::application::pool::ConnectionPool;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, TerminalInfo};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

const MAX_INPUT_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct TerminalOptions {
    pub cols: u32,
    pub rows: u32,
    pub initial_directory: Option<String>,
    pub title: Option<String>,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 32,
            initial_directory: None,
            title: None,
        }
    }
}

enum InputMsg {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct TerminalSession {
    info: TerminalInfo,
    profile_name: String,
    input: mpsc::Sender<InputMsg>,
    #[allow(dead_code)]
    lease: crate::application::pool::PoolLease,
    closed: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataEvent {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalClosedEvent {
    session_id: String,
    reason: String,
    exit_status: Option<i32>,
}

pub struct TerminalManager {
    sessions: RwLock<HashMap<String, Arc<TerminalSession>>>,
    audit: Arc<AuditService>,
}

impl TerminalManager {
    pub fn new(audit: Arc<AuditService>) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            audit,
        }
    }

    pub async fn open(
        self: &Arc<Self>,
        pool: Arc<ConnectionPool>,
        profile: &ConnectionProfile,
        options: TerminalOptions,
        app: AppHandle,
    ) -> AppResult<TerminalInfo> {
        let started = Instant::now();
        let profile_id = profile.id.clone();
        let profile_name = profile.name.clone();
        let target = options
            .title
            .clone()
            .or_else(|| options.initial_directory.clone())
            .unwrap_or_else(|| format!("{}:{}", profile.host, profile.port));

        let result = self.open_inner(pool, profile, options, app).await;
        match &result {
            Ok(info) => self.audit.log(
                AuditEvent::new("terminal", "open", "success")
                    .profile(Some(&profile_id), Some(&profile_name))
                    .target(target)
                    .duration(started.elapsed().as_millis() as u64)
                    .metadata(serde_json::json!({
                        "session_id": info.session_id,
                        "title": info.title,
                        "cols": info.cols,
                        "rows": info.rows
                    })),
            ),
            Err(error) => self.audit.log(
                AuditEvent::new("terminal", "open", "error")
                    .profile(Some(&profile_id), Some(&profile_name))
                    .target(target)
                    .duration(started.elapsed().as_millis() as u64)
                    .error(error.to_string()),
            ),
        }
        result
    }

    async fn open_inner(
        self: &Arc<Self>,
        pool: Arc<ConnectionPool>,
        profile: &ConnectionProfile,
        options: TerminalOptions,
        app: AppHandle,
    ) -> AppResult<TerminalInfo> {
        let TerminalOptions {
            cols,
            rows,
            initial_directory,
            title,
        } = options;
        let cols = cols.clamp(20, 500);
        let rows = rows.clamp(5, 300);

        let lease = pool.acquire().await?;
        let (read_half, writer) = lease.connection().open_shell(cols, rows).await?;

        let session_id = Uuid::new_v4().to_string();
        let ordinal = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|s| s.info.profile_id == profile.id)
                .count()
                + 1
        };
        let info = TerminalInfo {
            session_id: session_id.clone(),
            profile_id: profile.id.clone(),
            title: title.unwrap_or_else(|| format!("{} #{}", profile.name, ordinal)),
            cols,
            rows,
        };

        let (input_tx, mut input_rx) = mpsc::channel::<InputMsg>(256);

        if let Some(directory) = initial_directory
            .as_deref()
            .map(str::trim)
            .filter(|directory| !directory.is_empty())
        {
            let command = format!("cd {}\n", shell_quote(directory));
            let _ = input_tx.send(InputMsg::Data(command.into_bytes())).await;
        }
        let closed = Arc::new(AtomicBool::new(false));
        let session = Arc::new(TerminalSession {
            info: info.clone(),
            profile_name: profile.name.clone(),
            input: input_tx,
            lease,
            closed: closed.clone(),
        });

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session);
        }

        let weak: Weak<TerminalManager> = Arc::downgrade(self);

        let reader_app = app.clone();
        let reader_session_id = session_id.clone();
        let reader_closed = closed.clone();
        let reader_weak = weak.clone();
        let reader_profile_id = profile.id.clone();
        let reader_profile_name = profile.name.clone();
        let reader_title = info.title.clone();
        let mut read_half = read_half;
        tokio::spawn(async move {
            let mut exit_status: Option<i32> = None;
            loop {
                match read_half.wait().await {
                    Some(russh::ChannelMsg::Data { data }) => {
                        let _ = reader_app.emit(
                            "terminal:data",
                            TerminalDataEvent {
                                session_id: reader_session_id.clone(),
                                data: B64.encode(&data),
                            },
                        );
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, ext: 1 }) => {
                        let _ = reader_app.emit(
                            "terminal:data",
                            TerminalDataEvent {
                                session_id: reader_session_id.clone(),
                                data: B64.encode(&data),
                            },
                        );
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status: code }) => {
                        exit_status = Some(code as i32);
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }

            let user_closed = reader_closed.load(Ordering::SeqCst);
            reader_closed.store(true, Ordering::SeqCst);
            let _ = reader_app.emit(
                "terminal:closed",
                TerminalClosedEvent {
                    session_id: reader_session_id.clone(),
                    reason: if exit_status.is_some() {
                        "remote shell exited".to_string()
                    } else {
                        "connection to the host was closed".to_string()
                    },
                    exit_status,
                },
            );

            let reason = if exit_status.is_some() {
                "remote shell exited"
            } else {
                "connection to the host was closed"
            };
            if let Some(manager) = reader_weak.upgrade() {
                if !user_closed {
                    manager.audit.log(
                        AuditEvent::new("terminal", "remote-close", "success")
                            .profile(Some(&reader_profile_id), Some(&reader_profile_name))
                            .target(reader_title)
                            .exit(exit_status)
                            .error(reason),
                    );
                }
                manager.discard(&reader_session_id).await;
            }
        });

        let writer_weak = weak;
        let writer_app = app;
        let writer_session_id = session_id.clone();
        let writer = writer;
        tokio::spawn(async move {
            let mut announce: Option<&str> = None;
            while let Some(message) = input_rx.recv().await {
                match message {
                    InputMsg::Data(bytes) => {
                        if writer.write(bytes).await.is_err() {
                            announce = Some("terminal write failed");
                            break;
                        }
                    }
                    InputMsg::Resize(cols, rows) => {
                        if writer.resize(cols, rows).await.is_err() {
                            announce = Some("terminal resize failed");
                            break;
                        }
                    }
                    InputMsg::Close => {
                        let _ = writer.close().await;
                        announce = Some("terminal closed by user");
                        break;
                    }
                }
            }

            if let Some(reason) = announce {
                let _ = writer_app.emit(
                    "terminal:closed",
                    TerminalClosedEvent {
                        session_id: writer_session_id.clone(),
                        reason: reason.to_string(),
                        exit_status: None,
                    },
                );
            }
            if let Some(manager) = writer_weak.upgrade() {
                manager.discard(&writer_session_id).await;
            }
        });

        tracing::info!(
            target: "twoshell::terminal",
            "opened terminal {} for profile {} ({}x{})",
            info.session_id,
            info.profile_id,
            cols,
            rows
        );

        Ok(info)
    }

    pub async fn write(&self, session_id: &str, data: String) -> AppResult<()> {
        let session = self.get(session_id).await?;
        if session.closed.load(Ordering::SeqCst) {
            return Err(AppError::Terminal("terminal is already closed".into()));
        }
        let bytes = data.into_bytes();
        if bytes.is_empty() {
            return Ok(());
        }
        if bytes.len() > MAX_INPUT_CHUNK {
            return Err(AppError::Validation(
                "terminal input chunk is too large".into(),
            ));
        }
        session
            .input
            .send(InputMsg::Data(bytes))
            .await
            .map_err(|_| AppError::Terminal("terminal writer is gone".into()))
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        let session = self.get(session_id).await?;
        session
            .input
            .send(InputMsg::Resize(cols, rows))
            .await
            .map_err(|_| AppError::Terminal("terminal writer is gone".into()))
    }

    pub async fn close(&self, session_id: &str) -> AppResult<()> {
        let session = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.closed.store(true, Ordering::SeqCst);
            let _ = session.input.send(InputMsg::Close).await;
            self.audit.log(
                AuditEvent::new("terminal", "close", "success")
                    .profile(Some(&session.info.profile_id), Some(&session.profile_name))
                    .target(&session.info.session_id),
            );
        }
        Ok(())
    }

    pub async fn list(&self) -> Vec<TerminalInfo> {
        self.sessions
            .read()
            .await
            .values()
            .map(|session| session.info.clone())
            .collect()
    }

    pub async fn close_profile(&self, profile_id: &str) {
        let ids: Vec<String> = self
            .sessions
            .read()
            .await
            .values()
            .filter(|session| session.info.profile_id == profile_id)
            .map(|session| session.info.session_id.clone())
            .collect();
        for id in ids {
            let _ = self.close(&id).await;
        }
    }

    async fn get(&self, session_id: &str) -> AppResult<Arc<TerminalSession>> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("terminal {session_id} does not exist")))
    }

    async fn discard(&self, session_id: &str) {
        let removed = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(session_id)
        };
        if let Some(session) = removed {
            session.closed.store(true, Ordering::SeqCst);
        }
    }
}
