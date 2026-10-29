use crate::error::AppResult;
use crate::infrastructure::storage::Storage;
use crate::models::{ExecutionLog, LogFilter, NewExecutionLog};
use chrono::Utc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const MAX_COMMAND_CHARS: usize = 8_192;
const MAX_OUTPUT_CHARS: usize = 16_384;
const MAX_ERROR_CHARS: usize = 4_096;
const PRUNE_EVERY: u64 = 250;

/// Append-only audit trail for connections, remote commands, terminals and
/// destructive operations. Logging must never break the operation itself.
pub struct AuditService {
    storage: Arc<Storage>,
    writes: AtomicU64,
}

#[derive(Debug, Clone, Default)]
pub struct AuditEvent {
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub category: String,
    pub action: String,
    pub target: Option<String>,
    pub command: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

impl AuditEvent {
    pub fn new(
        category: impl Into<String>,
        action: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            category: category.into(),
            action: action.into(),
            status: status.into(),
            ..Default::default()
        }
    }

    pub fn profile(mut self, id: Option<&str>, name: Option<&str>) -> Self {
        self.profile_id = id.map(str::to_string);
        self.profile_name = name.map(str::to_string);
        self
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    pub fn command(mut self, command: impl Into<String>) -> Self {
        self.command = Some(command.into());
        self
    }

    pub fn exit(mut self, exit_code: Option<i32>) -> Self {
        self.exit_code = exit_code;
        self
    }

    pub fn duration(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn output(mut self, output: impl Into<String>) -> Self {
        self.output = Some(output.into());
        self
    }

    pub fn error(mut self, error: impl Into<String>) -> Self {
        self.error = Some(error.into());
        self
    }

    pub fn metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

impl AuditService {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self {
            storage,
            writes: AtomicU64::new(0),
        }
    }

    pub fn log(&self, event: AuditEvent) {
        // Metrics run every 1-10 seconds; logging them would drown the audit
        // trail. Everything else is recorded.
        if event.category == "metrics" || event.category == "silent" {
            return;
        }

        let record = NewExecutionLog {
            timestamp: Utc::now().timestamp(),
            profile_id: event.profile_id,
            profile_name: event.profile_name,
            category: event.category,
            action: event.action,
            target: event.target,
            command: event
                .command
                .map(|value| truncate(value, MAX_COMMAND_CHARS)),
            status: event.status,
            exit_code: event.exit_code,
            duration_ms: event.duration_ms,
            output: event.output.map(|value| truncate(value, MAX_OUTPUT_CHARS)),
            error: event.error.map(|value| truncate(value, MAX_ERROR_CHARS)),
            metadata_json: event.metadata.map(|value| value.to_string()),
        };

        match self.storage.insert_log(&record) {
            Ok(_) => {
                let writes = self.writes.fetch_add(1, Ordering::Relaxed) + 1;
                if writes % PRUNE_EVERY == 0 {
                    if let Err(error) = self.storage.prune_logs(10_000) {
                        tracing::warn!(target: "twoshell::audit", "pruning failed: {}", error);
                    }
                }
            }
            Err(error) => {
                tracing::warn!(target: "twoshell::audit", "could not persist log: {}", error);
            }
        }
    }

    pub fn list(&self, filter: &LogFilter) -> AppResult<Vec<ExecutionLog>> {
        self.storage.list_logs(filter)
    }

    pub fn clear(&self, profile_id: Option<&str>) -> AppResult<usize> {
        self.storage.clear_logs(profile_id)
    }

    pub fn db_path(&self) -> String {
        self.storage.path().display().to_string()
    }
}

fn truncate(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push_str("\n… [truncated]");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::storage::Storage;

    #[test]
    fn persists_events_and_skips_metrics() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Arc::new(Storage::open(&dir.path().join("db.sqlite"), None).unwrap());
        let audit = AuditService::new(storage);

        audit.log(AuditEvent::new("metrics", "exec", "success"));
        audit.log(
            AuditEvent::new("ssh", "exec", "success")
                .profile(Some("p1"), Some("prod"))
                .command("echo hello")
                .output("hello")
                .duration(12),
        );

        let logs = audit.list(&LogFilter::default()).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].category, "ssh");
        assert_eq!(logs[0].command.as_deref(), Some("echo hello"));
        assert_eq!(logs[0].duration_ms, Some(12));
    }

    #[test]
    fn truncation_is_character_safe() {
        let value = "á".repeat(10);
        let result = truncate(value, 5);
        assert!(result.starts_with("ááááá"));
        assert!(result.ends_with("[truncated]"));
    }
}
